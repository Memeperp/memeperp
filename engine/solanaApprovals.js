(function (root, factory) {
  const approvals = factory();
  if (typeof module === 'object' && module.exports) module.exports = approvals;
  if (root) root.MemePerpSolanaApprovals = approvals;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function routeAction(path) {
    if (path === '/positions/open') return { action: 'open' };
    if (path === '/position/tpsl') return { action: 'tpsl' };
    if (path === '/balance/add') return { action: 'balance' };
    if (path === '/account/reset') return { action: 'reset' };
    if (path === '/account/migrate') return { action: 'migrate' };
    const match = path.match(/^\/(positions|orders)\/([^/]+)\/(close|cancel|liquidate)$/);
    if (!match) return null;
    return { action: match[3], targetId: decodeURIComponent(match[2]) };
  }
  function checkScope(captured, current) {
    if (!captured.token || !captured.address || captured.chain !== 'solana' ||
      !current.connected || current.chain !== captured.chain ||
      current.provider !== captured.provider || current.address !== captured.address ||
      current.token !== captured.token || captured.provider?.isConnected === false ||
      String(captured.provider?.publicKey?.toString?.() || '') !== captured.address) {
      throw new Error('Wallet, account, or network changed during approval. Action cancelled.');
    }
  }
  async function authorize(path, body, { getState, issueChallenge, signMessage }) {
    const route = routeAction(path);
    if (!route) throw new Error('Unsupported Solana approval route');
    const captured = { ...getState() };
    checkScope(captured, getState());
    // Freeze what the user is approving; later edits cannot alter this request.
    const params = JSON.parse(JSON.stringify(body || {}));
    delete params.intentId;
    delete params.intentSignature;
    delete params.auditSig;
    if (route.targetId != null) params.targetId = route.targetId;
    const challenge = await issueChallenge({ action: route.action, params });
    checkScope(captured, getState());
    if (challenge.action !== route.action || challenge.chain !== 'solana' ||
      challenge.walletAddress !== captured.address || !challenge.intentId ||
      !String(challenge.message || '').includes(`\nWallet: ${captured.address}\n`)) {
      throw new Error('Wallet approval challenge does not match the active account');
    }
    const signed = await signMessage(captured.provider, challenge.message);
    checkScope(captured, getState());
    const raw = signed?.signature || signed;
    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw || []);
    if (bytes.length !== 64) throw new Error('Wallet did not return a valid approval signature');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      token: captured.token,
      body: { ...params, intentId: challenge.intentId, intentSignature: btoa(binary) },
    };
  }
  return { routeAction, authorize };
});