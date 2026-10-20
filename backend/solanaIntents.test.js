const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encodeBase58 } = require('ethers');
const { createSolanaIntents } = require('./solanaIntents');

function fixture() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const address = encodeBase58(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  let clock = Date.now();
  const service = createSolanaIntents({
    now: () => clock,
    verifySignature: (wallet, message, signature) => wallet === address &&
      crypto.verify(null, Buffer.from(message), keys.publicKey, Buffer.from(signature || '', 'base64')),
  });
  const request = body => ({
    sessionToken: 'session-a', walletAddress: address.toLowerCase(),
    signingAddress: address, params: {}, body,
  });
  const response = () => ({
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  function issue(action, params) {
    const res = response();
    service.issue(request({ action, params }), res);
    assert.equal(res.statusCode, 200);
    const challenge = res.body;
    return {
      ...params, intentId: challenge.intentId,
      intentSignature: crypto.sign(null, Buffer.from(challenge.message), keys.privateKey).toString('base64'),
    };
  }
  function submit(action, body, overrides = {}) {
    const req = { ...request(body), ...overrides };
    const res = response();
    let accepted = false;
    service.requireAction(action)(req, res, () => { accepted = true; });
    return { accepted, req, res };
  }
  return { address, service, request, response, issue, submit, expire: () => { clock += 120001; } };
}

test('accepts a real Ed25519 approval once and replaces untrusted audit references', () => {
  const f = fixture();
  const body = f.issue('balance', { amountSol: 1 });
  const result = f.submit('balance', { ...body, auditSig: 'not-a-signature' });
  assert.equal(result.accepted, true);
  assert.equal(result.req.body.auditSig, `SIM:${body.intentSignature}`);
  assert.equal(f.submit('balance', body).res.statusCode, 403);
});

for (const [name, modify, override] of [
  ['missing proof', () => ({ amountSol: 1 })],
  ['fake signature', body => ({ ...body, intentSignature: Buffer.alloc(64).toString('base64') })],
  ['changed amount', body => ({ ...body, amountSol: 2 })],
  ['wrong session', body => body, { sessionToken: 'session-b' }],
  ['wrong ledger wallet', body => body, { walletAddress: 'different-wallet' }],
  ['changed case-sensitive signing wallet', body => body, { signingAddress: 'different-public-key' }],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture();
    const result = f.submit('balance', modify(f.issue('balance', { amountSol: 1 })), override);
    assert.equal(result.accepted, false);
    assert.equal(result.res.statusCode, 403);
  });
}

test('expires approvals and revokes them on logout', () => {
  const f = fixture();
  const expired = f.issue('reset', {});
  f.expire();
  assert.equal(f.submit('reset', expired).accepted, false);
  const revoked = f.issue('reset', {});
  f.service.revoke('session-a');
  assert.equal(f.submit('reset', revoked).accepted, false);
});

test('rejects a different action and a different URL target', () => {
  const f = fixture();
  assert.equal(f.submit('reset', f.issue('balance', { amountSol: 1 })).accepted, false);
  const close = f.issue('close', { targetId: 'position-a', closePct: 25 });
  assert.equal(f.submit('close', close, { params: { id: 'position-b' } }).accepted, false);
});

test('binds every submitted opening field, including nested TP/SL values', () => {
  const f = fixture();
  const params = {
    market: { sym: 'QA', addr: f.address, name: 'QA token' },
    side: 'long', marginSol: 1, leverage: 2, marginMode: 'isolated',
    orderType: 'limit', limitPrice: 0.9, tpSl: { tpRoi: 20, tpQtyPct: 50 },
  };
  for (const field of Object.keys(params)) {
    const changed = typeof params[field] === 'object'
      ? { ...params[field], [field === 'market' ? 'addr' : 'tpQtyPct']: 'changed' }
      : typeof params[field] === 'number' ? params[field] + 1 : 'changed';
    assert.equal(f.submit('open', { ...f.issue('open', params), [field]: changed }).accepted, false, field);
  }
});

test('JSON object key order does not invalidate the same approved parameters', () => {
  const f = fixture();
  const body = f.issue('open', { market: { addr: f.address, sym: 'QA' }, marginSol: 1 });
  assert.equal(f.submit('open', { ...body, market: { sym: 'QA', addr: f.address } }).accepted, true);
});

test('all other action parameters are bound to the signature', () => {
  const f = fixture();
  for (const [action, params, changed] of [
    ['close', { targetId: 'a', closePct: 25 }, { targetId: 'a', closePct: 100 }],
    ['cancel', { targetId: 'a' }, { targetId: 'b' }],
    ['tpsl', { positionId: 'a', tpRoi: 20 }, { positionId: 'a', tpRoi: 30 }],
    ['migrate', { snapshot: { balanceSol: 1 } }, { snapshot: { balanceSol: 2 } }],
    ['liquidate', { targetId: 'a' }, { targetId: 'b' }],
  ]) {
    assert.equal(f.submit(action, { ...f.issue(action, params), ...changed }).accepted, false, action);
  }
});

test('rejects unsupported actions and limits pending confirmations', () => {
  const f = fixture();
  let res = f.response();
  f.service.issue(f.request({ action: 'unsupported', params: {} }), res);
  assert.equal(res.statusCode, 400);
  for (let i = 0; i < 10; i++) f.issue('reset', {});
  res = f.response();
  f.service.issue(f.request({ action: 'reset', params: {} }), res);
  assert.equal(res.statusCode, 429);
});