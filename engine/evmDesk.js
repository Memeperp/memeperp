/* Isolated EVM trading desk. Never calls the Solana engine. */
const EVM_NETWORKS = {
  robinhood: { label: 'Robinhood Chain', id: '0x1237', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', currency: 'ETH' },
  bsc: { label: 'BNB Smart Chain', id: '0x38', rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com', currency: 'BNB' },
};
let evmChain = 'solana';
let evmProvider = null;
let evmAccount = '';
let evmToken = '';
let evmWalletReady = false;
let evmConnecting = null;
let evmMarket = null;
let evmChartVisible = false;
let evmSearchItems = [];
let evmCurrentState = null;
let evmCollateralQuote = null;
let evmRefreshTimer = null;
let evmWalletRecoveryTimer = null;
let evmWalletRecoveryRunning = false;
let evmSequence = 0;
let evmOpening = false;
let evmMarketRequest = 0;
let evmMarketChoice = '';
let evmDefaultMarketAttempted = false;
const evmMarketStorageKey = () => `mp_testnet_evm_market_${evmChain}_${evmAccount.toLowerCase()}`;
const evmSessions = new Map();
const EVM_SELECTED_CHAIN_KEY = 'mp_testnet_selected_chain';
const EVM_SESSION_KEY = 'mp_testnet_evm_sessions';
function evmRememberSessions(changedChain = null, expectedSession = null) {
  if (changedChain) {
    // Storage events arrive asynchronously. Merge only this login/logout into
    // the latest persistent state, never another tab's stale full snapshot.
    const changedSession = evmSessions.get(changedChain);
    evmHydrateSessions();
    const latest = evmSessions.get(changedChain);
    if (expectedSession && latest &&
      (latest.token !== expectedSession.token ||
        latest.account.toLowerCase() !== expectedSession.account.toLowerCase())) return false;
    if (changedSession) evmSessions.set(changedChain, changedSession);
    else evmSessions.delete(changedChain);
  }
  const saved = {};
  for (const [chain, session] of evmSessions) {
    if (EVM_NETWORKS[chain] && session?.account && session?.token)
      saved[chain] = { account: session.account, token: session.token };
  }
  // Wallet browsers can recreate the preview tab on refresh. Keep sign-ins
  // across those documents, while the server still enforces their 24h expiry.
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      // On startup, migrate a legacy login only if no persistent record exists.
      // Normal view changes and restores must not rewrite other tabs' logins.
      if (storage === 'sessionStorage' || changedChain ||
        (window[storage].getItem(EVM_SESSION_KEY) == null && Object.keys(saved).length))
        window[storage].setItem(EVM_SESSION_KEY, JSON.stringify(saved));
    }
    catch (error) { console.warn(`Could not save EVM sessions in ${storage}:`, error.message); }
  }
  return true;
}
function evmForgetSession(chain, expectedSession = null) {
  evmSessions.delete(chain);
  return evmRememberSessions(chain, expectedSession);
}
function evmReadSavedSessions() {
  let saved = {};
  let raw = null;
  try { raw = localStorage.getItem(EVM_SESSION_KEY); } catch (_) {}
  // Migrate existing tab-only logins. An explicitly empty persistent store
  // is authoritative, so an older tab cannot resurrect a disconnected login.
  if (raw == null) {
    try { raw = sessionStorage.getItem(EVM_SESSION_KEY); } catch (_) {}
  }
  try { saved = JSON.parse(raw || '{}') || {}; } catch (_) {}
  return typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}
function evmHydrateSessions() {
  const saved = evmReadSavedSessions();
  const valid = new Set();
  for (const [chain, session] of Object.entries(saved)) {
    if (!Object.hasOwn(EVM_NETWORKS, chain) ||
      !/^0x[a-fA-F0-9]{40}$/.test(session?.account || '') ||
      typeof session?.token !== 'string' || !session.token) continue;
    valid.add(chain);
    const previous = evmSessions.get(chain);
    if (previous?.account === session.account && previous?.token === session.token) continue;
    evmSessions.set(chain, { account: session.account, token: session.token, provider: evmInjectedProvider() });
  }
  for (const chain of evmSessions.keys()) {
    if (!valid.has(chain)) evmSessions.delete(chain);
  }
}
async function evmRestoreOnLoad() {
  // Hydrate before any wallet RPC so switching views during restoration cannot
  // lose a remembered chain or later force the user back to the old selection.
  evmHydrateSessions();
  evmRememberSessions();
  let selected = 'solana';
  try { selected = localStorage.getItem(EVM_SELECTED_CHAIN_KEY) || 'solana'; } catch (_) {}
  const handoffChain = new URLSearchParams(window.location?.search || '').get('walletChain');
  if (handoffChain === 'solana' || Object.hasOwn(EVM_NETWORKS, handoffChain)) selected = handoffChain;
  if (Object.hasOwn(EVM_NETWORKS, selected)) evmSwitchChain(selected);
  else if (handoffChain === 'solana') evmSwitchChain('solana');
  if (handoffChain && window.history?.replaceState && window.location?.href) {
    const url = new URL(window.location.href);
    url.searchParams.delete('walletChain');
    window.history.replaceState(null, '', url);
  }
}
async function evmRecoverWallet() {
  if (evmWalletRecoveryRunning || document.hidden) return;
  const chain = evmChain;
  const sequence = evmSequence;
  const session = evmSessions.get(chain);
  if (!EVM_NETWORKS[chain] || !session) return;
  const provider = evmAvailableProvider();
  if (!provider) {
    evmPauseWallet();
    return;
  }
  evmWalletRecoveryRunning = true;
  let verifiedWallet = null;
  try {
    const accounts = await evmWalletAccounts(provider);
    if (sequence !== evmSequence || chain !== evmChain ||
      evmSessions.get(chain) !== session) return;
    if (!accounts?.length || evmAvailableProvider() !== provider) {
      evmPauseWallet();
      return;
    }
    if (String(accounts[0]).toLowerCase() !== session.account.toLowerCase()) {
      evmInvalidateRestoredSession(chain, session, 'Wallet account changed. Connect again to continue.');
      return;
    }
    if (evmWalletReady && evmProvider === provider && evmToken === session.token) return;
    session.provider = provider;
    verifiedWallet = { provider, accounts };
  } catch (_) {
    if (sequence === evmSequence && chain === evmChain) evmPauseWallet();
  } finally {
    evmWalletRecoveryRunning = false;
  }
  // Only serialize the bounded wallet probe. A slow backend or chain-status
  // request must never stop monitoring the live wallet's availability.
  if (verifiedWallet) await evmResumeSession(chain, sequence, session, verifiedWallet);
}
function evmAvailableProvider() {
  const provider = evmInjectedProvider();
  try {
    return provider && (typeof provider.isConnected !== 'function' || provider.isConnected())
      ? provider : null;
  } catch (_) { return null; }
}
async function evmWalletAccounts(provider) {
  let timeout;
  try {
    return await Promise.race([
      evmWalletRequest(provider, { method: 'eth_accounts' }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Wallet did not respond.')), 3000);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}
function evmWalletRequest(provider, request) {
  return MemePerpWalletSafety.requestEvm(provider, request);
}
function evmPauseWallet(forceInvalidate = false) {
  if (!EVM_NETWORKS[evmChain]) return;
  if (forceInvalidate || evmAccount || evmToken || evmWalletReady) {
    evmSequence++;
    evmReset();
  }
  // A cached login is only a restoration hint, never a live wallet connection.
  evmStatus('Wallet disconnected. Connect or unlock your EVM wallet to continue.');
  if (evmSessions.has(evmChain)) evmWatchWallet();
}
function evmWatchWallet() {
  if (evmWalletRecoveryTimer) clearInterval(evmWalletRecoveryTimer);
  evmWalletRecoveryTimer = setInterval(evmRecoverWallet, 1000);
}
window.addEventListener('focus', evmRecoverWallet);
window.addEventListener('pageshow', evmRecoverWallet);
window.addEventListener('ethereum#initialized', evmRecoverWallet);
document.addEventListener('visibilitychange', evmRecoverWallet);
window.addEventListener('storage', event => {
  if (event.key !== EVM_SESSION_KEY) return;
  evmHydrateSessions();
  const session = evmSessions.get(evmChain);
  if (!EVM_NETWORKS[evmChain] ||
    (session?.token === evmToken && session?.account === evmAccount) ||
    (!session && !evmToken)) return;
  // Reflect a sign-out or replacement login from another tab, invalidating any
  // in-flight approval before showing the updated account.
  evmSequence++;
  evmReset();
  if (session) evmResumeSession(evmChain, evmSequence, session);
  else {
    evmLoadPublicQuote(evmChain, evmSequence);
    evmStatus('Wallet disconnected in another tab. Connect again to continue.');
  }
});
const evmMutatingPositionIds = new Set();
const evmMutatingOrderIds = new Set();
const evmEl = id => document.getElementById(id);
const evmMoney = value => `${Number(value) < 0 ? '-' : ''}$${Math.abs(Number(value || 0)).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const evmCompactMoney = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 'Unavailable';
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
  return evmMoney(amount);
};
const evmPrice = value => Number(value || 0).toLocaleString('en-US', { maximumSignificantDigits: 8 });
const evmNative = value => Number(value || 0).toLocaleString('en-US', { maximumSignificantDigits: 10, maximumFractionDigits: 18 });
const evmSymbol = () => evmCollateralQuote?.symbol || EVM_NETWORKS[evmChain]?.currency || 'native';
const evmQuotePrice = () => Number(evmCollateralQuote?.priceUsd);
const evmNativeMoney = value => `${evmNative(value)} ${evmSymbol()}`;
const evmNativeField = value => value == null || !Number.isFinite(Number(value)) ? 'unavailable' : evmNativeMoney(value);
const evmUsdValue = value => Number.isFinite(evmQuotePrice()) && evmQuotePrice() > 0
  ? evmMoney(Number(value) * evmQuotePrice()) : 'USD value unavailable';
function evmSetQuote(data) {
  const symbol = String(data?.collateralSymbol || data?.symbol || EVM_NETWORKS[evmChain]?.currency || '');
  const priceUsd = Number(data?.collateralPriceUsd ?? data?.priceUsd);
  evmCollateralQuote = symbol && Number.isFinite(priceUsd) && priceUsd > 0 ? { symbol, priceUsd } : null;
  evmUpdateChainLabels();
  evmUpdatePreview();
  evmSyncOpenButton();
}
function evmUpdateChainLabels() {
  const symbol = EVM_NETWORKS[evmChain]?.currency || 'native';
  const label = evmEl('evmMarginLabel');
  const input = evmEl('evmMargin');
  if (label) label.textContent = `Margin amount (${symbol})`;
  if (input) input.placeholder = `Enter ${symbol} margin`;
}
function evmSyncOpenButton() {
  const button = evmEl('evmOpenBtn');
  if (!button) return;
  // The "Connect wallet" call to action must remain clickable when logged out.
  button.disabled = evmOpening || Boolean(evmToken && (!evmMarket || !evmCollateralQuote || !evmWalletReady));
  if (evmToken && !evmWalletReady) button.title = 'Unlock your EVM wallet before submitting an order.';
  else if (evmToken && !evmCollateralQuote) button.title = 'Order submission is unavailable until a live native collateral USD quote is available.';
  else button.removeAttribute('title');
}
function evmLoadPublicQuote(chain, sequence) {
  evmRequest(`/collateral?chain=${encodeURIComponent(chain)}`)
    .then(data => {
      if (sequence !== evmSequence || chain !== evmChain || evmToken) return;
      evmSetQuote(data);
      evmEl('evmCollateralQuote').textContent = evmCollateralQuote
        ? `Live collateral quote: 1 ${evmCollateralQuote.symbol} = ${evmMoney(evmCollateralQuote.priceUsd)}.`
        : 'Native collateral USD conversion unavailable; order submission is disabled.';
    })
    .catch(() => {
      if (sequence === evmSequence && chain === evmChain && !evmToken) {
        evmSetQuote(null);
        evmEl('evmCollateralQuote').textContent = 'Live native collateral quote unavailable; USD conversions are unavailable and order submission is disabled.';
      }
    });
}
for (let leverage = 1; leverage <= 20; leverage++) {
  const option = document.createElement('option');
  option.value = String(leverage);
  option.textContent = `${leverage}x`;
  if (leverage === 3) option.selected = true;
  evmEl('evmLeverage').append(option);
}
evmEl('evmMode').addEventListener('change', evmUpdatePreview);
evmUpdatePreview();

function evmStatus(message) {
  evmEl('evmStatus').textContent = message;
  evmEl('evmOrderStatus').textContent = message;
}
let evmDialogSubmit = null;
let evmDialogVersion = 0;
function evmCloseActionDialog() {
  evmDialogVersion++;
  const dialog = evmEl('evmActionDialog');
  dialog.classList.remove('show');
  dialog.setAttribute('aria-hidden', 'true');
  evmDialogSubmit = null;
}
function evmOpenActionDialog({ title, description, fields, submit }) {
  evmDialogVersion++;
  evmEl('evmActionSubmit').disabled = false;
  evmEl('evmActionTitle').textContent = title;
  evmEl('evmActionDescription').textContent = description;
  evmEl('evmActionError').textContent = '';
  const wrap = evmEl('evmActionFields');
  wrap.replaceChildren();
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = `evmAction_${field.name}`;
    const input = document.createElement('input');
    input.id = label.htmlFor;
    input.name = field.name;
    input.type = 'number';
    input.step = 'any';
    input.placeholder = field.placeholder || '';
    input.value = field.value == null ? '' : String(field.value);
    input.required = Boolean(field.required);
    wrap.append(label, input);
  }
  evmDialogSubmit = submit;
  const dialog = evmEl('evmActionDialog');
  dialog.classList.add('show');
  dialog.setAttribute('aria-hidden', 'false');
  wrap.querySelector('input')?.focus();
}
async function evmSubmitActionDialog(event) {
  event.preventDefault();
  if (!evmDialogSubmit) return;
  const submit = evmDialogSubmit;
  const button = evmEl('evmActionSubmit');
  const originalLabel = button.textContent;
  const fields = Object.fromEntries(new FormData(evmEl('evmActionForm')).entries());
  button.disabled = true;
  button.textContent = 'Confirm in wallet…';
  try {
    await submit(fields);
    if (evmDialogSubmit === submit) evmCloseActionDialog();
  } catch (error) {
    if (evmDialogSubmit === submit) evmEl('evmActionError').textContent = error.message || 'Unable to complete the request.';
  } finally {
    if (evmDialogSubmit === submit) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && evmEl('evmActionDialog').classList.contains('show')) evmCloseActionDialog();
});
function evmToggleSearch(open = null) {
  const panel = evmEl('evmSearchPanel');
  const expanded = open == null ? !panel.classList.contains('open') : Boolean(open);
  panel.classList.toggle('open', expanded);
  evmEl('evmMarketPicker').setAttribute('aria-expanded', String(expanded));
  if (expanded) evmEl('evmSearchInput').focus();
}
document.addEventListener('click', event => {
  if (evmChain !== 'solana' && !event.target.closest('#evmMarketPicker, #evmSearchPanel, #evmChartEmpty button')) evmToggleSearch(false);
});
function evmSetSide(side) {
  if (!['long', 'short'].includes(side)) return;
  evmEl('evmSide').value = side;
  for (const value of ['long', 'short']) {
    const button = evmEl(value === 'long' ? 'evmLongBtn' : 'evmShortBtn');
    button.classList.toggle('active', value === side);
    button.setAttribute('aria-pressed', String(value === side));
  }
  evmUpdatePreview();
}
function evmShowLedgerTab(tab) {
  if (!['positions', 'orders', 'closed', 'activity', 'profile'].includes(tab)) return;
  document.querySelectorAll('[data-evm-tab]').forEach(button => {
    const active = button.dataset.evmTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-evm-view]').forEach(view => view.classList.toggle('active', view.dataset.evmView === tab));
}
async function evmRequest(route, options = {}) {
  const res = await fetch(`/api/evm${route}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(evmToken ? { Authorization: `Bearer ${evmToken}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}
function evmReset() {
  evmCloseActionDialog();
  evmOpening = false;
  evmMutatingPositionIds.clear();
  evmMutatingOrderIds.clear();
  evmAccount = '';
  evmToken = '';
  evmWalletReady = false;
  evmProvider = null;
  evmMarket = null;
  evmMarketRequest++;
  evmMarketChoice = '';
  evmDefaultMarketAttempted = false;
  evmToggleChart(false);
  evmSearchItems = [];
  evmCurrentState = null;
  evmCollateralQuote = null;
  evmEl('evmSearchInput').value = '';
  evmToggleSearch(false);
  evmShowLedgerTab('positions');
  if (evmRefreshTimer) clearInterval(evmRefreshTimer);
  evmRefreshTimer = null;
  if (evmWalletRecoveryTimer) clearInterval(evmWalletRecoveryTimer);
  evmWalletRecoveryTimer = null;
  evmEl('evmResults').textContent = 'Search markets on this network.';
  evmEl('evmSelected').textContent = 'No market selected';
  evmEl('evmSelected').classList.remove('is-copyable');
  evmEl('evmSelected').removeAttribute('title');
  evmEl('evmSelected').onclick = null;
  evmEl('evmMarketCard').classList.add('no-market');
  evmEl('evmChartEmpty').style.display = 'flex';
  evmEl('evmChartLink').classList.remove('is-visible');
  evmEl('evmChartLink').removeAttribute('href');
  evmEl('evmPositions').textContent = 'Connect your EVM wallet to view positions.';
  evmEl('evmOrders').textContent = 'Connect your EVM wallet to view pending orders.';
  evmEl('evmClosed').textContent = 'No closed positions.';
  evmEl('evmActivity').textContent = 'Connect your EVM wallet to view activity.';
  evmEl('evmProfile').style.display = 'block';
  evmEl('evmProfile').innerHTML = '<div class="evm-empty">Connect wallet to view profile.</div><button type="button" class="btn" onclick="evmConnect()">Connect wallet</button>';
  evmEl('evmMarketDetails').style.display = 'none';
  evmEl('evmChart').removeAttribute('src');
  evmEl('evmChart').classList.remove('is-visible');
  evmEl('evmCollateralQuote').textContent = 'Native collateral conversion unavailable.';
  evmRenderPnl(null);
  evmEl('evmOpenBtn').textContent = 'Connect wallet to trade';
  evmSyncOpenButton();
  evmEl('evmWalletBtn').textContent = 'Connect EVM wallet';
  evmEl('evmWalletBtn').disabled = false;
  evmEl('evmWalletBtn').onclick = evmConnect;
  evmEl('evmWalletBtn').removeAttribute('title');
  for (const id of ['evmPositions', 'evmOrders', 'evmClosed', 'evmActivity']) evmEl(id).classList.add('evm-empty');
}
function evmRenderPnl(state) {
  const unrealized = evmEl('evmUnrealizedPnl');
  const realized = evmEl('evmRealizedPnl');
  if (!state) {
    for (const el of [unrealized, realized]) {
      el.textContent = '—';
      el.className = 'v';
    }
    return;
  }
  const positions = Array.isArray(state.positions) ? state.positions : [];
  const hasMissingMark = positions.some(pos => pos.unrealizedPnlUsd == null);
  const unrealizedUsd = Number(state.portfolio?.unrealizedPnlUsd);
  const realizedUsd = Number(state.realizedPnlUsd);
  const unrealizedBasis = Number(state.portfolio?.marginUsedUsd || 0);
  const realizedBasis = Number(state.realizedBasisUsd || 0);
  function show(el, value, basis) {
    if (!Number.isFinite(value)) {
      el.textContent = '—';
      el.className = 'v';
      return;
    }
    const percent = basis > 0 ? value / basis * 100 : value === 0 ? 0 : null;
    const prefix = value >= 0 ? '+' : '';
    const percentageLabel = percent == null ? '' : ` (${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%)`;
    el.textContent = `${prefix}${evmMoney(value)}${percentageLabel}`;
    el.className = `v ${value >= 0 ? 'good' : 'bad'}`;
  }
  if (hasMissingMark) {
    unrealized.textContent = 'Price unavailable';
    unrealized.className = 'v';
  } else show(unrealized, unrealizedUsd, unrealizedBasis);
  show(realized, realizedUsd, realizedBasis);
}
function evmShowWalletBalance(balance = null, placeholder = 'Loading balance…') {
  const button = evmEl('evmWalletBtn');
  const address = document.createElement('span');
  address.className = 'wallet-btn-main';
  address.textContent = `${evmAccount.slice(0, 6)}…${evmAccount.slice(-4)}`;
  const amount = document.createElement('span');
  amount.className = 'wallet-btn-sub';
  amount.textContent = balance == null ? placeholder : evmNativeField(balance);
  button.replaceChildren(address, amount);
  button.title = 'Disconnect EVM wallet';
  button.onclick = evmDisconnect;
}
function evmStartRefresh() {
  if (evmRefreshTimer) clearInterval(evmRefreshTimer);
  evmRefreshTimer = setInterval(async () => {
    if (document.hidden) return;
    await evmRecoverWallet();
    if (evmToken && evmWalletReady && evmChain !== 'solana')
      evmLoadState().catch(err => evmStatus(err.message));
  }, 10000);
}
function evmInvalidateRestoredSession(chain, session, message) {
  const removed = evmForgetSession(chain, session);
  evmSequence++;
  evmReset();
  const replacement = evmSessions.get(chain);
  if (!removed && replacement) {
    // An older account check or HTTP response must not delete a newer login.
    evmResumeSession(chain, evmSequence, replacement);
    return;
  }
  evmStatus(message);
  evmLoadPublicQuote(chain, evmSequence);
}
async function evmResumeSession(chain, sequence, session, verifiedWallet = null) {
  let accounts = [];
  const provider = evmAvailableProvider();
  if (!provider) {
    evmPauseWallet();
    return;
  }
  session.provider = provider;
  evmBindProviderEvents(provider);
  try {
    accounts = verifiedWallet?.provider === provider
      ? verifiedWallet.accounts : await evmWalletAccounts(provider);
  }
  catch (_) {
    if (sequence === evmSequence && chain === evmChain) evmPauseWallet();
    return;
  }
  if (sequence !== evmSequence || chain !== evmChain || evmSessions.get(chain) !== session) return;
  if (!accounts?.length || evmAvailableProvider() !== provider) {
    evmPauseWallet();
    return;
  }
  if (accounts?.length && String(accounts[0]).toLowerCase() !== session.account.toLowerCase()) {
    evmInvalidateRestoredSession(chain, session, 'Wallet account changed. Connect again to view this account.');
    return;
  }
  evmProvider = session.provider;
  evmBindProviderEvents(session.provider);
  evmAccount = session.account;
  evmToken = session.token;
  evmWalletReady = Boolean(accounts?.length);
  evmWatchWallet();
  evmShowWalletBalance();
  if (!evmCurrentState) {
    evmEl('evmPositions').textContent = 'Loading positions…';
    evmEl('evmOrders').textContent = 'Loading pending orders…';
    evmEl('evmActivity').textContent = 'Loading activity…';
  }
  evmOrderTypeChange();
  try {
    await evmLoadState();
    if (sequence !== evmSequence || chain !== evmChain) return;
    evmStartRefresh();
    evmStatus('');
  } catch (error) {
    if (sequence !== evmSequence || chain !== evmChain) return;
    if (error.status === 401 || error.status === 403) {
      evmInvalidateRestoredSession(chain, session, 'Wallet session expired. Connect again to continue.');
    } else {
      evmStartRefresh();
      if (!evmCurrentState) {
        evmShowWalletBalance(null, 'Balance unavailable');
        for (const id of ['evmPositions', 'evmOrders', 'evmActivity'])
          evmEl(id).textContent = 'Account data unavailable. Retrying…';
      }
      evmStatus(`Wallet session restored, but balance could not refresh: ${error.message}`);
    }
  }
}
function evmSwitchChain(chain) {
  window.MemePerpWallets?.cancelPicker();
  if (chain !== 'solana' && !EVM_NETWORKS[chain]) return;
  evmHydrateSessions();
  try { localStorage.setItem(EVM_SELECTED_CHAIN_KEY, chain); }
  catch (error) { console.warn('Could not remember the selected network:', error.message); }
  if (chain === evmChain) return;
  evmSequence++;
  evmReset();
  evmChain = chain;
  evmEl('chainSwitchTest').value = chain;
  document.body.classList.toggle('evm-active', chain !== 'solana');
  setTrendingTickerChain(chain);
  if (chain === 'solana') return;
  // Draft protection belongs to the order being composed, not the next chain.
  evmEl('evmTpSlToggle').checked = false;
  evmToggleTpSl();
  evmRiskModes.order = { tp: { trigger: 'roi', size: 'pct' }, sl: { trigger: 'roi', size: 'pct' } };
  evmBuildRiskFields('order', evmEl('evmTpSlFields'));
  evmUpdateChainLabels();
  evmEl('evmLeverage').value = '3';
  evmSetSide('long');
  evmOrderTypeChange();
  evmUpdatePreview();
  evmStatus('');
  const session = evmSessions.get(chain);
  if (session) evmResumeSession(chain, evmSequence, session);
  else evmLoadPublicQuote(chain, evmSequence);
}
function evmInjectedProvider() {
  if (window.MemePerpWallets) return window.MemePerpWallets.currentEvm();
  const providers = window.ethereum?.providers || (window.ethereum ? [window.ethereum] : []);
  return providers.find(p => typeof p?.request === 'function') || null;
}
function evmBindProviderEvents(provider) {
  if (typeof provider?.on !== 'function' || provider.__memePerpBound) return;
  provider.__memePerpBound = true;
  provider.on('accountsChanged', accounts => {
    if (provider !== evmInjectedProvider()) return;
    const next = String(accounts?.[0] || '').toLowerCase();
    if (!next) {
      evmPauseWallet(true);
      return;
    }
    const activeChanged = Boolean(evmAccount && evmAccount.toLowerCase() !== next);
    for (const [chain, session] of evmSessions) {
      if (session.account.toLowerCase() !== next) evmForgetSession(chain);
    }
    if (activeChanged) evmDisconnect();
    else if (!evmAccount && evmSessions.get(evmChain)?.account.toLowerCase() === next)
      evmResumeSession(evmChain, evmSequence, evmSessions.get(evmChain));
  });
  provider.on('chainChanged', id => {
    if (evmAccount && String(id).toLowerCase() !== EVM_NETWORKS[evmChain]?.id) {
      evmSequence++;
      evmStatus(`Wallet network changed. Switch back to ${EVM_NETWORKS[evmChain].label} before confirming an action.`);
    }
  });
  provider.on('disconnect', () => {
    if (provider === evmInjectedProvider() || provider === evmProvider) evmPauseWallet(true);
  });
}
async function evmConnect() {
  if (evmConnecting === evmSequence) return;
  const chain = evmChain;
  const sequence = evmSequence;
  const net = EVM_NETWORKS[chain];
  if (!net) return;
  evmConnecting = sequence;
  evmEl('evmWalletBtn').disabled = true;
  try {
    const provider = window.MemePerpWallets
      ? await window.MemePerpWallets.choose(chain) : evmInjectedProvider();
    if (!provider && window.MemePerpWallets) return;
    if (!provider) throw new Error('No EVM wallet detected. Install or unlock an EVM-compatible wallet.');
    if (sequence !== evmSequence || chain !== evmChain) return;
    evmStatus('Approve the network and account requests in your wallet…');
    let current = await evmWalletRequest(provider, { method: 'eth_chainId' });
    if (sequence !== evmSequence || chain !== evmChain) return;
    if (String(current).toLowerCase() !== net.id) {
      try {
        await evmWalletRequest(provider, { method: 'wallet_switchEthereumChain', params: [{ chainId: net.id }] });
      } catch (err) {
        if (err.code !== 4902 && err?.data?.originalError?.code !== 4902) throw err;
        await evmWalletRequest(provider, { method: 'wallet_addEthereumChain', params: [{
          chainId: net.id, chainName: net.label, rpcUrls: [net.rpc],
          nativeCurrency: { name: net.currency, symbol: net.currency, decimals: 18 },
          blockExplorerUrls: [net.explorer],
        }] });
      }
      current = await evmWalletRequest(provider, { method: 'eth_chainId' });
      if (String(current).toLowerCase() !== net.id) throw new Error('Wallet is not on the selected network');
    }
    if (sequence !== evmSequence || chain !== evmChain) return;
    const [address] = await evmWalletRequest(provider, { method: 'eth_requestAccounts' });
    if (sequence !== evmSequence || chain !== evmChain) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) throw new Error('Wallet did not return an EVM address');
    const { message } = await evmRequest('/auth/challenge', { method: 'POST', body: JSON.stringify({ chain, address }) });
    if (sequence !== evmSequence || chain !== evmChain) return;
    evmStatus('Sign the login message. This does not transfer funds.');
    const signature = await evmWalletRequest(provider, { method: 'personal_sign', params: [message, address] });
    if (sequence !== evmSequence || chain !== evmChain) return;
    const { token } = await evmRequest('/auth/verify', { method: 'POST', body: JSON.stringify({ chain, address, message, signature }) });
    if (sequence !== evmSequence) return;
    const [liveAccounts, liveChain] = await Promise.all([
      evmWalletAccounts(provider), evmWalletRequest(provider, { method: 'eth_chainId' }),
    ]);
    if (sequence !== evmSequence || chain !== evmChain) return;
    if (evmAvailableProvider() !== provider ||
      String(liveAccounts?.[0] || '').toLowerCase() !== address.toLowerCase() ||
      String(liveChain).toLowerCase() !== net.id)
      throw new Error('Wallet unavailable or account/network changed. Connect again.');
    evmProvider = provider;
    evmAccount = address;
    evmToken = token;
    evmWalletReady = true;
    evmSessions.set(chain, { account: address, token, provider });
    evmRememberSessions(chain);
    evmWatchWallet();
    evmShowWalletBalance();
    evmStatus('');
    evmBindProviderEvents(provider);
    await evmLoadState();
    evmSyncOpenButton();
    evmOrderTypeChange();
    evmStartRefresh();
  } catch (error) {
    if (sequence === evmSequence) evmStatus(`Connection failed: ${error.message}`);
  } finally {
    if (evmConnecting === sequence) {
      evmConnecting = null;
      evmEl('evmWalletBtn').disabled = false;
    }
  }
}
async function evmDisconnect() {
  const token = evmToken;
  evmForgetSession(evmChain);
  if (token) evmRequest('/auth/logout', { method: 'POST' }).catch(() => {});
  evmSequence++;
  evmReset();
  evmEl('evmWalletBtn').removeAttribute('title');
  evmStatus('Wallet disconnected. Positions remain saved to the signed wallet and selected chain.');
  if (EVM_NETWORKS[evmChain]) evmLoadPublicQuote(evmChain, evmSequence);
}
async function evmSearch() {
  const chain = evmChain;
  const q = evmEl('evmSearchInput').value.trim();
  if (!q || !EVM_NETWORKS[chain]) return;
  const sequence = evmSequence;
  evmEl('evmResults').textContent = 'Searching live markets…';
  try {
    const data = await evmRequest(`/search?chain=${encodeURIComponent(chain)}&q=${encodeURIComponent(q)}`);
    if (sequence !== evmSequence || q !== evmEl('evmSearchInput').value.trim()) return;
    evmSearchItems = data.items || [];
    const wrap = evmEl('evmResults');
    wrap.replaceChildren();
    if (!evmSearchItems.length) { wrap.textContent = 'No indexed token markets found on this network. Try a 0x contract address.'; return; }
    evmSearchItems.forEach((item, i) => {
      const button = document.createElement('button');
      button.className = 'evm-result';
      button.type = 'button';
      const title = document.createElement('strong');
      title.textContent = `${item.sym} · ${item.name}`;
      const detail = document.createElement('div');
      detail.className = 'evm-muted';
      detail.textContent = item.referencePrice
        ? `ETH/USD reference · price from ${item.priceSource} · no Robinhood token liquidity implied`
        : `${item.addr.slice(0, 8)}…${item.addr.slice(-6)} · $${evmPrice(item.priceUsd)} · Liquidity ${evmMoney(item.liquidityUsd)}`;
      button.append(title, detail);
      button.onclick = () => evmSelect(i);
      wrap.append(button);
    });
  } catch (error) { if (sequence === evmSequence) evmEl('evmResults').textContent = error.message; }
}
async function evmSelect(index) {
  const candidate = evmSearchItems[index];
  return evmSelectMarket(candidate);
}
function evmToggleChart(show = !evmChartVisible) {
  evmChartVisible = Boolean(show && evmMarket);
  const toggle = evmEl('evmChartToggle');
  toggle.disabled = !evmMarket;
  toggle.textContent = evmChartVisible ? 'CHART ON' : 'CHART OFF';
  toggle.classList.toggle('on', evmChartVisible);
  toggle.setAttribute('aria-pressed', String(evmChartVisible));
  const chart = evmEl('evmChart');
  const shell = evmEl('evmChartShell');
  const link = evmEl('evmChartLink');
  shell.style.display = evmChartVisible ? 'block' : 'none';
  if (evmChartVisible) {
    const url = `https://dexscreener.com/${encodeURIComponent(evmMarket.chartChain || evmChain)}/${encodeURIComponent(evmMarket.addr)}`;
    chart.src = `${url}?embed=1&theme=dark&trades=0&info=0`;
    chart.classList.add('is-visible');
    link.href = url;
    link.classList.add('is-visible');
  } else {
    chart.removeAttribute('src');
    chart.classList.remove('is-visible');
    link.removeAttribute('href');
    link.classList.remove('is-visible');
  }
}
async function evmSelectMarket(candidate, automatic = false) {
  const sequence = evmSequence;
  if (!candidate) return;
  const request = ++evmMarketRequest;
  if (!automatic) {
    evmMarketChoice = String(candidate.addr || '').toLowerCase();
    evmDefaultMarketAttempted = true;
    if (EVM_NETWORKS[evmChain] && evmAccount && /^0x[a-fA-F0-9]{40}$/.test(evmMarketChoice))
      localStorage.setItem(evmMarketStorageKey(), evmMarketChoice);
  }
  evmMarket = null;
  evmToggleChart(false);
  evmSyncOpenButton();
  evmEl('evmSelected').textContent = 'Checking the live market…';
  try {
    const market = await evmRequest(`/market?chain=${encodeURIComponent(evmChain)}&address=${encodeURIComponent(candidate.addr)}`);
    if (sequence !== evmSequence || request !== evmMarketRequest) return;
    evmMarket = market;
    evmToggleChart(false);
    evmToggleSearch(false);
    const selected = evmEl('evmSelected');
    selected.replaceChildren(document.createTextNode(
      market.referencePrice ? 'Selected token: ETH - Ether / USD reference' : `Selected token: ${market.sym} - ${market.name}`
    ));
    const marker = document.createElement('span');
    marker.className = 'verified-check';
    marker.textContent = '✓';
    marker.title = 'Selected market';
    marker.setAttribute('aria-label', 'Selected market');
    selected.append(marker);
    selected.classList.add('is-copyable');
    selected.title = `${market.addr} · Click to copy contract address`;
    selected.onclick = async () => {
      try {
        await navigator.clipboard.writeText(market.addr);
        evmStatus('Contract address copied.');
      } catch (_) {
        evmStatus(`Contract address: ${market.addr}`);
      }
    };
    evmEl('evmMarketCard').classList.remove('no-market');
    evmEl('evmMarketDetails').style.display = 'block';
    evmEl('evmMarketPrice').textContent = `$${evmPrice(market.priceUsd)}`;
    evmEl('evmMarketLiquidity').textContent = market.referencePrice ? 'Not applicable' : evmMoney(market.liquidityUsd);
    evmEl('evmMarketFdv').textContent = evmCompactMoney(market.fdvUsd);
    evmEl('evmMarketCap').textContent = market.referencePrice ? 'Not applicable' : evmCompactMoney(market.marketCapUsd);
    const ageMinutes = market.createdAt ? Math.max(0, Math.floor((Date.now() - market.createdAt) / 60000)) : null;
    evmEl('evmMarketAge').textContent = ageMinutes == null ? 'Unavailable'
      : ageMinutes < 60 ? `${ageMinutes}m`
      : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`
      : `${Math.floor(ageMinutes / 1440)}d ${Math.floor(ageMinutes % 1440 / 60)}h`;
    evmEl('evmMarketChange').textContent = market.change24h == null ? 'Unavailable' : `${Number(market.change24h) >= 0 ? '+' : ''}${Number(market.change24h).toFixed(2)}%`;
    evmEl('evmMarketChain').textContent = EVM_NETWORKS[evmChain].label;
    evmEl('evmMarketAddressLabel').textContent = market.referencePrice ? 'Price source' : 'Contract';
    evmEl('evmMarketAddress').textContent = market.referencePrice ? market.priceSource : `${market.addr.slice(0, 9)}…${market.addr.slice(-7)}`;
    evmSyncOpenButton();
    evmOrderTypeChange();
    evmUpdatePreview();
  } catch (error) {
    if (sequence === evmSequence && request === evmMarketRequest) {
      evmMarket = null;
      evmToggleChart(false);
      const savedPosition = automatic && evmCurrentState?.positions?.find(pos =>
        pos.addr?.toLowerCase() === String(candidate.addr || '').toLowerCase());
      evmEl('evmSelected').textContent = savedPosition
        ? `Open position: ${savedPosition.sym}${savedPosition.name ? ` - ${savedPosition.name}` : ''} · live market unavailable`
        : error.message;
      if (savedPosition) evmDefaultMarketAttempted = false;
      evmEl('evmSelected').classList.remove('is-copyable');
      evmEl('evmSelected').removeAttribute('title');
      evmEl('evmSelected').onclick = null;
      evmEl('evmMarketCard').classList.add('no-market');
      evmEl('evmMarketDetails').style.display = 'none';
      evmEl('evmChart').removeAttribute('src');
      evmEl('evmChart').classList.remove('is-visible');
      evmEl('evmChartEmpty').style.display = 'flex';
      evmEl('evmChartLink').classList.remove('is-visible');
      evmUpdatePreview();
    }
  }
}
function evmOrderTypeChange() {
  const type = evmEl('evmOrderType').value;
  evmEl('evmTriggerWrap').style.display = type === 'market' ? 'none' : 'block';
  evmEl('evmTriggerLabel').textContent = type === 'limit' ? 'Limit price (USD per token)' : 'Stop trigger (USD per token)';
  evmEl('evmTriggerPrice').required = type !== 'market';
  evmEl('evmOpenBtn').textContent = evmToken
    ? (type === 'market' ? 'Open position' : `Place ${type} order`)
    : 'Connect wallet to trade';
  evmSyncOpenButton();
  evmUpdatePreview();
}
function evmToggleTpSl() {
  evmEl('evmTpSlFields').style.display = evmEl('evmTpSlToggle').checked ? 'block' : 'none';
}
const evmRiskModes = {
  order: { tp: { trigger: 'roi', size: 'pct' }, sl: { trigger: 'roi', size: 'pct' } },
  edit: { tp: { trigger: 'roi', size: 'pct' }, sl: { trigger: 'roi', size: 'pct' } },
};
const evmRiskFields = ['tp', 'tpRoi', 'sl', 'slRoi', 'tpQty', 'tpQtyPct', 'slQty', 'slQtyPct'];
function evmRiskContext(position = null) {
  if (position) return { entry: Number(position.entry), qty: Number(position.qty), leverage: Number(position.leverage), side: position.side };
  const mark = Number(evmMarket?.priceUsd);
  const limit = Number(evmEl('evmTriggerPrice').value);
  const entry = evmEl('evmOrderType').value === 'limit' && limit > 0 ? limit : mark;
  const qty = Number(evmEl('evmMargin').value) * Number(evmEl('evmLeverage').value) * evmQuotePrice() / entry;
  return { entry, qty, leverage: Number(evmEl('evmLeverage').value), side: evmEl('evmSide').value };
}
function evmRiskInput(scope, field) {
  return evmEl(`evmRisk_${scope}_${field}`);
}
function evmSyncRisk(scope, leg, edited, context) {
  const mode = evmRiskModes[scope][leg];
  if (edited === 'roi' || edited === 'price') mode.trigger = edited;
  if (edited === 'pct' || edited === 'qty') mode.size = edited;
  const roi = evmRiskInput(scope, `${leg}Roi`);
  const price = evmRiskInput(scope, leg);
  const pct = evmRiskInput(scope, `${leg}QtyPct`);
  const qty = evmRiskInput(scope, `${leg}Qty`);
  const { entry, leverage, side } = context();
  if (edited === 'roi') {
    const n = Number(roi.value);
    const move = Math.abs(n) / (100 * leverage);
    const sign = (side === 'short' ? -1 : 1) * (leg === 'sl' ? -1 : 1);
    price.value = roi.value !== '' && entry > 0 && leverage > 0 && n !== 0
      ? String(Number((entry * (1 + sign * move)).toPrecision(12))) : '';
  } else if (edited === 'price') {
    const n = Number(price.value);
    const computed = ((n - entry) / entry) * leverage * 100 * (side === 'short' ? -1 : 1);
    roi.value = price.value !== '' && n > 0 && entry > 0 && leverage > 0
      ? String(Number(computed.toFixed(4))) : '';
  } else if (edited === 'pct') {
    qty.value = pct.value !== '' && context().qty > 0
      ? String(Number((Number(pct.value) * context().qty / 100).toPrecision(12))) : '';
  } else if (edited === 'qty') {
    pct.value = qty.value !== '' && context().qty > 0
      ? String(Number((Number(qty.value) / context().qty * 100).toFixed(4))) : '';
  }
  const note = evmEl(`evmRisk_${scope}_${leg}Mode`);
  if (note) note.textContent = `Saved as ${mode.trigger === 'roi' ? 'ROI' : 'price'} and ${mode.size === 'pct' ? 'percentage' : 'quantity'}; other values are previews.`;
}
function evmBuildRiskFields(scope, container, source = {}, context = () => evmRiskContext()) {
  container.replaceChildren();
  for (const leg of ['tp', 'sl']) {
    const label = document.createElement('div');
    label.className = 'evm-field-label';
    label.textContent = leg === 'tp' ? 'Take profit' : 'Stop loss';
    container.append(label);
    for (const pair of [
      [['Roi', 'ROI %', 'roi'], ['', 'Price (USD per token)', 'price']],
      [['QtyPct', 'Close %', 'pct'], ['Qty', 'Close quantity (tokens)', 'qty']],
    ]) {
      const row = document.createElement('div');
      row.className = 'evm-form-row';
      for (const [suffix, placeholder, edited] of pair) {
        const field = leg + suffix;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.id = `evmRisk_${scope}_${field}`;
        input.name = field;
        input.setAttribute('aria-label', `${leg === 'tp' ? 'Take-profit' : 'Stop-loss'} ${placeholder}`);
        input.placeholder = placeholder;
        input.value = source[field] == null ? '' : String(source[field]);
        input.addEventListener('input', () => evmSyncRisk(scope, leg, edited, context));
        row.append(input);
      }
      container.append(row);
    }
    const note = document.createElement('div');
    note.className = 'evm-muted';
    note.id = `evmRisk_${scope}_${leg}Mode`;
    container.append(note);
    evmSyncRisk(scope, leg, '', context);
  }
}
function evmReadRisk(scope, context) {
  const values = Object.fromEntries(evmRiskFields.map(field => [field, null]));
  for (const leg of ['tp', 'sl']) {
    const mode = evmRiskModes[scope][leg];
    const triggerField = mode.trigger === 'roi' ? `${leg}Roi` : leg;
    const sizeField = mode.size === 'pct' ? `${leg}QtyPct` : `${leg}Qty`;
    const triggerRaw = evmRiskInput(scope, triggerField).value.trim();
    const sizeRaw = evmRiskInput(scope, sizeField).value.trim();
    if (!triggerRaw && !sizeRaw) continue;
    if (!triggerRaw || !sizeRaw) throw new Error(`${leg.toUpperCase()} needs both a trigger and a close ${mode.size === 'pct' ? 'percentage' : 'quantity'}.`);
    const trigger = Number(triggerRaw);
    const size = Number(sizeRaw);
    if (!Number.isFinite(trigger) || (mode.trigger === 'roi'
      ? (leg === 'tp' ? trigger <= 0 || trigger > 1000 : trigger >= 0 || trigger < -100)
      : trigger <= 0)) throw new Error(`Enter a valid ${leg.toUpperCase()} ${mode.trigger === 'roi' ? 'ROI' : 'price'}.`);
    if (!Number.isFinite(size) || size <= 0 || (mode.size === 'pct' ? size > 100 : context.qty > 0 && size > context.qty))
      throw new Error(`Enter a ${leg.toUpperCase()} close ${mode.size === 'pct' ? 'percentage greater than 0 and no more than 100' : 'quantity no greater than the position'}.`);
    if (mode.trigger === 'price' && context.entry > 0) {
      const goodDirection = (context.side === 'short' ? -1 : 1) * (leg === 'sl' ? -1 : 1) * (trigger - context.entry) > 0;
      if (!goodDirection) throw new Error(`${leg.toUpperCase()} price must be on the ${leg === 'tp' ? 'profit' : 'loss'} side of entry.`);
    }
    values[triggerField] = trigger;
    values[sizeField] = size;
  }
  return values;
}
evmBuildRiskFields('order', evmEl('evmTpSlFields'));
function evmSetMarginPct(percent) {
  if (!evmCurrentState) return evmStatus(`Connect your wallet to load your ${evmSymbol()} balance.`);
  if (!evmCollateralQuote) return evmStatus('Wait for a live collateral quote before choosing a margin preset.');
  const balance = Number(evmCurrentState.portfolio?.availableBalanceNative ?? evmCurrentState.availableBalanceNative ?? evmCurrentState.balanceNative);
  if (!Number.isFinite(balance) || balance <= 0) return evmStatus('No available balance to use for a margin preset.');
  const leverage = Number(evmEl('evmLeverage').value || 1);
  const maxAffordable = balance / (1 + leverage * 0.0006);
  const maxOrder = Math.min(maxAffordable, 1000 / evmQuotePrice());
  evmEl('evmMargin').value = (maxOrder * percent / 100 * 0.999999).toPrecision(10).replace(/\.?0+$/, '');
  evmUpdatePreview();
}
function evmAddBalance() {
  if (!evmToken) return evmStatus('Connect your EVM wallet first.');
  if (!evmWalletReady) return evmStatus('Unlock your EVM wallet before adding test balance.');
  if (!evmCollateralQuote) return evmStatus('Cannot add to your balance until a live native collateral USD quote is available.');
  const chain = evmChain;
  const sequence = evmSequence;
  const symbol = evmSymbol();
  const window = evmCurrentState?.creditWindow;
  const used = window && Date.now() - Number(window.startedAt) < 6 * 60 * 60 * 1000 ? Number(window.amountUsd || 0) : 0;
  evmOpenActionDialog({
    title: 'Add test balance',
    description: `Enter a USD amount. Up to ${evmMoney(Math.max(0, 1000 - used))} remains in the six-hour credit window on ${EVM_NETWORKS[chain].label}. The server converts it to ${symbol} at the live quote (about ${evmMoney(evmQuotePrice())} per ${symbol}).`,
    fields: [{ name: 'amountUsd', label: 'Amount to add (USD)', placeholder: 'e.g. 1000', required: true }],
    submit: async ({ amountUsd: raw }) => {
      const amountUsd = Number(raw);
      if (!raw || !Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1000) throw new Error('Enter a USD amount from $1 to $1,000.');
      const confirmed = await evmConfirmAction('balance', { amountUsd }, chain, sequence, evmDialogVersion);
      const result = await evmRequest('/balance/add', { method: 'POST', body: JSON.stringify(confirmed) });
      if (sequence !== evmSequence || chain !== evmChain) return;
      evmStatus(`Added ${evmMoney(result.amountUsd)} (about ${evmNativeMoney(result.amountNative)}) to your ${EVM_NETWORKS[chain].label} balance. ${evmMoney(result.remainingUsd)} remains in this six-hour credit window.`);
      await evmLoadState();
    },
  });
}
function evmUpdatePreview() {
  if (!evmEl('evmPreviewEntry')) return;
  const marketPrice = Number(evmMarket?.priceUsd || 0);
  const triggerPrice = Number(evmEl('evmTriggerPrice')?.value || 0);
  const entry = evmEl('evmOrderType')?.value === 'market' ? marketPrice : triggerPrice;
  const type = evmEl('evmOrderType')?.value;
  const side = evmEl('evmSide')?.value;
  const hint = evmEl('evmTriggerHint');
  if (hint) {
    const waits = type === 'limit'
      ? (side === 'long' ? triggerPrice < marketPrice : triggerPrice > marketPrice)
      : (side === 'long' ? triggerPrice > marketPrice : triggerPrice < marketPrice);
    hint.textContent = marketPrice > 0 && triggerPrice > 0
      ? waits
        ? `Waits for the live price to ${side === 'long' ? type === 'limit' ? 'fall' : 'rise' : type === 'limit' ? 'rise' : 'fall'} to your ${type === 'limit' ? 'limit' : 'trigger'}. See it in Orders.`
        : type === 'limit'
          ? `This limit would fill immediately. Choose a ${side === 'long' ? 'lower' : 'higher'} limit to leave it pending, or select Market.`
          : 'This stop may trigger immediately at the live price.'
      : type === 'limit'
        ? 'A long limit waits below the current price; a short limit waits above it.'
        : 'A long stop waits above the current price; a short stop waits below it.';
  }
  const marginNative = Number(evmEl('evmMargin')?.value || 0);
  const leverage = Number(evmEl('evmLeverage')?.value || 1);
  evmEl('evmPreviewEntry').textContent = entry > 0
    ? `Entry $${evmPrice(entry)} · spot ${marketPrice > 0 ? '$' + evmPrice(marketPrice) : 'unavailable'}` : '—';
  evmEl('evmPreviewMargin').textContent = Number.isFinite(evmQuotePrice()) && evmQuotePrice() > 0
    ? `${evmNativeMoney(marginNative)} · ${evmUsdValue(marginNative)}` : `${evmNativeMoney(marginNative)} · USD conversion unavailable`;
  evmEl('evmPreviewNotional').textContent = Number.isFinite(evmQuotePrice()) && evmQuotePrice() > 0
    ? `${evmMoney(marginNative * evmQuotePrice() * leverage)} · ${evmNative(marginNative * leverage)} ${evmSymbol()} eq.`
    : `USD conversion unavailable · ${evmNative(marginNative * leverage)} ${evmSymbol()} eq.`;
  evmEl('evmPreviewMode').textContent = (evmEl('evmMode')?.value || 'isolated').toUpperCase();
}
async function evmConfirmAction(action, payload, chain, sequence, dialogVersion = null) {
  const provider = evmProvider;
  const account = evmAccount;
  const token = evmToken;
  if (!provider || !account || !token) throw new Error('Reconnect your EVM wallet before confirming this action.');
  if (evmAvailableProvider() !== provider) {
    evmPauseWallet();
    throw new Error('Wallet disconnected. Connect again before confirming this action.');
  }
  if (!evmWalletReady) throw new Error('Unlock your EVM wallet before confirming this action.');
  const { intentId, message } = await evmRequest('/auth/order-intent', {
    method: 'POST', body: JSON.stringify({ action, order: payload }),
  });
  if (sequence !== evmSequence || chain !== evmChain || token !== evmToken ||
    (dialogVersion != null && dialogVersion !== evmDialogVersion)) throw new Error('Action cancelled.');
  const [walletChain, walletAccounts] = await Promise.all([
    evmWalletRequest(provider, { method: 'eth_chainId' }),
    evmWalletRequest(provider, { method: 'eth_accounts' }),
  ]);
  if (String(walletChain).toLowerCase() !== EVM_NETWORKS[chain]?.id ||
    String(walletAccounts?.[0] || '').toLowerCase() !== account.toLowerCase()) {
    throw new Error('Connected wallet or network changed. Reconnect before trading.');
  }
  evmStatus('Confirm this simulated action in your wallet. No wallet funds move.');
  let intentSignature;
  try {
    intentSignature = await evmWalletRequest(provider, { method: 'personal_sign', params: [message, account] });
  } catch (_) {
    throw new Error('Wallet confirmation was rejected. No action was taken.');
  }
  if (sequence !== evmSequence || chain !== evmChain || token !== evmToken || account !== evmAccount ||
    (dialogVersion != null && dialogVersion !== evmDialogVersion)) {
    throw new Error('Wallet or network changed. Action cancelled.');
  }
  const [confirmedChain, confirmedAccounts] = await Promise.all([
    evmWalletRequest(provider, { method: 'eth_chainId' }),
    evmWalletRequest(provider, { method: 'eth_accounts' }),
  ]);
  if (String(confirmedChain).toLowerCase() !== EVM_NETWORKS[chain]?.id ||
    String(confirmedAccounts?.[0] || '').toLowerCase() !== account.toLowerCase() ||
    sequence !== evmSequence || token !== evmToken ||
    (dialogVersion != null && dialogVersion !== evmDialogVersion)) {
    throw new Error('Wallet or network changed. Action cancelled.');
  }
  return { ...payload, intentId, intentSignature };
}
async function evmOpen() {
  if (evmOpening) return;
  if (!evmToken) return evmConnect();
  if (!evmMarket) return evmStatus('Select a live token market first.');
  if (!evmCollateralQuote) return evmStatus('Order submission is disabled because the live native collateral USD quote is unavailable.');
  const chain = evmChain;
  const sequence = evmSequence;
  const button = evmEl('evmOpenBtn');
  const type = evmEl('evmOrderType').value;
  const marginNative = Number(evmEl('evmMargin').value);
  const triggerPrice = Number(evmEl('evmTriggerPrice').value);
  const marginUsd = marginNative * evmQuotePrice();
  if (!Number.isFinite(marginNative) || marginNative <= 0) return evmStatus(`Enter a positive margin amount in ${evmSymbol()}.`);
  if (!Number.isFinite(marginUsd) || marginUsd <= 0) return evmStatus('Native margin cannot be converted to USD without a valid live collateral quote.');
  if (marginUsd < 1 || marginUsd > 1000) return evmStatus('Margin must be worth $1–$1,000 at the live collateral quote.');
  const availableNative = Number(evmCurrentState?.portfolio?.availableBalanceNative ?? evmCurrentState?.availableBalanceNative ?? evmCurrentState?.balanceNative);
  const leverage = Number(evmEl('evmLeverage').value);
  if (Number.isFinite(availableNative) && marginNative * (1 + leverage * 0.0006) > availableNative + 1e-12)
    return evmStatus(`Margin plus the estimated fee exceeds your available ${evmSymbol()} test balance. Add test balance or use a smaller margin.`);
  if (type !== 'market' && (!Number.isFinite(triggerPrice) || triggerPrice <= 0)) return evmStatus('Enter a positive trigger / limit price.');
  const currentPrice = Number(evmMarket.priceUsd);
  if (type === 'limit' && Number.isFinite(currentPrice) &&
    (evmEl('evmSide').value === 'long' ? triggerPrice >= currentPrice : triggerPrice <= currentPrice)) {
    return evmStatus(`This limit would fill at the displayed price. Choose a ${evmEl('evmSide').value === 'long' ? 'lower' : 'higher'} limit to leave it pending, or use Market.`);
  }
  let risk = Object.fromEntries(evmRiskFields.map(field => [field, null]));
  try {
    if (evmEl('evmTpSlToggle').checked) {
      risk = evmReadRisk('order', evmRiskContext());
      if (risk.tp == null && risk.tpRoi == null && risk.sl == null && risk.slRoi == null)
        throw new Error('Enter a take-profit or stop-loss trigger and close size, or turn off TP/SL.');
    }
  } catch (error) { return evmStatus(error.message); }
  evmOpening = true;
  button.disabled = true;
  try {
    const route = type === 'market' ? '/positions/open' : '/orders';
    const payload = {
      address: evmMarket.addr, side: evmEl('evmSide').value,
      marginNative, leverage, mode: evmEl('evmMode').value,
      ...risk,
    };
    if (type !== 'market') {
      payload.type = type;
      payload.triggerPrice = triggerPrice;
    }
    button.textContent = 'CONFIRM IN WALLET…';
    const confirmed = await evmConfirmAction(type === 'market' ? 'open' : 'order', payload, chain, sequence);
    button.textContent = 'SUBMITTING ORDER…';
    const result = await evmRequest(route, {
      method: 'POST',
      body: JSON.stringify(confirmed),
    });
    if (sequence !== evmSequence || chain !== evmChain) return;
    evmEl('evmMargin').value = '';
    const initiallyPending = type !== 'market' && result.order?.status === 'pending';
    evmStatus(initiallyPending
      ? `${type === 'limit' ? 'Limit' : 'Stop'} order placed. Loading Orders…`
      : 'Order accepted. Updating positions…');
    try {
      await evmLoadState();
    } catch (refreshError) {
      evmShowLedgerTab(initiallyPending ? 'orders' : 'positions');
      evmStatus(`Order accepted, but the list could not refresh: ${refreshError.message}. Reconnect or reload to view it; do not submit it again.`);
      return;
    }
    if (type !== 'market' && result.order) {
      const stillPending = evmCurrentState?.orders?.some(order => order.id === result.order.id && order.status === 'pending');
      evmShowLedgerTab(stillPending ? 'orders' : 'positions');
      evmStatus(stillPending
        ? `${type === 'limit' ? 'Limit' : 'Stop'} order queued at $${evmPrice(triggerPrice)}. View or cancel it in Orders.`
        : `${type === 'limit' ? 'Limit' : 'Stop'} order filled at the live market price. View it in Positions.`);
    } else if (result.position) {
      evmShowLedgerTab('positions');
      evmStatus(`${result.position.side === 'long' ? 'Long' : 'Short'} opened at $${evmPrice(result.position.entry)}.`);
    }
  } catch (error) { if (sequence === evmSequence) evmStatus(error.message); }
  finally {
    if (sequence === evmSequence) {
      evmOpening = false;
      evmOrderTypeChange();
    }
  }
}
async function evmClose(id) {
  const positionId = String(id || '');
  if (!positionId || evmMutatingPositionIds.has(positionId)) return;
  const chain = evmChain;
  const sequence = evmSequence;
  evmMutatingPositionIds.add(positionId);
  if (evmCurrentState) evmRenderPositions(evmCurrentState);
  try {
    const confirmed = await evmConfirmAction('close', { targetId: positionId }, chain, sequence);
    evmStatus('Wallet approved. Closing position…');
    await evmRequest(`/positions/${encodeURIComponent(positionId)}/close`, {
      method: 'POST', body: JSON.stringify(confirmed),
    });
    if (sequence !== evmSequence) return;
    evmStatus('Position closed at the latest available market price.');
    await evmLoadState();
  } catch (error) { if (sequence === evmSequence) evmStatus(error.message); }
  finally {
    evmMutatingPositionIds.delete(positionId);
    if (sequence === evmSequence && evmCurrentState) evmRenderPositions(evmCurrentState);
  }
}
async function evmReducePosition(id, requestedPercent = null) {
  if (!evmToken) return evmStatus('Connect your EVM wallet to reduce a position.');
  const positionId = String(id || '');
  if (!positionId || evmMutatingPositionIds.has(positionId)) return;
  let percent = Number(requestedPercent);
  if (requestedPercent == null) {
    return evmOpenActionDialog({
      title: 'Reduce position',
      description: 'Choose how much of this position to close.',
      fields: [{ name: 'percent', label: 'Percent to close (1–99)', value: 25, required: true }],
      submit: async ({ percent: value }) => {
        if (!value || !Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) >= 100) throw new Error('Enter a percentage from 1 to 99.');
        await evmReducePosition(id, Number(value));
      },
    });
  }
  if (!Number.isFinite(percent) || percent < 1 || percent >= 100) {
    return evmStatus('Enter a reduce percentage from 1 to 99.');
  }
  const chain = evmChain;
  const sequence = evmSequence;
  const dialogVersion = evmEl('evmActionDialog').classList.contains('show') ? evmDialogVersion : null;
  evmMutatingPositionIds.add(positionId);
  evmRenderPositions(evmCurrentState || { positions: [], closed: [], orders: [], activity: [] });
  try {
    const confirmed = await evmConfirmAction('reduce', { targetId: positionId, percent }, chain, sequence, dialogVersion);
    evmStatus('Wallet approved. Reducing position…');
    await evmRequest(`/positions/${encodeURIComponent(positionId)}/reduce`, {
      method: 'POST', body: JSON.stringify(confirmed),
    });
    if (sequence !== evmSequence) return;
    evmStatus(`Reduced ${percent}% of the position. No on-chain order was sent.`);
    await evmLoadState();
  } catch (error) {
    if (sequence === evmSequence) {
      evmStatus(`Could not reduce position: ${error.message}`);
      if (dialogVersion != null && dialogVersion === evmDialogVersion) throw error;
    }
  } finally {
    evmMutatingPositionIds.delete(positionId);
    if (sequence === evmSequence && evmCurrentState) evmRenderPositions(evmCurrentState);
  }
}
function evmEditProtection(pos) {
  for (const leg of ['tp', 'sl']) {
    evmRiskModes.edit[leg] = {
      trigger: pos[leg] != null ? 'price' : 'roi',
      size: pos[`${leg}Qty`] != null ? 'qty' : 'pct',
    };
  }
  evmOpenActionDialog({
    title: `TP/SL · ${pos.sym || 'position'}`,
    description: 'Use ROI or price for each trigger, and close % or token quantity. Calculated counterparts are previews. Clear both trigger and size to remove a leg.',
    fields: [],
    submit: async () => {
      const risk = evmReadRisk('edit', evmRiskContext(pos));
      const positionId = String(pos.id);
      if (evmMutatingPositionIds.has(positionId)) throw new Error('This position already has an action pending.');
      const chain = evmChain;
      const sequence = evmSequence;
      evmMutatingPositionIds.add(positionId);
      try {
        const confirmed = await evmConfirmAction('tpsl', { targetId: positionId, ...risk }, chain, sequence, evmDialogVersion);
        evmStatus('Wallet approved. Updating TP/SL…');
        await evmRequest(`/positions/${encodeURIComponent(positionId)}/tpsl`, {
          method: 'POST', body: JSON.stringify(confirmed),
        });
        if (sequence !== evmSequence) return;
        evmStatus('TP/SL settings updated.');
        await evmLoadState();
      } finally {
        evmMutatingPositionIds.delete(positionId);
        if (sequence === evmSequence && evmCurrentState) evmRenderPositions(evmCurrentState);
      }
    },
  });
  evmBuildRiskFields('edit', evmEl('evmActionFields'), pos, () => evmRiskContext(pos));
}
function evmFormatRiskLeg(item, leg) {
  const trigger = item?.[leg] != null ? `$${evmPrice(item[leg])}`
    : item?.[`${leg}Roi`] != null ? `${item[`${leg}Roi`]}% ROI` : null;
  if (!trigger) return '';
  const size = item[`${leg}QtyPct`] != null ? `${item[`${leg}QtyPct`]}%`
    : item[`${leg}Qty`] != null ? `${evmNative(item[`${leg}Qty`])} tokens` : 'full position (existing)';
  return `${leg.toUpperCase()} ${trigger} · close ${size}`;
}
function evmRenderPositions(state) {
  const positions = Array.isArray(state.positions) ? state.positions : [];
  if (!evmDefaultMarketAttempted) {
    evmDefaultMarketAttempted = true;
    const saved = localStorage.getItem(evmMarketStorageKey());
    const top = [...positions].sort((a, b) =>
      Date.parse(b.openedAt || 0) - Date.parse(a.openedAt || 0))[0];
    const address = /^0x[a-fA-F0-9]{40}$/.test(saved || '') ? saved : top?.addr;
    if (address) evmSelectMarket({ addr: address }, true);
  }
  const wrap = evmEl('evmPositions');
  wrap.replaceChildren();
  wrap.classList.toggle('evm-empty', !positions.length);
  if (!positions.length) wrap.textContent = 'No open positions.';
  positions.forEach(pos => {
    const box = document.createElement('div');
    box.className = 'quick-pos-card';
    const head = document.createElement('div');
    head.className = 'quick-pos-head';
    const title = document.createElement('span');
    const symbol = document.createElement('b');
    symbol.className = 'evm-position-symbol';
    symbol.textContent = pos.sym || 'TOKEN';
    if (pos.addr) {
      symbol.tabIndex = 0;
      symbol.setAttribute('role', 'button');
      symbol.title = 'Show this market';
      symbol.onclick = () => evmSelectMarket({ addr: pos.addr });
      symbol.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); symbol.click(); }
      };
    }
    const side = document.createElement('span');
    side.className = pos.side === 'long' ? 'good' : 'bad';
    side.textContent = String(pos.side || '').toUpperCase();
    title.append(symbol, ' ', side);
    const pnl = document.createElement('span');
    pnl.className = 'quick-pos-pnl';
    const pnlUsd = Number(pos.unrealizedPnlUsd);
    const hasPnl = pos.unrealizedPnlUsd != null && Number.isFinite(pnlUsd);
    const quote = evmQuotePrice();
    const hasQuote = Number.isFinite(quote) && quote > 0;
    pnl.classList.add(hasPnl ? (pnlUsd >= 0 ? 'good' : 'bad') : 'muted');
    pnl.textContent = hasPnl
      ? `${pnlUsd >= 0 ? '+' : ''}${evmMoney(pnlUsd)}${hasQuote ? ` · ${pnlUsd >= 0 ? '+' : ''}${evmNative(pnlUsd / quote)} ${evmSymbol()}` : ''}`
      : 'P&L unavailable';
    head.append(title, pnl);
    const detail = document.createElement('div');
    detail.className = 'quick-pos-meta';
    const qty = Number(pos.qty);
    const marginUsd = Number(pos.marginUsd);
    const mark = Number(pos.mark);
    const entry = Number(pos.entry);
    const liq = Number(pos.liquidationPrice);
    const hasMark = pos.mark != null && Number.isFinite(mark) && mark > 0;
    const hasLiq = pos.liquidationPrice != null && Number.isFinite(liq) && liq > 0;
    const hasSize = Number.isFinite(qty) && qty > 0;
    const hasMargin = pos.marginUsd != null && Number.isFinite(marginUsd) && marginUsd > 0;
    const roe = hasPnl && hasMargin ? pnlUsd / marginUsd * 100 : null;
    const liqDistance = hasMark && hasLiq
      ? (pos.side === 'short' ? liq - mark : mark - liq) / mark * 100 : null;
    function addDetail(label, value, valueClass = '') {
      const cell = document.createElement('span');
      cell.append(`${label}: `);
      if (valueClass) {
        const emphasis = document.createElement('b');
        emphasis.className = valueClass;
        emphasis.textContent = value;
        cell.append(emphasis);
      } else cell.append(value);
      detail.append(cell);
      return cell;
    }
    function positionPriceWithMarketCap(price) {
      const value = Number(price);
      const referencePrice = Number(pos.mark);
      const referenceMarketCap = Number(pos.marketCapUsd);
      const estimatedMarketCap = value > 0 && referencePrice > 0 && referenceMarketCap > 0
        ? referenceMarketCap * value / referencePrice
        : 0;
      const capText = estimatedMarketCap > 0 ? `MC est. ${evmCompactMoney(estimatedMarketCap)}` : 'MC unavailable';
      return `${capText} · $${evmPrice(value)}`;
    }
    const openedAt = pos.openedAt ? new Date(pos.openedAt) : null;
    addDetail('Entry', Number.isFinite(entry) && entry > 0 ? positionPriceWithMarketCap(entry) : '—');
    addDetail('Mark', hasMark ? positionPriceWithMarketCap(mark) : 'unavailable');
    addDetail('Opened', openedAt && Number.isFinite(openedAt.getTime())
      ? openedAt.toLocaleString() : '—');
    addDetail('Mode', String(pos.mode || 'isolated').toUpperCase());
    addDetail('Margin', `${evmNativeField(pos.marginNative)} (${hasMargin ? evmMoney(marginUsd) : 'USD unavailable'})`);
    addDetail('Qty', hasSize ? qty.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');
    addDetail('Lev', `${pos.leverage || 1}x`);
    addDetail('ROE', roe == null ? 'unavailable' : `${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%`, roe == null ? '' : roe >= 0 ? 'good' : 'bad');
    addDetail('Notional', hasSize && Number.isFinite(entry) && hasMark
      ? `${evmMoney(qty * entry)} → ${evmMoney(qty * mark)}` : 'unavailable');
    addDetail('PnL', roe == null ? 'unavailable'
      : `${pnlUsd >= 0 ? '+' : ''}${evmMoney(pnlUsd)} (${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%)`,
    roe == null ? '' : pnlUsd >= 0 ? 'good' : 'bad');
    const liquidation = addDetail('Liq', hasLiq && hasMark ? positionPriceWithMarketCap(liq) : 'unavailable');
    const busy = evmMutatingPositionIds.has(String(pos.id || ''));
    const reduce = document.createElement('button');
    reduce.className = 'btn quick-reduce-btn';
    reduce.textContent = busy ? 'Confirm in wallet…' : 'REDUCE';
    reduce.title = 'Choose a percentage between 1% and 99%';
    reduce.disabled = busy;
    reduce.onclick = () => evmReducePosition(pos.id);
    liquidation.append(document.createElement('br'), reduce);
    const riskText = [evmFormatRiskLeg(pos, 'tp'), evmFormatRiskLeg(pos, 'sl')].filter(Boolean).join(' / ');
    if (riskText) addDetail('TP/SL', riskText);
    addDetail('Liq Dist', liqDistance == null ? 'unavailable' : `${liqDistance >= 0 ? '+' : ''}${liqDistance.toFixed(2)}%`,
      liqDistance == null ? '' : liqDistance <= 5 ? 'bad' : liqDistance <= 12 ? 'warn' : 'good');
    const buttons = document.createElement('div');
    buttons.className = 'quick-pos-actions evm-actions';
    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.textContent = busy ? 'Confirm in wallet…' : riskText ? 'Edit TP/SL' : 'Set TP/SL';
    edit.disabled = busy;
    edit.onclick = () => evmEditProtection(pos);
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = busy ? 'Confirm in wallet…' : 'Close position';
    close.disabled = busy;
    close.onclick = () => evmClose(pos.id);
    buttons.append(edit, close);
    box.append(head, detail, buttons);
    wrap.append(box);
  });
  evmRenderOrders(state.orders || []);
  const closed = Array.isArray(state.closed) ? state.closed : [];
  const history = evmEl('evmClosed');
  history.replaceChildren();
  history.classList.toggle('evm-empty', !closed.length);
  if (!closed.length) history.textContent = 'No closed positions or recorded activity.';
  closed.slice(0, 50).forEach(pos => {
    const row = document.createElement('div');
    row.className = 'evm-history-item';
    const date = pos.closedAt ? new Date(pos.closedAt).toLocaleString() : 'Date unavailable';
    row.textContent = `${pos.sym} · ${String(pos.side || '').toUpperCase()} · ${pos.reason || 'CLOSED'} · Entry $${evmPrice(pos.entry)} → Exit $${evmPrice(pos.exit)} · Realized ${evmMoney(pos.pnlUsd)} · ${date}`;
    history.append(row);
  });
  evmRenderActivity(state.activity || []);
  evmRenderProfile(state, closed, positions);
}
function evmRenderActivity(activity) {
  const wrap = evmEl('evmActivity');
  wrap.replaceChildren();
  wrap.classList.toggle('evm-empty', !Array.isArray(activity) || !activity.some(event => event && typeof event === 'object'));
  if (!Array.isArray(activity) || !activity.some(event => event && typeof event === 'object')) {
    wrap.textContent = 'No wallet activity recorded yet.';
    return;
  }
  activity.filter(event => event && typeof event === 'object').slice(0, 100).forEach(event => {
    const row = document.createElement('div');
    row.className = 'evm-history-item';
    const rawAction = event.action || event.type || event.event || event.status || 'Activity';
    const action = ['limit', 'stop'].includes(rawAction)
      ? `${rawAction} order placed` : String(rawAction).replace(/[_-]+/g, ' ');
    const related = [
      ...(evmCurrentState?.positions || []),
      ...(evmCurrentState?.closed || []),
      ...(evmCurrentState?.orders || []),
    ].find(item =>
      (event.closedRecordId && item.id === event.closedRecordId) ||
      (event.positionId && item.id === event.positionId) ||
      (event.orderId && item.id === event.orderId) ||
      (event.address && item.addr?.toLowerCase() === String(event.address).toLowerCase()));
    const symbol = event.sym || event.symbol || related?.sym || '';
    const name = event.name || related?.name || '';
    const tokenLabel = symbol && name && name.toUpperCase() !== String(symbol).toUpperCase()
      ? `${symbol} (${name})` : symbol || name ||
        (event.address ? `${String(event.address).slice(0, 8)}…${String(event.address).slice(-4)}` : '');
    const when = event.createdAt || event.timestamp || event.at || event.date || event.closedAt;
    const date = when && Number.isFinite(Date.parse(when)) ? new Date(when).toLocaleString() : '';
    const detail = event.message || event.description || event.reason || '';
    const pnl = event.pnlUsd == null ? '' : ` · P&L ${evmMoney(event.pnlUsd)}`;
    row.textContent = [date, action, tokenLabel, detail].filter(Boolean).join(' · ') + pnl;
    wrap.append(row);
  });
}
function evmRenderOrders(orders) {
  const wrap = evmEl('evmOrders');
  wrap.replaceChildren();
  const pending = (Array.isArray(orders) ? orders : []).filter(order =>
    !['cancelled', 'canceled', 'filled', 'closed', 'rejected', 'expired'].includes(String(order.status || 'pending').toLowerCase()));
  wrap.classList.toggle('evm-empty', !pending.length);
  if (!pending.length) { wrap.textContent = 'No pending orders.'; return; }
  pending.forEach(order => {
    const box = document.createElement('div');
    box.className = 'quick-pos-card';
    const head = document.createElement('div');
    head.className = 'quick-pos-head';
    head.textContent = `${order.sym || order.name || (order.address ? `${order.address.slice(0, 8)}…` : 'Token')} · ${String(order.side || '').toUpperCase()} ${order.leverage || 1}x`;
    const detail = document.createElement('div');
    detail.className = 'quick-pos-meta';
    const marginDisplay = `${evmNativeField(order.marginNative)} margin (${order.marginNative == null ? 'USD conversion unavailable' : evmUsdValue(order.marginNative)})`;
    const riskDisplay = [evmFormatRiskLeg(order, 'tp'), evmFormatRiskLeg(order, 'sl')].filter(Boolean).join(' / ');
    for (const item of [String(order.type || 'limit').toUpperCase(), marginDisplay, `Trigger ${order.triggerPrice == null ? '—' : '$' + evmPrice(order.triggerPrice)}`, riskDisplay || 'TP/SL not set', String(order.status || 'pending').toUpperCase()]) {
      const cell = document.createElement('span');
      cell.textContent = item;
      detail.append(cell);
    }
    box.append(head, detail);
    if (order.id) {
      const cancel = document.createElement('button');
      cancel.className = 'btn evm-danger';
      cancel.textContent = evmMutatingOrderIds.has(String(order.id)) ? 'Confirm in wallet…' : 'Cancel order';
      cancel.disabled = evmMutatingOrderIds.has(String(order.id));
      cancel.onclick = () => evmCancelOrder(order.id);
      const actions = document.createElement('div');
      actions.className = 'quick-pos-actions evm-actions';
      actions.append(cancel);
      box.append(actions);
    }
    wrap.append(box);
  });
}
function evmRenderProfile(state, closed, positions) {
  const profile = evmEl('evmProfile');
  const wallet = evmAccount ? `${evmAccount.slice(0, 8)}…${evmAccount.slice(-6)}` : '—';
  profile.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = 'Wallet profile';
  const summary = document.createElement('div');
  const availableNative = state.portfolio?.availableBalanceNative ?? state.availableBalanceNative;
  const equityNative = state.portfolio?.equityNative ?? state.equityNative;
  summary.textContent = `Wallet ${wallet} · ${EVM_NETWORKS[evmChain].label} · Balance ${evmNativeField(state.balanceNative)} (${state.balanceUsd == null ? 'USD value unavailable' : evmMoney(state.balanceUsd)}) · Available ${evmNativeField(availableNative)} (${availableNative == null ? 'USD value unavailable' : evmUsdValue(availableNative)}) · Equity ${evmNativeField(equityNative)} (${equityNative == null ? 'USD value unavailable' : evmUsdValue(equityNative)}) · Open ${positions.length} · Closed ${closed.length}`;
  profile.append(title, summary);
  profile.style.display = 'block';
}
function evmShowProfile() {
  evmShowLedgerTab('profile');
}
async function evmCancelOrder(id) {
  if (!id) return evmStatus('This pending order does not include a cancellable order ID.');
  const orderId = String(id);
  if (evmMutatingOrderIds.has(orderId)) return;
  const chain = evmChain;
  const sequence = evmSequence;
  evmMutatingOrderIds.add(orderId);
  if (evmCurrentState) evmRenderOrders(evmCurrentState.orders || []);
  try {
    const confirmed = await evmConfirmAction('cancel', { targetId: orderId }, chain, sequence);
    evmStatus('Wallet approved. Cancelling order…');
    await evmRequest(`/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST', body: JSON.stringify(confirmed),
    });
    if (sequence !== evmSequence) return;
    evmStatus('Pending order cancelled.');
    await evmLoadState();
  } catch (error) { if (sequence === evmSequence) evmStatus(error.message); }
  finally {
    evmMutatingOrderIds.delete(orderId);
    if (sequence === evmSequence && evmCurrentState) evmRenderOrders(evmCurrentState.orders || []);
  }
}
async function evmLoadState() {
  if (!evmToken) return;
  const sequence = evmSequence;
  const chain = evmChain;
  const state = await evmRequest('/state');
  if (sequence !== evmSequence || chain !== evmChain) return;
  evmCurrentState = state;
  evmSetQuote({ collateralSymbol: state.collateralSymbol, collateralPriceUsd: state.collateralPriceUsd });
  evmShowWalletBalance(state.balanceNative);
  evmRenderPnl(state);
  evmEl('evmCollateralQuote').textContent = evmCollateralQuote
    ? `Live collateral quote: 1 ${evmCollateralQuote.symbol} = ${evmMoney(evmCollateralQuote.priceUsd)}.`
    : 'Live collateral quote unavailable. USD conversions are unavailable and order submission is disabled.';
  evmRenderPositions(state);
  evmSyncOpenButton();
}