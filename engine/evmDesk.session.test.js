const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const walletSafety = require('./walletSafety');

const source = fs.readFileSync(require.resolve('./evmDesk.js'), 'utf8');
const address = `0x${'1'.repeat(40)}`;
const otherAddress = `0x${'2'.repeat(40)}`;
const key = 'mp_testnet_evm_sessions';
const selectedKey = 'mp_testnet_selected_chain';
const chainIds = { robinhood: '0x1237', bsc: '0x38' };

function storage(values = new Map()) {
  return {
    values,
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, String(value)),
    removeItem: name => values.delete(name),
  };
}

function provider(chain = 'bsc') {
  const listeners = {};
  const wallet = {
    accounts: [address],
    chainId: chainIds[chain],
    calls: [],
    on(name, callback) { listeners[name] = callback; },
    emit(name, value) { listeners[name]?.(value); },
    async request(request) {
      wallet.calls.push(request);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return wallet.accounts;
      if (request.method === 'eth_chainId') return wallet.chainId;
      if (request.method === 'wallet_switchEthereumChain') {
        wallet.chainId = request.params[0].chainId;
        return null;
      }
      if (request.method === 'personal_sign') return 'fixture-signature';
      throw new Error(`Unexpected wallet method: ${request.method}`);
    },
  };
  return wallet;
}

function desk({ local = storage(), tab = storage(), wallet = provider(), loadStatus = 200, walletTimeoutMs = 3000 } = {}) {
  const elements = new Map();
  const events = {};
  const timers = new Map();
  const calls = { requests: [], statuses: [], balances: 0, loads: 0, warnings: [] };
  let timerId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'evmOrderType' ? 'market' : '',
      checked: false, disabled: false, textContent: '', style: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, removeAttribute() {}, replaceChildren() {},
      append() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  const window = {
    localStorage: local, sessionStorage: tab,
    ethereum: wallet,
    addEventListener(name, listener) { events[name] = listener; },
  };
  const context = vm.createContext({
    window, localStorage: local, sessionStorage: tab,
    document: {
      hidden: false,
      getElementById: element,
      createElement: tag => element(`created-${tag}-${++timerId}`),
      addEventListener(name, listener) { events[name] = listener; },
      body: { classList: { toggle() {} } },
    },
    console: { warn: (...args) => calls.warnings.push(args), log() {} },
    setInterval(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearInterval(id) { timers.delete(id); },
    setTimeout: (callback, delay) => setTimeout(callback, delay === 3000 ? walletTimeoutMs : delay),
    clearTimeout,
    calls, loadStatus, MemePerpWalletSafety: walletSafety, URLSearchParams, URL,
    setTrendingTickerChain() {},
  });
  vm.runInContext(source, context);
  // Keep the real persistence, session resumption, event handlers, connect,
  // disconnect and action-confirmation logic. Rendering/HTTP are isolated.
  vm.runInContext(String.raw`
    evmReset = function() {
      evmAccount = ''; evmToken = ''; evmProvider = null; evmWalletReady = false;
      if (evmRefreshTimer) clearInterval(evmRefreshTimer);
      if (evmWalletRecoveryTimer) clearInterval(evmWalletRecoveryTimer);
      evmRefreshTimer = null; evmWalletRecoveryTimer = null;
      document.getElementById('evmWalletBtn').textContent = 'Connect EVM wallet';
    };
    evmStatus = message => calls.statuses.push(message);
    evmShowWalletBalance = () => { calls.balances++; };
    evmLoadPublicQuote = () => {};
    evmLoadState = async () => {
      calls.loads++;
      if (loadStatus !== 200) {
        const error = new Error('Fixture session rejected'); error.status = loadStatus; throw error;
      }
    };
    evmOrderTypeChange = evmToggleTpSl = evmBuildRiskFields =
      evmUpdateChainLabels = evmSetSide = evmUpdatePreview = function() {};
    evmRequest = async (route, options = {}) => {
      calls.requests.push(route);
      if (route === '/auth/challenge') {
        const { chain, address } = JSON.parse(options.body);
        return { message: 'MemePerp testnet sign-in\nChain: ' + chain + '\nWallet: ' + address.toLowerCase() +
          '\nNonce: ' + 'a'.repeat(32) + '\nNo transaction or funds will be transferred.' };
      }
      if (route === '/auth/verify') return { token: 'token-' + JSON.parse(options.body).chain };
      if (route === '/auth/order-intent') {
        const { order } = JSON.parse(options.body);
        const amount = order.amountUsd != null
          ? '$' + order.amountUsd + ' USD (converted to ' + (evmChain === 'bsc' ? 'BNB' : 'ETH') + ' at the live quote)'
          : order.amountNative + ' ' + (evmChain === 'bsc' ? 'BNB' : 'ETH');
        return {
          intentId: '00000000-0000-4000-8000-000000000001',
          message: 'MemePerp Testnet Confirm ADD TEST BALANCE\nChain: ' + evmChain +
            '\nWallet: ' + evmAccount + '\nAmount: ' + amount +
            '\nNonce: 00000000-0000-4000-8000-000000000001\nSimulated order only. No on-chain transaction or wallet funds transfer.',
        };
      }
      return { ok: true };
    };
  `, context);
  return {
    local, tab, context, window, events, calls, timers,
    elements,
    run: expression => vm.runInContext(expression, context),
    state: () => JSON.parse(vm.runInContext(`JSON.stringify({
      chain: evmChain, account: evmAccount, token: evmToken,
      ready: evmWalletReady, chains: [...evmSessions.keys()]
    })`, context)),
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

async function connect(d, chain) {
  d.run(`evmSwitchChain('${chain}')`);
  await d.run('evmConnect()');
  await settle();
  assert.equal(d.state().token, `token-${chain}`);
}

for (const chain of ['robinhood', 'bsc']) {
  test(`${chain}: restore after refresh and a fresh tab without asking for another signature`, async () => {
    const original = desk();
    await connect(original, chain);
    for (const tab of [original.tab, storage()]) {
      const wallet = provider(chain);
      const reloaded = desk({ local: original.local, tab, wallet });
      await reloaded.run('evmRestoreOnLoad()');
      await settle();
      assert.equal(reloaded.state().chain, chain);
      assert.equal(reloaded.state().account, address);
      assert.equal(reloaded.state().ready, true);
      assert.equal(reloaded.state().token, `token-${chain}`);
      assert.equal(wallet.calls.some(call => call.method === 'personal_sign'), false);
      assert.equal(wallet.calls.some(call => call.method === 'wallet_switchEthereumChain'), false);
    }
  });
}

test('RH and BNB sessions survive switching between both EVM networks and Solana', async () => {
  const d = desk();
  await connect(d, 'robinhood');
  await connect(d, 'bsc');
  for (const chain of ['solana', 'robinhood', 'bsc', 'solana', 'bsc', 'robinhood']) {
    d.run(`evmSwitchChain('${chain}')`);
    await settle();
    assert.deepEqual(d.state().chains.sort(), ['bsc', 'robinhood']);
    assert.equal(d.state().token, chain === 'solana' ? '' : `token-${chain}`);
  }
  assert.equal(d.calls.requests.filter(route => route === '/auth/verify').length, 2);
});

test('migrates old sessionStorage logins and restores them after a new document', async () => {
  const local = storage(new Map([[selectedKey, 'bsc']]));
  const tab = storage(new Map([[key, JSON.stringify({ bsc: { account: address, token: 'token-bsc' } })]]));
  const d = desk({ local, tab });
  await d.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(JSON.parse(local.getItem(key)).bsc.token, 'token-bsc');
  const fresh = desk({ local, tab: storage() });
  await fresh.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(fresh.state().account, address);
});

test('an explicitly disconnected persistent session cannot be resurrected from an older tab cache', async () => {
  const local = storage(new Map([[selectedKey, 'bsc'], [key, '{}']]));
  const tab = storage(new Map([[key, JSON.stringify({ bsc: { account: address, token: 'old-token' } })]]));
  const d = desk({ local, tab });
  await d.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(d.state().token, '');
  assert.deepEqual(d.state().chains, []);
});

test('restoring while Solana is selected keeps both EVM logins for later visits', async () => {
  const d = desk();
  await connect(d, 'robinhood');
  await connect(d, 'bsc');
  d.run("evmSwitchChain('solana')");
  const fresh = desk({ local: d.local, tab: storage() });
  await fresh.run('evmRestoreOnLoad()');
  assert.equal(fresh.state().chain, 'solana');
  assert.equal(fresh.state().token, '');
  fresh.run("evmSwitchChain('robinhood')");
  await settle();
  assert.equal(fresh.state().token, 'token-robinhood');
});

test('a late-injected provider recovers the stored sign-in without prompts or switching the view', async () => {
  const original = desk();
  await connect(original, 'bsc');
  const d = desk({ local: original.local, tab: storage(), wallet: null });
  await d.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(d.state().account, '');
  assert.equal(d.state().token, '');
  assert.equal(d.state().ready, false);
  assert.equal(d.calls.loads, 0);
  const wallet = provider('bsc');
  d.window.ethereum = wallet;
  await d.run('evmRecoverWallet()');
  assert.equal(d.state().ready, true);
  assert.equal(d.state().chain, 'bsc');
  assert.equal(wallet.calls.some(call => call.method === 'personal_sign'), false);
});

test('locked/revoked accounts and transport loss disconnect the active wallet without losing restoration hints', async () => {
  const wallet = provider();
  const d = desk({ wallet });
  await connect(d, 'robinhood');
  await connect(d, 'bsc');
  wallet.accounts = [];
  wallet.emit('accountsChanged', []);
  wallet.emit('disconnect');
  assert.equal(d.state().ready, false);
  assert.equal(d.state().account, '');
  assert.equal(d.state().token, '');
  assert.equal(d.elements.get('evmWalletBtn').textContent, 'Connect EVM wallet');
  assert.deepEqual(d.state().chains.sort(), ['bsc', 'robinhood']);
  wallet.accounts = [address];
  await d.run('evmRecoverWallet()');
  assert.equal(d.state().ready, true);
  assert.equal(d.state().token, 'token-bsc');
});

for (const chain of ['robinhood', 'bsc']) {
  for (const unavailable of ['missing', 'revoked', 'transport']) {
    test(`${chain}: stored login does not connect or load account data when wallet is ${unavailable}`, async () => {
      const original = desk();
      await connect(original, chain);
      const wallet = unavailable === 'missing' ? null : provider(chain);
      if (unavailable === 'revoked') wallet.accounts = [];
      if (unavailable === 'transport') wallet.isConnected = () => false;
      const d = desk({ local: original.local, tab: storage(), wallet });
      await d.run('evmRestoreOnLoad()');
      await settle();
      assert.equal(d.state().account, '');
      assert.equal(d.state().token, '');
      assert.equal(d.state().ready, false);
      assert.equal(d.calls.loads, 0);
      assert.equal(d.calls.balances, 0);
      assert.equal(d.elements.get('evmWalletBtn').textContent, 'Connect EVM wallet');
    });
  }
  for (const loss of ['removed', 'revoked', 'transport', 'rpc-error', 'rpc-timeout']) {
    test(`${chain}: monitoring disconnects a silently ${loss} wallet and prevents approvals`, async () => {
      const wallet = provider(chain);
      const d = desk({ wallet, walletTimeoutMs: 5 });
      await connect(d, chain);
      const before = d.calls.loads;
      const sequence = d.run('evmSequence');
      if (loss === 'removed') d.window.ethereum = null;
      if (loss === 'revoked') wallet.accounts = [];
      if (loss === 'transport') wallet.isConnected = () => false;
      if (loss === 'rpc-error') wallet.request = async () => { throw new Error('Extension removed'); };
      if (loss === 'rpc-timeout') wallet.request = () => new Promise(() => {});
      await d.run('evmRecoverWallet()');
      assert.equal(d.state().account, '');
      assert.equal(d.state().token, '');
      assert.equal(d.state().ready, false);
      assert.ok(d.run('evmSequence') > sequence);
      assert.equal(d.elements.get('evmWalletBtn').textContent, 'Connect EVM wallet');
      assert.equal(d.calls.loads, before);
      assert.equal([...d.timers.values()].some(timer => timer.delay === 10000), false);
      const requests = d.calls.requests.length;
      await assert.rejects(d.run("evmConfirmAction('balance', { amountUsd: 1 }, evmChain, evmSequence)"), /Reconnect/);
      assert.equal(d.calls.requests.length, requests);
    });
  }
}

test('removing the provider blocks confirmation even before the monitoring tick', async () => {
  const d = desk();
  await connect(d, 'bsc');
  const requests = d.calls.requests.length;
  d.window.ethereum = null;
  await assert.rejects(d.run("evmConfirmAction('balance', { amountUsd: 1 }, evmChain, evmSequence)"), /disconnected/);
  assert.equal(d.state().token, '');
  assert.equal(d.calls.requests.length, requests);
});

test('wallet removal during login cannot publish a connected account', async () => {
  const wallet = provider();
  const d = desk({ wallet });
  const request = wallet.request;
  wallet.request = async params => {
    const result = await request(params);
    if (params.method === 'personal_sign') d.window.ethereum = null;
    return result;
  };
  d.run("evmSwitchChain('bsc')");
  await d.run('evmConnect()');
  assert.equal(d.state().account, '');
  assert.equal(d.state().token, '');
  assert.equal(d.state().ready, false);
  assert.equal(d.calls.loads, 0);
});

test('a late account RPC cannot reconnect the view after a disconnect event', async () => {
  const original = desk();
  await connect(original, 'bsc');
  const wallet = provider();
  const request = wallet.request;
  let resolveAccounts;
  wallet.request = params => params.method === 'eth_accounts'
    ? new Promise(resolve => { resolveAccounts = resolve; })
    : request(params);
  const d = desk({ local: original.local, tab: storage(), wallet });
  await d.run('evmRestoreOnLoad()');
  wallet.emit('disconnect');
  resolveAccounts([address]);
  await settle();
  assert.equal(d.state().account, '');
  assert.equal(d.state().token, '');
  assert.equal(d.calls.loads, 0);
});

for (const loss of ['removed', 'revoked']) {
  test(`a pending recovery state request cannot prevent monitoring a silently ${loss} wallet`, async () => {
    const original = desk();
    await connect(original, 'bsc');
    const d = desk({ local: original.local, tab: storage(), wallet: null });
    await d.run('evmRestoreOnLoad()');
    d.run(`evmLoadState = () => new Promise(resolve => { globalThis.finishState = resolve; });`);
    const wallet = provider();
    d.window.ethereum = wallet;
    const recovery = d.run('evmRecoverWallet()');
    await settle();
    assert.equal(d.state().ready, true);
    assert.equal(d.run('evmWalletRecoveryRunning'), false);
    if (loss === 'removed') d.window.ethereum = null;
    else wallet.accounts = [];
    await d.run('evmRecoverWallet()');
    assert.equal(d.state().account, '');
    assert.equal(d.state().token, '');
    assert.equal(d.state().ready, false);
    assert.equal(d.elements.get('evmWalletBtn').textContent, 'Connect EVM wallet');
    d.context.finishState();
    await recovery;
    assert.equal(d.state().token, '');
  });
}

test('a positively changed account invalidates the old sessions on both networks', async () => {
  const wallet = provider();
  const d = desk({ wallet });
  await connect(d, 'robinhood');
  await connect(d, 'bsc');
  wallet.accounts = [otherAddress];
  wallet.emit('accountsChanged', wallet.accounts);
  assert.equal(d.state().token, '');
  assert.deepEqual(d.state().chains, []);
  assert.deepEqual(JSON.parse(d.local.getItem(key)), {});
});

test('a mismatched account on restoration is not shown as the connected wallet', async () => {
  const original = desk();
  await connect(original, 'bsc');
  const wallet = provider();
  wallet.accounts = [otherAddress];
  const d = desk({ local: original.local, tab: storage(), wallet });
  await d.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(d.state().token, '');
  assert.equal(d.state().account, '');
  assert.deepEqual(JSON.parse(d.local.getItem(key)), {});
});

test('explicit disconnect signs out only that chain and stays disconnected on refresh', async () => {
  const d = desk();
  await connect(d, 'robinhood');
  await connect(d, 'bsc');
  await d.run('evmDisconnect()');
  assert.deepEqual(d.state().chains, ['robinhood']);
  const fresh = desk({ local: d.local, tab: storage() });
  await fresh.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(fresh.state().token, '');
  assert.deepEqual(fresh.state().chains, ['robinhood']);
  assert.ok(d.calls.requests.includes('/auth/logout'));
});

test('a sign-out in another tab clears the active view and invalidates in-flight confirmations', async () => {
  const d = desk();
  await connect(d, 'bsc');
  const sequence = d.run('evmSequence');
  d.local.setItem(key, '{}');
  d.events.storage({ key });
  assert.equal(d.state().token, '');
  assert.ok(d.run('evmSequence') > sequence);
  assert.deepEqual(d.state().chains, []);
});

test('a view switch cannot resurrect another tab’s logout before its storage event arrives', async () => {
  const first = desk();
  await connect(first, 'robinhood');
  await connect(first, 'bsc');
  const stale = desk({ local: first.local, tab: storage() });
  await stale.run('evmRestoreOnLoad()');
  await settle();
  stale.run("evmSwitchChain('robinhood')");
  await settle();
  await first.run('evmDisconnect()');
  // Deliberately delay the storage event until after the stale tab navigates.
  stale.run("evmSwitchChain('solana')");
  await settle();
  assert.deepEqual(Object.keys(JSON.parse(first.local.getItem(key))), ['robinhood']);
  stale.events.storage({ key });
  stale.run("evmSwitchChain('bsc')");
  await settle();
  assert.equal(stale.state().token, '');
  assert.deepEqual(stale.state().chains, ['robinhood']);
});

test('a stale tab’s login on RH preserves a newer BNB login from another tab', async () => {
  const first = desk();
  await connect(first, 'bsc');
  const stale = desk({ local: first.local, tab: storage() });
  await stale.run('evmRestoreOnLoad()');
  await settle();
  // This represents a newer signed-in BNB session before the event is delivered.
  const saved = JSON.parse(first.local.getItem(key));
  saved.bsc.token = 'newer-bsc-token';
  first.local.setItem(key, JSON.stringify(saved));
  await connect(stale, 'robinhood');
  assert.equal(JSON.parse(first.local.getItem(key)).bsc.token, 'newer-bsc-token');
  stale.run("evmSwitchChain('bsc')");
  await settle();
  assert.equal(stale.state().token, 'newer-bsc-token');
});

test('a pending restoration cannot force the user back after switching to Solana', async () => {
  const first = desk();
  await connect(first, 'bsc');
  const wallet = provider('bsc');
  const request = wallet.request;
  let finish;
  wallet.request = params => params.method === 'eth_accounts'
    ? new Promise(resolve => { finish = resolve; })
    : request(params);
  const d = desk({ local: first.local, tab: storage(), wallet });
  await d.run('evmRestoreOnLoad()');
  d.run("evmSwitchChain('solana')");
  finish([address]);
  await settle();
  assert.equal(d.state().chain, 'solana');
  assert.equal(d.state().token, '');
  assert.deepEqual(d.state().chains, ['bsc']);
});

for (const status of [401, 403]) {
  test(`an old restoration’s ${status} cannot remove a newer same-chain login`, async () => {
    const first = desk();
    await connect(first, 'bsc');
    const d = desk({ local: first.local, tab: storage() });
    d.run(`evmLoadState = async () => {
      if (evmToken === 'newer-bsc-token') return;
      await new Promise((resolve, reject) => { globalThis.rejectOldState = reject; });
    }`);
    await d.run('evmRestoreOnLoad()');
    await settle();
    const saved = JSON.parse(first.local.getItem(key));
    saved.bsc.token = 'newer-bsc-token';
    first.local.setItem(key, JSON.stringify(saved));
    // The storage event is still queued when the previous login is rejected.
    const error = new Error('Old login rejected');
    error.status = status;
    d.context.rejectOldState(error);
    await settle();
    assert.equal(JSON.parse(first.local.getItem(key)).bsc.token, 'newer-bsc-token');
    assert.equal(d.state().token, 'newer-bsc-token');
    assert.equal(d.state().ready, true);
    assert.equal(d.calls.requests.includes('/auth/logout'), false);
  });
}

test('expired server sessions are removed instead of restoring an unusable connection', async () => {
  const original = desk();
  await connect(original, 'bsc');
  const d = desk({ local: original.local, tab: storage(), loadStatus: 401 });
  await d.run('evmRestoreOnLoad()');
  await settle();
  assert.equal(d.state().token, '');
  assert.deepEqual(JSON.parse(d.local.getItem(key)), {});
});

for (const chain of ['robinhood', 'bsc']) {
  test(`${chain}: quietly restored login still blocks actions on the wrong wallet network`, async () => {
    const original = desk();
    await connect(original, chain);
    const wallet = provider(chain === 'bsc' ? 'robinhood' : 'bsc');
    const d = desk({ local: original.local, tab: storage(), wallet });
    await d.run('evmRestoreOnLoad()');
    await settle();
    assert.equal(d.state().token, `token-${chain}`);
    assert.equal(d.calls.statuses.at(-1), '');
    await assert.rejects(d.run("evmConfirmAction('balance', { amountUsd: 1 }, evmChain, evmSequence)"), /network changed/);
    assert.equal(wallet.calls.some(call => call.method === 'personal_sign'), false);
  });
}

test('restored sign-in still requires a fresh exact-action signature', async () => {
  const original = desk();
  await connect(original, 'bsc');
  const wallet = provider('bsc');
  const d = desk({ local: original.local, tab: storage(), wallet });
  await d.run('evmRestoreOnLoad()');
  await settle();
  const result = await d.run("evmConfirmAction('balance', { amountUsd: 1 }, evmChain, evmSequence)");
  assert.equal(result.intentSignature, 'fixture-signature');
  assert.equal(wallet.calls.filter(call => call.method === 'personal_sign').length, 1);
  assert.match(wallet.calls.find(call => call.method === 'personal_sign').params[0], /^MemePerp Testnet Confirm ADD TEST BALANCE\n/);
  assert.match(wallet.calls.find(call => call.method === 'personal_sign').params[0], /No on-chain transaction or wallet funds transfer\.$/);
});

test('invalid session storage is ignored without making the view fail to load', async () => {
  for (const value of ['{invalid-json', '[]', '{"constructor":{"account":"' + address + '","token":"bad"}}']) {
    const d = desk({ local: storage(new Map([[key, value], [selectedKey, 'bsc']])) });
    await d.run('evmRestoreOnLoad()');
    await settle();
    assert.equal(d.state().token, '');
    assert.deepEqual(d.state().chains, []);
  }
});

test('an explicitly selected discovery-only wallet can sign in without window.ethereum', async () => {
  const wallet = provider('bsc');
  const d = desk({ wallet: null });
  d.window.MemePerpWallets = {
    choose: async () => wallet, currentEvm: () => wallet, cancelPicker() {},
  };
  await d.run("evmSwitchChain('bsc'); evmConnect()");
  assert.equal(d.state().ready, true);
  assert.equal(d.state().account, address);
  assert.equal(wallet.calls.filter(call => call.method === 'personal_sign').length, 1);
  assert.equal(d.elements.get('evmWalletBtn').disabled, false);
});

test('cancelling the wallet picker sends no sign-in requests', async () => {
  const d = desk({ wallet: null });
  d.window.MemePerpWallets = {
    choose: async () => null, currentEvm: () => null, cancelPicker() {},
  };
  await d.run("evmSwitchChain('bsc'); evmConnect()");
  assert.equal(d.state().ready, false);
  assert.equal(d.calls.requests.length, 0);
  assert.equal(d.elements.get('evmWalletBtn').disabled, false);
});

test('changing chains while choosing a wallet cancels the old connection before prompting', async () => {
  const wallet = provider('robinhood');
  const d = desk({ wallet: null });
  let release;
  d.window.MemePerpWallets = {
    choose: () => new Promise(resolve => { release = resolve; }),
    currentEvm: () => wallet, cancelPicker() {},
  };
  const pending = d.run("evmSwitchChain('robinhood'); evmConnect()");
  d.run("evmSwitchChain('bsc')");
  release(wallet);
  await pending;
  assert.equal(d.state().chain, 'bsc');
  assert.equal(d.state().ready, false);
  assert.equal(wallet.calls.length, 0);
  assert.equal(d.calls.requests.length, 0);
});

test('storage failure does not turn a successful wallet login into a failed connection', async () => {
  const unavailable = {
    getItem() { throw new Error('Storage disabled'); },
    setItem() { throw new Error('Storage disabled'); },
  };
  const d = desk({ local: storage(), tab: unavailable });
  await connect(d, 'bsc');
  assert.equal(d.state().account, address);
  assert.ok(d.calls.warnings.length);
});