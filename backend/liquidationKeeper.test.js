const test = require('node:test');
const assert = require('node:assert/strict');
const { startLiquidationKeeper } = require('./liquidationKeeper');

test('server keeper records one liquidation across repeated checks', async () => {
  const originalSetInterval = global.setInterval;
  const signalListeners = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };
  let tick;
  global.setInterval = (callback) => {
    tick = callback;
    return null;
  };

  const account = {
    walletAddress: 'wallet-example',
    balanceSol: 0,
    positions: [{
      id: 'position-1',
      side: 'long',
      sym: 'EXAMPLE',
      entry: 2,
      qty: 10,
      liq: 1,
      margin: 1,
      marginUsd: 10,
      notional: 20,
    }],
    history: [],
  };
  const ledger = {
    wallets: { 'wallet-example': account },
    markets: { EXAMPLE: { sym: 'EXAMPLE', px: 0.9 } },
    pools: {},
    meta: { solUsd: 100 },
  };

  try {
    startLiquidationKeeper({
      ledger,
      onLiquidated: (wallet, position) => {
        wallet.history.push({ type: 'LIQ', positionId: position.id });
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    await tick();
    await tick();
    assert.equal(account.positions.length, 0);
    assert.equal(ledger.liquidations.length, 1);
    assert.deepEqual(account.history, [{ type: 'LIQ', positionId: 'position-1' }]);
  } finally {
    global.setInterval = originalSetInterval;
    for (const signal of Object.keys(signalListeners)) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});