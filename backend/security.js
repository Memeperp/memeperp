// Bounded, expiring authentication state. Never evict an active challenge or
// reset an active rate limit just to make room for another caller.
class ExpiringMap extends Map {
  constructor({ deadline, maxSize = 10000, now = Date.now, entries = [] }) {
    super();
    this.deadline = deadline;
    this.maxSize = maxSize;
    this.now = now;
    this.lastPruned = -Infinity;
    for (const [key, value] of entries) this.set(key, value);
  }
  prune() {
    const time = this.now();
    for (const [key, value] of this) {
      if (!Number.isFinite(Number(value?.[this.deadline])) || Number(value[this.deadline]) <= time) super.delete(key);
    }
    this.lastPruned = time;
  }
  get(key) {
    const value = super.get(key);
    if (value && Number(value[this.deadline]) <= this.now()) {
      super.delete(key);
      return undefined;
    }
    return value;
  }
  set(key, value) {
    if (this.now() - this.lastPruned >= 60000 || this.size >= this.maxSize) this.prune();
    if (!super.has(key) && this.size >= this.maxSize) {
      const error = new Error('Temporary authentication capacity reached');
      error.status = 429;
      throw error;
    }
    return super.set(key, value);
  }
}

function securityHeaders(production) {
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-XSS-Protection', '0');
    res.set('X-Permitted-Cross-Domain-Policies', 'none');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Inline scripts/handlers still exist in the legacy desk. Do not claim a
    // strict script CSP; restrict plugins, base URL changes, forms and framing.
    const directives = ["object-src 'none'", "base-uri 'self'", "form-action 'self'"];
    if (production) {
      res.set('X-Frame-Options', 'DENY');
      res.set('Strict-Transport-Security', 'max-age=31536000');
      directives.push("frame-ancestors 'none'");
    }
    res.set('Content-Security-Policy', directives.join('; '));
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  };
}

function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const messages = {
    400: 'Invalid request',
    413: 'Request body is too large',
    415: 'Unsupported request format',
    429: 'Temporarily busy. Please retry later.',
  };
  const status = Object.hasOwn(messages, error.status) ? Number(error.status) : 500;
  if (status === 429) res.set('Retry-After', '60');
  res.status(status).json({ error: messages[status] || 'Request could not be completed' });
}

function challengeKey(wallet, message) {
  return `${wallet}:${require('crypto').createHash('sha256').update(message).digest('hex')}`;
}

module.exports = { ExpiringMap, securityHeaders, errorHandler, challengeKey };