(function (root) {
  'use strict';
  // Discovery and readable-message adapters only. No transaction methods.
  const standards = new Map();
  const announced = new Map();
  let selectedEvm = null;
  let closePicker = null;
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener());
  const solAccount = accounts => (accounts || []).find(account =>
    account.chains?.some(chain => chain.startsWith('solana:')) &&
    account.features?.includes('solana:signMessage'));
  const publicKey = account => !account ? null : root.solanaWeb3?.PublicKey
    ? new root.solanaWeb3.PublicKey(account.address) : {
      toString: () => account.address,
      toBase58: () => account.address,
      toBytes: () => new Uint8Array(account.publicKey),
    };

  function wrapStandard(wallet) {
    let account = solAccount(wallet.accounts);
    const events = new Map();
    const emit = (type, value) => events.get(type)?.forEach(callback => callback(value));
    const adapter = {
      name: wallet.name,
      get publicKey() { return publicKey(account); },
      get isConnected() { return !!account; },
      on(type, callback) {
        if (!events.has(type)) events.set(type, new Set());
        events.get(type).add(callback);
      },
      async connect(options = {}) {
        const result = await wallet.features['standard:connect'].connect({ silent: !!options.onlyIfTrusted });
        account = solAccount(result.accounts);
        if (!account) throw new Error('This wallet account does not support Solana message signing.');
        return { publicKey: publicKey(account) };
      },
      async disconnect() {
        await wallet.features['standard:disconnect']?.disconnect();
        account = null;
        emit('disconnect');
      },
      unregister() {
        account = null;
        emit('disconnect');
      },
      async signMessage(message) {
        if (!account) throw new Error('Reconnect this wallet before signing.');
        const signingAccount = account;
        const [result] = await wallet.features['solana:signMessage'].signMessage({
          account: signingAccount, message, display: 'utf8',
        });
        if (account !== signingAccount) throw new Error('Wallet account changed during approval. Please retry.');
        if (result?.signature?.length !== 64 || !result.signedMessage ||
          result.signedMessage.length !== message.length ||
          !message.every((byte, i) => byte === result.signedMessage[i])) {
          throw new Error('Wallet did not sign the requested readable message.');
        }
        return { signature: new Uint8Array(result.signature), publicKey: publicKey(account) };
      },
    };
    const off = wallet.features['standard:events']?.on('change', change => {
      if ('accounts' in change) {
        account = solAccount(change.accounts);
        emit('accountChanged', publicKey(account));
        if (!account) emit('disconnect');
      }
      notify();
    });
    return { adapter, off };
  }

  function register(...wallets) {
    const added = [];
    for (const wallet of wallets) {
      if (standards.has(wallet) || !wallet.features?.['standard:connect'] ||
        !wallet.features?.['solana:signMessage'] ||
        !wallet.chains?.some(chain => chain.startsWith('solana:'))) continue;
      standards.set(wallet, wrapStandard(wallet));
      added.push(wallet);
    }
    notify();
    return () => {
      for (const wallet of added) {
        const entry = standards.get(wallet);
        entry?.adapter.unregister();
        entry?.off?.();
        standards.delete(wallet);
      }
      notify();
    };
  }
  const api = Object.freeze({ register });
  root.addEventListener('wallet-standard:register-wallet', event => {
    if (typeof event.detail === 'function') event.detail(api);
  });
  root.addEventListener('eip6963:announceProvider', event => {
    const { info, provider } = event.detail || {};
    if (info?.uuid && typeof provider?.request === 'function' && !announced.has(info.uuid)) {
      announced.set(info.uuid, { name: info.name || 'EVM wallet', provider });
      notify();
    }
  });
  function discover() {
    root.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
    root.dispatchEvent(new Event('eip6963:requestProvider'));
  }
  function unique(providers, eligible) {
    return [...new Set(providers.filter(provider => provider && eligible(provider)))];
  }
  function solanaProviders() {
    return unique([
      ...[...standards.values()].map(entry => entry.adapter),
      ...(Array.isArray(root.solana?.providers) ? root.solana.providers : []),
      ...(Array.isArray(root.phantom?.solana?.providers) ? root.phantom.solana.providers : []),
      root.phantom?.solana, root.solflare, root.backpack?.solana,
      root.jupiter?.solana, root.jupiter, root.solana?.provider, root.solana,
    ], provider => typeof provider.connect === 'function' && typeof provider.signMessage === 'function');
  }
  function evmProviders() {
    return unique([
      ...[...announced.values()].map(entry => entry.provider),
      ...(Array.isArray(root.ethereum?.providers) ? root.ethereum.providers : []), root.ethereum,
      root.phantom?.ethereum, root.coinbaseWalletExtension,
    ], provider => typeof provider.request === 'function');
  }
  function currentEvm() {
    // Never silently substitute a different wallet after explicit selection.
    if (selectedEvm) return evmProviders().includes(selectedEvm) ? selectedEvm : null;
    return evmProviders()[0] || null;
  }
  function name(provider) {
    const announcement = [...announced.values()].find(entry => entry.provider === provider);
    return announcement?.name || provider.name ||
      (provider.isPhantom ? 'Phantom' : provider.isSolflare ? 'Solflare' :
        provider.isBackpack ? 'Backpack' : provider.isMetaMask ? 'MetaMask' :
          provider.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet');
  }
  function browseLinks(chain, address) {
    const target = new URL(address);
    if (!['https:', 'http:'].includes(target.protocol)) return [];
    target.hash = '';
    target.searchParams.set('walletChain', chain);
    const encoded = encodeURIComponent(target.href);
    const ref = encodeURIComponent(target.origin);
    return chain === 'solana' ? [
      ['Open in Phantom', `https://phantom.com/ul/browse/${encoded}?ref=${ref}`],
      ['Open in Solflare', `https://solflare.com/ul/v1/browse/${encoded}?ref=${ref}`],
      ['Open in MetaMask', `https://link.metamask.io/dapp/${target.href.replace(/^https?:\/\//, '')}`],
    ] : [
      ['Open in MetaMask', `https://link.metamask.io/dapp/${target.href.replace(/^https?:\/\//, '')}`],
    ];
  }
  function cancelPicker() { closePicker?.(); }
  async function choose(chain) {
    cancelPicker();
    discover();
    const providers = chain === 'solana' ? solanaProviders : evmProviders;
    if (providers().length === 1) {
      const provider = providers()[0];
      if (chain !== 'solana') selectedEvm = provider;
      return provider;
    }
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.className = 'mp-wallet-picker';
      dialog.setAttribute('aria-labelledby', 'mp-wallet-picker-title');
      dialog.innerHTML = '<h2 id="mp-wallet-picker-title">Connect wallet</h2><p class="mp-wallet-note"></p><div class="mp-wallet-options"></div><div class="mp-wallet-handoff"></div><button type="button" class="btn mp-wallet-close">Cancel</button>';
      const finish = provider => {
        clearInterval(poll);
        listeners.delete(render);
        dialog.remove();
        closePicker = null;
        previousFocus?.focus?.();
        if (provider && chain !== 'solana') selectedEvm = provider;
        resolve(provider);
      };
      const render = () => {
        const available = providers();
        dialog.querySelector('.mp-wallet-note').textContent = available.length
          ? `Choose a wallet for ${chain === 'solana' ? 'Solana' : chain === 'bsc' ? 'BNB Smart Chain' : 'Robinhood Chain'}.`
          : 'No compatible provider is available in this browser yet. Open the site in a wallet app, unlock it, or enable its extension.';
        const options = dialog.querySelector('.mp-wallet-options');
        // Do not replace focused buttons on every discovery poll.
        const signature = available.map(name).join('|');
        if (options.dataset.signature === signature) return;
        options.dataset.signature = signature;
        options.replaceChildren();
        available.forEach(provider => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = name(provider);
          button.onclick = () => finish(provider);
          options.append(button);
        });
      };
      browseLinks(chain, root.location.href).forEach(([label, url]) => {
        const link = document.createElement('a');
        link.className = 'btn mp-wallet-link';
        link.textContent = label;
        link.href = url;
        dialog.querySelector('.mp-wallet-handoff').append(link);
      });
      dialog.querySelector('.mp-wallet-close').onclick = () => finish(null);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      closePicker = () => finish(null);
      const poll = setInterval(render, 500);
      listeners.add(render);
      document.body.append(dialog);
      render();
      dialog.showModal();
    });
  }
  root.MemePerpWallets = { solanaProviders, evmProviders, currentEvm, choose, discover, cancelPicker, browseLinks };
  discover();
  root.addEventListener('pageshow', discover);
  root.addEventListener('focus', discover);
})(window);