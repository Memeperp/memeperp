const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-rpc-policy-'));
process.env.NODE_ENV = 'test';
process.env.TESTNET_LEDGER_FILE = path.join(dir, 'solana-ledger.json');
process.env.EVM_SIMULATION_FILE = path.join(dir, 'evm-ledger.json');
process.env.RPC_URL = 'https://rpc.test.invalid';
// Server imports must never read shared accounts or start automatic keepers.
const originalSetInterval = global.setInterval;
let app;
try {
  global.setInterval = () => ({ unref() {} });
  ({ app } = require('./server'));
} finally {
  global.setInterval = originalSetInterval;
}

test('mainnet RPC forwards only explicit read-only JSON-RPC methods and rejects write payloads before upstream', async t => {
  const originalFetch = global.fetch;
  const upstreamCalls = [];
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    global.fetch = originalFetch;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  global.fetch = async (url, options) => {
    upstreamCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }); },
    };
  };
  const endpoint = `http://127.0.0.1:${server.address().port}/api/mainnet/provider/rpc`;
  const send = async payload => {
    const response = await originalFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, data: await response.json() };
  };

  const read = await send({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0xabc', 'latest'] });
  assert.equal(read.status, 200);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, process.env.RPC_URL);
  const solanaReadMethods = [
    'getBalance', 'getTokenAccountsByOwner', 'getTokenAccountBalance',
    'getSlot', 'getSignatureStatuses', 'getVersion',
  ];
  for (const method of solanaReadMethods) {
    const payload = { jsonrpc: '2.0', id: 20, method, params: [] };
    assert.equal((await send(payload)).status, 200, `Solana read ${method} must work`);
    assert.deepEqual(JSON.parse(upstreamCalls.at(-1).options.body), payload);
  }
  const allowedCount = upstreamCalls.length;

  const denied = [
    { jsonrpc: '2.0', id: 0, method: 'sendTransaction', params: ['fixture'] },
    { jsonrpc: '2.0', id: 0, method: 'requestAirdrop', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction', params: [{}] },
    { jsonrpc: '2.0', id: 3, method: 'eth_signTransaction', params: [{}] },
    { jsonrpc: '2.0', id: 4, method: 'eth_sendRawTransaction', params: ['0xdead'] },
    { jsonrpc: '2.0', id: 5, method: 'eth_sign', params: ['0xabc', '0xdead'] },
    { jsonrpc: '2.0', id: 6, method: 'personal_sign', params: ['0xdead', '0xabc'] },
    { jsonrpc: '2.0', id: 7, method: 'eth_signTypedData_v4', params: [] },
    { jsonrpc: '2.0', id: 8, method: 'eth_sendUserOperation', params: [] },
    { jsonrpc: '2.0', id: 9, method: 'eth_coinbase', params: [] },
    [{ jsonrpc: '2.0', id: 10, method: 'eth_blockNumber' }],
    { jsonrpc: '1.0', id: 11, method: 'eth_blockNumber' },
    { id: 12, method: 'eth_blockNumber' },
    { jsonrpc: '2.0', method: 'eth_blockNumber' },
    { jsonrpc: '2.0', id: 13, method: 'eth_blockNumber', params: null },
    { jsonrpc: '2.0', id: 14, method: 'eth_blockNumber', unexpected: true },
  ];
  for (const payload of denied) {
    const response = await send(payload);
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(payload)}`);
  }
  assert.equal(upstreamCalls.length, allowedCount, 'rejected methods must never reach configured upstream');
});