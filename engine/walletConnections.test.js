const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('./walletConnections.js'), 'utf8');
const safety = require('./walletSafety');

function app() {
  class CustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  }
  const window = new EventTarget();
  window.location = { href: 'https://desk.example/testnet.html?foo=bar#positions' };
  const context = vm.createContext({
    window, Event, CustomEvent, URL, Uint8Array, Set, Map, console,
    setInterval, clearInterval, document: {},
  });
  vm.runInContext(source, context);
  return {
    window, api: window.MemePerpWallets,
    announce(type, detail) { window.dispatchEvent(new CustomEvent(type, { detail })); },
  };
}
function standard(name = 'Jupiter') {
  const account = {
    address: '11111111111111111111111111111111',
    publicKey: new Uint8Array(32),
    chains: ['solana:devnet'], features: ['solana:signMessage'],
  };
  let change;
  const calls = [];
  const wallet = {
    name, chains: ['solana:devnet'], accounts: [],
    features: {
      'standard:connect': { async connect(options) {
        calls.push(['connect', options]);
        wallet.accounts = [account];
        return { accounts: [account] };
      } },
      'standard:events': { on(type, listener) { change = listener; return () => { calls.push(['off']); }; } },
      'standard:disconnect': { async disconnect() { calls.push(['disconnect']); } },
      'solana:signMessage': { async signMessage(input) {
        calls.push(['sign', input]);
        return [{ signature: new Uint8Array(64), signedMessage: input.message }];
      } },
    },
  };
  return { wallet, account, calls, change: accounts => change({ accounts }) };
}

test('Jupiter registers late through Wallet Standard without window.solana', async () => {
  const a = app();
  const w = standard();
  a.announce('wallet-standard:register-wallet', api => api.register(w.wallet));
  const [provider] = a.api.solanaProviders();
  assert.equal(provider.name, 'Jupiter');
  assert.equal(provider.isConnected, false);
  assert.equal((await provider.connect()).publicKey.toString(), w.account.address);
  const message = 'MemePerp Connect Confirmation\nNonce: 123\nConnection only. No transaction or funds will be transferred.';
  const result = await safety.signSolanaMessage(provider, message);
  assert.equal(result.signature.length, 64);
  assert.equal(w.calls.filter(([type]) => type === 'sign').length, 1);
  assert.equal(provider.signTransaction, undefined);
});

test('app-ready registers a wallet present before the app discovery request', () => {
  const a = app();
  const w = standard('Phantom');
  a.window.addEventListener('wallet-standard:app-ready', event => event.detail.register(w.wallet));
  a.api.discover();
  a.api.discover();
  assert.equal(a.api.solanaProviders().length, 1);
});

test('silent recovery stays silent and accountsChanged removes signing authority', async () => {
  const a = app(), w = standard();
  a.announce('wallet-standard:register-wallet', api => api.register(w.wallet));
  const [provider] = a.api.solanaProviders();
  await provider.connect({ onlyIfTrusted: true });
  assert.equal(w.calls[0][1].silent, true);
  let changed = 'not-called';
  provider.on('accountChanged', value => { changed = value; });
  w.change([]);
  assert.equal(changed, null);
  assert.equal(provider.publicKey, null);
  await assert.rejects(provider.signMessage(new Uint8Array([1])), /Reconnect/);
});

test('unsigned, changed and incomplete wallet responses are rejected', async () => {
  const a = app(), w = standard();
  a.announce('wallet-standard:register-wallet', api => api.register(w.wallet));
  const [provider] = a.api.solanaProviders();
  await provider.connect();
  w.wallet.features['solana:signMessage'].signMessage = async () =>
    [{ signature: new Uint8Array(64), signedMessage: new Uint8Array([2]) }];
  await assert.rejects(provider.signMessage(new Uint8Array([1])), /requested readable message/);
  w.wallet.features['solana:signMessage'].signMessage = async ({ message }) =>
    [{ signature: new Uint8Array(63), signedMessage: message }];
  await assert.rejects(provider.signMessage(new Uint8Array([1])), /requested readable message/);
  w.wallet.features['solana:signMessage'].signMessage = async ({ message }) => {
    w.change([]);
    return [{ signature: new Uint8Array(64), signedMessage: message }];
  };
  await assert.rejects(provider.signMessage(new Uint8Array([1])), /account changed/);
});

test('unregister removes events and local authority without disconnecting the wallet remotely', async () => {
  const a = app(), w = standard();
  let unregister;
  a.announce('wallet-standard:register-wallet', api => { unregister = api.register(w.wallet); });
  const [provider] = a.api.solanaProviders();
  await provider.connect();
  unregister();
  assert.equal(a.api.solanaProviders().length, 0);
  assert.equal(provider.isConnected, false);
  assert.equal(w.calls.some(([type]) => type === 'off'), true);
  assert.equal(w.calls.some(([type]) => type === 'disconnect'), false);
});

test('unsupported wallets are excluded and legacy Phantom providers are discovered', () => {
  const a = app(), w = standard();
  delete w.wallet.features['solana:signMessage'];
  a.announce('wallet-standard:register-wallet', api => api.register(w.wallet));
  assert.equal(a.api.solanaProviders().length, 0);
  const legacy = { connect() {}, signMessage() {}, isPhantom: true };
  a.window.phantom = { solana: legacy };
  a.window.solana = legacy;
  assert.equal(a.api.solanaProviders().length, 1);
  assert.equal(a.api.solanaProviders()[0], legacy);
});

test('EIP-6963 discovers EVM wallets without window.ethereum and pins explicit selection', async () => {
  const a = app();
  const provider = { request() {} };
  a.announce('eip6963:announceProvider', { info: { uuid: 'metamask', name: 'MetaMask' }, provider });
  assert.equal(a.api.currentEvm(), provider);
  assert.equal(await a.api.choose('bsc'), provider);
  const other = { request() {} };
  a.window.ethereum = other;
  assert.equal(a.api.currentEvm(), provider);
  a.announce('eip6963:announceProvider', { info: { uuid: 'metamask', name: 'MetaMask' }, provider });
  assert.equal(a.api.evmProviders().length, 2);
});

test('mobile browse links preserve the route and selected chain without signing or session data', () => {
  const a = app();
  const sol = a.api.browseLinks('solana', a.window.location.href);
  assert.equal(sol.length, 3);
  assert.equal(new URL(sol[0][1]).host, 'phantom.com');
  const phantomTarget = new URL(decodeURIComponent(new URL(sol[0][1]).pathname.slice('/ul/browse/'.length)));
  assert.equal(phantomTarget.searchParams.get('walletChain'), 'solana');
  assert.equal(phantomTarget.hash, '');
  const evm = a.api.browseLinks('robinhood', a.window.location.href);
  assert.equal(evm.length, 1);
  assert.match(evm[0][1], /walletChain=robinhood/);
  assert.equal(a.api.browseLinks('solana', 'file:///testnet.html').length, 0);
});