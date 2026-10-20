const test = require('node:test');
const assert = require('node:assert/strict');
const approvals = require('./solanaApprovals');
const safety = require('./walletSafety');

const address = 'Ds9QomXL4wHoFxXPXDFzdvaiNZqwgk352DhYC1FC4mG5';
function fixture() {
  const state = {
    address, token: 'session-a', chain: 'solana', connected: true,
    provider: { publicKey: { toString: () => address }, isConnected: true },
  };
  const dependencies = {
    getState: () => state,
    issueChallenge: async ({ action, params }) => ({
      action, chain: 'solana', walletAddress: address,
      intentId: '12345678-1234-1234-1234-123456789abc',
      message: [
        'MemePerp Testnet Confirm CLOSE OR REDUCE POSITION',
        'Chain: solana', `Wallet: ${address}`,
        `Parameters: ${JSON.stringify(params)}`,
        'Nonce: 12345678-1234-1234-1234-123456789abc',
        'Expires At: 2026-10-03T22:00:00.000Z',
        'Simulated action only. No on-chain transaction or wallet funds transfer.',
      ].join('\n'),
    }),
    signMessage: async (_provider, message) => {
      safety.solanaMessageBytes(message);
      return { signature: new Uint8Array(64).fill(1) };
    },
  };
  return { state, dependencies };
}

test('adds one exact, readable action approval with the URL target and original session', async () => {
  const { dependencies } = fixture();
  const approved = await approvals.authorize('/positions/position-a/close', { closePct: 25 }, dependencies);
  assert.equal(approved.token, 'session-a');
  assert.equal(approved.body.targetId, 'position-a');
  assert.equal(approved.body.closePct, 25);
  assert.equal(Buffer.from(approved.body.intentSignature, 'base64').length, 64);
});

for (const [name, change] of [
  ['account', state => { state.address = 'different'; }],
  ['network', state => { state.chain = 'bsc'; }],
  ['session', state => { state.token = 'session-b'; }],
  ['provider', state => { state.provider = {}; }],
  ['disconnect', state => { state.connected = false; }],
  ['case-sensitive public key', state => { state.provider.publicKey = { toString: () => address.toLowerCase() }; }],
]) {
  test(`cancels if the ${name} changes while the wallet is approving`, async () => {
    const { state, dependencies } = fixture();
    dependencies.signMessage = async () => {
      change(state);
      return { signature: new Uint8Array(64).fill(1) };
    };
    await assert.rejects(approvals.authorize('/balance/add', { amountSol: 1 }, dependencies), /changed during approval/);
  });
}

test('never prompts the wallet after the account changes during challenge retrieval', async () => {
  const { state, dependencies } = fixture();
  const original = dependencies.issueChallenge;
  let prompted = false;
  dependencies.issueChallenge = async args => {
    const result = await original(args);
    state.token = 'different';
    return result;
  };
  dependencies.signMessage = async () => { prompted = true; };
  await assert.rejects(approvals.authorize('/account/reset', {}, dependencies), /changed during approval/);
  assert.equal(prompted, false);
});

test('rejects cancelled signing, malformed signatures, and a challenge for another wallet', async () => {
  const { dependencies } = fixture();
  dependencies.signMessage = async () => { throw new Error('User rejected'); };
  await assert.rejects(approvals.authorize('/balance/add', { amountSol: 1 }, dependencies), /User rejected/);
  dependencies.signMessage = async () => ({ signature: new Uint8Array(3) });
  await assert.rejects(approvals.authorize('/balance/add', { amountSol: 1 }, dependencies), /valid approval signature/);
  dependencies.issueChallenge = async () => ({ walletAddress: 'other', action: 'balance', chain: 'solana' });
  await assert.rejects(approvals.authorize('/balance/add', { amountSol: 1 }, dependencies), /does not match/);
});

test('freezes submitted parameters before asynchronous approval', async () => {
  const { dependencies } = fixture();
  const body = { amountSol: 1 };
  const original = dependencies.issueChallenge;
  dependencies.issueChallenge = async args => { body.amountSol = 9; return original(args); };
  const approved = await approvals.authorize('/balance/add', body, dependencies);
  assert.equal(approved.body.amountSol, 1);
});

test('recognizes each financial mutation but never signs login, reads, or quotes', () => {
  for (const path of ['/positions/open', '/positions/a/close', '/orders/a/cancel',
    '/position/tpsl', '/balance/add', '/account/reset', '/account/migrate', '/positions/a/liquidate']) {
    assert.ok(approvals.routeAction(path), path);
  }
  for (const path of ['/auth/verify', '/account/state', '/trade/quote', '/actions/challenge']) {
    assert.equal(approvals.routeAction(path), null, path);
  }
});