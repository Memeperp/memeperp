const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { selectDexScreenerPair } = require('./priceKeeper');

const ledgerFile = path.join(os.tmpdir(), `memeperp-tpsl-${process.pid}.json`);
process.env.TESTNET_LEDGER_FILE = ledgerFile;
const { __test: tpsl } = require('./server');

test.after(() => {
  for (const file of [ledgerFile, `${ledgerFile}.tmp`]) {
    try { fs.unlinkSync(file); } catch {}
  }
  delete process.env.TESTNET_LEDGER_FILE;
});

function accountWithPosition(position, price = 100) {
  const account = {
    walletAddress: 'wallet-test',
    balanceSol: 1,
    realizedPnlUsd: 0,
    realizedBasisUsd: 0,
    positions: [position],
    closedPositions: [],
    openOrders: [],
    history: [],
    balanceGrants: [],
  };
  tpsl.setDb({
    wallets: { 'wallet-test': account },
    markets: { ABC: { sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: price, maxLev: 10, oiCap: 10000 } },
    pools: {
      ABC: {
        sym: 'ABC', addr: 'TokenAddress123', liquidityUsd: 50000, reservedUsd: 500,
        longOpenInterestUsd: position.side === 'long' ? 500 : 0,
        shortOpenInterestUsd: position.side === 'short' ? 500 : 0,
        feeOpenBps: 10, feeCloseBps: 10, maintenanceMarginRatio: 0.06,
      },
    },
    meta: { solUsd: 100 },
  });
  return account;
}

function makePosition(side, tpSl) {
  return {
    id: `position-${side}`,
    walletOwner: 'wallet-test',
    sym: 'ABC',
    name: 'Alpha',
    addr: 'TokenAddress123',
    side,
    marginMode: 'isolated',
    margin: 0.5,
    marginUsd: 50,
    effectiveMarginUsd: 50,
    lev: 10,
    entry: 100,
    qty: 5,
    notional: 500,
    liq: side === 'long' ? 91 : 109,
    maintenanceMarginRatio: 0.06,
    tpSl,
    status: 'open',
    openedAt: new Date(0).toISOString(),
  };
}

test('TP/SL input validation rejects zero/invalid quantities and immediate triggers', () => {
  assert.equal(tpsl.validateTpSlInput({ tp: 110, tpQtyPct: 0 }).ok, false);
  assert.equal(tpsl.validateTpSlInput({ sl: 90, slQtyPct: 101 }).ok, false);
  assert.equal(tpsl.validateTpSlInput({ tp: 'NaN', tpQty: 1 }).ok, false);
  assert.equal(tpsl.validateTpSlInput({ slRoi: -10, slQtyPct: 100 }).ok, true);
  assert.equal(tpsl.validateTpSlInput({ slRoi: 0, slQtyPct: 100 }).ok, false);
  assert.equal(tpsl.validateTpSlInput({ slRoi: 10, slQtyPct: 100 }).ok, false);
  assert.equal(tpsl.validateQueuedTpSl({ slRoi: -10, slQtyPct: 100 }).ok, true);
  assert.equal(tpsl.validateQueuedTpSl({ tp: 110 }).code, 'TPSL_INCOMPLETE');
  assert.equal(tpsl.validateQueuedTpSl({ tp: 110, tpQtyPct: 100 }).ok, true,
    'a queued limit retains an absolute TP until its actual fill entry is known');

  const immediate = tpsl.validateTpSlForExecution({
    side: 'long', entryPrice: 100, leverage: 5, quantity: 2,
    tpSl: { tp: 99, tpQtyPct: 100 },
  });
  assert.equal(immediate.ok, false);
  assert.equal(immediate.code, 'TP_IMMEDIATE_TRIGGER');

  const missingQuantity = tpsl.validateTpSlForExecution({
    side: 'short', entryPrice: 100, leverage: 5, quantity: 2,
    tpSl: { slRoi: 20 },
  });
  assert.equal(missingQuantity.ok, false);
  assert.equal(missingQuantity.code, 'SL_QTY_REQUIRED');
  assert.equal(tpsl.validateTpSlForExecution({
    side: 'long', entryPrice: 100, leverage: 3, quantity: 2,
    tpSl: { tp: 110, tpQtyPct: 100, slQtyPct: 100 },
  }).code, 'SL_TRIGGER_REQUIRED');
});

test('a triggered partial TP records only the closed slice and releases the same OI/margin slice', () => {
  const account = accountWithPosition(makePosition('long', {
    tp: null, tpRoi: 20, tpQtyPct: 50, sl: null, slRoi: null,
  }));

  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 102 }], 100);

  const current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.positions.length, 1);
  assert.equal(current.positions[0].qty, 2.5);
  assert.equal(current.positions[0].margin, 0.25);
  assert.equal(current.positions[0].notional, 250);
  assert.equal(current.positions[0].tpSl.tp, null, 'one-shot TP must be cleared after firing');

  assert.equal(current.closedPositions.length, 1);
  assert.equal(current.closedPositions[0].positionId, 'position-long');
  assert.notEqual(current.closedPositions[0].id, 'position-long');
  assert.equal(current.closedPositions[0].quantity, 2.5);
  assert.equal(current.closedPositions[0].marginSol, 0.25);
  assert.equal(current.closedPositions[0].reason, 'TP');
  assert.equal(current.closedPositions[0].exitPrice, 102);
  assert.ok(current.closedPositions[0].pnlUsd > 0);
  assert.equal(current.history[0].type, 'TP');
  assert.equal(current.history[0].chainStatus, 'recorded', 'simulator audit references must not be reported as chain submissions');

  const pool = tpsl.getDb().pools.ABC;
  assert.equal(pool.reservedUsd, 250);
  assert.equal(pool.longOpenInterestUsd, 250);
});

test('a retained absolute SL closes at most the quantity remaining after a partial TP', () => {
  accountWithPosition(makePosition('long', {
    tp: 102, tpQtyPct: 50, sl: 90, slQty: 5,
  }));
  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 102 }], 100);
  let current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.positions[0].qty, 2.5);
  assert.equal(current.positions[0].tpSl.tp, null);
  assert.equal(current.positions[0].tpSl.slQty, 5);

  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 90 }], 100);
  current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.positions.length, 0);
  assert.equal(current.closedPositions.length, 2);
  assert.equal(current.closedPositions[0].reason, 'SL');
  assert.equal(current.closedPositions[0].quantity, 2.5);
  assert.equal(tpsl.getDb().pools.ABC.reservedUsd, 0);
});

test('a short SL trigger closes the full legacy position and persists activity and a closed trade', () => {
  accountWithPosition(makePosition('short', { sl: 110 }));

  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 111 }], 100);

  const current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.positions.length, 0);
  assert.equal(current.closedPositions.length, 1);
  assert.equal(current.closedPositions[0].side, 'short');
  assert.equal(current.closedPositions[0].quantity, 5);
  assert.equal(current.closedPositions[0].marginSol, 0.5);
  assert.equal(current.closedPositions[0].reason, 'SL');
  assert.equal(current.closedPositions[0].exitPrice, 111);
  assert.equal(current.history[0].type, 'SL');
  assert.equal(tpsl.getDb().pools.ABC.reservedUsd, 0);
});

test('adding to a position revalidates stored absolute TP/SL at the combined entry before debiting balance', () => {
  const account = accountWithPosition(makePosition('long', { tp: 105, tpQtyPct: 100 }));
  const pool = tpsl.getDb().pools.ABC;
  const balanceBefore = account.balanceSol;
  const reservedBefore = pool.reservedUsd;

  const result = tpsl.applyOpenPositionToAccount({
    account,
    observedMarket: { sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123' },
    pool,
    side: 'long',
    marginMode: 'isolated',
    marginSol: 0.5,
    leverage: 12,
    limitPrice: null,
    tpSl: null,
    auditSig: 'signed-intent',
    quote: {
      executionPrice: 120, quantity: 5, marginUsd: 50, notionalUsd: 600,
      feeSol: 0.01, feeUsd: 1, totalPremiumPct: 0.1,
      liqPrice: 100, maintenanceMarginRatio: 0.06, effectiveMarginUsd: 50,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TP_IMMEDIATE_TRIGGER');
  assert.equal(account.balanceSol, balanceBefore);
  assert.equal(pool.reservedUsd, reservedBefore);
  assert.equal(account.positions.length, 1);
  assert.equal(account.positions[0].entry, 100);
});

test('ROI-only settings stay relative to the combined position leverage when adding size', () => {
  const position = makePosition('short', { tpRoi: 1000, tpQtyPct: 100 });
  position.margin = 1;
  position.marginUsd = 100;
  position.effectiveMarginUsd = 100;
  position.lev = 5;
  const account = accountWithPosition(position);
  const pool = tpsl.getDb().pools.ABC;

  const result = tpsl.applyOpenPositionToAccount({
    account,
    observedMarket: { sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123' },
    pool,
    side: 'short',
    marginMode: 'isolated',
    marginSol: 0.5,
    leverage: 40,
    limitPrice: null,
    tpSl: null,
    auditSig: 'signed-intent',
    quote: {
      executionPrice: 100, quantity: 20, marginUsd: 50, notionalUsd: 2000,
      feeSol: 0.02, feeUsd: 2, totalPremiumPct: 0.1,
      liqPrice: 110, maintenanceMarginRatio: 0.06, effectiveMarginUsd: 50,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(account.positions[0].lev, 2500 / 150);
  assert.equal(account.positions[0].tpSl.tpRoi, 1000, 'ROI trigger must remain ROI-based instead of becoming a stale absolute price');
});

test('a negative SL ROI from the form is accepted and closes at the loss threshold', () => {
  accountWithPosition(makePosition('long', { slRoi: -10, slQtyPct: 100 }));
  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 99 }], 100);
  const current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.positions.length, 0);
  assert.equal(current.closedPositions[0].reason, 'SL');
});

test('automatic polling observes fresh keeper prices and ignores stale prices', () => {
  accountWithPosition(makePosition('long', { tp: 102, tpQtyPct: 100 }), 102);
  tpsl.getDb().markets.ABC.updatedAt = new Date().toISOString();
  assert.equal(tpsl.runAutomaticOrderChecks(), true);
  assert.equal(tpsl.getDb().wallets['wallet-test'].positions.length, 0);

  accountWithPosition(makePosition('long', { tp: 102, tpQtyPct: 100 }), 102);
  tpsl.getDb().markets.ABC.updatedAt = new Date(0).toISOString();
  assert.equal(tpsl.runAutomaticOrderChecks(), false);
  assert.equal(tpsl.getDb().wallets['wallet-test'].positions.length, 1);
});

test('persisted pending orders retain TP/SL settings for validation and fill', () => {
  const order = tpsl.sanitizeOpenOrder({
    id: 'limit-1', sym: 'ABC', side: 'long', marginSol: 0.1, leverage: 3,
    limitPrice: 90, tpSl: { tpRoi: 30, tpQtyPct: 100 },
  }, 'wallet-test');
  assert.deepEqual(order.tpSl, {
    tp: null, tpRoi: 30, sl: null, slRoi: null,
    tpQty: null, tpQtyPct: 100, slQty: null, slQtyPct: null,
  });
});

test('a limit order is explicitly cancelled when its absolute trigger is invalid at fill', () => {
  const account = {
    walletAddress: 'wallet-test',
    balanceSol: 1,
    realizedPnlUsd: 0,
    realizedBasisUsd: 0,
    positions: [],
    closedPositions: [],
    openOrders: [{
      id: 'limit-invalid-tp',
      walletOwner: 'wallet-test',
      sym: 'ABC',
      name: 'Alpha',
      addr: 'TokenAddress123',
      side: 'long',
      marginMode: 'isolated',
      marginSol: 0.1,
      leverage: 3,
      limitPrice: 100,
      auditSig: 'signed-intent',
      tpSl: { tp: 85, tpQtyPct: 100 },
    }],
    history: [],
    balanceGrants: [],
  };
  tpsl.setDb({
    wallets: { 'wallet-test': account },
    markets: { ABC: { sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 90, updatedAt: new Date().toISOString() } },
    pools: { ABC: { sym: 'ABC', addr: 'TokenAddress123', liquidityUsd: 50000, reservedUsd: 0, feeOpenBps: 10 } },
    meta: { solUsd: 100 },
  });

  assert.equal(tpsl.processPendingLimitOrders(), true);
  const current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.openOrders.length, 0);
  assert.equal(current.positions.length, 0);
  assert.equal(current.balanceSol, 1);
  assert.equal(current.history[0].type, 'ORDER_CANCELLED');
  assert.match(current.history[0].msg, /TP\/SL is invalid at fill.*TP_IMMEDIATE_TRIGGER/);
});

test('a filled limit order persists its TP/SL onto the new open position', () => {
  const account = {
    walletAddress: 'wallet-test',
    balanceSol: 1,
    realizedPnlUsd: 0,
    realizedBasisUsd: 0,
    positions: [],
    closedPositions: [],
    openOrders: [{
      id: 'limit-fill',
      walletOwner: 'wallet-test',
      sym: 'ABC',
      name: 'Alpha',
      addr: 'TokenAddress123',
      side: 'long',
      marginMode: 'isolated',
      marginSol: 0.1,
      leverage: 3,
      limitPrice: 100,
      auditSig: 'recorded-intent',
      tpSl: { tpRoi: 30, tpQtyPct: 100 },
    }],
    history: [],
    balanceGrants: [],
  };
  tpsl.setDb({
    wallets: { 'wallet-test': account },
    markets: { ABC: { sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 110, maxLev: 10, oiCap: 10000 } },
    pools: { ABC: { sym: 'ABC', addr: 'TokenAddress123', liquidityUsd: 50000, reservedUsd: 0, feeOpenBps: 10 } },
    meta: { solUsd: 100 },
  });

  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 90 }], 100);

  const current = tpsl.getDb().wallets['wallet-test'];
  assert.equal(current.openOrders.length, 0);
  assert.equal(current.positions.length, 1);
  assert.equal(current.positions[0].entry, 90);
  assert.equal(current.positions[0].tpSl.tpRoi, 30);
  assert.equal(current.positions[0].tpSl.tpQtyPct, 100);

  tpsl.syncObservedMarkets([{ sym: 'ABC', name: 'Alpha', addr: 'TokenAddress123', px: 99 }], 100);
  assert.equal(tpsl.getDb().wallets['wallet-test'].positions.length, 0);
  assert.equal(tpsl.getDb().wallets['wallet-test'].closedPositions[0].exitPrice, 99);
});

test('price keeper selects the highest-liquidity pair for the matching Solana base mint only', () => {
  const selected = selectDexScreenerPair([
    { chainId: 'ethereum', baseToken: { address: 'TokenAddress123' }, priceUsd: '999', liquidity: { usd: 900000 } },
    { chainId: 'solana', baseToken: { address: 'DifferentMint' }, priceUsd: '500', liquidity: { usd: 800000 } },
    { chainId: 'solana', baseToken: { address: 'TokenAddress123' }, priceUsd: '1.25', liquidity: { usd: 1000 } },
    { chainId: 'solana', baseToken: { address: 'tokenaddress123' }, priceUsd: '1.5', liquidity: { usd: 3000 } },
    { chainId: 'solana', baseToken: { address: 'TokenAddress123' }, priceUsd: 'NaN', liquidity: { usd: 9000 } },
  ], 'TokenAddress123');

  assert.equal(selected.priceUsd, '1.5');
  assert.equal(selectDexScreenerPair([], 'TokenAddress123'), null);
});