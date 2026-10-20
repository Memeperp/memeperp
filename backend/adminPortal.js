const express = require('express');
const crypto = require('crypto');
const telemetry = require('./siteTelemetry');
const storage = require('./persistentStore');
const trading = require('./tradingControl');

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function summarize(ledger, evm) {
  const accounts = [], positions = [], orders = [], activity = [];
  let closedTrades = 0, notionalUsd = 0, realizedPnlUsd = 0;
  function add(account, wallet, chain) {
    const sol = chain === 'solana', currency = sol ? 'SOL' : chain === 'bsc' ? 'BNB' : 'ETH';
    const live = Array.isArray(account.positions) ? account.positions : [];
    const pending = (sol ? account.openOrders : account.orders) || [];
    const openOrders = pending.filter(order => ['open', 'pending'].includes(order.status || 'open'));
    accounts.push({ wallet, chain, balanceNative: num(sol ? account.balanceSol : account.balanceNative),
      currency, positions: live.length, orders: openOrders.length, realizedPnlUsd: num(account.realizedPnlUsd) });
    realizedPnlUsd += num(account.realizedPnlUsd);
    closedTrades += (sol ? account.closedPositions : account.closed)?.length || 0;
    for (const p of live) {
      notionalUsd += num(p.notional || p.notionalUsd || num(p.qty) * num(p.entry));
      positions.push({ wallet, chain, symbol: p.sym, side: p.side, marginNative: num(sol ? p.margin : p.marginNative),
        currency, leverage: num(p.lev || p.leverage), entry: num(p.entry), quantity: num(p.qty) });
    }
    for (const order of openOrders) orders.push({ wallet, chain, symbol: order.sym, side: order.side,
      limitPrice: num(order.limitPrice || order.triggerPrice), marginNative: num(sol ? order.marginSol : order.marginNative), currency });
    for (const entry of (sol ? account.history : account.activity) || []) {
      activity.push({ wallet, chain, type: entry.type || entry.event || 'ACTIVITY',
        message: entry.msg || entry.message || JSON.stringify(entry.details || entry.data ||
          Object.fromEntries(Object.entries(entry).filter(([key]) => !['id', 'at', 'type'].includes(key)))),
        createdAt: entry.ts || entry.at || entry.createdAt });
    }
  }
  for (const [wallet, account] of Object.entries(ledger.wallets || {})) add(account, ledger.meta?.walletSigningAddresses?.[wallet] || wallet, 'solana');
  for (const [key, account] of Object.entries(evm || {})) add(account, account.address || key.split(':')[1], account.chain || key.split(':')[0]);
  activity.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const signups = (ledger.meta?.betaWaitlist || []).map(row => ({ email: row.email, createdAt: row.createdAt }));
  const allFeedback = Array.isArray(ledger.meta?.feedback) ? ledger.meta.feedback : [];
  const feedback = allFeedback.slice().sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)).slice(0, 500)
    .map(row => ({ id: row.id, category: row.category, message: row.message, createdAt: row.createdAt, status: row.status }));
  return {
    metrics: { accounts: accounts.length, openPositions: positions.length, pendingOrders: orders.length,
      closedTrades, signups: signups.length, feedback: allFeedback.length, realizedPnlUsd, notionalUsd },
    accounts, positions, orders, activity: activity.slice(0, 200), signups, feedback,
    markets: Object.values(ledger.markets || {}).map(m => ({
      symbol: m.sym, address: m.addr, price: num(m.px), updatedAt: m.updatedAt,
    })),
  };
}
function createAdminPortal({ requireAdmin, getLedger, getEvm, adminWallet, revoke, onImported }) {
  const router = express.Router();
  const privateHeaders = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
  router.use(privateHeaders);
  router.get('/identity', (_req, res) => res.json({ walletAddress: adminWallet, configured: Boolean(adminWallet) }));
  router.use(requireAdmin);
  // Cookies authorize page navigation. Mutations need an explicit bearer
  // header, preventing another site from using the browser cookie as CSRF.
  const bearerOnly = (req, res, next) => {
    if (!/^Bearer \S+$/.test(String(req.headers.authorization || ''))) return res.status(403).json({ error: 'Explicit admin authorization is required' });
    next();
  };
  router.get('/overview', async (_req, res) => {
    try {
      const summary = summarize(getLedger(), getEvm());
      res.json({
        generatedAt: new Date().toISOString(), trading: trading.get(), storage: storage.status(),
        ...summary, metrics: { ...summary.metrics, ...await telemetry.metrics() },
        providers: { rpcConfigured: Boolean(process.env.RPC_URL), birdeyeConfigured: Boolean(process.env.BIRDEYE_KEY) },
      });
    } catch (_) { res.status(503).json({ error: 'Owner statistics are temporarily unavailable' }); }
  });
  router.post('/trading', bearerOnly, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Choose enabled or paused' });
    if (storage.migrationRequired) return res.status(409).json({ error: 'Import a verified backup before enabling trading' });
    try {
      const settings = trading.setEnabled(req.body.enabled, req.adminWallet);
      await storage.flush();
      res.json({ ok: true, trading: settings });
    } catch (_) { res.status(503).json({ error: 'Trading setting was not saved. New trades remain blocked.' }); }
  });
  router.get('/export', (_req, res) => {
    if (storage.migrationRequired) return res.status(409).json({ error: 'This database does not contain the previous published records. Do not treat an empty export as a production backup.' });
    res.set('Content-Disposition', `attachment; filename="memeperp-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(storage.export());
  });
  router.post('/import', bearerOnly, async (req, res) => {
    if (req.body?.confirmation !== 'IMPORT VERIFIED PRODUCTION BACKUP') return res.status(400).json({ error: 'Confirm that this is the verified production backup' });
    try {
      await storage.importVerified(req.body.backup);
      onImported?.();
      res.json({ ok: true, trading: trading.get(), checksum: crypto.createHash('sha256').update(JSON.stringify(req.body.backup)).digest('hex') });
    } catch (_) { res.status(409).json({ error: 'Backup was not imported. Check its format and that the target has no existing accounts.' }); }
  });
  router.post('/logout', bearerOnly, (req, res) => {
    revoke(req.adminToken);
    const secure = storage.production || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('mp_admin', {
      path: '/admin', httpOnly: true, secure,
      sameSite: storage.production || !secure ? 'strict' : 'none',
      partitioned: secure && !storage.production,
    });
    res.json({ ok: true });
  });
  return router;
}
module.exports = { createAdminPortal, summarize };