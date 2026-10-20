const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Wallet } = require('ethers');

test('EVM simulated collateral is native-denominated, migrated atomically, and chain isolated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-evm-'));
  process.env.EVM_SIMULATION_FILE = path.join(dir, 'ledger.json');
  process.env.NODE_ENV = 'test';
  const tokenAddress = '0x1111111111111111111111111111111111111111';
  const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  const originalFetch = global.fetch;
  let tokenPrice = 100;
  let ethPrice = 2000;
  let liquidity = 100000;
  let ethOracleAvailable = false;
  let bnbPrice = 500;
  let heldTokenFetches = 0;
  const releaseTokenFetches = [];
  global.fetch = async (url, options) => {
    const uri = String(url);
    if (uri.startsWith('https://api.dexscreener.com/')) {
      if (uri.toLowerCase().includes(tokenAddress.toLowerCase()) && heldTokenFetches > 0) {
        heldTokenFetches--;
        await new Promise(resolve => releaseTokenFetches.push(resolve));
      }
      if (uri.toLowerCase().includes(wethAddress.toLowerCase())) {
        return { ok: true, json: async () => ({ pairs: ethOracleAvailable ? [
          { chainId: 'ethereum', baseToken: { address: wethAddress, symbol: 'WETH' }, priceUsd: String(ethPrice), liquidity: { usd: 1000000 } },
          { chainId: 'ethereum', baseToken: { address: wethAddress, symbol: 'WETH' }, priceUsd: '1990', liquidity: { usd: 1000 } },
        ] : [] }) };
      }
      if (uri.toLowerCase().includes(wbnbAddress.toLowerCase())) {
        return { ok: true, json: async () => ({ pairs: [
          { chainId: 'bsc', baseToken: { address: wbnbAddress, symbol: 'WBNB' }, priceUsd: String(bnbPrice), liquidity: { usd: 5000000 } },
          { chainId: 'bsc', baseToken: { address: wbnbAddress, symbol: 'WBNB' }, priceUsd: '1', liquidity: { usd: 100 } },
        ] }) };
      }
      return { ok: true, json: async () => ({
        pairs: ['bsc', 'ethereum', 'robinhood'].map(chainId => ({
          chainId, baseToken: { address: tokenAddress, symbol: 'TEST', name: 'Practice Token' },
          priceUsd: String(tokenPrice), liquidity: { usd: liquidity }, marketCap: 200000,
        })),
      }) };
    }
    return originalFetch(url, options);
  };

  const wallet = Wallet.createRandom();
  const lowBalanceWallet = Wallet.createRandom();
  const migrationWallet = Wallet.createRandom();
  const failedOracleWallet = Wallet.createRandom();
  fs.writeFileSync(process.env.EVM_SIMULATION_FILE, JSON.stringify({
    accounts: {
      [`robinhood:${wallet.address.toLowerCase()}`]: {
        balanceUsd: 4321, realizedPnlUsd: 12, realizedBasisUsd: 3, positions: [], closed: [], orders: [], activity: [],
      },
      [`robinhood:${migrationWallet.address.toLowerCase()}`]: {
        balanceUsd: 500, realizedPnlUsd: 7, realizedBasisUsd: 20,
        positions: [{
          id: 'legacy-position', chain: 'robinhood', addr: tokenAddress, sym: 'TEST', side: 'long',
          entry: 100, qty: 1, marginUsd: 50, leverage: 2, mode: 'isolated', openFeeUsd: 0.03,
        }],
        closed: [{ id: 'historic', pnlUsd: 5, marginUsd: 25 }],
        orders: [{
          id: 'legacy-order', chain: 'robinhood', addr: tokenAddress, sym: 'TEST', side: 'long',
          marginUsd: 20, leverage: 1, mode: 'isolated', reservedFeeUsd: 0.012,
          type: 'limit', triggerPrice: 90, status: 'pending', expiresAt: new Date(Date.now() + 60000).toISOString(),
        }],
        activity: [{ id: 'historic-activity', type: 'old' }],
      },
      [`bsc:${lowBalanceWallet.address.toLowerCase()}`]: {
        balanceUsd: 110, realizedPnlUsd: 0, realizedBasisUsd: 0, positions: [], closed: [], orders: [], activity: [],
      },
    },
  }));
  delete require.cache[require.resolve('./evmSimulation')];
  const app = express();
  app.use(express.json());
  const evmRouter = require('./evmSimulation');
  app.use('/api/evm', evmRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/evm`;
  const rawCall = async (route, body, token) => {
    const res = await originalFetch(base + route, {
      method: body == null ? 'GET' : 'POST',
      headers: { ...(body == null ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };
  const signers = new Map();

  const intentFor = route => {
    if (route === '/balance/add') return { action: 'balance' };
    if (route === '/orders') return { action: 'order' };
    if (route === '/positions/open') return { action: 'open' };
    const match = route.match(/^\/(orders|positions)\/([^/]+)\/(cancel|tpsl|reduce|close)$/);
    return match ? { action: match[3], targetId: decodeURIComponent(match[2]) } : null;
  };
  const call = async (route, body, token) => {
    const intent = intentFor(route);
    if (body != null && token && signers.has(token) && intent) {
      const payload = { ...body, ...(intent.targetId ? { targetId: intent.targetId } : {}) };
      const challenge = await rawCall('/auth/order-intent', { action: intent.action, order: payload }, token);
      assert.equal(challenge.status, 200);
      return rawCall(route, {
        ...payload, intentId: challenge.data.intentId,
        intentSignature: await signers.get(token).signMessage(challenge.data.message),
      }, token);
    }
    return rawCall(route, body, token);
  };
  const signInAs = async (signingWallet, chain) => {
    const challenge = await call('/auth/challenge', { chain, address: signingWallet.address });
    assert.equal(challenge.status, 200);
    const login = await call('/auth/verify', {
      chain, address: signingWallet.address, message: challenge.data.message,
      signature: await signingWallet.signMessage(challenge.data.message),
    });
    assert.equal(login.status, 200);
    signers.set(login.data.token, signingWallet);
    return login.data.token;
  };
  const waitForHeldFetches = async count => {
    for (let attempt = 0; attempt < 200 && releaseTokenFetches.length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(releaseTokenFetches.length, count, 'expected market requests to pause before settlement');
  };
  try {
    const bscToken = await signInAs(wallet, 'bsc');
    const failedOracleToken = await signInAs(failedOracleWallet, 'robinhood');
    assert.equal((await call('/state', null, failedOracleToken)).status, 503, 'oracle unavailability must fail, never assume USD = 1');
    assert.equal(fs.existsSync(process.env.EVM_SIMULATION_FILE), true);
    assert.equal(JSON.parse(fs.readFileSync(process.env.EVM_SIMULATION_FILE, 'utf8')).accounts[`robinhood:${failedOracleWallet.address.toLowerCase()}`], undefined,
      'failed oracle must not persist a default/reset account');
    ethOracleAvailable = true;

    assert.equal((await call('/state')).status, 401);
    assert.equal((await call('/positions/open', { address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2 })).status, 401);
    const initial = await call('/state', null, bscToken);
    const collateral = await call('/collateral?chain=bsc');
    assert.equal(collateral.status, 200);
    assert.equal(collateral.data.collateralSymbol, 'BNB');
    assert.equal(initial.status, 200);
    assert.equal(initial.data.collateralSymbol, 'BNB');
    assert.equal(initial.data.collateralPriceUsd, 500);
    assert.equal(initial.data.balanceNative, 0, 'new account starts empty until test balance is added');
    assert.equal(initial.data.balanceUsd, 0);
    assert.deepEqual(initial.data.orders, []);
    const unsignedTrade = {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
    };
    assert.equal((await rawCall('/positions/open', unsignedTrade, bscToken)).status, 403,
      'a signed login alone never approves a new trade');
    const mismatched = await rawCall('/auth/order-intent', { action: 'open', order: unsignedTrade }, bscToken);
    assert.equal((await rawCall('/positions/open', {
      ...unsignedTrade, leverage: 3, intentId: mismatched.data.intentId,
      intentSignature: await wallet.signMessage(mismatched.data.message),
    }, bscToken)).status, 403, 'the signature is bound to the exact trade');
    assert.equal((await rawCall('/positions/open', {
      ...unsignedTrade, intentId: mismatched.data.intentId,
      intentSignature: await wallet.signMessage(mismatched.data.message),
    }, bscToken)).status, 403, 'a rejected intent cannot be reused');
    const protectionIntent = await rawCall('/auth/order-intent', {
      action: 'open', order: { ...unsignedTrade, tpRoi: 25, tpQtyPct: 50 },
    }, bscToken);
    assert.equal((await rawCall('/positions/open', {
      ...unsignedTrade, tpRoi: 25, tpQtyPct: 51, intentId: protectionIntent.data.intentId,
      intentSignature: await wallet.signMessage(protectionIntent.data.message),
    }, bscToken)).status, 403, 'a TP/SL signature binds both chosen trigger and close-size representation');
    assert.equal((await rawCall('/balance/add', { amountUsd: 50 }, bscToken)).status, 403,
      'a login session cannot add test balance without approval');
    const balanceIntent = await rawCall('/auth/order-intent', {
      action: 'balance', order: { amountUsd: 50 },
    }, bscToken);
    assert.match(balanceIntent.data.message, /ADD TEST BALANCE/);
    assert.equal((await rawCall('/balance/add', {
      amountUsd: 51, intentId: balanceIntent.data.intentId,
      intentSignature: await wallet.signMessage(balanceIntent.data.message),
    }, bscToken)).status, 403, 'approved balance amount cannot be increased');
    const wrongWalletIntent = await rawCall('/auth/order-intent', {
      action: 'balance', order: { amountUsd: 50 },
    }, bscToken);
    assert.equal((await rawCall('/balance/add', {
      amountUsd: 50, intentId: wrongWalletIntent.data.intentId,
      intentSignature: await lowBalanceWallet.signMessage(wrongWalletIntent.data.message),
    }, bscToken)).status, 403, 'a different wallet cannot authorize a top-up');
    const unfundedOrder = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.02, leverage: 2,
    }, bscToken);
    assert.equal(unfundedOrder.status, 400);
    assert.match(unfundedOrder.data.error, /Add test balance/);
    assert.equal((await call('/balance/add', { amountNative: 0 }, bscToken)).status, 400);
    assert.equal((await call('/balance/add', { amountNative: 0.4 }, bscToken)).data.remainingUsd, 800);
    assert.equal((await call('/balance/add', { amountUsd: 'bad' }, bscToken)).status, 400);
    const dollarCredit = await call('/balance/add', { amountUsd: 100 }, bscToken);
    assert.equal(dollarCredit.status, 200);
    assert.equal(dollarCredit.data.amountUsd, 100);
    assert.equal(dollarCredit.data.amountNative, 0.2, 'USD amount converts to native collateral at the live quote');
    assert.equal(dollarCredit.data.remainingUsd, 700);
    assert.equal((await call('/balance/add', { amountNative: 1.602 }, bscToken)).status, 429);
    assert.equal((await call('/balance/add', { amountNative: 1.4 }, bscToken)).data.remainingUsd, 0);
    assert.equal((await call('/balance/add', { amountUsd: 1 }, bscToken)).status, 429, 'USD top-ups share the same six-hour cap');

    const signedOrder = {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2,
      mode: 'isolated', type: 'limit', triggerPrice: 90,
    };
    const alteredOrderProtection = await rawCall('/auth/order-intent', {
      action: 'order', order: { ...signedOrder, tpRoi: 10, tpQtyPct: 25 },
    }, bscToken);
    assert.equal((await rawCall('/orders', {
      ...signedOrder, tpRoi: 10, tpQtyPct: 26,
      intentId: alteredOrderProtection.data.intentId,
      intentSignature: await wallet.signMessage(alteredOrderProtection.data.message),
    }, bscToken)).status, 403, 'pending-order signatures bind their TP/SL size representation');
    assert.equal((await rawCall('/orders', signedOrder, bscToken)).status, 403,
      'pending orders also need an explicit wallet confirmation');
    const orderChallenge = await rawCall('/auth/order-intent', { action: 'order', order: signedOrder }, bscToken);
    const confirmedOrder = {
      ...signedOrder, intentId: orderChallenge.data.intentId,
      intentSignature: await wallet.signMessage(orderChallenge.data.message),
    };
    const placedOnce = await rawCall('/orders', confirmedOrder, bscToken);

    assert.equal(placedOnce.status, 200);
    assert.equal((await rawCall('/orders', confirmedOrder, bscToken)).status, 403,
      'wallet confirmations are consumed exactly once');
    const firstCancelRoute = `/orders/${placedOnce.data.order.id}/cancel`;
    assert.equal((await rawCall(firstCancelRoute, {}, bscToken)).status, 403, 'cancellation requires fresh approval');
    const cancelIntent = await rawCall('/auth/order-intent', {
      action: 'cancel', order: { targetId: placedOnce.data.order.id },
    }, bscToken);
    assert.match(cancelIntent.data.message, /CANCEL ORDER/);
    const signedCancel = {
      targetId: placedOnce.data.order.id, intentId: cancelIntent.data.intentId,
      intentSignature: await wallet.signMessage(cancelIntent.data.message),
    };
    assert.equal((await rawCall(`/orders/not-the-approved-order/cancel`, signedCancel, bscToken)).status, 403,
      'a cancellation cannot be retargeted through the URL');
    assert.equal((await rawCall(firstCancelRoute, signedCancel, bscToken)).status, 403,
      'a rejected cancellation intent cannot be replayed');
    assert.equal((await call(firstCancelRoute, {}, bscToken)).status, 200);
    const marketableLong = await call('/orders', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2,
      mode: 'isolated', type: 'limit', triggerPrice: 100,
    }, bscToken);
    assert.equal(marketableLong.status, 409, 'an already-executable long limit must not open a position');
    assert.match(marketableLong.data.error, /lower limit/);
    assert.equal((await call('/state', null, bscToken)).data.positions.length, 0);

    tokenPrice = 100;
    const invalidAtFillOrder = await call('/orders', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
      type: 'limit', triggerPrice: 90, tp: 85, tpQtyPct: 50,
    }, bscToken);
    assert.equal(invalidAtFillOrder.status, 200);
    tokenPrice = 90;
    await evmRouter.__test.processOpenAccounts();
    const rejectedAtFill = (await call('/state', null, bscToken)).data.orders.find(order => order.id === invalidAtFillOrder.data.order.id);
    assert.equal(rejectedAtFill.status, 'rejected', 'absolute protection is revalidated against the actual limit fill price');
    assert.match(rejectedAtFill.rejectionReason, /TP trigger/);
    assert.equal((await call('/state', null, bscToken)).data.positions.length, 0);
    tokenPrice = 100;

    const invalidLev = await call('/positions/open', { address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 21 }, bscToken);
    assert.equal(invalidLev.status, 400);
    assert.equal((await call('/positions/open', { address: tokenAddress, side: 'long', marginUsd: 100, leverage: 2 }, bscToken)).status, 400,
      'legacy USD margin input is not silently accepted');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, tp: 110, tpRoi: 10,
    }, bscToken)).status, 400, 'price and ROI trigger representations cannot both be selected');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, tp: 90,
    }, bscToken)).status, 400, 'long absolute TP must be above entry');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, tpRoi: 10, tpQtyPct: 0,
    }, bscToken)).status, 400, 'partial close percentages must be within 1–100');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, tpRoi: 10, tpQty: 3,
    }, bscToken)).status, 400, 'manual close quantity cannot exceed the position quantity');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2,
      tpRoi: 10, tpQty: 1, tpQtyPct: 50,
    }, bscToken)).status, 400, 'manual quantity and percentage sizing are mutually exclusive');
    assert.equal((await call('/positions/open', {
      address: tokenAddress, side: 'short', marginNative: 0.2, leverage: 2, tp: 110,
    }, bscToken)).status, 400, 'short absolute TP must be below entry');
    const opened = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'cross', tpRoi: 25,
    }, bscToken);

    liquidity = 30000;
    const crossState = await call('/state', null, bscToken);
    assert.equal(crossState.data.positions.length, 1, 'free same-chain balance provides cross liquidation cushion');
    assert.equal(typeof crossState.data.portfolio.equityUsd, 'number');
    assert.equal(crossState.data.positions[0].mark, 100, 'an open position keeps a live mark below the new-entry liquidity threshold');
    assert.equal(Number.isFinite(crossState.data.positions[0].unrealizedPnlUsd), true);

    const crossCloseRoute = `/positions/${opened.data.position.id}/close`;
    assert.equal((await rawCall(crossCloseRoute, {}, bscToken)).status, 403, 'closing requires fresh approval');
    assert.equal((await call('/state', null, bscToken)).data.positions.length, 1);
    const wrongActionIntent = await rawCall('/auth/order-intent', {
      action: 'reduce', order: { targetId: opened.data.position.id, percent: 25 },
    }, bscToken);
    assert.equal((await rawCall(crossCloseRoute, {
      targetId: opened.data.position.id, intentId: wrongActionIntent.data.intentId,
      intentSignature: await wallet.signMessage(wrongActionIntent.data.message),
    }, bscToken)).status, 403, 'a reduction signature cannot authorize a full close');
    const closeIntent = await rawCall('/auth/order-intent', {
      action: 'close', order: { targetId: opened.data.position.id },
    }, bscToken);
    assert.match(closeIntent.data.message, /CLOSE POSITION/);
    assert.equal((await rawCall(crossCloseRoute, {
      targetId: opened.data.position.id, intentId: closeIntent.data.intentId,
      intentSignature: await lowBalanceWallet.signMessage(closeIntent.data.message),
    }, bscToken)).status, 403, 'another wallet cannot approve the close');
    assert.equal((await call('/state', null, bscToken)).data.positions.length, 1);
    const approvedClose = await rawCall('/auth/order-intent', {
      action: 'close', order: { targetId: opened.data.position.id },
    }, bscToken);
    const signedClose = {
      targetId: opened.data.position.id, intentId: approvedClose.data.intentId,
      intentSignature: await wallet.signMessage(approvedClose.data.message),
    };
    const secondCloseIntent = await rawCall('/auth/order-intent', {
      action: 'close', order: { targetId: opened.data.position.id },
    }, bscToken);
    const secondSignedClose = {
      targetId: opened.data.position.id, intentId: secondCloseIntent.data.intentId,
      intentSignature: await wallet.signMessage(secondCloseIntent.data.message),
    };
    heldTokenFetches = 2;
    const firstClose = rawCall(crossCloseRoute, signedClose, bscToken);
    const secondClose = rawCall(crossCloseRoute, secondSignedClose, bscToken);
    await waitForHeldFetches(2);
    releaseTokenFetches.splice(0).forEach(release => release());
    const racingCloses = await Promise.all([firstClose, secondClose]);
    assert.deepEqual(racingCloses.map(result => result.status).sort(), [200, 409],
      'only one of two approved concurrent closes can settle a position');
    assert.equal((await rawCall(crossCloseRoute, signedClose, bscToken)).status, 403,
      'a closing approval cannot be replayed');
    assert.equal((await call('/state', null, bscToken)).data.closed.filter(pos => pos.id === opened.data.position.id).length, 1,
      'concurrent closes must record and credit one closure only');
    liquidity = 100000;
    tokenPrice = 100;
    const beforeOrder = (await call('/state', null, bscToken)).data.balanceNative;
    const pending = await call('/orders', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
      type: 'limit', triggerPrice: 90, tpRoi: 20, slRoi: -40,
    }, bscToken);
    assert.equal(pending.status, 200);
    assert.equal(pending.data.order.status, 'pending');
    assert.equal(pending.data.order.marginNative, 0.2);
    assert.equal(pending.data.order.marginUsd, 100);
    const reservedState = await call('/state', null, bscToken);
    assert.equal(reservedState.data.orders[0].status, 'pending');
    assert.ok(reservedState.data.portfolio.reservedMarginUsd > 100);
    assert.ok(reservedState.data.balanceNative < beforeOrder, 'pending order margin and fee are held in native units');
    assert.equal((await rawCall(`/orders/${pending.data.order.id}/cancel`, {}, bscToken)).status, 403);
    const canceled = await call(`/orders/${pending.data.order.id}/cancel`, {}, bscToken);
    assert.equal(canceled.status, 200);
    assert.equal(canceled.data.order.status, 'cancelled');
    assert.ok(Math.abs((await call('/state', null, bscToken)).data.balanceNative - beforeOrder) < 1e-10,
      'cancelling refunds reserved margin and fees to the native balance');
    assert.equal((await rawCall('/auth/order-intent', {
      action: 'cancel', order: { targetId: pending.data.order.id },
    }, bscToken)).status, 404, 'a filled or cancelled order cannot request another cancellation approval');
    const stop = await call('/orders', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
      type: 'stop', triggerPrice: 105, tpRoi: 10, slRoi: -30,
    }, bscToken);
    assert.equal(stop.data.order.status, 'pending');
    tokenPrice = 106;
    await evmRouter.__test.processOpenAccounts();
    const offlineFilled = JSON.parse(fs.readFileSync(process.env.EVM_SIMULATION_FILE, 'utf8'))
      .accounts[`bsc:${wallet.address.toLowerCase()}`];
    assert.equal(offlineFilled.orders.find(order => order.id === stop.data.order.id).status, 'filled',
      'limit/stop orders fill without a connected browser polling state');
    const filled = await call('/state', null, bscToken);
    assert.equal(filled.data.orders.find(order => order.id === stop.data.order.id).status, 'filled');
    assert.equal(filled.data.positions.length, 1);
    assert.equal(filled.data.positions[0].mode, 'isolated');
    assert.equal(filled.data.positions[0].marginNative, 0.2);
    tokenPrice = 112;
    await evmRouter.__test.processOpenAccounts();
    const offlineClosed = JSON.parse(fs.readFileSync(process.env.EVM_SIMULATION_FILE, 'utf8'))
      .accounts[`bsc:${wallet.address.toLowerCase()}`];
    assert.equal(offlineClosed.positions.length, 0, 'TP/SL settles without an open browser');
    const takeProfit = await call('/state', null, bscToken);
    assert.equal(takeProfit.data.positions.length, 0);
    assert.equal(takeProfit.data.closed[0].reason, 'TP');
    assert.equal(takeProfit.data.activity.some(event => event.type === 'order_filled'), true);

    tokenPrice = 100;
    const quantityStop = await call('/positions/open', {
      address: tokenAddress, side: 'short', marginNative: 0.2, leverage: 2, mode: 'isolated',
      slRoi: -20, slQty: 0.4,
    }, bscToken);
    assert.equal(quantityStop.status, 200);
    tokenPrice = 110;
    await evmRouter.__test.processOpenAccounts();
    const quantityStopState = (await call('/state', null, bscToken)).data;
    const quantityStopClosed = quantityStopState.closed.find(item => item.positionId === quantityStop.data.position.id);
    const quantityStopRemainder = quantityStopState.positions.find(item => item.id === quantityStop.data.position.id);
    assert.equal(quantityStopClosed.reason, 'SL');
    assert.equal(quantityStopClosed.partial, true);
    assert.ok(Math.abs(quantityStopClosed.qty - 0.4) < 1e-10);
    assert.ok(Math.abs(quantityStopRemainder.qty - 1.6) < 1e-10);
    assert.equal(quantityStopRemainder.slRoi, null, 'a consumed partial trigger is cleared to prevent repeat closes');
    assert.equal(quantityStopRemainder.slQty, null);
    assert.equal((await call('/positions/' + quantityStop.data.position.id + '/close', {}, bscToken)).status, 200);

    tokenPrice = 100;
    const percentTakeProfit = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'cross',
      tp: 110, tpQtyPct: 25, slRoi: -50, slQty: 1.8,
    }, bscToken);
    assert.equal(percentTakeProfit.status, 200);
    tokenPrice = 112;
    await evmRouter.__test.processOpenAccounts();
    const percentTpState = (await call('/state', null, bscToken)).data;
    const percentTpClosed = percentTpState.closed.find(item => item.positionId === percentTakeProfit.data.position.id);
    const percentTpRemainder = percentTpState.positions.find(item => item.id === percentTakeProfit.data.position.id);
    assert.equal(percentTpClosed.reason, 'TP');
    assert.equal(percentTpClosed.partial, true);
    assert.ok(Math.abs(percentTpClosed.qty - 0.5) < 1e-10);
    assert.ok(Math.abs(percentTpClosed.marginNative - 0.05) < 1e-10);
    assert.ok(Math.abs(percentTpRemainder.qty - 1.5) < 1e-10);
    assert.equal(percentTpRemainder.tp, null);
    assert.equal(percentTpRemainder.slRoi, -50,
      'an opposing stop keeps its exact saved trigger after a partial take profit');
    assert.equal(percentTpRemainder.slQty, 1.8,
      'the saved absolute quantity is not silently rewritten to the smaller remainder');
    tokenPrice = 115;
    await evmRouter.__test.processOpenAccounts();
    assert.equal(JSON.parse(fs.readFileSync(process.env.EVM_SIMULATION_FILE, 'utf8'))
      .accounts[`bsc:${wallet.address.toLowerCase()}`].closed.filter(item =>
        item.positionId === percentTakeProfit.data.position.id).length, 1,
    'the same partial TP does not trigger repeatedly on the remaining quantity');
    tokenPrice = 74;
    await evmRouter.__test.processOpenAccounts();
    const stoppedState = (await call('/state', null, bscToken)).data;
    const stopClosed = stoppedState.closed.find(item =>
      (item.id === percentTakeProfit.data.position.id || item.positionId === percentTakeProfit.data.position.id) &&
      item.reason === 'SL');
    assert.ok(stopClosed, 'the retained stop closes the remainder when triggered');
    assert.ok(Math.abs(stopClosed.qty - 1.5) < 1e-10, 'the executed quantity cannot exceed the remaining position');
    assert.ok(!stoppedState.positions.some(item => item.id === percentTakeProfit.data.position.id));
    tokenPrice = 100;

    const isolated = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
    }, bscToken);
    const isolatedState = await call('/state', null, bscToken);
    const isolatedPosition = isolatedState.data.positions[0];
    const expectedLiquidation = (isolatedPosition.qty * isolatedPosition.entry - isolatedPosition.marginUsd) /
      (isolatedPosition.qty * (1 - 0.006));
    assert.ok(Math.abs(isolatedPosition.liquidationPrice - expectedLiquidation) < 1e-8,
      'the displayed liquidation price uses the same maintenance threshold as settlement');
    tokenPrice = 50;
    const liquidation = await call('/state', null, bscToken);
    assert.equal(liquidation.data.positions.length, 0);
    assert.equal(liquidation.data.closed[0].id, isolated.data.position.id);
    assert.equal(liquidation.data.closed[0].reason, 'LIQ');

    tokenPrice = 100;
    const short = await call('/positions/open', {
      address: tokenAddress, side: 'short', marginNative: 0.2, leverage: 2, mode: 'isolated',
    }, bscToken);

    assert.equal((await rawCall(`/positions/${short.data.position.id}/reduce`, { percent: 25 }, bscToken)).status, 403);
    const changedReduction = await rawCall('/auth/order-intent', {
      action: 'reduce', order: { targetId: short.data.position.id, percent: 25 },
    }, bscToken);
    const reductionSignature = await wallet.signMessage(changedReduction.data.message);
    assert.equal((await rawCall(`/positions/${short.data.position.id}/reduce`, {
      targetId: short.data.position.id, percent: 50, intentId: changedReduction.data.intentId,
      intentSignature: reductionSignature,
    }, bscToken)).status, 403, 'approved reduction cannot change size');
    assert.equal((await rawCall(`/positions/${short.data.position.id}/reduce`, {
      targetId: short.data.position.id, percent: 25, intentId: changedReduction.data.intentId,
      intentSignature: reductionSignature,
    }, bscToken)).status, 403, 'mismatched intent is consumed');
    const changedProtection = await rawCall('/auth/order-intent', {
      action: 'tpsl', order: { targetId: short.data.position.id, tpRoi: 20, slRoi: -20 },
    }, bscToken);
    const changedSizeProtection = await rawCall('/auth/order-intent', {
      action: 'tpsl', order: { targetId: short.data.position.id, slRoi: -20, slQtyPct: 25 },
    }, bscToken);
    assert.equal((await rawCall(`/positions/${short.data.position.id}/tpsl`, {
      targetId: short.data.position.id, slRoi: -20, slQtyPct: 30,
      intentId: changedSizeProtection.data.intentId,
      intentSignature: await wallet.signMessage(changedSizeProtection.data.message),
    }, bscToken)).status, 403, 'TP/SL edit signatures bind manual trigger sizing');
    assert.equal((await rawCall(`/positions/${short.data.position.id}/tpsl`, {
      targetId: short.data.position.id, tpRoi: 20, slRoi: -30,
      intentId: changedProtection.data.intentId,
      intentSignature: await wallet.signMessage(changedProtection.data.message),
    }, bscToken)).status, 403, 'approved TP/SL cannot change triggers');
    const unchanged = (await call('/state', null, bscToken)).data.positions[0];
    assert.equal(unchanged.qty, short.data.position.qty);
    assert.equal(unchanged.slRoi, null);
    assert.equal((await call(`/positions/${short.data.position.id}/reduce`, { percent: 0 }, bscToken)).status, 400);
    assert.equal((await call(`/positions/${short.data.position.id}/reduce`, { percent: 100 }, bscToken)).status, 400);
    tokenPrice = 110;
    const partial = await call(`/positions/${short.data.position.id}/reduce`, { percent: 25 }, bscToken);
    assert.equal(partial.status, 200);
    assert.equal(partial.data.closed.reason, 'REDUCE');
    assert.equal(partial.data.closed.partial, true);
    assert.equal(partial.data.closed.positionId, short.data.position.id);
    assert.equal(partial.data.closed.qty, 0.5);
    assert.equal(partial.data.closed.marginNative, 0.05);
    assert.equal(partial.data.closed.marginUsd, 25);
    assert.ok(Math.abs(partial.data.closed.openFeeNative - 0.00006) < 1e-10);
    assert.ok(Math.abs(partial.data.closed.closeFeeUsd - 0.033) < 1e-10);
    assert.ok(Math.abs(partial.data.closed.pnlUsd - (-5.063)) < 1e-10);
    assert.ok(Math.abs(partial.data.returnedUsd - 19.967) < 1e-10);
    assert.ok(Math.abs(partial.data.position.qty - 1.5) < 1e-10);
    assert.ok(Math.abs(partial.data.position.marginNative - 0.15) < 1e-10);
    assert.equal((await call(`/positions/${short.data.position.id}/tpsl`, {
      slRoi: -20, slQty: 1.6,
    }, bscToken)).status, 400, 'a protection quantity is checked against the resized position');
    assert.equal((await rawCall(`/positions/${short.data.position.id}/tpsl`, { slRoi: -20 }, bscToken)).status, 403,
      'changing existing protection requires approval');
    await call(`/positions/${short.data.position.id}/tpsl`, { slRoi: -20 }, bscToken);
    const staleReduceIntent = await rawCall('/auth/order-intent', {
      action: 'reduce', order: { targetId: short.data.position.id, percent: 25 },
    }, bscToken);
    heldTokenFetches = 1;
    const staleReduction = rawCall(`/positions/${short.data.position.id}/reduce`, {
      targetId: short.data.position.id, percent: 25, intentId: staleReduceIntent.data.intentId,
      intentSignature: await wallet.signMessage(staleReduceIntent.data.message),
    }, bscToken);
    await waitForHeldFetches(1);
    tokenPrice = 111;
    await evmRouter.__test.processOpenAccounts();
    releaseTokenFetches.splice(0).forEach(release => release());
    assert.equal((await staleReduction).status, 409,
      'a reduction waiting on a quote cannot credit a position already closed by its stop loss');
    const stopLoss = await call('/state', null, bscToken);
    assert.equal(stopLoss.data.positions.length, 0);
    assert.equal(stopLoss.data.closed[0].reason, 'SL');

    liquidity = 1000;
    assert.equal((await call('/orders', {
      address: tokenAddress, side: 'long', marginNative: 0.02, leverage: 1, type: 'limit', triggerPrice: 90,
    }, bscToken)).status, 503);
    liquidity = 100000;

    const emptyRobinhood = await call('/state', null, failedOracleToken);
    assert.equal(emptyRobinhood.data.balanceNative, 0, 'new Robinhood account receives no automatic ETH');
    assert.equal((await call('/positions/open', {
      address: wethAddress, side: 'long', marginNative: 0.01, leverage: 2,
    }, failedOracleToken)).status, 400);
    const robinhoodToken = await signInAs(wallet, 'robinhood');
    const robinhoodState = await call('/state', null, robinhoodToken);
    const bscBalanceIntent = await rawCall('/auth/order-intent', {
      action: 'balance', order: { amountUsd: 10 },
    }, bscToken);
    assert.equal((await rawCall('/balance/add', {
      amountUsd: 10, intentId: bscBalanceIntent.data.intentId,
      intentSignature: await wallet.signMessage(bscBalanceIntent.data.message),
    }, robinhoodToken)).status, 403, 'an approval on BNB must not authorize a Robinhood action');
    assert.equal(robinhoodState.data.collateralSymbol, 'ETH');
    assert.equal(robinhoodState.data.collateralPriceUsd, 2000);
    assert.equal(robinhoodState.data.balanceUsd, 4321, 'legacy USD balance converts to native and preserves USD value');
    assert.ok(Math.abs(robinhoodState.data.balanceNative - 2.1605) < 1e-10);
    assert.equal(robinhoodState.data.closed.length, 0);
    assert.equal(robinhoodState.data.positions.length, 0, 'ledger remains isolated by chain');
    assert.equal(robinhoodState.data.realizedPnlUsd, 12);
    const ethSearch = await call('/search?chain=robinhood&q=ETH');
    assert.equal(ethSearch.status, 200);
    assert.equal(ethSearch.data.items[0].sym, 'ETH');
    assert.equal(ethSearch.data.items[0].referencePrice, true);
    assert.equal(ethSearch.data.items[0].liquidityUsd, null, 'reference market must not claim Robinhood liquidity');
    const ethMarket = await call(`/market?chain=robinhood&address=${wethAddress}`);
    assert.equal(ethMarket.status, 200);
    assert.equal(ethMarket.data.priceSource, 'Ethereum WETH/USD');
    const ethPosition = await call('/positions/open', {
      address: wethAddress, side: 'long', marginNative: 0.05, leverage: 3, mode: 'isolated', tpRoi: 20, slRoi: -10,
    }, robinhoodToken);

    assert.equal(ethPosition.status, 200, JSON.stringify(ethPosition.data));
    assert.equal(ethPosition.data.position.marginUsd, 100);
    assert.equal((await call('/state', null, robinhoodToken)).data.positions[0].tpRoi, 20);
    assert.equal((await rawCall(`/positions/${ethPosition.data.position.id}/tpsl`, { tpRoi: 30 }, robinhoodToken)).status, 403);
    assert.equal((await call(`/positions/${ethPosition.data.position.id}/tpsl`, { tpRoi: 30, slRoi: -15 }, robinhoodToken)).status, 200);
    assert.equal((await call(`/positions/${ethPosition.data.position.id}/tpsl`, { slRoi: 5 }, robinhoodToken)).status, 400);
    assert.equal((await rawCall(`/positions/${ethPosition.data.position.id}/close`, {}, robinhoodToken)).status, 403);
    assert.equal((await call(`/positions/${ethPosition.data.position.id}/close`, {}, robinhoodToken)).status, 200);
    assert.equal((await call('/state', null, robinhoodToken)).data.positions.length, 0);
    ethPrice = 2000;
    const robinhoodPartial = await call('/positions/open', {
      address: wethAddress, side: 'long', marginNative: 0.05, leverage: 3, mode: 'isolated',
      tp: 2100, tpQtyPct: 25,
    }, robinhoodToken);
    assert.equal(robinhoodPartial.status, 200, JSON.stringify(robinhoodPartial.data));
    ethPrice = 2200;
    await new Promise(resolve => setTimeout(resolve, 5100));
    await evmRouter.__test.processOpenAccounts();
    const robinhoodPartialState = (await call('/state', null, robinhoodToken)).data;
    const robinhoodPartialClosed = robinhoodPartialState.closed.find(item =>
      item.positionId === robinhoodPartial.data.position.id);
    const robinhoodRemainder = robinhoodPartialState.positions.find(item =>
      item.id === robinhoodPartial.data.position.id);
    assert.equal(robinhoodPartialClosed.reason, 'TP');
    assert.equal(robinhoodPartialClosed.partial, true);
    assert.ok(Math.abs(robinhoodPartialClosed.qty - 0.0375) < 1e-10);
    assert.ok(Math.abs(robinhoodRemainder.qty - 0.1125) < 1e-10);
    assert.equal(robinhoodRemainder.tp, null);
    assert.equal((await call(`/positions/${robinhoodPartial.data.position.id}/close`, {}, robinhoodToken)).status, 200);
    ethPrice = 2000;
    const rhLimit = await call('/orders', {
      address: wethAddress, side: 'long', marginNative: 0.05, leverage: 3,
      mode: 'isolated', type: 'limit', triggerPrice: 1800,
    }, robinhoodToken);
    assert.equal(rhLimit.status, 200, JSON.stringify(rhLimit.data));
    assert.equal(rhLimit.data.order.status, 'pending', 'Robinhood limit orders stay pending below the live reference price');
    assert.equal((await call('/state', null, robinhoodToken)).data.orders.some(order =>
      order.id === rhLimit.data.order.id && order.status === 'pending'), true);
    assert.equal((await call(`/orders/${rhLimit.data.order.id}/cancel`, {}, robinhoodToken)).status, 200);
    const marketableShort = await call('/orders', {
      address: wethAddress, side: 'short', marginNative: 0.05, leverage: 3,
      mode: 'isolated', type: 'limit', triggerPrice: 1900,
    }, robinhoodToken);
    assert.equal(marketableShort.status, 409, 'an already-executable short limit must not open a position');
    assert.match(marketableShort.data.error, /higher limit/);
    assert.equal((await call('/state', null, robinhoodToken)).data.positions.length, 0);
    liquidity = 30000;
    const rejectedNewEntryQuote = await call(`/market?chain=robinhood&address=${tokenAddress}`);
    assert.equal(rejectedNewEntryQuote.status, 503, 'low liquidity still blocks new-entry market quotes');
    const migrationToken = await signInAs(migrationWallet, 'robinhood');
    const migrated = await call('/state', null, migrationToken);
    assert.equal(migrated.status, 200);
    assert.equal(migrated.data.balanceUsd, 500);
    assert.ok(Math.abs(migrated.data.positions[0].marginNative - 50 / migrated.data.collateralPriceUsd) < 1e-12,
      'legacy USD margin converts at the current live ETH quote');
    assert.equal(migrated.data.positions[0].marginUsd, 50);
    assert.equal(migrated.data.positions[0].mark, tokenPrice,
      'existing Robinhood positions keep a live mark below the new-entry liquidity threshold');
    assert.equal(migrated.data.positions[0].marketCapUsd, 200000);
    assert.equal(Number.isFinite(migrated.data.positions[0].unrealizedPnlUsd), true);
    assert.ok(Math.abs(migrated.data.positions[0].openFeeNative - 0.03 / migrated.data.collateralPriceUsd) < 1e-15);
    assert.ok(Math.abs(migrated.data.orders[0].marginNative - 20 / migrated.data.collateralPriceUsd) < 1e-12);
    assert.ok(Math.abs(migrated.data.orders[0].reservedFeeNative - 0.012 / migrated.data.collateralPriceUsd) < 1e-15);
    assert.equal(migrated.data.closed[0].id, 'historic');
    assert.equal(migrated.data.activity[0].id, 'historic-activity');
    assert.equal(migrated.data.realizedPnlUsd, 7);
    liquidity = 100000;
    const storedMigrated = JSON.parse(fs.readFileSync(process.env.EVM_SIMULATION_FILE, 'utf8')).accounts[`robinhood:${migrationWallet.address.toLowerCase()}`];
    assert.equal(storedMigrated.collateralVersion, 2);
    assert.equal(storedMigrated.balanceUsd, undefined);
    assert.equal(storedMigrated.positions[0].marginUsd, undefined);
    assert.ok(Math.abs(storedMigrated.positions[0].marginNative - 50 / migrated.data.collateralPriceUsd) < 1e-12);

    const lowBalanceToken = await signInAs(lowBalanceWallet, 'bsc');
    tokenPrice = 100;
    const lowBalancePosition = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'cross',
    }, lowBalanceToken);
    assert.equal(lowBalancePosition.status, 200);
    tokenPrice = 40;
    const crossLiquidation = await call('/state', null, lowBalanceToken);
    assert.equal(crossLiquidation.data.closed[0].reason, 'LIQ');
    assert.ok(crossLiquidation.data.closed[0].pnlUsd < -100, 'cross liquidation records losses beyond position margin');
    assert.ok(Math.abs(crossLiquidation.data.closed[0].pnlUsd - (-120.168)) < 1e-10);
    assert.equal(crossLiquidation.data.realizedPnlUsd, crossLiquidation.data.closed[0].pnlUsd);
    tokenPrice = 100;
    const isolatedBefore = (await call('/state', null, bscToken)).data;
    const isolatedLoss = await call('/positions/open', {
      address: tokenAddress, side: 'long', marginNative: 0.2, leverage: 2, mode: 'isolated',
    }, bscToken);
    assert.equal(isolatedLoss.status, 200);
    tokenPrice = 1;
    assert.equal((await call(`/positions/${isolatedLoss.data.position.id}/close`, {}, bscToken)).status, 200);
    const isolatedAfter = (await call('/state', null, bscToken)).data;
    assert.ok(isolatedAfter.balanceNative >= 0);
    assert.ok(isolatedAfter.closed[0].pnlUsd >= -100.121,
      'isolated realized loss cannot exceed posted margin and opening fee');
    assert.ok(Math.abs(isolatedAfter.balanceNative - (isolatedBefore.balanceNative - 0.2 - 0.00024)) < 1e-8,
      'closing an isolated position with an extreme loss does not debit unrelated free balance');
  } finally {
    releaseTokenFetches.splice(0).forEach(release => release());
    global.fetch = originalFetch;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('./evmSimulation')];
  }
});
