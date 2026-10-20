const fs = require('fs');
const path = require('path');
const store = require('./persistentStore');
const file = `${process.env.TESTNET_LEDGER_FILE || process.env.EVM_SIMULATION_FILE || path.join(__dirname, '..', '.data', 'operator')}.settings`;
let settings = { enabled: !store.production, updatedAt: null };
if (!store.enabled) {
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
store.register('settings', () => settings, value => { settings = value; });
function isEnabled() { return settings.enabled === true && !store.migrationRequired && !store.failure; }
function setEnabled(enabled, wallet) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  settings = { ...settings, enabled, updatedAt: new Date().toISOString(), updatedBy: wallet };
  if (store.enabled) store.save('settings', settings);
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  return get();
}
function get() { return { ...settings, enabled: isEnabled() }; }
function requireTrading(req, res, next) {
  if (!isEnabled()) return res.status(423).json({
    error: 'New trading is paused by the administrator. Closing positions and cancelling orders remain available.',
    code: 'TRADING_PAUSED',
  });
  next();
}
module.exports = { isEnabled, setEnabled, get, requireTrading };