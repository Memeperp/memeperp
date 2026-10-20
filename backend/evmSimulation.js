const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isAddress, verifyMessage } = require('ethers');
const store = require('./persistentStore');
const trading = require('./tradingControl');
const { ExpiringMap, challengeKey } = require('./security');

const router = express.Router();
const FILE = process.env.EVM_SIMULATION_FILE || path.join(__dirname, '..', '.data', 'evm-simulation.json');
const SESSION_FILE = `${FILE}.sessions`;
const CHAINS = { robinhood: 'robinhood', bsc: 'bsc' };
const COLLATERAL = {
  robinhood: { symbol: 'ETH', chainId: 'ethereum', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  bsc: { symbol: 'BNB', chainId: 'bsc', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
};
// Robinhood's native ETH has no ERC-20 contract. Use a disclosed, liquid Ethereum
// WETH/USD reference for simulated ETH/USD positions, never a made-up RH pair.
const REFERENCE_LIQUIDITY_USD = 1_000_000;
const ORDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ORACLE_TTL_MS = 5000;
const FEE_RATE = 0.0006;
const MAINTENANCE_RATE = 0.006;
const nonces = new ExpiringMap({ deadline: 'exp', maxSize: 5000 });
// Persist only hashes of high-entropy bearer tokens so a server restart does
// not sign out every network. Intent approvals remain ephemeral and single-use.
let persistedSessions = {};
try {
  persistedSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).sessions || {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const sessions = new ExpiringMap({ deadline: 'exp', entries: Object.entries(persistedSessions).filter(([, session]) =>
  session && session.exp > Date.now() && Object.hasOwn({ robinhood: true, bsc: true }, session.chain) &&
  isAddress(session.address || '')) });
function sessionKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function saveSessions() {
  if (store.enabled) {
    store.save('evm_sessions', { sessions: Object.fromEntries(sessions) });
    return;
  }
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  const temp = `${SESSION_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
  fs.renameSync(temp, SESSION_FILE);
}
const tradeIntents = new Map();
const authAttempts = new ExpiringMap({ deadline: 'until' });
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;
const requestLimits = new ExpiringMap({ deadline: 'until' });
router.use((req, res, next) => {
  // Verified accounts have independent budgets; forged bearer strings never
  // create new rate-limit buckets. Anonymous market lookups are IP-limited.
  const auth = String(req.headers.authorization || '');
  const session = auth.startsWith('Bearer ') ? sessions.get(sessionKey(auth.slice(7).trim())) : null;
  const id = session ? `wallet:${session.chain}:${session.address}` : `ip:${req.ip}`;
  const limit = session ? 300 : 120;
  const time = Date.now();
  const entry = requestLimits.get(id) || { count: 0, until: time + 60000 };
  if (++entry.count > limit) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - time) / 1000))));
    return fail(res, 429, 'Too many requests. Wait and retry.');
  }
  requestLimits.set(id, entry);
  next();
});
let accounts = {};
const collateralCache = new Map();
const accountInitialization = new Map();
try {
  accounts = JSON.parse(fs.readFileSync(FILE, 'utf8')).accounts || {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function save(snapshot = accounts) {
  if (store.enabled) {
    store.save('evm', { accounts: snapshot });
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ accounts: snapshot }, null, 2));
  fs.renameSync(temp, FILE);
}
function validChain(chain) {
  return Object.hasOwn(CHAINS, chain);
}
function key(chain, address) {
  return `${chain}:${address.toLowerCase()}`;
}
function normalizeAccount(acc) {
  acc.realizedPnlUsd = Number(acc.realizedPnlUsd || 0);
  acc.realizedBasisUsd = Number(acc.realizedBasisUsd || 0);
  acc.positions = Array.isArray(acc.positions) ? acc.positions : [];
  acc.closed = Array.isArray(acc.closed) ? acc.closed : [];
  acc.orders = Array.isArray(acc.orders) ? acc.orders : [];
  acc.activity = Array.isArray(acc.activity) ? acc.activity : [];
  return acc;
}
function fail(res, status, message) {
  return res.status(status).json({ error: message });
}
function requireSession(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /i, '');
  const session = sessions.get(sessionKey(token));
  if (!session || session.exp < Date.now()) return fail(res, 401, 'Connect and sign in with your EVM wallet');
  req.evm = session;
  next();
}
const INTENT_FIELDS = {
  open: ['address', 'side', 'marginNative', 'leverage', 'mode', 'type', 'triggerPrice', 'tp', 'tpRoi', 'sl', 'slRoi', 'tpQty', 'tpQtyPct', 'slQty', 'slQtyPct'],
  order: ['address', 'side', 'marginNative', 'leverage', 'mode', 'type', 'triggerPrice', 'tp', 'tpRoi', 'sl', 'slRoi', 'tpQty', 'tpQtyPct', 'slQty', 'slQtyPct'],
  balance: ['amountUsd', 'amountNative'],
  cancel: ['targetId'],
  tpsl: ['targetId', 'tp', 'tpRoi', 'sl', 'slRoi', 'tpQty', 'tpQtyPct', 'slQty', 'slQtyPct'],
  reduce: ['targetId', 'percent'],
  close: ['targetId'],
};
const INTENT_LABELS = {
  open: 'OPEN POSITION', order: 'PLACE ORDER', balance: 'ADD TEST BALANCE',
  cancel: 'CANCEL ORDER', tpsl: 'CHANGE TP/SL', reduce: 'REDUCE POSITION', close: 'CLOSE POSITION',
};
function tradeIntentDigest(action, body) {
  return crypto.createHash('sha256').update(JSON.stringify([
    action, ...INTENT_FIELDS[action].map(field => body?.[field] ?? null),
  ])).digest('hex');
}
function requireTradeIntent(action) {
  return (req, res, next) => {
    const id = String(req.body?.intentId || '');
    const intent = tradeIntents.get(id);
    tradeIntents.delete(id);
    if (!intent || intent.expiresAt < Date.now() || intent.action !== action ||
      intent.chain !== req.evm.chain || intent.address !== req.evm.address ||
      (req.params.id && String(req.body?.targetId || '') !== req.params.id) ||
      intent.digest !== tradeIntentDigest(action, req.body)) {
      return fail(res, 403, 'Confirm this exact action in your connected wallet before submitting');
    }
    try {
      if (verifyMessage(intent.message, req.body?.intentSignature).toLowerCase() !== req.evm.address) {
        return fail(res, 403, 'Action signature does not match the connected wallet');
      }
    } catch (_) {
      return fail(res, 403, 'Wallet confirmation was not completed');
    }
    next();
  };
}
function limitAuth(req, res, next) {
  const now = Date.now();
  // Reverse proxies may give every visitor the same req.ip. Scope the limit
  // to a wallet as well, so one user cannot lock everyone out of sign-in.
  const id = `${req.ip}:${String(req.body?.address || '').toLowerCase()}`;
  const entry = authAttempts.get(id);
  if (!entry && authAttempts.size >= 10000) authAttempts.prune();
  if (!entry && authAttempts.size >= 10000) return fail(res, 429, 'EVM sign-in is temporarily busy');
  const nextEntry = entry && entry.until > now ? entry : { count: 0, until: now + AUTH_WINDOW_MS };
  nextEntry.count++;
  authAttempts.set(id, nextEntry);
  if (nextEntry.count > AUTH_MAX_ATTEMPTS) return fail(res, 429, 'Too many EVM sign-in requests; try again later');
  next();
}
function pricePnl(pos, price) {
  return (pos.side === 'long' ? 1 : -1) * pos.qty * (price - pos.entry);
}
async function collateralPrice(chain) {
  if (!validChain(chain)) throw new Error('Select a valid EVM chain');
  const cfg = COLLATERAL[chain];
  const cached = collateralCache.get(chain);
  if (cached?.price > 0 && Date.now() - cached.at < ORACLE_TTL_MS) return cached.price;
  if (cached?.promise) return cached.promise;
  const entry = { promise: null };
  entry.promise = (async () => {
    try {
      const json = await dexJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cfg.address)}`);
      const pair = (json.pairs || []).filter(p =>
        String(p?.chainId || '').toLowerCase() === cfg.chainId &&
        String(p?.baseToken?.address || '').toLowerCase() === cfg.address.toLowerCase() &&
        Number(p.priceUsd) > 0 && Number(p.liquidity?.usd) >= REFERENCE_LIQUIDITY_USD)
        .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
      const price = Number(pair?.priceUsd);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`Live ${cfg.symbol}/USD collateral quote is unavailable`);
      collateralCache.set(chain, { price, at: Date.now() });
      return price;
    } catch (error) {
      collateralCache.delete(chain);
      throw new Error(`Unable to obtain live ${cfg.symbol}/USD collateral quote: ${error.message}`);
    }
  })();
  collateralCache.set(chain, entry);
  return entry.promise;
}
async function initializeAccount(chain, address, id) {
  const nativePrice = await collateralPrice(chain);
  const existing = accounts[id] || null;
  if (!existing) {
    const fresh = {
      collateralVersion: 2, balanceNative: 0,
      realizedPnlUsd: 0, realizedBasisUsd: 0, positions: [], closed: [], orders: [], activity: [],
    };
    const candidate = { ...accounts, [id]: fresh };
    save(candidate);
    accounts = candidate;
    return { acc: fresh, nativePrice };
  }
  if (existing.collateralVersion === 2 && Number.isFinite(Number(existing.balanceNative))) {
    const normalized = normalizeAccount(existing);
    accounts[id] = normalized;
    return { acc: normalized, nativePrice };
  }
  // Convert a legacy USD ledger as a single durable snapshot; leave the original untouched if
  // the oracle or disk write fails so a later request can retry safely.
  const migrated = JSON.parse(JSON.stringify(existing));
  const legacyBalance = Number(migrated.balanceUsd);
  if (!Number.isFinite(legacyBalance) || legacyBalance < 0) {
    throw new Error('Legacy simulated balance is invalid; refusing to reset collateral');
  }
  migrated.balanceNative = legacyBalance / nativePrice;
  delete migrated.balanceUsd;
  for (const pos of migrated.positions || []) {
    const marginUsd = Number(pos.marginUsd);
    if (!Number.isFinite(marginUsd) || marginUsd < 0) throw new Error('Legacy position margin is invalid');
    pos.marginNative = marginUsd / nativePrice;
    delete pos.marginUsd;
    if (pos.openFeeUsd != null) {
      pos.openFeeNative = Number(pos.openFeeUsd) / nativePrice;
      delete pos.openFeeUsd;
    }
  }
  for (const order of migrated.orders || []) {
    if (order.marginUsd != null) {
      const marginUsd = Number(order.marginUsd);
      if (!Number.isFinite(marginUsd) || marginUsd < 0) throw new Error('Legacy order margin is invalid');
      order.marginNative = marginUsd / nativePrice;
      delete order.marginUsd;
    }
    if (order.reservedFeeUsd != null) {
      order.reservedFeeNative = Number(order.reservedFeeUsd) / nativePrice;
      delete order.reservedFeeUsd;
    }
  }
  migrated.collateralVersion = 2;
  normalizeAccount(migrated);
  const candidate = { ...accounts, [id]: migrated };
  save(candidate);
  accounts = candidate;
  return { acc: migrated, nativePrice };
}
async function ensureAccount(chain, address) {
  const id = key(chain, address);
  const pending = accountInitialization.get(id);
  if (pending) return pending;
  const initialized = initializeAccount(chain, address, id);
  accountInitialization.set(id, initialized);
  try {
    return await initialized;
  } finally {
    if (accountInitialization.get(id) === initialized) accountInitialization.delete(id);
  }
}
function logActivity(acc, type, details = {}) {
  acc.activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...details, type });
  acc.activity = acc.activity.slice(0, 500);
}
function closePosition(acc, pos, price, reason, nativePrice) {
  // A quote fetch may have yielded while another close or automatic trigger
  // settled the same position. Never credit proceeds twice.
  if (!acc.positions.includes(pos)) return false;
  const gross = pricePnl(pos, price);
  const feeUsd = Math.abs(pos.qty * price) * FEE_RATE;
  const openFeeUsd = Number(pos.openFeeNative || 0) * nativePrice;
  const rawReturnedNative = pos.marginNative + (gross - feeUsd) / nativePrice;
  const returnedNative = pos.mode === 'cross' ? rawReturnedNative : Math.max(0, rawReturnedNative);
  if (reason === 'LIQ') {
    if (pos.mode === 'cross') {
      // Cross collateral may use this chain-wallet's free balance, but never another account's funds.
      acc.balanceNative = Math.max(0, acc.balanceNative + returnedNative);
    }
  } else {
    acc.balanceNative += Math.max(0, returnedNative);
  }
  // Isolated losses cannot exceed the posted margin; record the same loss
  // actually returned to the ledger, including fees already charged on open.
  const realizedPnl = pos.mode === 'cross'
    ? gross - feeUsd - openFeeUsd
    : (returnedNative - pos.marginNative) * nativePrice - openFeeUsd;
  acc.realizedPnlUsd += realizedPnl;
  acc.realizedBasisUsd += pos.marginNative * nativePrice;
  acc.positions = acc.positions.filter(p => p.id !== pos.id);
  const closed = { ...pos, exit: price, pnlUsd: realizedPnl, closeFeeUsd: feeUsd, reason, closedAt: new Date().toISOString() };
  acc.closed.unshift(closed);
  acc.closed = acc.closed.slice(0, 200);
  logActivity(acc, 'position_closed', { positionId: pos.id, address: pos.addr, symbol: pos.sym, reason, price, pnlUsd: closed.pnlUsd });
  save();
  return true;
}
function closePartialPosition(acc, pos, price, reason, nativePrice, qty, percent = null) {
  if (!acc.positions.includes(pos) || !Number.isFinite(qty) || qty <= 0 || qty >= pos.qty) return false;
  const fraction = qty / pos.qty;
  const reducedMargin = pos.marginNative * fraction;
  const reducedOpenFee = Number(pos.openFeeNative || 0) * fraction;
  const reducedPos = { ...pos, qty };
  const gross = pricePnl(reducedPos, price);
  const closeFeeUsd = Math.abs(qty * price) * FEE_RATE;
  const rawReturnedNative = reducedMargin + (gross - closeFeeUsd) / nativePrice;
  const returnedNative = pos.mode === 'cross' ? rawReturnedNative : Math.max(0, rawReturnedNative);
  const realizedPnlUsd = pos.mode === 'cross'
    ? gross - closeFeeUsd - reducedOpenFee * nativePrice
    : (returnedNative - reducedMargin) * nativePrice - reducedOpenFee * nativePrice;
  const closed = {
    ...pos,
    id: crypto.randomUUID(),
    positionId: pos.id,
    qty,
    marginNative: reducedMargin,
    marginUsd: reducedMargin * nativePrice,
    openFeeNative: reducedOpenFee,
    openFeeUsd: reducedOpenFee * nativePrice,
    exit: price,
    pnlUsd: realizedPnlUsd,
    closeFeeUsd,
    reason,
    ...(percent == null ? {} : { percent }),
    partial: true,
    closedAt: new Date().toISOString(),
  };
  if (pos.mode === 'cross') acc.balanceNative = Math.max(0, acc.balanceNative + returnedNative);
  else acc.balanceNative += Math.max(0, returnedNative);
  acc.realizedPnlUsd += realizedPnlUsd;
  acc.realizedBasisUsd += reducedMargin * nativePrice;
  pos.qty -= qty;
  pos.marginNative -= reducedMargin;
  pos.openFeeNative = Math.max(0, Number(pos.openFeeNative || 0) - reducedOpenFee);
  acc.closed.unshift(closed);
  acc.closed = acc.closed.slice(0, 200);
  logActivity(acc, reason === 'REDUCE' ? 'position_reduced' : 'position_partially_closed', {
    positionId: pos.id, closedRecordId: closed.id, address: pos.addr,
    symbol: pos.sym, qty, marginNative: reducedMargin, realizedPnlUsd, reason,
  });
  return closed;
}
function pruneInvalidProtectionSize(pos) {
  for (const kind of ['tp', 'sl']) {
    if (pos[`${kind}Qty`] != null && (!Number.isFinite(Number(pos[`${kind}Qty`])) ||
      Number(pos[`${kind}Qty`]) <= 0)) {
      delete pos[`${kind}Qty`];
      delete pos[`${kind}QtyPct`];
      delete pos[kind];
      delete pos[`${kind}Roi`];
    }
  }
}
function crossCushion(acc, pos, prices, nativePrice) {
  let cushion = acc.balanceNative;
  for (const other of acc.positions) {
    if (other.id === pos.id || other.mode !== 'cross') continue;
    const mark = prices[other.addr];
    cushion += other.marginNative + (Number.isFinite(mark) ? pricePnl(other, mark) / nativePrice : 0);
  }
  return Math.max(0, cushion);
}
function liquidationPrice(acc, pos, prices, nativePrice) {
  if (!Number.isFinite(pos.qty) || pos.qty <= 0 || !Number.isFinite(nativePrice) || nativePrice <= 0) return null;
  const equityBeforePnl = (pos.marginNative + (pos.mode === 'cross' ? crossCushion(acc, pos, prices, nativePrice) : 0)) * nativePrice;
  // Solve the same equity <= maintenance threshold used by settleTriggers.
  const price = pos.side === 'long'
    ? (pos.qty * pos.entry - equityBeforePnl) / (pos.qty * (1 - MAINTENANCE_RATE))
    : (pos.qty * pos.entry + equityBeforePnl) / (pos.qty * (1 + MAINTENANCE_RATE));
  return Number.isFinite(price) && price > 0 ? price : null;
}
function settleTriggers(acc, prices, nativePrice) {
  for (const pos of [...acc.positions]) {
    const mark = prices[pos.addr];
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const gross = pricePnl(pos, mark);
    const marginUsd = pos.marginNative * nativePrice;
    const roi = gross / marginUsd * 100;
    const crossEquity = pos.mode === 'cross' ? (crossCushion(acc, pos, prices, nativePrice) + pos.marginNative) * nativePrice + gross : marginUsd + gross;
    const maintenance = Math.abs(pos.qty * mark) * MAINTENANCE_RATE;
    if (pos.mode === 'cross' ? crossEquity <= maintenance : marginEquity(pos, mark, nativePrice) <= maintenance) closePosition(acc, pos, mark, 'LIQ', nativePrice);
    else {
      const trigger = triggeredProtection(pos, mark, roi);
      if (trigger) settleProtection(acc, pos, mark, trigger, nativePrice);
    }
  }
}
function marginEquity(pos, mark, nativePrice) {
  return pos.marginNative * nativePrice + pricePnl(pos, mark);
}
async function dexJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Market data provider returned ${response.status}`);
  return response.json();
}
function matches(pair, chain, address) {
  return String(pair?.chainId || '').toLowerCase() === chain &&
    String(pair?.baseToken?.address || '').toLowerCase() === address.toLowerCase() &&
    Number(pair?.priceUsd) > 0;
}
function normalize(pair) {
  return {
    chain: pair.chainId,
    addr: pair.baseToken.address,
    sym: String(pair.baseToken.symbol || 'TOKEN').slice(0, 25),
    name: String(pair.baseToken.name || pair.baseToken.symbol || 'Token').slice(0, 80),
    priceUsd: Number(pair.priceUsd),
    liquidityUsd: Number(pair.liquidity?.usd || 0),
    fdvUsd: pair.fdv == null ? null : Number(pair.fdv),
    marketCapUsd: Number(pair.marketCap || pair.fdv || 0),
    createdAt: Number(pair.pairCreatedAt) > 0 ? Number(pair.pairCreatedAt) : null,
    change24h: Number(pair.priceChange?.h24 || 0),
  };
}
function isRobinhoodEthReference(chain, address) {
  return chain === 'robinhood' && address.toLowerCase() === COLLATERAL.robinhood.address.toLowerCase();
}
async function robinhoodEthMarket() {
  return {
    chain: 'robinhood', addr: COLLATERAL.robinhood.address,
    sym: 'ETH', name: 'Ether / USD reference', priceUsd: await collateralPrice('robinhood'),
    liquidityUsd: null, fdvUsd: null, marketCapUsd: null, createdAt: null, change24h: null,
    referencePrice: true, priceSource: 'Ethereum WETH/USD', chartChain: 'ethereum',
  };
}
async function market(chain, address, { allowExistingPosition = false } = {}) {
  if (!validChain(chain) || !isAddress(address)) throw new Error('Select a valid EVM chain and token contract');
  if (isRobinhoodEthReference(chain, address)) return robinhoodEthMarket();
  const json = await dexJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pair = (json.pairs || []).filter(p => matches(p, chain, address))
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!pair) throw new Error('No live market for this token on the selected chain');
  const token = normalize(pair);
  if (!Number.isFinite(token.priceUsd) || token.priceUsd <= 0) throw new Error('Market quote is stale or invalid');
  if (!allowExistingPosition && (token.liquidityUsd < 50000 || token.marketCapUsd < 100000)) {
    throw new Error('Market requires at least $50,000 liquidity and $100,000 market cap');
  }
  return token;
}
function riskValue(value) {
  return value === '' || value == null ? null : Number(value);
}
function parseRisk(body, { side, entry, qty } = {}) {
  const risk = {};
  for (const [kind, roiLimit] of [['tp', [0, 1000]], ['sl', [-100, 0]]]) {
    const trigger = riskValue(body?.[kind]);
    const roi = riskValue(body?.[`${kind}Roi`]);
    const quantity = riskValue(body?.[`${kind}Qty`]);
    const percent = riskValue(body?.[`${kind}QtyPct`]);
    if (trigger !== null && roi !== null) throw new Error(`${kind.toUpperCase()} must use either a trigger price or ROI, not both`);
    if (trigger !== null && (!Number.isFinite(trigger) || trigger <= 0)) throw new Error(`${kind.toUpperCase()} trigger price must be positive`);
    if (roi !== null && (!Number.isFinite(roi) || (kind === 'tp' ? roi <= 0 || roi > roiLimit[1] : roi >= 0 || roi < roiLimit[0]))) {
      throw new Error('TP must be 0–1000% and SL -100–0% ROI');
    }
    if (trigger !== null && Number.isFinite(entry) && side) {
      const directionValid = kind === 'tp'
        ? (side === 'long' ? trigger > entry : trigger < entry)
        : (side === 'long' ? trigger < entry : trigger > entry);
      if (!directionValid) throw new Error(`${kind.toUpperCase()} trigger must be ${kind === 'tp' ? 'above' : 'below'} the entry for a long and the reverse for a short`);
    }
    if (quantity !== null && percent !== null) throw new Error(`${kind.toUpperCase()} close size must use quantity or percent, not both`);
    if ((quantity !== null || percent !== null) && trigger === null && roi === null) {
      throw new Error(`${kind.toUpperCase()} close size requires a ${kind.toUpperCase()} trigger`);
    }
    if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0 || (Number.isFinite(qty) && quantity > qty))) {
      throw new Error(`${kind.toUpperCase()} close quantity must be positive and no greater than the position quantity`);
    }
    if (percent !== null && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
      throw new Error(`${kind.toUpperCase()} close percent must be greater than 0 and no more than 100`);
    }
    risk[kind] = trigger;
    risk[`${kind}Roi`] = roi;
    risk[`${kind}Qty`] = quantity;
    risk[`${kind}QtyPct`] = percent;
  }
  return risk;
}
function protectionFields(item) {
  return {
    tp: item.tp ?? null, tpRoi: item.tpRoi ?? null,
    sl: item.sl ?? null, slRoi: item.slRoi ?? null,
    tpQty: item.tpQty ?? null, tpQtyPct: item.tpQtyPct ?? null,
    slQty: item.slQty ?? null, slQtyPct: item.slQtyPct ?? null,
  };
}
function triggeredProtection(pos, mark, roi) {
  if ((pos.tp != null && (pos.side === 'long' ? mark >= pos.tp : mark <= pos.tp)) ||
    (pos.tpRoi != null && roi >= pos.tpRoi)) return 'TP';
  if ((pos.sl != null && (pos.side === 'long' ? mark <= pos.sl : mark >= pos.sl)) ||
    (pos.slRoi != null && roi <= pos.slRoi)) return 'SL';
  return null;
}
function settleProtection(acc, pos, mark, reason, nativePrice) {
  const kind = reason.toLowerCase();
  const quantity = pos[`${kind}Qty`];
  const percent = pos[`${kind}QtyPct`];
  let closeQty = quantity != null ? Math.min(pos.qty, Number(quantity))
    : percent != null ? pos.qty * Number(percent) / 100 : pos.qty;
  if (!Number.isFinite(closeQty) || closeQty <= 0 || closeQty > pos.qty) {
    // Legacy positions default to a full close; stale or invalid explicit sizing is
    // disabled rather than risking repeated automatic partial settlements.
    delete pos[`${kind}Qty`];
    delete pos[`${kind}QtyPct`];
    delete pos[kind];
    delete pos[`${kind}Roi`];
    save();
    return false;
  }
  if (closeQty >= pos.qty) return closePosition(acc, pos, mark, reason, nativePrice);
  const closed = closePartialPosition(acc, pos, mark, reason, nativePrice, closeQty,
    percent != null ? Number(percent) : null);
  if (!closed) return false;
  // Consume the trigger and its size once, even if the remainder still meets it.
  delete pos[kind];
  delete pos[`${kind}Roi`];
  delete pos[`${kind}Qty`];
  delete pos[`${kind}QtyPct`];
  pruneInvalidProtectionSize(pos);
  save();
  return closed;
}
function orderTriggered(order, price) {
  if (order.type === 'limit') {
    return order.side === 'long' ? price <= order.triggerPrice : price >= order.triggerPrice;
  }
  return order.side === 'long' ? price >= order.triggerPrice : price <= order.triggerPrice;
}
function fillOrder(acc, order, token, nativePrice) {
  if (order.status !== 'pending') return false;
  const pos = {
    id: crypto.randomUUID(), chain: order.chain, addr: order.addr, sym: token.sym, name: token.name,
    side: order.side, entry: token.priceUsd, qty: order.marginNative * order.leverage * nativePrice / token.priceUsd,
    marginNative: order.marginNative, leverage: order.leverage, mode: order.mode, openFeeNative: order.reservedFeeNative,
    openedAt: new Date().toISOString(), tpRoi: order.tpRoi, slRoi: order.slRoi,
    tp: order.tp, sl: order.sl, tpQty: order.tpQty, tpQtyPct: order.tpQtyPct,
    slQty: order.slQty, slQtyPct: order.slQtyPct,
  };
  try { parseRisk(pos, { side: pos.side, entry: pos.entry, qty: pos.qty }); }
  catch (error) {
    order.status = 'rejected';
    order.rejectionReason = error.message;
    order.closedAt = new Date().toISOString();
    acc.balanceNative += order.marginNative + order.reservedFeeNative;
    logActivity(acc, 'order_rejected', { orderId: order.id, address: order.addr, reason: error.message });
    save();
    return false;
  }
  order.status = 'filled';
  order.filledAt = new Date().toISOString();
  order.fillPrice = token.priceUsd;
  order.positionId = pos.id;
  acc.positions.unshift(pos);
  logActivity(acc, 'order_filled', { orderId: order.id, positionId: pos.id, address: order.addr, symbol: token.sym, side: order.side, price: token.priceUsd });
  save();
  return true;
}
function cancelOrder(acc, order, status = 'cancelled') {
  if (order.status !== 'pending') return false;
  order.status = status;
  order.closedAt = new Date().toISOString();
  acc.balanceNative += order.marginNative + order.reservedFeeNative;
  logActivity(acc, status === 'expired' ? 'order_expired' : 'order_cancelled', { orderId: order.id, address: order.addr, symbol: order.sym, releasedNative: order.marginNative + order.reservedFeeNative });
  save();
  return true;
}
async function processOrders(chain, acc, prices = {}, nativePrice) {
  if (!Number.isFinite(nativePrice) || nativePrice <= 0) throw new Error('A live collateral quote is required before processing orders');
  for (const order of [...acc.orders]) {
    if (order.status !== 'pending') continue;
    if (Date.now() >= Date.parse(order.expiresAt)) {
      cancelOrder(acc, order, 'expired');
      continue;
    }
    let token;
    try {
      token = await market(chain, order.addr);
    } catch (_) {
      // An unavailable or ineligible quote never triggers a simulated fill.
      continue;
    }
    prices[order.addr] = token.priceUsd;
    if (trading.isEnabled() && orderTriggered(order, token.priceUsd)) fillOrder(acc, order, token, nativePrice);
  }
  return prices;
}
let processingOpenAccounts = false;
async function processOpenAccounts() {
  if (processingOpenAccounts) return;
  processingOpenAccounts = true;
  try {
    for (const [id, acc] of Object.entries(accounts)) {
      const chain = id.split(':')[0];
      if (!validChain(chain) || acc.collateralVersion !== 2) continue;
      if (!acc.orders?.some(order => order.status === 'pending') &&
        !acc.positions?.some(pos => pos.tp != null || pos.tpRoi != null || pos.sl != null || pos.slRoi != null)) continue;
      try {
        const nativePrice = await collateralPrice(chain);
        const prices = {};
        const addresses = [...new Set((acc.positions || []).map(pos => pos.addr))];
        await Promise.all(addresses.map(async address => {
          try { prices[address] = (await market(chain, address, { allowExistingPosition: true })).priceUsd; }
          catch (_) { prices[address] = null; }
        }));
        await processOrders(chain, acc, prices, nativePrice);
        settleTriggers(acc, prices, nativePrice);
      } catch (error) {
        console.warn(`EVM automatic checks unavailable for ${chain}: ${error.message}`);
      }
    }
  } finally {
    processingOpenAccounts = false;
  }
}
// Pending limits and TP/SL must continue to run even if the trader closes the page.
setInterval(() => { processOpenAccounts().catch(error => console.warn('EVM automatic checks failed:', error)); }, 15000).unref();
function portfolio(acc, prices, nativePrice) {
  const unrealizedPnlUsd = acc.positions.reduce((sum, pos) => {
    const mark = prices[pos.addr];
    return sum + (Number.isFinite(mark) ? pricePnl(pos, mark) - Number(pos.openFeeNative || 0) * nativePrice : 0);
  }, 0);
  const marginUsedNative = acc.positions.reduce((sum, pos) => sum + pos.marginNative, 0);
  const reservedMarginNative = acc.orders.filter(order => order.status === 'pending')
    .reduce((sum, order) => sum + order.marginNative + order.reservedFeeNative, 0);
  const marginUsedUsd = marginUsedNative * nativePrice;
  const reservedMarginUsd = reservedMarginNative * nativePrice;
  const availableBalanceUsd = acc.balanceNative * nativePrice;
  const equityNative = acc.balanceNative + marginUsedNative + unrealizedPnlUsd / nativePrice;
  return {
    availableBalanceNative: acc.balanceNative,
    availableBalanceUsd,
    unrealizedPnlUsd,
    equityNative,
    equityUsd: equityNative * nativePrice,
    marginUsedNative,
    reservedMarginNative,
    marginUsedUsd,
    reservedMarginUsd,
  };
}

router.post('/auth/challenge', limitAuth, (req, res) => {
  const { chain, address } = req.body || {};
  if (!validChain(chain) || !isAddress(address)) return fail(res, 400, 'Invalid chain or wallet address');
  if (!nonces.has(key(chain, address)) && nonces.size >= 10000) return fail(res, 429, 'EVM sign-in is temporarily busy');
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `MemePerp testnet sign-in\nChain: ${chain}\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\nNo transaction or funds will be transferred.`;
  nonces.set(challengeKey(key(chain, address), message), { message, exp: Date.now() + 5 * 60 * 1000 });
  res.json({ message });
});
router.post('/auth/verify', limitAuth, (req, res) => {
  const { chain, address, signature, message } = req.body || {};
  if (!validChain(chain) || !isAddress(address)) return fail(res, 400, 'Invalid chain or wallet address');
  if (typeof message !== 'string') return fail(res, 400, 'Invalid sign-in message');
  const id = challengeKey(key(chain, address), message);
  const challenge = nonces.get(id);
  nonces.delete(id);
  if (!challenge || challenge.exp < Date.now() || challenge.message !== message) return fail(res, 401, 'Sign-in challenge expired');
  try {
    if (verifyMessage(message, signature).toLowerCase() !== address.toLowerCase()) return fail(res, 401, 'Wallet signature does not match');
  } catch (_) {
    return fail(res, 401, 'Invalid wallet signature');
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionKey(token), { chain, address: address.toLowerCase(), exp: Date.now() + 24 * 60 * 60 * 1000 });
  saveSessions();
  res.json({ token });
});
router.post('/auth/logout', requireSession, (req, res) => {
  sessions.delete(sessionKey(String(req.headers.authorization || '').replace(/^Bearer /i, '')));
  saveSessions();
  res.json({ ok: true });
});
router.post('/auth/order-intent', requireSession, (req, res) => {
  const { action, order } = req.body || {};
  if (['open', 'order'].includes(action) && !trading.isEnabled()) {
    return trading.requireTrading(req, res, () => {});
  }
  if (!Object.hasOwn(INTENT_FIELDS, action) || !order || typeof order !== 'object' || Array.isArray(order)) {
    return fail(res, 400, 'Choose a valid action to confirm');
  }
  const targetId = String(order.targetId || '');
  if (['cancel', 'tpsl', 'reduce', 'close'].includes(action)) {
    const account = accounts[key(req.evm.chain, req.evm.address)];
    const items = action === 'cancel' ? account?.orders : account?.positions;
    if (!targetId || !items?.some(item => item.id === targetId && (action !== 'cancel' || item.status === 'pending'))) {
      return fail(res, 404, 'Position or pending order not found for this wallet');
    }
  }
  if (tradeIntents.size >= 10000) return fail(res, 429, 'Too many pending wallet confirmations');
  const intentId = crypto.randomUUID();
  const symbol = COLLATERAL[req.evm.chain].symbol;
  const details = ['open', 'order'].includes(action) ? [
    `Market: ${order.address}`,
    `Side: ${order.side}`,
    `Margin: ${order.marginNative} ${symbol}`,
    `Leverage: ${order.leverage}x`,
    `Mode: ${order.mode}`,
    `Order: ${action === 'order' ? `${order.type} at $${order.triggerPrice}` : 'market'}`,
    `Take-profit ROI: ${order.tpRoi ?? 'off'}`,
    `Take-profit price: ${order.tp ?? 'off'}`,
    `Take-profit close size: ${order.tpQtyPct != null ? `${order.tpQtyPct}%` : order.tpQty ?? 'full position'}`,
    `Stop-loss ROI: ${order.slRoi ?? 'off'}`,
    `Stop-loss price: ${order.sl ?? 'off'}`,
    `Stop-loss close size: ${order.slQtyPct != null ? `${order.slQtyPct}%` : order.slQty ?? 'full position'}`,
  ] : action === 'balance' ? [
    `Amount: ${order.amountUsd != null ? `$${order.amountUsd} USD (converted to ${symbol} at the live quote)` : `${order.amountNative} ${symbol}`}`,
  ] : [
    `${action === 'cancel' ? 'Order' : 'Position'} ID: ${targetId}`,
    ...(action === 'reduce' ? [`Reduce by: ${order.percent}%`] : []),
    ...(action === 'tpsl' ? [
      `Take-profit: ${order.tp != null ? `$${order.tp}` : order.tpRoi == null || order.tpRoi === '' ? 'off' : `${order.tpRoi}% ROI`}`,
      `Take-profit close size: ${order.tpQtyPct != null ? `${order.tpQtyPct}%` : order.tpQty ?? 'full position'}`,
      `Stop-loss: ${order.sl != null ? `$${order.sl}` : order.slRoi == null || order.slRoi === '' ? 'off' : `${order.slRoi}% ROI`}`,
      `Stop-loss close size: ${order.slQtyPct != null ? `${order.slQtyPct}%` : order.slQty ?? 'full position'}`,
    ] : []),
    ...(action === 'close' || action === 'reduce' ? ['Execution uses the latest live market price.'] : []),
  ];
  const message = [
    `MemePerp Testnet Confirm ${INTENT_LABELS[action]}`,
    `Chain: ${req.evm.chain}`,
    `Wallet: ${req.evm.address}`,
    ...details,
    `Nonce: ${intentId}`,
    'Simulated order only. No on-chain transaction or wallet funds transfer.',
  ].join('\n');
  tradeIntents.set(intentId, {
    action, message, digest: tradeIntentDigest(action, order),
    chain: req.evm.chain, address: req.evm.address, expiresAt: Date.now() + 5 * 60 * 1000,
  });
  res.json({ intentId, message });
});
router.get('/collateral', async (req, res) => {
  const chain = String(req.query.chain || '');
  if (!validChain(chain)) return fail(res, 400, 'Select a valid EVM chain');
  try {
    res.json({ chain, collateralSymbol: COLLATERAL[chain].symbol, collateralPriceUsd: await collateralPrice(chain) });
  } catch (error) {
    fail(res, 503, error.message);
  }
});
router.get('/search', async (req, res) => {
  const chain = String(req.query.chain || '');
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!validChain(chain) || !q) return fail(res, 400, 'Select a chain and enter a token');
  try {
    const exact = isAddress(q);
    const json = await dexJson(exact
      ? `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(q)}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const seen = new Set();
    const items = (json.pairs || []).filter(p => String(p.chainId).toLowerCase() === chain && isAddress(p.baseToken?.address || '') &&
      (!exact || p.baseToken.address.toLowerCase() === q.toLowerCase()))
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))
      .filter(p => {
        const id = p.baseToken.address.toLowerCase();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 20).map(normalize);
    if (chain === 'robinhood' && (['eth', 'ether', 'weth'].includes(q.toLowerCase()) ||
      isRobinhoodEthReference(chain, q))) items.unshift(await robinhoodEthMarket());
    res.json({ items });
  } catch (error) {
    fail(res, 503, error.message);
  }
});
router.get('/market', async (req, res) => {
  try { res.json(await market(String(req.query.chain || ''), String(req.query.address || ''))); }
  catch (error) { fail(res, 503, error.message); }
});
router.get('/state', requireSession, async (req, res) => {
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const prices = {};
    const marketSnapshots = {};
    const addresses = [...new Set([
      ...acc.positions.map(pos => pos.addr),
      ...acc.orders.filter(order => order.status === 'pending').map(order => order.addr),
    ])];
    await Promise.all(addresses.map(async address => {
      const isOpenPosition = acc.positions.some(pos => pos.addr.toLowerCase() === address.toLowerCase());
      try {
        const snapshot = await market(req.evm.chain, address, {
          allowExistingPosition: isOpenPosition,
        });
        marketSnapshots[address.toLowerCase()] = snapshot;
        prices[address] = snapshot.priceUsd;
      }
      catch (_) {
        prices[address] = null;
        marketSnapshots[address.toLowerCase()] = null;
      }
    }));
    await processOrders(req.evm.chain, acc, prices, nativePrice);
    settleTriggers(acc, prices, nativePrice);
    const totals = portfolio(acc, prices, nativePrice);
    const positions = acc.positions.map(pos => ({
      ...pos,
      ...protectionFields(pos),
      marginUsd: pos.marginNative * nativePrice,
      openFeeUsd: Number(pos.openFeeNative || 0) * nativePrice,
      mark: prices[pos.addr],
      marketCapUsd: marketSnapshots[pos.addr.toLowerCase()]?.marketCapUsd ?? null,
      liquidationPrice: liquidationPrice(acc, pos, prices, nativePrice),
      unrealizedPnlUsd: Number.isFinite(prices[pos.addr]) ? pricePnl(pos, prices[pos.addr]) - Number(pos.openFeeNative || 0) * nativePrice : null,
    }));
    const orders = acc.orders.map(order => ({
      ...order,
      ...protectionFields(order),
      marginUsd: order.marginNative * nativePrice,
      reservedFeeUsd: order.reservedFeeNative * nativePrice,
    }));
    const balanceUsd = acc.balanceNative * nativePrice;
    res.json({
      ...acc, collateralSymbol: COLLATERAL[req.evm.chain].symbol, collateralPriceUsd: nativePrice,
      balanceNative: acc.balanceNative, balanceUsd,
      positions, orders, prices,
      portfolio: totals,
      ...totals,
    });
  } catch (error) {
    fail(res, 503, error.message);
  }
});
router.post('/balance/add', requireSession, requireTradeIntent('balance'), async (req, res) => {
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const usesUsd = req.body?.amountUsd != null;
    const amountUsd = usesUsd ? Number(req.body.amountUsd) : Number(req.body?.amountNative) * nativePrice;
    const amountNative = usesUsd ? amountUsd / nativePrice : Number(req.body?.amountNative);
    if (!Number.isFinite(amountNative) || amountNative <= 0 || amountUsd < 1 || amountUsd > 1000) {
      return fail(res, 400, `Enter ${COLLATERAL[req.evm.chain].symbol} worth $1–$1,000 at the live collateral quote`);
    }
    const now = Date.now();
    const previous = acc.creditWindow;
    const window = previous && Number.isFinite(previous.startedAt) && now - previous.startedAt < 6 * 60 * 60 * 1000
      ? previous : { startedAt: now, amountUsd: 0 };
    if (window.amountUsd + amountUsd > 1000) return fail(res, 429, 'You can add at most $1,000 in test balance per six hours on this chain');
    window.amountUsd += amountUsd;
    acc.creditWindow = window;
    acc.balanceNative += amountNative;
    logActivity(acc, 'practice_balance_added', { amountNative, amountUsd });
    save();
    res.json({ balanceNative: acc.balanceNative, amountNative, amountUsd, remainingUsd: 1000 - window.amountUsd });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/orders', requireSession, trading.requireTrading, requireTradeIntent('order'), async (req, res) => {
  const body = req.body || {};
  const { address, side } = body;
  const marginNative = Number(body.marginNative);
  const leverage = Number(body.leverage);
  const mode = body.mode == null ? 'isolated' : String(body.mode);
  const type = String(body.type || '');
  const triggerPrice = Number(body.triggerPrice);
  if (!['long', 'short'].includes(side) || !Number.isFinite(marginNative) ||
    !Number.isInteger(leverage) || leverage < 1 || leverage > 20 || !['cross', 'isolated'].includes(mode) ||
    !['limit', 'stop'].includes(type) || !Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    return fail(res, 400, 'Use native collateral worth $1–$1,000, 1–20x leverage, cross or isolated mode, and a valid limit/stop trigger price');
  }
  let risk;
  try { risk = parseRisk(body, { side }); }
  catch (error) { return fail(res, 400, error.message); }
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    if (acc.orders.filter(order => order.status === 'pending').length >= 100) {
      return fail(res, 409, 'Cancel an existing order before placing another');
    }
    const marginUsd = marginNative * nativePrice;
    if (!Number.isFinite(marginUsd) || marginUsd < 1 || marginUsd > 1000) return fail(res, 400, 'Margin must be worth $1–$1,000 at the live collateral quote');
    if (acc.positions.length + acc.orders.filter(order => order.status === 'pending').length >= 10) return fail(res, 409, 'Maximum 10 open positions or pending orders');
    const token = await market(req.evm.chain, String(address || ''));
    if (acc.positions.length + acc.orders.filter(order => order.status === 'pending').length >= 10) {
      return fail(res, 409, 'Maximum 10 open positions or pending orders');
    }
    if (acc.positions.some(pos => pos.addr.toLowerCase() === token.addr.toLowerCase()) ||
      acc.orders.some(order => order.status === 'pending' && order.addr.toLowerCase() === token.addr.toLowerCase())) {
      return fail(res, 409, 'Close the existing position or cancel the pending order for this token first');
    }
    if (type === 'limit' && orderTriggered({ type, side, triggerPrice }, token.priceUsd)) {
      return fail(res, 409, `Limit price is already executable at the live price ($${token.priceUsd}). Choose a ${side === 'long' ? 'lower' : 'higher'} limit to leave an order pending, or use Market to open now.`);
    }
    const feeNative = marginNative * leverage * FEE_RATE;
    if (marginNative + feeNative > acc.balanceNative) return fail(res, 400, `Insufficient ${COLLATERAL[req.evm.chain].symbol} balance. Use Add test balance first.`);
    const order = {
      id: crypto.randomUUID(), chain: req.evm.chain, addr: token.addr, sym: token.sym, name: token.name,
      side, marginNative, leverage, mode, type, triggerPrice, ...risk, reservedFeeNative: feeNative,
      status: 'pending', placedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
    };
    if (!trading.isEnabled()) return trading.requireTrading(req, res, () => {});
    acc.balanceNative -= marginNative + feeNative;
    acc.orders.unshift(order);
    logActivity(acc, 'order_placed', { orderId: order.id, address: token.addr, symbol: token.sym, side, type, triggerPrice });
    if (type === 'stop' && orderTriggered(order, token.priceUsd)) fillOrder(acc, order, token, nativePrice);
    acc.orders = acc.orders.slice(0, 200);
    save();
    res.json({
      order: { ...order, ...protectionFields(order), marginUsd, reservedFeeUsd: feeNative * nativePrice },
      position: order.positionId ? {
        ...acc.positions.find(pos => pos.id === order.positionId),
        ...protectionFields(acc.positions.find(pos => pos.id === order.positionId) || {}),
        marginUsd, openFeeUsd: feeNative * nativePrice,
      } : null,
    });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/orders/:id/cancel', requireSession, requireTradeIntent('cancel'), async (req, res) => {
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const order = acc.orders.find(item => item.id === req.params.id);
    if (!order) return fail(res, 404, 'Order not found');
    if (!cancelOrder(acc, order)) return fail(res, 409, 'Only pending orders can be cancelled');
    res.json({ ok: true, order: { ...order, ...protectionFields(order), marginUsd: order.marginNative * nativePrice } });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/positions/open', requireSession, trading.requireTrading, requireTradeIntent('open'), async (req, res) => {
  const body = req.body || {};
  const { address, side } = body;
  const marginNative = Number(body.marginNative);
  const leverage = Number(body.leverage);
  const mode = body.mode == null ? 'isolated' : String(body.mode);
  if (!['long', 'short'].includes(side) || !Number.isFinite(marginNative) ||
    !Number.isInteger(leverage) || leverage < 1 || leverage > 20 || !['cross', 'isolated'].includes(mode)) {
    return fail(res, 400, 'Use native collateral worth $1–$1,000, 1–20x leverage, and cross or isolated mode');
  }
  let risk;
  try { risk = parseRisk(body, { side }); }
  catch (error) { return fail(res, 400, error.message); }
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const marginUsd = marginNative * nativePrice;
    if (!Number.isFinite(marginUsd) || marginUsd < 1 || marginUsd > 1000) return fail(res, 400, 'Margin must be worth $1–$1,000 at the live collateral quote');
    if (acc.positions.length >= 10) return fail(res, 409, 'Maximum 10 open positions');
    const token = await market(req.evm.chain, String(address || ''));
    const positionQty = marginUsd * leverage / token.priceUsd;
    try { risk = parseRisk(body, { side, entry: token.priceUsd, qty: positionQty }); }
    catch (error) { return fail(res, 400, error.message); }
    if (acc.positions.length >= 10) return fail(res, 409, 'Maximum 10 open positions');
    if (acc.positions.some(pos => pos.addr.toLowerCase() === token.addr.toLowerCase()) ||
      acc.orders.some(order => order.status === 'pending' && order.addr.toLowerCase() === token.addr.toLowerCase())) {
      return fail(res, 409, 'Close the existing position or cancel the pending order for this token first');
    }
    const feeNative = marginNative * leverage * FEE_RATE;
    if (marginNative + feeNative > acc.balanceNative) return fail(res, 400, `Insufficient ${COLLATERAL[req.evm.chain].symbol} balance. Use Add test balance first.`);
    const pos = {
      id: crypto.randomUUID(), chain: req.evm.chain, addr: token.addr, sym: token.sym, name: token.name, side,
      entry: token.priceUsd, qty: positionQty, marginNative, leverage, mode, openFeeNative: feeNative,
      openedAt: new Date().toISOString(), ...risk,
    };
    if (!trading.isEnabled()) return trading.requireTrading(req, res, () => {});
    acc.balanceNative -= marginNative + feeNative;
    acc.positions.unshift(pos);
    logActivity(acc, 'position_opened', { positionId: pos.id, address: token.addr, symbol: token.sym, side, mode, entry: token.priceUsd });
    save();
    res.json({ position: { ...pos, ...protectionFields(pos), marginUsd, openFeeUsd: feeNative * nativePrice } });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/positions/:id/tpsl', requireSession, requireTradeIntent('tpsl'), async (req, res) => {
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const pos = acc.positions.find(p => p.id === req.params.id);
    if (!pos) return fail(res, 404, 'Position not found');
    let risk;
    try { risk = parseRisk(req.body || {}, { side: pos.side, entry: pos.entry, qty: pos.qty }); }
    catch (error) { return fail(res, 400, error.message); }
    Object.assign(pos, risk);
    logActivity(acc, 'position_risk_updated', { positionId: pos.id, ...protectionFields(pos) });
    save();
    res.json({ position: { ...pos, ...protectionFields(pos), marginUsd: pos.marginNative * nativePrice } });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/positions/:id/reduce', requireSession, requireTradeIntent('reduce'), async (req, res) => {
  const percent = Number(req.body?.percent);
  if (!Number.isFinite(percent) || percent < 1 || percent > 99) {
    return fail(res, 400, 'Reduction percent must be between 1 and 99');
  }
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const pos = acc.positions.find(position => position.id === req.params.id);
    if (!pos) return fail(res, 404, 'Position not found');
    const quote = await market(req.evm.chain, pos.addr, { allowExistingPosition: true });
    if (!acc.positions.includes(pos)) return fail(res, 409, 'Position already closed');
    const reducedQty = pos.qty * percent / 100;
    const closed = closePartialPosition(acc, pos, quote.priceUsd, 'REDUCE', nativePrice, reducedQty, percent);
    if (!closed) return fail(res, 409, 'Position already closed');
    const reducedMargin = closed.marginNative;
    const closeFeeUsd = closed.closeFeeUsd;
    const gross = pricePnl(closed, quote.priceUsd);
    const rawReturnedNative = reducedMargin + (gross - closeFeeUsd) / nativePrice;
    const returnedNative = pos.mode === 'cross' ? rawReturnedNative : Math.max(0, rawReturnedNative);
    const realizedPnlUsd = closed.pnlUsd;
    pruneInvalidProtectionSize(pos);
    save();
    res.json({
      ok: true,
      position: { ...pos, ...protectionFields(pos), marginUsd: pos.marginNative * nativePrice, openFeeUsd: pos.openFeeNative * nativePrice },
      closed, releasedMarginNative: reducedMargin, releasedMarginUsd: reducedMargin * nativePrice,
      closeFeeUsd, returnedNative, returnedUsd: returnedNative * nativePrice, realizedPnlUsd,
    });
  } catch (error) { fail(res, 503, error.message); }
});
router.post('/positions/:id/close', requireSession, requireTradeIntent('close'), async (req, res) => {
  try {
    const { acc, nativePrice } = await ensureAccount(req.evm.chain, req.evm.address);
    const pos = acc.positions.find(p => p.id === req.params.id);
    if (!pos) return fail(res, 404, 'Position not found');
    const quote = await market(req.evm.chain, pos.addr, { allowExistingPosition: true });
    if (!closePosition(acc, pos, quote.priceUsd, 'MANUAL', nativePrice)) {
      return fail(res, 409, 'Position already closed');
    }
    res.json({ ok: true, balanceNative: acc.balanceNative });
  } catch (error) { fail(res, 503, error.message); }
});

if (process.env.NODE_ENV !== 'test') {
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, challenge] of nonces) if (challenge.exp < now) nonces.delete(id);
    for (const [token, session] of sessions) if (session.exp < now) sessions.delete(token);
    for (const [id, entry] of authAttempts) if (entry.until < now) authAttempts.delete(id);
    for (const [id, intent] of tradeIntents) if (intent.expiresAt < now) tradeIntents.delete(id);
  }, 60000);
  cleanup.unref();
}

router.__test = { processOpenAccounts };
store.register('evm', () => ({ accounts }), value => { accounts = value.accounts || {}; });
store.register('evm_sessions', () => ({ sessions: Object.fromEntries(sessions) }), value => {
  sessions.clear();
  for (const [id, session] of Object.entries(value.sessions || {})) {
    if (session?.exp > Date.now() && validChain(session.chain) && isAddress(session.address || '')) sessions.set(id, session);
  }
});
router.adminAccounts = () => accounts;
router.identifySession = token => {
  const session = sessions.get(sessionKey(token));
  return session?.exp > Date.now() ? { wallet: session.address, chain: session.chain } : null;
};
module.exports = router;