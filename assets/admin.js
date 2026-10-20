(function () {
  'use strict';

  const TOKEN_KEY = 'memeperp_admin_token';
  const POLL_MS = 15000;
  const token = sessionStorage.getItem(TOKEN_KEY);
  const dashboardContent = document.getElementById('dashboard-content');
  const loading = document.getElementById('dashboard-loading');
  const alertBox = document.getElementById('dashboard-alert');
  const refreshLabel = document.getElementById('refresh-label');
  const refreshButton = document.getElementById('refresh-button');
  const logoutButton = document.getElementById('logout-button');
  const toggleButton = document.getElementById('trading-toggle');
  const exportButton = document.getElementById('export-button');
  const retryOverview = document.getElementById('retry-overview');
  const tradingDialog = document.getElementById('trading-dialog');
  const confirmTrading = document.getElementById('confirm-trading');
  const migrationWarning = document.getElementById('migration-warning');
  const migrationStatus = document.getElementById('migration-status');
  const migrationFileName = document.getElementById('migration-file');
  const chooseBackup = document.getElementById('choose-backup');
  const reviewImport = document.getElementById('review-import');
  const backupFileInput = document.getElementById('backup-file');
  const importDialog = document.getElementById('import-dialog');
  const importFileSummary = document.getElementById('import-file-summary');
  const importConfirmation = document.getElementById('import-confirmation');
  const confirmImport = document.getElementById('confirm-import');
  const IMPORT_CONFIRMATION = 'IMPORT VERIFIED PRODUCTION BACKUP';
  let polling = null;
  let pollingInFlight = false;
  let isAuthenticated = false;
  let tradingEnabled = null;
  let migrationRequired = false;
  let selectedBackup = null;

  if (!token) {
    window.location.replace('/admin/login');
  } else {
    initialize();
  }

  function setPrivateView(visible) {
    dashboardContent.setAttribute('aria-hidden', String(!visible));
    dashboardContent.hidden = !visible;
    loading.hidden = visible;
  }

  function fmt(value, options = {}) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: options.digits ?? 2, ...options }).format(n);
  }

  function dateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function compactWallet(value) {
    const wallet = String(value || '');
    return wallet.length > 18 ? `${wallet.slice(0, 7)}…${wallet.slice(-6)}` : wallet || '—';
  }

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined && content !== null) element.textContent = String(content);
    return element;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) {
      sessionStorage.removeItem(TOKEN_KEY);
      stopPolling();
      window.location.replace('/admin/login');
      throw new Error('Your owner session expired. Sign in again.');
    }
    return response;
  }

  async function jsonRequest(path, options = {}) {
    const response = await request(path, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
    return result;
  }

  function setAlert(message, isError = true) {
    alertBox.textContent = message || '';
    alertBox.hidden = !message;
    alertBox.classList.toggle('success-alert', Boolean(message) && !isError);
  }

  function setRefreshState(text, error = false) {
    refreshLabel.textContent = text;
    document.querySelector('.live-dot').classList.toggle('is-error', error);
  }

  function fillRows(tableBodyId, mobileId, rows, columns, makeCells, emptyMessage) {
    const body = document.getElementById(tableBodyId);
    const mobile = document.getElementById(mobileId);
    body.replaceChildren();
    mobile.replaceChildren();
    if (!Array.isArray(rows) || !rows.length) {
      const tr = node('tr');
      const td = node('td', 'empty-cell', emptyMessage);
      td.colSpan = columns;
      tr.append(td);
      body.append(tr);
      mobile.append(node('div', 'record-empty', emptyMessage));
      return;
    }
    rows.forEach(row => {
      const tr = node('tr');
      const record = node('article', 'record-card');
      makeCells(row).forEach(([label, value, className, wide]) => {
        const td = node('td', className || '', value);
        tr.append(td);
        const field = node('div', `record-field${wide ? ' wide' : ''}`);
        field.append(node('span', 'record-label', label), node('span', `record-value${className?.includes('cell-primary') ? ' primary' : ''}`, value));
        record.append(field);
      });
      body.append(tr);
      mobile.append(record);
    });
  }

  function putCount(id, rows, noun, requiresMigration = false) {
    document.getElementById(id).textContent = requiresMigration ? 'Not imported' : `${fmt(rows?.length || 0, { maximumFractionDigits: 0 })} ${noun}`;
  }

  function renderMetrics(metrics, isMigrationRequired) {
    const metricGroups = [
      [
        ['Accounts', metrics.accounts, 'On the ledger', 'ledger'],
        ['Open positions', metrics.openPositions, 'Current exposure', 'ledger'],
        ['Pending orders', metrics.pendingOrders, 'Awaiting execution', 'ledger'],
        ['Closed trades', metrics.closedTrades, 'Recorded closes', 'ledger'],
        ['Signups', metrics.signups, 'Waitlist entries', 'ledger'],
        ['Realized P&L', metrics.realizedPnlUsd, 'USD · realized', 'currency-ledger'],
        ['Open notional', metrics.notionalUsd, 'USD · open exposure', 'currency-ledger'],
        ['Visits since tracking began', metrics.totalVisits, 'Anonymous browser IDs'],
        ['Unique since tracking began', metrics.uniqueVisitors, 'Anonymous browser IDs'],
        ['Today visits · UTC', metrics.todayVisits, 'UTC calendar day'],
        ['Today unique · UTC', metrics.todayUniqueVisitors, 'Anonymous browser IDs · UTC'],
        ['Live visitors', metrics.liveVisitors, 'Visible page heartbeat ≤ 60s'],
        ['Live sessions', metrics.liveSessions, 'Visible page heartbeat ≤ 60s'],
        ['Authenticated live', metrics.authenticatedLiveUsers, 'Active authenticated users'],
      ],
    ][0];
    const grid = document.getElementById('metric-grid');
    grid.replaceChildren();
    metricGroups.forEach(([label, value, note, type]) => {
      const card = node('article', `metric-card${label === 'Realized P&L' || label === 'Live visitors' ? ' emphasis' : ''}`);
      card.append(node('span', 'metric-label', label));
      const isUnavailable = isMigrationRequired && (type === 'ledger' || type === 'currency-ledger');
      const display = isUnavailable ? 'Not imported'
        : type === 'currency' || type === 'currency-ledger' ? `$${fmt(value, { maximumFractionDigits: 2 })}`
          : fmt(value, { maximumFractionDigits: 0 });
      card.append(node('strong', `metric-number${isUnavailable ? ' metric-unavailable' : ''}`, display), node('span', 'metric-note', isUnavailable ? 'Awaiting verified production backup' : note));
      grid.append(card);
    });
  }

  function statusCell(label, value, good) {
    const cell = node('div', 'system-cell');
    cell.append(node('span', 'system-label', label));
    const status = node('span', 'system-value');
    status.append(node('i', `system-indicator${good === true ? ' good' : good === false ? ' bad' : ''}`), node('span', '', value));
    cell.append(status);
    return cell;
  }

  function renderSystem(data) {
    const storage = data.storage || {};
    const providers = data.providers || {};
    const grid = document.getElementById('system-grid');
    grid.replaceChildren(
      statusCell('Storage mode', storage.mode || 'Unknown'),
      statusCell('Storage ready', storage.ready ? 'Ready' : 'Not ready', Boolean(storage.ready)),
      statusCell('Storage health', storage.healthy ? 'Healthy' : 'Attention', Boolean(storage.healthy)),
      statusCell('Pending writes', fmt(storage.pendingWrites, { maximumFractionDigits: 0 }), storage.pendingWrites !== null && storage.pendingWrites !== undefined && Number(storage.pendingWrites) === 0),
      statusCell('RPC provider', providers.rpcConfigured ? 'Configured' : 'Not configured', Boolean(providers.rpcConfigured)),
      statusCell('Birdeye provider', providers.birdeyeConfigured ? 'Configured' : 'Not configured', Boolean(providers.birdeyeConfigured)),
      statusCell('Last saved', dateTime(storage.lastSavedAt)),
      statusCell('Data migration', storage.migrationRequired ? 'Required' : 'Complete', storage.migrationRequired ? false : true),
    );
    document.getElementById('footer-storage').textContent = storage.lastSavedAt ? `Storage last saved ${dateTime(storage.lastSavedAt)}.` : 'Storage save time not reported.';
  }

  function renderMigration(storage) {
    migrationRequired = storage?.migrationRequired === true;
    dashboardContent.dataset.migration = migrationRequired ? 'required' : 'complete';
    migrationWarning.hidden = !migrationRequired;
    backupFileInput.disabled = !migrationRequired;
    chooseBackup.disabled = !migrationRequired;
    exportButton.disabled = migrationRequired;
    exportButton.title = migrationRequired ? 'Export is unavailable until the verified production backup is imported.' : 'Download owner backup';
    toggleButton.disabled = migrationRequired;
    toggleButton.title = migrationRequired ? 'Trading controls remain locked until migration is complete.' : '';
    if (!migrationRequired) {
      backupFileInput.value = '';
      selectedBackup = null;
      migrationFileName.textContent = 'No backup selected';
      reviewImport.hidden = true;
    }
  }

  function renderTrading(trading) {
    tradingEnabled = Boolean(trading?.enabled);
    const stateText = document.getElementById('trading-state-text');
    const mark = document.getElementById('trading-mark');
    const description = document.getElementById('trading-description');
    const updated = document.getElementById('trading-updated');
    const buttonText = document.getElementById('trading-button-text');
    stateText.textContent = tradingEnabled ? 'open.' : 'paused.';
    stateText.classList.toggle('paused-text', !tradingEnabled);
    mark.classList.toggle('paused', !tradingEnabled);
    description.textContent = tradingEnabled
      ? 'New positions, increases, limit orders, and automatic limit fills are enabled.'
      : 'New positions, increases, limit orders, and automatic limit fills are paused. Risk exits remain active.';
    updated.textContent = trading?.updatedAt ? `Last changed ${dateTime(trading.updatedAt)}${trading.updatedBy ? ` · ${trading.updatedBy}` : ''}` : 'Server has not reported a change time.';
    buttonText.textContent = tradingEnabled ? 'Pause new trading' : 'Resume new trading';
    toggleButton.classList.toggle('is-paused', !tradingEnabled);
    toggleButton.disabled = migrationRequired;
    toggleButton.title = migrationRequired ? 'Trading controls remain locked until migration is complete.' : '';
    document.getElementById('confirm-title').textContent = tradingEnabled ? 'Pause new trading?' : 'Resume new trading?';
    document.getElementById('confirm-copy').textContent = tradingEnabled
      ? 'New positions, increases, limit orders, and automatic limit fills will stop across all three chains.'
      : 'New positions, increases, limit orders, and automatic limit fills will be allowed across all three chains.';
    confirmTrading.textContent = tradingEnabled ? 'Pause new trading' : 'Resume new trading';
    confirmTrading.classList.toggle('danger-button', tradingEnabled);
  }

  function renderDashboard(data) {
    const storage = data.storage || {};
    renderMigration(storage);
    renderTrading(data.trading || {});
    renderMetrics(data.metrics || {}, migrationRequired);
    renderSystem(data);
    const accounts = migrationRequired ? [] : Array.isArray(data.accounts) ? data.accounts : [];
    putCount('account-count', accounts, 'accounts', migrationRequired);
    fillRows('accounts-body', 'accounts-mobile', accounts, 6, row => [
      ['Wallet', compactWallet(row.wallet), 'wallet-cell'],
      ['Chain', row.chain || '—', ''],
      ['Balance', `${fmt(row.balanceNative, { maximumFractionDigits: 6 })} ${row.currency || ''}`.trim(), ''],
      ['Positions', fmt(row.positions, { maximumFractionDigits: 0 }), ''],
      ['Orders', fmt(row.orders, { maximumFractionDigits: 0 }), ''],
      ['Realized P&L', `$${fmt(row.realizedPnlUsd, { maximumFractionDigits: 2 })}`, Number(row.realizedPnlUsd) >= 0 ? 'positive' : 'negative'],
    ], migrationRequired ? 'Account records are unavailable until the verified backup is imported.' : 'No accounts have been recorded.');
    const positions = migrationRequired ? [] : Array.isArray(data.positions) ? data.positions : [];
    putCount('position-count', positions, 'positions', migrationRequired);
    fillRows('positions-body', 'positions-mobile', positions, 8, row => [
      ['Market', row.symbol || '—', 'cell-primary'],
      ['Wallet', compactWallet(row.wallet), 'wallet-cell'],
      ['Chain', row.chain || '—', ''],
      ['Side', row.side || '—', `side-tag ${String(row.side).toLowerCase()}`],
      ['Margin', `${fmt(row.marginNative, { maximumFractionDigits: 6 })} ${row.currency || ''}`.trim(), ''],
      ['Leverage', `${fmt(row.leverage, { maximumFractionDigits: 2 })}×`, ''],
      ['Entry', fmt(row.entry, { maximumFractionDigits: 8 }), ''],
      ['Quantity', fmt(row.quantity, { maximumFractionDigits: 8 }), ''],
    ], migrationRequired ? 'Position records are unavailable until the verified backup is imported.' : 'No open positions.');
    const orders = migrationRequired ? [] : Array.isArray(data.orders) ? data.orders : [];
    putCount('order-count', orders, 'orders', migrationRequired);
    fillRows('orders-body', 'orders-mobile', orders, 4, row => [
      ['Market', row.symbol || '—', 'cell-primary'],
      ['Side', row.side || '—', `side-tag ${String(row.side).toLowerCase()}`],
      ['Limit price', fmt(row.limitPrice, { maximumFractionDigits: 8 }), ''],
      ['Margin', `${fmt(row.marginNative, { maximumFractionDigits: 6 })} ${row.currency || ''}`.trim(), ''],
    ], migrationRequired ? 'Order records are unavailable until the verified backup is imported.' : 'No pending orders.');
    const markets = migrationRequired ? [] : Array.isArray(data.markets) ? data.markets : [];
    putCount('market-count', markets, 'markets', migrationRequired);
    fillRows('markets-body', 'markets-mobile', markets, 3, row => [
      ['Market', row.symbol || '—', 'cell-primary'],
      ['Reference price', `$${fmt(row.price, { maximumFractionDigits: 8 })}`, ''],
      ['Updated', dateTime(row.updatedAt), ''],
    ], migrationRequired ? 'Market records are unavailable until the verified backup is imported.' : 'No market reference data available.');
    renderActivity(data.activity, migrationRequired);
    renderSignups(data.signups, migrationRequired);
    renderFeedback(data.feedback, migrationRequired);
    document.getElementById('generated-at').textContent = dateTime(data.generatedAt);
  }

  function renderActivity(entries, requiresMigration) {
    const list = document.getElementById('activity-list');
    const rows = requiresMigration ? [] : Array.isArray(entries) ? entries : [];
    list.replaceChildren();
    putCount('activity-count', rows, 'events', requiresMigration);
    if (!rows.length) {
      list.append(node('div', 'record-empty', requiresMigration ? 'Activity history is unavailable until the verified backup is imported.' : 'No activity has been recorded.'));
      return;
    }
    rows.forEach(item => {
      const row = node('article', 'activity-item');
      const main = node('div', 'activity-main');
      main.append(node('span', 'activity-message', item.message || 'Activity update'));
      const meta = node('div', 'activity-meta');
      meta.append(node('span', 'activity-type', `${item.type || 'event'}${item.chain ? ` · ${item.chain}` : ''}`));
      if (item.wallet) meta.append(node('span', '', compactWallet(item.wallet)));
      main.append(meta);
      row.append(main, node('time', 'activity-time', dateTime(item.createdAt)));
      list.append(row);
    });
  }

  function renderSignups(entries, requiresMigration) {
    const list = document.getElementById('signup-list');
    const rows = requiresMigration ? [] : Array.isArray(entries) ? entries : [];
    list.replaceChildren();
    putCount('signup-count', rows, 'signups', requiresMigration);
    if (!rows.length) {
      list.append(node('div', 'record-empty', requiresMigration ? 'Signup history is unavailable until the verified backup is imported.' : 'No signups yet.'));
      return;
    }
    rows.forEach(entry => {
      const row = node('article', 'signup-item');
      row.append(node('span', 'signup-email', entry.email || '—'), node('time', 'signup-time', dateTime(entry.createdAt)));
      list.append(row);
    });
  }

  function renderFeedback(entries, requiresMigration) {
    const list = document.getElementById('feedback-list');
    const rows = requiresMigration ? [] : Array.isArray(entries) ? entries : [];
    list.replaceChildren();
    putCount('feedback-count', rows, 'messages', requiresMigration);
    if (!rows.length) {
      list.append(node('div', 'record-empty', requiresMigration ? 'Feedback is unavailable until the verified backup is imported.' : 'No feedback yet.'));
      return;
    }
    rows.forEach(item => {
      const row = node('article', 'feedback-item');
      const header = node('div', 'feedback-header');
      header.append(node('span', 'feedback-category', item.category || 'other'));
      header.append(node('time', 'activity-time', dateTime(item.createdAt)));
      row.append(header, node('p', 'feedback-message', item.message || ''));
      list.append(row);
    });
  }

  async function loadOverview(isInitial = false) {
    if (pollingInFlight || !isAuthenticated && !isInitial) return;
    pollingInFlight = true;
    refreshButton.classList.add('is-loading');
    setRefreshState(isInitial ? 'Verifying session' : 'Updating snapshot');
    try {
      const data = await jsonRequest('/api/admin/overview', { headers: { Accept: 'application/json' } });
      renderDashboard(data);
      isAuthenticated = true;
      if (isInitial) setPrivateView(true);
      retryOverview.hidden = true;
      setAlert('');
      setRefreshState('Live · 15 sec');
      const label = document.querySelector('.refresh-status');
      label.setAttribute('aria-label', `Updated ${dateTime(data.generatedAt)}`);
      if (isInitial) startPolling();
    } catch (error) {
      if (!isAuthenticated) {
        setPrivateView(false);
        loading.querySelector('strong').textContent = 'Owner dashboard unavailable';
        loading.querySelector('span:last-child').textContent = error.message || 'Unable to verify this admin session.';
        retryOverview.hidden = false;
      } else if (!/session expired/i.test(error.message)) {
        setAlert(`Could not refresh the overview. Showing the last successful snapshot. ${error.message}`, true);
        setRefreshState('Update failed', true);
      }
    } finally {
      pollingInFlight = false;
      refreshButton.classList.remove('is-loading');
    }
  }

  function startPolling() {
    stopPolling();
    if (isAuthenticated && !document.hidden) polling = window.setInterval(() => loadOverview(false), POLL_MS);
  }

  function stopPolling() {
    if (polling) window.clearInterval(polling);
    polling = null;
  }

  async function initialize() {
    setPrivateView(false);
    await loadOverview(true);
  }

  async function updateTrading() {
    confirmTrading.disabled = true;
    const desired = !tradingEnabled;
    confirmTrading.textContent = desired ? 'Saving…' : 'Saving…';
    toggleButton.disabled = true;
    try {
      await jsonRequest('/api/admin/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled: desired }),
      });
      tradingDialog.close();
      setAlert(desired ? 'New trading has been enabled on the server.' : 'New trading is paused. Existing risk exits remain available.', false);
      await loadOverview(false);
    } catch (error) {
      if (!/session expired/i.test(error.message)) setAlert(`Trading setting was not changed. ${error.message}`, true);
    } finally {
      confirmTrading.disabled = false;
      toggleButton.disabled = false;
    }
  }

  function setMigrationStatus(message, state = '') {
    migrationStatus.textContent = message;
    migrationStatus.dataset.state = state;
  }

  function isBackupShape(backup) {
    return backup && typeof backup === 'object' && !Array.isArray(backup) &&
      backup.format === 'memeperp-backup' && backup.version === 1 &&
      backup.solana?.wallets && typeof backup.solana.wallets === 'object' && !Array.isArray(backup.solana.wallets) &&
      backup.evm?.accounts && typeof backup.evm.accounts === 'object' && !Array.isArray(backup.evm.accounts);
  }

  async function readBackupFile(event) {
    const file = event.target.files?.[0];
    selectedBackup = null;
    reviewImport.hidden = true;
    if (!file) {
      migrationFileName.textContent = 'No backup selected';
      setMigrationStatus('');
      return;
    }
    migrationFileName.textContent = file.name;
    setMigrationStatus('Reading and checking backup format…', 'working');
    try {
      const parsed = JSON.parse(await file.text());
      if (!isBackupShape(parsed)) {
        throw new Error('This is not a supported MemePerp backup. Choose an exported format/version 1 backup with Solana and EVM account data.');
      }
      selectedBackup = { parsed, fileName: file.name };
      reviewImport.hidden = false;
      setMigrationStatus('Backup JSON format recognized. The server will validate its contents and verify the import checksum.', 'success');
    } catch (error) {
      selectedBackup = null;
      setMigrationStatus(error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message || 'Unable to read this backup file.', 'error');
    }
  }

  function openImportDialog() {
    if (!migrationRequired || !selectedBackup) return;
    importConfirmation.value = '';
    confirmImport.disabled = true;
    importFileSummary.textContent = `${selectedBackup.fileName} is ready for server validation. Import is allowed only into an empty account database.`;
    importDialog.showModal();
    importConfirmation.focus();
  }

  async function importBackup() {
    if (!migrationRequired || !selectedBackup || importConfirmation.value !== IMPORT_CONFIRMATION) return;
    confirmImport.disabled = true;
    confirmImport.textContent = 'Validating and importing…';
    try {
      const result = await jsonRequest('/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ backup: selectedBackup.parsed, confirmation: IMPORT_CONFIRMATION }),
      });
      if (result.ok !== true || !result.checksum || result.trading?.enabled !== false) {
        throw new Error('The server did not return the expected verified import result. Refresh status before trying again.');
      }
      importDialog.close();
      const checksum = String(result.checksum);
      setMigrationStatus(`Import verified by server · SHA-256 ${checksum}`, 'success');
      await loadOverview(false);
      setAlert(`Verified backup imported successfully. Trading is paused. Server checksum: ${checksum}`, false);
    } catch (error) {
      if (!/session expired/i.test(error.message)) {
        setMigrationStatus(`Import failed. ${error.message}`, 'error');
        setAlert(`Verified backup was not confirmed as imported. ${error.message}`, true);
      }
    } finally {
      confirmImport.textContent = 'Import backup';
      confirmImport.disabled = importConfirmation.value !== IMPORT_CONFIRMATION;
    }
  }

  async function exportBackup() {
    exportButton.disabled = true;
    const original = exportButton.innerHTML;
    exportButton.textContent = 'Preparing export…';
    try {
      const response = await request('/api/admin/export', { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] || `memeperp-backup-${new Date().toISOString().slice(0,10)}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = decodeURIComponent(filename.replace(/"/g, ''));
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setAlert('Backup export downloaded.', false);
    } catch (error) {
      if (!/session expired/i.test(error.message)) setAlert(`Backup export failed. ${error.message}`, true);
    } finally {
      exportButton.disabled = false;
      exportButton.innerHTML = original;
    }
  }

  async function logout() {
    stopPolling();
    logoutButton.disabled = true;
    try {
      await request('/api/admin/logout', { method: 'POST', headers: { Accept: 'application/json' } });
    } catch (_) {
      // Always clear this tab's bearer token, even if the network is unavailable.
    } finally {
      sessionStorage.removeItem(TOKEN_KEY);
      isAuthenticated = false;
      setPrivateView(false);
      window.location.replace('/admin/login');
    }
  }

  refreshButton.addEventListener('click', () => loadOverview(false));
  retryOverview.addEventListener('click', () => {
    loading.querySelector('strong').textContent = 'Verifying owner session';
    loading.querySelector('span:last-child').textContent = 'Private dashboard data is not displayed until authorization succeeds.';
    retryOverview.hidden = true;
    loadOverview(true);
  });
  logoutButton.addEventListener('click', logout);
  chooseBackup.addEventListener('click', () => {
    if (migrationRequired) backupFileInput.click();
  });
  reviewImport.addEventListener('click', openImportDialog);
  backupFileInput.addEventListener('change', readBackupFile);
  importConfirmation.addEventListener('input', () => {
    confirmImport.disabled = importConfirmation.value !== IMPORT_CONFIRMATION || !selectedBackup || !migrationRequired;
  });
  confirmImport.addEventListener('click', importBackup);
  toggleButton.addEventListener('click', () => {
    if (typeof tradingEnabled !== 'boolean') return;
    tradingDialog.showModal();
  });
  confirmTrading.addEventListener('click', updateTrading);
  exportButton.addEventListener('click', exportBackup);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (isAuthenticated) {
      loadOverview(false);
      startPolling();
    }
  });
  document.querySelectorAll('.side-link[href^="#"]').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.side-link[href^="#"]').forEach(item => item.classList.remove('active'));
      link.classList.add('active');
    });
  });
})();