const crypto = require('crypto');

const FIELDS = {
  open: ['market', 'side', 'marginSol', 'leverage', 'marginMode', 'orderType', 'limitPrice', 'tpSl'],
  close: ['targetId', 'closePct'],
  cancel: ['targetId'],
  tpsl: ['positionId', 'tp', 'tpRoi', 'sl', 'slRoi', 'tpQty', 'tpQtyPct', 'slQty', 'slQtyPct'],
  balance: ['amountSol'],
  reset: [],
  migrate: ['snapshot'],
  liquidate: ['targetId', 'markPrice'],
};
const LABELS = {
  open: 'OPEN OR PLACE POSITION', close: 'CLOSE OR REDUCE POSITION',
  cancel: 'CANCEL ORDER', tpsl: 'CHANGE TP/SL', balance: 'ADD TEST BALANCE',
  reset: 'RESET ACCOUNT', migrate: 'IMPORT LEGACY PRACTICE ACCOUNT',
  liquidate: 'LIQUIDATE PRACTICE POSITION',
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function parameters(action, body) {
  return Object.fromEntries(FIELDS[action].map(field => [field, stable(body?.[field] ?? null)]));
}
function digest(action, body) {
  return crypto.createHash('sha256').update(JSON.stringify([action, parameters(action, body)])).digest('hex');
}

function createSolanaIntents({ verifySignature, now = Date.now, ttlMs = 120000 }) {
  const intents = new Map();
  function revoke(token) {
    for (const [id, intent] of intents) if (intent.sessionToken === token) intents.delete(id);
  }
  function issue(req, res) {
    const { action, params } = req.body || {};
    if (!Object.hasOwn(FIELDS, action) || !params || typeof params !== 'object' || Array.isArray(params)) {
      return res.status(400).json({ error: 'Unsupported Solana action or parameters' });
    }
    if (!req.signingAddress) return res.status(401).json({ error: 'Reconnect and sign in with your Solana wallet' });
    const details = JSON.stringify(parameters(action, params));
    if (details.length > 8000) return res.status(400).json({ error: 'Action details are too large for readable wallet confirmation' });
    const time = now();
    let pending = 0;
    for (const [id, intent] of intents) {
      if (intent.expiresAt <= time) intents.delete(id);
      else if (intent.sessionToken === req.sessionToken) pending++;
    }
    if (pending >= 10 || intents.size >= 2000) return res.status(429).json({ error: 'Too many pending wallet confirmations. Wait and retry.' });
    const intentId = crypto.randomUUID();
    const expiresAt = time + ttlMs;
    const message = [
      `MemePerp Testnet Confirm ${LABELS[action]}`,
      'Chain: solana', `Wallet: ${req.signingAddress}`,
      `Parameters: ${details}`, `Nonce: ${intentId}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
      'Simulated action only. No on-chain transaction or wallet funds transfer.',
    ].join('\n');
    intents.set(intentId, {
      action, message, expiresAt, sessionToken: req.sessionToken,
      walletAddress: req.walletAddress, signingAddress: req.signingAddress,
      digest: digest(action, params),
    });
    return res.json({ intentId, message, expiresAt, action, chain: 'solana', walletAddress: req.signingAddress });
  }
  function requireAction(action) {
    return (req, res, next) => {
      const id = String(req.body?.intentId || '');
      const intent = intents.get(id);
      // A caller cannot consume another session's pending confirmation.
      if (!intent || intent.sessionToken !== req.sessionToken) {
        return res.status(403).json({ error: 'Confirm this exact action in your connected Solana wallet', code: 'ACTION_APPROVAL_REQUIRED' });
      }
      intents.delete(id);
      if (intent.expiresAt <= now() || intent.action !== action ||
        intent.walletAddress !== req.walletAddress || intent.signingAddress !== req.signingAddress ||
        (req.params.id != null && String(req.body?.targetId || '') !== String(req.params.id)) ||
        intent.digest !== digest(action, req.body)) {
        return res.status(403).json({ error: 'Wallet approval expired or action details changed. Confirm again.', code: 'ACTION_APPROVAL_MISMATCH' });
      }
      if (!verifySignature(intent.signingAddress, intent.message, req.body?.intentSignature)) {
        return res.status(403).json({ error: 'Invalid wallet approval signature', code: 'ACTION_SIGNATURE_INVALID' });
      }
      // History records the proof verified here, never a client-supplied reference.
      req.body.auditSig = `SIM:${req.body.intentSignature}`;
      next();
    };
  }
  return { issue, requireAction, revoke };
}
module.exports = { createSolanaIntents, parameters, digest };