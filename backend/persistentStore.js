const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

class PersistentStore {
  constructor({ pool, enabled, production = false, backupDir } = {}) {
    const isolated = process.env.NODE_ENV === 'test' ||
      Boolean(process.env.TESTNET_LEDGER_FILE || process.env.EVM_SIMULATION_FILE);
    this.production = production || process.env.NODE_ENV === 'production';
    this.enabled = enabled ?? (!isolated && Boolean(process.env.DATABASE_URL));
    if (this.production && !this.enabled) throw new Error('Production requires persistent PostgreSQL storage');
    this.pool = pool || (this.enabled ? new Pool({
      connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
      max: 5, idleTimeoutMillis: 30000,
    }) : null);
    this.backupDir = backupDir || path.join(__dirname, '..', '.local', 'backups');
    this.domains = new Map();
    this.tail = Promise.resolve();
    this.pendingWrites = 0;
    this.failure = null;
    this.ready = false;
    this.migrationRequired = false;
    this.lastSavedAt = null;
    this.pool?.on?.('error', () => { this.failure = 'Persistent database connection was interrupted'; });
  }
  register(key, get, set) { this.domains.set(key, { get, set, revision: null }); }
  initialize() {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }
  async load() {
    if (!this.enabled) { this.ready = true; return; }
    // Schema is applied in development / by Publish, never by app startup.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT key, value, revision FROM app_documents');
      const existing = new Map(rows.map(row => [row.key, row]));
      const missing = [...this.domains.keys()].filter(key => !existing.has(key));
      if (missing.some(key => ['solana', 'evm'].includes(key)) && this.production) {
        this.migrationRequired = true;
        for (const [key, domain] of this.domains) {
          const row = existing.get(key);
          if (row) { domain.set(row.value); domain.revision = Number(row.revision); }
        }
      } else {
        if (missing.length && !this.production) {
          const backup = this.export();
          fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(this.backupDir, `legacy-${Date.now()}-${crypto.randomUUID()}.json`),
            JSON.stringify(backup, null, 2), { mode: 0o600, flag: 'wx' });
        }
        for (const [key, domain] of this.domains) {
          let row = existing.get(key);
          if (!row) {
            const seed = this.production && key === 'settings' ? { enabled: false, updatedAt: null }
              : this.production && key === 'evm_sessions' ? { sessions: {} } : domain.get();
            const result = await client.query(
              'INSERT INTO app_documents(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING RETURNING value,revision',
              [key, JSON.stringify(seed)]);
            row = result.rows[0] || (await client.query('SELECT value,revision FROM app_documents WHERE key=$1', [key])).rows[0];
          }
          domain.set(row.value);
          domain.revision = Number(row.revision);
        }
      }
      await client.query('COMMIT');
      this.ready = true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      this.failure = 'Persistent storage could not be initialized';
      throw new Error(this.failure);
    } finally { client.release(); }
  }
  save(key, value) {
    if (!this.enabled) return;
    if (!this.ready || this.migrationRequired || this.failure) {
      throw new Error('Persistent storage is not available for account changes');
    }
    const domain = this.domains.get(key);
    if (!domain) throw new Error('Unknown persistent document');
    // Capture the exact committed state, not a mutable object read later.
    const snapshot = JSON.stringify(value);
    this.pendingWrites++;
    this.tail = this.tail.then(async () => {
      if (this.failure) return;
      const result = await this.pool.query(
        'UPDATE app_documents SET value=$1::jsonb,revision=revision+1,updated_at=now() WHERE key=$2 AND revision=$3 RETURNING revision',
        [snapshot, key, domain.revision]);
      if (!result.rows.length) throw new Error('Concurrent writer conflict');
      domain.revision = Number(result.rows[0].revision);
      this.lastSavedAt = new Date().toISOString();
    }).catch(() => { this.failure = 'Persistent write failed; account changes have been stopped'; })
      .finally(() => { this.pendingWrites--; });
  }
  async flush() {
    await this.tail;
    if (this.failure) throw new Error(this.failure);
  }
  status() {
    return {
      mode: this.enabled ? 'postgres' : 'isolated-files', ready: this.ready,
      healthy: !this.failure, pendingWrites: this.pendingWrites,
      lastSavedAt: this.lastSavedAt, migrationRequired: this.migrationRequired,
    };
  }
  export() {
    // Authentication records are deliberately excluded from backups.
    return {
      format: 'memeperp-backup', version: 1, createdAt: new Date().toISOString(),
      solana: this.domains.get('solana')?.get() || { wallets: {}, markets: {}, pools: {}, meta: {} },
      evm: this.domains.get('evm')?.get() || { accounts: {} },
      settings: this.domains.get('settings')?.get() || { enabled: false },
    };
  }
  async importVerified(backup) {
    if (!this.enabled || !this.migrationRequired) throw new Error('Import is allowed only into an uninitialized production database');
    if (backup?.format !== 'memeperp-backup' || backup.version !== 1 ||
      !backup.solana?.wallets || typeof backup.solana.wallets !== 'object' || Array.isArray(backup.solana.wallets) ||
      !backup.evm?.accounts || typeof backup.evm.accounts !== 'object' || Array.isArray(backup.evm.accounts)) throw new Error('Invalid backup format');
    const values = {
      solana: backup.solana, evm: backup.evm, evm_sessions: { sessions: {} },
      settings: { enabled: false, updatedAt: new Date().toISOString(), importedAt: new Date().toISOString() },
    };
    const client = await this.pool.connect();
    const imported = new Map();
    try {
      await client.query('BEGIN');
      const existing = await client.query("SELECT key FROM app_documents WHERE key IN ('solana','evm')");
      if (existing.rows.length) throw new Error('Existing accounts cannot be overwritten by import');
      for (const [key, value] of Object.entries(values)) {
        const result = await client.query(
          'INSERT INTO app_documents(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING RETURNING revision,value',
          [key, JSON.stringify(value)]);
        const row = result.rows[0] || (await client.query('SELECT revision,value FROM app_documents WHERE key=$1', [key])).rows[0];
        imported.set(key, row);
      }
      await client.query('COMMIT');
      for (const [key, row] of imported) {
        const domain = this.domains.get(key);
        if (domain) { domain.set(row.value); domain.revision = Number(row.revision); }
      }
      this.migrationRequired = false;
      this.lastSavedAt = new Date().toISOString();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  middleware() {
    return async (req, res, next) => {
      try {
        await this.initialize();
        if (this.failure) return res.status(503).json({ error: 'Persistent storage is unavailable. Account changes are stopped.' });
        if (this.migrationRequired &&
          /^\/api\/(?:testnet|evm|mainnet\/beta\/join)/.test(req.path)) {
          return res.status(503).json({ error: 'The owner must import a verified production backup before trading resumes', code: 'MIGRATION_REQUIRED' });
        }
        const json = res.json.bind(res);
        res.json = body => {
          // Responses acknowledge success only after durable writes finish.
          const snapshot = JSON.parse(JSON.stringify(body));
          this.flush().then(() => {
            if (!res.writableEnded) json(snapshot);
          }).catch(() => {
            if (!res.writableEnded) { res.status(503); json({ error: 'Data was not saved. Account changes have been stopped.', code: 'STORAGE_UNAVAILABLE' }); }
          });
          return res;
        };
        next();
      } catch (_) {
        res.status(503).json({ error: 'Persistent storage is unavailable. Do not retry account changes until service recovers.' });
      }
    };
  }
}
const store = new PersistentStore();
module.exports = store;
module.exports.PersistentStore = PersistentStore;