const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeBase58, Wallet } = require('ethers');

// Isolate the whole server root, not just the ledger: beta-list data, EVM
// sessions, and log files must not touch the workspace during HTTP tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-solana-intents-'));
fs.mkdirSync(path.join(root, 'backend'));
for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.js'))) {
  fs.copyFileSync(path.join(__dirname, file), path.join(root, 'backend', file));
}
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), 'dir');
for (const file of ['admin.html', 'admin-login.html']) fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(root, file));
process.env.TESTNET_LEDGER_FILE = path.join(root, 'ledger.json');
process.env.EVM_SIMULATION_FILE = path.join(root, 'evm.json');
const wallet = () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    keys, address: encodeBase58(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    sign: message => crypto.sign(null, Buffer.from(message), keys.privateKey).toString('base64'),
  };
};
const trader = wallet();
const other = wallet();
const admin = wallet();
process.env.ADMIN_WALLET = admin.address;
const realFetch = global.fetch;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.dexscreener.com/')) return realFetch(url, options);
  const address = String(url).split('/').pop();
  return new Response(JSON.stringify({ pairs: [{
    chainId: 'solana', dexId: 'qa', pairAddress: address,
    baseToken: { address, symbol: address === SOL ? 'SOL' : 'QATEST', name: 'QA token' },
    quoteToken: { address: USDC, symbol: 'USDC' },
    priceUsd: address === SOL ? '100' : '1',
    liquidity: { usd: 1000000 }, marketCap: 1000000, priceChange: { h24: 0 },
  }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { app } = require(path.join(root, 'backend/server.js'));
let server, origin, token, otherToken, positionId, orderId;
async function call(route, body, auth = token) {
  const response = await realFetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function login(signer) {
  const nonce = await call('/api/testnet/auth/nonce', { walletAddress: signer.address }, '');
  assert.equal(nonce.status, 200);
  const response = await call('/api/testnet/auth/verify', {
    walletAddress: signer.address, message: nonce.body.message, signature: signer.sign(nonce.body.message),
  }, '');
  assert.equal(response.status, 200);
  return response.body.sessionToken;
}
async function proof(action, params, auth = token, signer = trader) {
  const response = await call('/api/testnet/actions/challenge', { action, params }, auth);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.walletAddress, signer.address);
  return { ...params, intentId: response.body.intentId, intentSignature: signer.sign(response.body.message) };
}
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  token = await login(trader);
  otherToken = await login(other);
});
test.after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('owner dashboard rejects strangers, proves owner signatures, and protects private HTML', async () => {
  assert.equal((await call('/api/admin/overview', undefined, '')).status, 401);
  const gate = await realFetch(`${origin}/admin`, { redirect: 'manual' });
  assert.equal(gate.status, 302);
  assert.equal(gate.headers.get('location'), '/admin/login');
  assert.equal((await realFetch(`${origin}/admin.html`)).status, 404);
  assert.equal((await call('/api/mainnet/admin/challenge', { walletAddress: trader.address }, '')).status, 403);
  const challenge = await call('/api/mainnet/admin/challenge', { walletAddress: admin.address }, '');
  const verified = await realFetch(`${origin}/api/mainnet/admin/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: admin.address, message: challenge.body.message, signature: admin.sign(challenge.body.message) }),
  });
  assert.equal(verified.status, 200);
  const { adminToken } = await verified.json();
  const cookie = verified.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  const page = await realFetch(`${origin}/admin`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/admin/overview', undefined, adminToken)).status, 200);
  const csrf = await realFetch(`${origin}/api/admin/trading`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0] },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(csrf.status, 403);
  assert.equal((await call('/api/admin/trading', { enabled: 'false' }, adminToken)).status, 400);
  assert.equal((await call('/api/admin/trading', { enabled: false }, adminToken)).status, 200);
  assert.equal((await call('/api/testnet/positions/open', { market: {} })).status, 423);
  assert.equal((await call('/api/testnet/actions/challenge', { action: 'open', params: {} })).status, 423);
  // Pausing new trading must not disable existing risk-management intents.
  assert.equal((await call('/api/testnet/actions/challenge', { action: 'close', params: { targetId: 'qa-position', closePct: 100 } })).status, 200);
  assert.equal((await call('/api/testnet/actions/challenge', { action: 'cancel', params: { targetId: 'qa-order' } })).status, 200);
  for (const chain of ['bsc', 'robinhood']) {
    const signer = Wallet.createRandom();
    const nonce = await call('/api/evm/auth/challenge', { chain, address: signer.address }, '');
    const evmLogin = await call('/api/evm/auth/verify', {
      chain, address: signer.address, message: nonce.body.message, signature: await signer.signMessage(nonce.body.message),
    }, '');
    assert.equal(evmLogin.status, 200);
    for (const route of ['/positions/open', '/orders']) {
      assert.equal((await call(`/api/evm${route}`, {}, evmLogin.body.token)).status, 423);
    }
  }
  assert.equal((await call('/api/admin/trading', { enabled: true }, adminToken)).status, 200);
  const exported = await call('/api/admin/export', undefined, adminToken);
  assert.equal(exported.body.format, 'memeperp-backup');
  assert.equal(exported.body.evm_sessions, undefined);
  assert.equal((await call('/api/admin/logout', {}, adminToken)).status, 200);
  assert.equal((await call('/api/admin/overview', undefined, adminToken)).status, 401);
});

test('visitor counts deduplicate heartbeats and count only verified signed-in wallets', async () => {
  const presence = { visitorId: crypto.randomUUID(), sessionId: crypto.randomUUID(), visitId: crypto.randomUUID(), path: '/', visible: true };
  assert.equal((await call('/api/site/presence', { ...presence, wallet: admin.address }, '')).status, 200);
  assert.equal((await call('/api/site/presence', presence, '')).status, 200);
  const metrics = require(path.join(root, 'backend/siteTelemetry.js'));
  let counts = await metrics.metrics();
  assert.equal(counts.totalVisits, 1);
  assert.equal(counts.liveVisitors, 1);
  assert.equal(counts.authenticatedLiveUsers, 0);
  assert.equal((await call('/api/site/presence', presence)).status, 200);
  counts = await metrics.metrics();
  assert.equal(counts.authenticatedLiveUsers, 1);
  await call('/api/site/presence', { ...presence, visible: false });
  assert.equal((await metrics.metrics()).liveVisitors, 0);
});

test('a valid login or arbitrary auditSig cannot authorize any financial mutation', async () => {
  for (const route of [
    '/balance/add', '/positions/open', '/positions/missing/close',
    '/orders/missing/cancel', '/position/tpsl', '/account/reset',
    '/account/migrate', '/positions/missing/liquidate',
  ]) {
    const response = await call(`/api/testnet${route}`, { amountSol: 1, auditSig: 'not-a-signature' });
    assert.equal(response.status, 403, route);
    assert.equal(response.body.code, 'ACTION_APPROVAL_REQUIRED');
  }
  const state = await call('/api/testnet/account/state');
  assert.equal(state.body.accountState.balanceSol, 0);
  assert.equal(state.body.accountState.positions.length, 0);
});

test('funding accepts a real approval and rejects replay, changed amount, and another session', async () => {
  const body = await proof('balance', { amountSol: 5 });
  const response = await call('/api/testnet/balance/add', body);
  assert.equal(response.status, 200);
  assert.equal(response.body.accountState.balanceSol, 5);
  assert.equal((await call('/api/testnet/balance/add', body)).status, 403);
  const changed = await proof('balance', { amountSol: 1 });
  assert.equal((await call('/api/testnet/balance/add', { ...changed, amountSol: 2 })).status, 403);
  const wrongSession = await proof('balance', { amountSol: 1 });
  assert.equal((await call('/api/testnet/balance/add', wrongSession, otherToken)).status, 403);
  const state = await call('/api/testnet/account/state');
  assert.equal(state.body.accountState.balanceSol, 5);
});

test('opens a real approved practice position and updates its approved TP/SL', async () => {
  const params = { market: { sym: 'QATEST', name: 'QA token', addr: USDC },
    side: 'long', marginSol: 1, leverage: 2, marginMode: 'isolated', orderType: 'market', tpSl: null };
  const opened = await call('/api/testnet/positions/open', await proof('open', params));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.accountState.positions.length, 1);
  positionId = opened.body.accountState.positions[0].id;
  const updated = await call('/api/testnet/position/tpsl',
    await proof('tpsl', { positionId, tpRoi: 20, tpQtyPct: 50 }));
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.position.tpSl.tpRoi, 20);
});

test('queues and cancels a limit order with separate verified approvals', async () => {
  const params = { market: { sym: 'QATEST', name: 'QA token', addr: USDC },
    side: 'long', marginSol: 0.2, leverage: 2, marginMode: 'isolated',
    orderType: 'limit', limitPrice: 0.5, tpSl: null };
  const opened = await call('/api/testnet/positions/open', await proof('open', params));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.queued, true);
  orderId = opened.body.accountState.openOrders[0].id;
  const body = await proof('cancel', { targetId: orderId });
  assert.equal((await call('/api/testnet/orders/different/cancel', body)).status, 403);
  const cancelled = await call(`/api/testnet/orders/${orderId}/cancel`, await proof('cancel', { targetId: orderId }));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.accountState.openOrders.length, 0);
});

test('reduces the exact approved percentage, closes the remainder, then resets with a new proof', async () => {
  const reduced = await call(`/api/testnet/positions/${positionId}/close`,
    await proof('close', { targetId: positionId, closePct: 25 }));
  assert.equal(reduced.status, 200, JSON.stringify(reduced.body));
  assert.equal(reduced.body.accountState.positions.length, 1);
  const closed = await call(`/api/testnet/positions/${positionId}/close`,
    await proof('close', { targetId: positionId, closePct: 100 }));
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.accountState.positions.length, 0);
  const reset = await call('/api/testnet/account/reset', await proof('reset', {}));
  assert.equal(reset.status, 200);
  assert.equal(reset.body.accountState.balanceSol, 0);
});

test('admin access verifies the exact case-sensitive public key and cannot reuse its challenge', async () => {
  assert.equal((await call('/api/mainnet/admin/challenge', { walletAddress: trader.address }, '')).status, 403);
  assert.equal((await call('/api/mainnet/beta/list', undefined, '')).status, 401);
  const challenge = await call('/api/mainnet/admin/challenge', { walletAddress: admin.address }, '');
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.walletAddress, admin.address);
  const body = { walletAddress: admin.address, message: challenge.body.message, signature: admin.sign(challenge.body.message) };
  const verified = await call('/api/mainnet/admin/verify', body, '');
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal((await call('/api/mainnet/beta/list', undefined, verified.body.adminToken)).status, 200);
  assert.equal((await call('/api/mainnet/admin/verify', body, '')).status, 400);
});