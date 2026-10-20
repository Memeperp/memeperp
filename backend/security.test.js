const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeBase58, Wallet } = require('ethers');
const { ExpiringMap, securityHeaders } = require('./security');

test('authentication stores expire entries without evicting active proofs or rate limits', () => {
  let time = 10;
  const map = new ExpiringMap({ deadline: 'exp', maxSize: 2, now: () => time });
  map.set('first', { exp: 20 });
  map.set('second', { exp: 30 });
  assert.throws(() => map.set('third', { exp: 40 }), error => error.status === 429);
  assert.equal(map.get('second').exp, 30);
  time = 21;
  map.set('third', { exp: 40 });
  assert.equal(map.size, 2);
  assert.equal(map.get('first'), undefined);
  assert.equal(map.get('third').exp, 40);
});

test('production headers restrict framing and plugins without blocking development embeds', () => {
  for (const production of [true, false]) {
    const headers = {};
    securityHeaders(production)({ path: '/api/testnet/account/state' }, {
      set: (key, value) => { headers[key] = value; },
    }, () => {});
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.ok(headers['Content-Security-Policy'].includes("object-src 'none'"));
    assert.equal(headers['X-Frame-Options'], production ? 'DENY' : undefined);
    assert.equal(headers['Content-Security-Policy'].includes('frame-ancestors'), production);
    assert.equal(Boolean(headers['Strict-Transport-Security']), production);
  }
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-security-'));
fs.cpSync(__dirname, path.join(root, 'backend'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '..', 'node_modules'), path.join(root, 'node_modules'), 'dir');
process.env.NODE_ENV = 'test';
process.env.TESTNET_LEDGER_FILE = path.join(root, 'solana.json');
process.env.EVM_SIMULATION_FILE = path.join(root, 'evm.json');
const keys = crypto.generateKeyPairSync('ed25519');
const address = encodeBase58(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const sign = message => crypto.sign(null, Buffer.from(message), keys.privateKey).toString('base64');
process.env.ADMIN_WALLET = address;
const realFetch = global.fetch;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let gate, release, ready, quoteRequests = 0;
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.dexscreener.com/')) return realFetch(url, options);
  if (gate) {
    if (++quoteRequests === 4) ready();
    await gate;
  }
  const token = String(url).split('/').pop();
  return new Response(JSON.stringify({ pairs: [{
    chainId: 'solana', baseToken: { address: token, symbol: token === SOL ? 'SOL' : 'QASEC', name: 'Security fixture' },
    quoteToken: { address: USDC }, priceUsd: token === SOL ? '100' : '1',
    liquidity: { usd: 1000000 },
  }] }), { status: 200 });
};
const { app } = require(path.join(root, 'backend/server.js'));
let server, origin, token;
async function call(route, body, auth = token) {
  const response = await realFetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function proof(action, params) {
  const result = await call('/api/testnet/actions/challenge', { action, params });
  assert.equal(result.status, 200);
  return { ...params, intentId: result.body.intentId, intentSignature: sign(result.body.message) };
}
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  release?.();
  global.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('malformed bodies do not expose stack traces or parser input; APIs are not cached', async () => {
  const response = await realFetch(origin + '/api/mainnet/beta/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private_input":',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid request' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  const oversized = await realFetch(origin + '/api/mainnet/beta/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1100000) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'Request body is too large' });
});

test('markup signup payloads and private workspace files are rejected', async () => {
  assert.equal((await call('/api/mainnet/beta/join', { email: '<svg/onload=alert(1)>@example.invalid' }, '')).status, 400);
  for (const route of ['/.data/testnet-shared-ledger.json', '/.local/backups/private.json', '/backend/server.js', '/admin.html', '/.env']) {
    assert.equal((await realFetch(origin + route)).status, 404);
  }
  assert.equal((await call('/api/admin/export', undefined, '')).status, 401);
});

test('two genuine wallet-approved closes cannot credit the same Solana position twice', async () => {
  const nonce = await call('/api/testnet/auth/nonce', { walletAddress: address }, '');
  const login = await call('/api/testnet/auth/verify', {
    walletAddress: address, message: nonce.body.message, signature: sign(nonce.body.message),
  }, '');
  assert.equal(login.status, 200);
  token = login.body.sessionToken;
  assert.equal((await call('/api/testnet/balance/add', await proof('balance', { amountSol: 2 }))).status, 200);
  const opened = await call('/api/testnet/positions/open', await proof('open', {
    market: { addr: USDC }, marginSol: 0.1, leverage: 1, side: 'long', orderType: 'market',
  }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const params = { targetId: opened.body.accountState.positions[0].id, closePct: 100 };
  const proofs = [await proof('close', params), await proof('close', params)];
  const started = new Promise(resolve => { ready = resolve; });
  gate = new Promise(resolve => { release = resolve; });
  const pending = Promise.all(proofs.map(body => call(`/api/testnet/positions/${params.targetId}/close`, body)));
  let timeout;
  try {
    await Promise.race([started, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Both closes did not reach the quote barrier')), 5000);
    })]);
  } finally { clearTimeout(timeout); release(); gate = null; }
  const results = await pending;
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const stateResult = await call('/api/testnet/account/state');
  assert.equal(stateResult.status, 200);
  const state = stateResult.body.accountState;
  assert.equal(state.positions.length, 0);
  assert.equal(state.closedPositions.length, 1);
  assert.equal(state.history.filter(row => row.type === 'CLOSE').length, 1);
  assert.ok(state.balanceSol <= 2);
});

test('another Solana challenge cannot invalidate an already-issued login; proofs remain single-use', async () => {
  const first = await call('/api/testnet/auth/nonce', { walletAddress: address }, '');
  const second = await call('/api/testnet/auth/nonce', { walletAddress: address }, '');
  assert.notEqual(first.body.message, second.body.message);
  const body = { walletAddress: address, message: first.body.message, signature: sign(first.body.message) };
  assert.equal((await call('/api/testnet/auth/verify', body, '')).status, 200);
  assert.equal((await call('/api/testnet/auth/verify', body, '')).status, 400);
});

test('another owner challenge cannot invalidate an in-progress owner approval', async () => {
  const first = await call('/api/mainnet/admin/challenge', { walletAddress: address }, '');
  await call('/api/mainnet/admin/challenge', { walletAddress: address }, '');
  const body = { walletAddress: address, message: first.body.message, signature: sign(first.body.message) };
  assert.equal((await call('/api/mainnet/admin/verify', body, '')).status, 200);
  assert.equal((await call('/api/mainnet/admin/verify', body, '')).status, 400);
});

test('another EVM challenge cannot replace a pending signed login and cannot replay it', async () => {
  const wallet = Wallet.createRandom(), params = { chain: 'bsc', address: wallet.address };
  const first = await call('/api/evm/auth/challenge', params, '');
  await call('/api/evm/auth/challenge', params, '');
  const body = { ...params, message: first.body.message, signature: await wallet.signMessage(first.body.message) };
  assert.equal((await call('/api/evm/auth/verify', body, '')).status, 200);
  assert.equal((await call('/api/evm/auth/verify', body, '')).status, 401);
});