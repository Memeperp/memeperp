const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PersistentStore } = require('./persistentStore');
const copy = value => JSON.parse(JSON.stringify(value));
class FakePool {
  constructor() { this.rows = new Map(); this.fail = false; this.calls = []; }
  async connect() { return { query: this.query.bind(this), release() {} }; }
  async query(sql, params = []) {
    this.calls.push(sql);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('SELECT')) {
      let rows = [...this.rows].map(([key, row]) => ({ key, ...copy(row) }));
      if (sql.includes("IN ('solana','evm')")) rows = rows.filter(row => ['solana', 'evm'].includes(row.key));
      if (sql.includes('key=$1')) rows = rows.filter(row => row.key === params[0]);
      return { rows };
    }
    if (sql.startsWith('INSERT')) {
      if (this.rows.has(params[0])) return { rows: [] };
      const row = { value: JSON.parse(params[1]), revision: 1 };
      this.rows.set(params[0], row);
      return { rows: [copy(row)] };
    }
    if (sql.startsWith('UPDATE')) {
      if (this.fail) throw new Error('Injected database outage');
      const row = this.rows.get(params[1]);
      if (!row || row.revision !== params[2]) return { rows: [] };
      row.value = JSON.parse(params[0]); row.revision++;
      return { rows: [{ revision: row.revision }] };
    }
    throw new Error('Unexpected test SQL');
  }
}
function fixture(production = false) {
  const pool = new FakePool();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-store-'));
  const store = new PersistentStore({ pool, enabled: true, production, backupDir: dir });
  const state = {
    solana: { wallets: { legacycase: { balanceSol: 7 } }, markets: {}, pools: {}, meta: { betaWaitlist: [{ email: 'qa@example.invalid' }] } },
    evm: { accounts: {} }, evm_sessions: { sessions: { 'fake-test-hash': { exp: 99 } } },
    settings: { enabled: true },
  };
  for (const key of Object.keys(state)) store.register(key, () => state[key], value => { state[key] = value; });
  return { pool, store, state, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), dir };
}
test('development imports all documents atomically and keeps a private backup without auth sessions', async () => {
  const f = fixture();
  try {
    await f.store.initialize();
    assert.equal(f.pool.rows.size, 4);
    assert.equal(f.pool.rows.get('solana').value.wallets.legacycase.balanceSol, 7);
    assert.equal(f.pool.rows.get('solana').value.meta.betaWaitlist.length, 1);
    const file = path.join(f.dir, fs.readdirSync(f.dir)[0]);
    const backup = JSON.parse(fs.readFileSync(file));
    assert.equal(backup.format, 'memeperp-backup');
    assert.equal(backup.evm_sessions, undefined);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(f.pool.calls.filter(sql => sql === 'COMMIT').length, 1);
    assert.ok(!f.pool.calls.some(sql => /CREATE|ALTER/.test(sql)));
  } finally { f.cleanup(); }
});
test('writes capture immutable snapshots, serialize revisions, and survive reload', async () => {
  const f = fixture();
  try {
    await f.store.initialize();
    const first = { wallets: { legacycase: { balanceSol: 8 } }, meta: {} };
    f.store.save('solana', first);
    first.wallets.legacycase.balanceSol = 9;
    f.store.save('solana', first);
    await f.store.flush();
    assert.equal(f.pool.rows.get('solana').revision, 3);
    assert.equal(f.pool.rows.get('solana').value.wallets.legacycase.balanceSol, 9);
    const reloaded = new PersistentStore({ pool: f.pool, enabled: true, backupDir: f.dir });
    let loaded;
    reloaded.register('solana', () => ({}), value => { loaded = value; });
    await reloaded.initialize();
    assert.equal(loaded.wallets.legacycase.balanceSol, 9);
    assert.equal(f.store.status().pendingWrites, 0);
  } finally { f.cleanup(); }
});
test('database write failures stop all future saves and never acknowledge success', async () => {
  const f = fixture();
  try {
    await f.store.initialize();
    f.pool.fail = true;
    const replies = [];
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { replies.push({ status: this.statusCode, body }); } };
    await f.store.middleware()({ path: '/api/testnet/balance/add' }, res, () => {
      f.store.save('solana', { wallets: {} });
      res.json({ ok: true });
    });
    await f.store.flush().catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies[0].status, 503);
    assert.equal(replies[0].body.ok, undefined);
    assert.equal(f.pool.rows.get('solana').value.wallets.legacycase.balanceSol, 7);
    assert.throws(() => f.store.save('solana', {}), /not available/);
    assert.equal(f.store.status().healthy, false);
  } finally { f.cleanup(); }
});
test('optimistic revision checks never overwrite another server writer', async () => {
  const f = fixture();
  try {
    await f.store.initialize();
    f.pool.rows.get('solana').revision++;
    f.store.save('solana', { wallets: {} });
    await assert.rejects(f.store.flush(), /write failed/);
    assert.equal(f.pool.rows.get('solana').value.wallets.legacycase.balanceSol, 7);
  } finally { f.cleanup(); }
});
test('empty production never imports bundled development data; verified import starts paused', async () => {
  const f = fixture(true);
  try {
    await f.store.initialize();
    assert.equal(f.pool.rows.size, 0);
    assert.equal(f.store.migrationRequired, true);
    assert.throws(() => f.store.save('solana', {}), /not available/);
    await assert.rejects(f.store.importVerified({}), /Invalid backup/);
    await f.store.importVerified(f.store.export());
    assert.equal(f.store.migrationRequired, false);
    assert.equal(f.state.settings.enabled, false);
    assert.deepEqual(f.state.evm_sessions.sessions, {});
    assert.equal(f.state.solana.wallets.legacycase.balanceSol, 7);
    await assert.rejects(f.store.importVerified(f.store.export()), /uninitialized/);
  } finally { f.cleanup(); }
});
test('production fills missing operational settings safely without changing existing accounts', async () => {
  const f = fixture(true);
  try {
    f.pool.rows.set('solana', { value: f.state.solana, revision: 15 });
    f.pool.rows.set('evm', { value: f.state.evm, revision: 8 });
    await f.store.initialize();
    assert.equal(f.store.migrationRequired, false);
    assert.equal(f.pool.rows.get('solana').revision, 15);
    assert.equal(f.state.settings.enabled, false);
    assert.deepEqual(f.state.evm_sessions.sessions, {});
  } finally { f.cleanup(); }
});
test('real PostgreSQL retains an isolated document across store restarts', { skip: !process.env.DATABASE_URL }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeperp-pg-'));
  const key = `qa:persistence:${crypto.randomUUID()}`;
  const first = new PersistentStore({ enabled: true, backupDir: dir });
  const second = new PersistentStore({ enabled: true, backupDir: dir });
  try {
    first.register(key, () => ({ testValue: 1 }), () => {});
    await first.initialize();
    first.save(key, { testValue: 42 });
    await first.flush();
    let loaded;
    second.register(key, () => ({ testValue: 0 }), value => { loaded = value; });
    await second.initialize();
    assert.equal(loaded.testValue, 42);
  } finally {
    await first.pool.query('DELETE FROM app_documents WHERE key=$1', [key]);
    await Promise.all([first.pool.end(), second.pool.end()]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});