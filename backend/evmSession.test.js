const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Wallet } = require('ethers');

test('EVM sign-in survives a server restart without writing bearer tokens to disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-session-'));
  process.env.NODE_ENV = 'test';
  process.env.EVM_SIMULATION_FILE = path.join(dir, 'ledger.json');
  const modulePath = require.resolve('./evmSimulation');
  const servers = [];
  const start = async () => {
    delete require.cache[modulePath];
    const app = express();
    app.use(express.json());
    app.use('/api/evm', require('./evmSimulation'));
    const server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/api/evm`;
  };
  const request = async (base, route, body, token) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const wallet = Wallet.createRandom();
    const first = await start();
    const login = await request(first, '/auth/challenge', { chain: 'bsc', address: wallet.address });
    assert.equal(login.status, 200);
    const verified = await request(first, '/auth/verify', {
      chain: 'bsc', address: wallet.address, message: login.data.message,
      signature: await wallet.signMessage(login.data.message),
    });
    assert.equal(verified.status, 200);
    const token = verified.data.token;
    const saved = fs.readFileSync(`${process.env.EVM_SIMULATION_FILE}.sessions`, 'utf8');
    assert.ok(!saved.includes(token), 'raw bearer token must not be stored');
    const rebooted = await start();
    assert.equal((await request(rebooted, '/auth/order-intent', { action: 'invalid', order: {} }, token)).status, 400);
    assert.equal((await request(rebooted, '/auth/order-intent', { action: 'invalid', order: {} }, 'invalid')).status, 401);
    assert.equal((await request(rebooted, '/auth/logout', {}, token)).status, 200);
    assert.equal((await request(rebooted, '/auth/order-intent', { action: 'invalid', order: {} }, token)).status, 401);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});