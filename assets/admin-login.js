(function () {
  'use strict';

  const TOKEN_KEY = 'memeperp_admin_token';
  const identityEl = document.getElementById('identity-status');
  const messageEl = document.getElementById('login-message');
  const loginButton = document.getElementById('connect-wallet');
  const retryButton = document.getElementById('retry-identity');
  let identity = null;
  let busy = false;

  async function readJson(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
    return payload;
  }

  function setIdentity(state, text) {
    identityEl.dataset.state = state;
    identityEl.lastElementChild.textContent = text;
    loginButton.disabled = state !== 'ready' || busy;
    retryButton.hidden = state !== 'error' || busy;
  }

  function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function loadIdentity() {
    setIdentity('loading', 'Checking owner configuration…');
    try {
      const response = await fetch('/api/admin/identity', { headers: { Accept: 'application/json' } });
      identity = await readJson(response);
      if (!identity.configured || !identity.walletAddress) {
        setIdentity('error', 'Owner wallet is not configured on the server.');
        return;
      }
      setIdentity('ready', `Configured owner · ${identity.walletAddress.slice(0, 6)}…${identity.walletAddress.slice(-5)}`);
    } catch (error) {
      identity = null;
      setIdentity('error', error.message || 'Could not check owner configuration.');
    }
  }

  async function signIn() {
    if (busy || !identity?.configured || !identity.walletAddress) return;
    busy = true;
    loginButton.disabled = true;
    loginButton.querySelector('span:first-child').textContent = 'Waiting for wallet…';
    messageEl.textContent = '';
    try {
      const wallets = window.MemePerpWallets;
      const safety = window.MemePerpWalletSafety;
      if (!wallets || !safety) throw new Error('Wallet security tools are unavailable. Reload and try again.');
      const provider = await wallets.choose('solana');
      if (!provider) return;
      const connected = await provider.connect();
      const walletAddress = String(connected?.publicKey?.toBase58?.() || provider.publicKey?.toBase58?.() || provider.publicKey || '').trim();
      if (!walletAddress) throw new Error('The selected wallet did not provide a Solana address.');
      if (walletAddress !== identity.walletAddress) throw new Error('This wallet is not the configured MemePerp owner wallet.');

      loginButton.querySelector('span:first-child').textContent = 'Requesting secure challenge…';
      const challengeResponse = await fetch('/api/mainnet/admin/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });
      const challenge = await readJson(challengeResponse);
      if (!challenge.message || challenge.walletAddress !== walletAddress) throw new Error('The server returned an invalid sign-in challenge.');

      loginButton.querySelector('span:first-child').textContent = 'Approve readable message…';
      const signed = await safety.signSolanaMessage(provider, challenge.message);
      const signature = signed?.signature instanceof Uint8Array ? signed.signature : signed instanceof Uint8Array ? signed : null;
      if (!signature?.length) throw new Error('Wallet did not return a valid message signature.');
      const signedAddress = String(signed?.publicKey?.toBase58?.() || signed?.publicKey || walletAddress);
      if (signedAddress !== walletAddress) throw new Error('Wallet account changed during approval. Please retry.');

      loginButton.querySelector('span:first-child').textContent = 'Verifying owner access…';
      const verifyResponse = await fetch('/api/mainnet/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ walletAddress, message: challenge.message, signature: toBase64(signature) }),
      });
      const verified = await readJson(verifyResponse);
      if (!verified.adminToken) throw new Error('The server did not issue an admin session.');
      sessionStorage.setItem(TOKEN_KEY, verified.adminToken);
      window.location.assign('/admin');
    } catch (error) {
      messageEl.textContent = error?.message || 'Unable to authenticate this wallet.';
    } finally {
      busy = false;
      loginButton.querySelector('span:first-child').textContent = 'Connect owner wallet';
      loginButton.disabled = identityEl.dataset.state !== 'ready';
    }
  }

  loginButton.addEventListener('click', signIn);
  retryButton.addEventListener('click', () => {
    messageEl.textContent = '';
    loadIdentity();
  });
  loadIdentity();
})();