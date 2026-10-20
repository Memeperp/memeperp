(function () {
  'use strict';
  if (/^\/admin(?:\/|$)/.test(location.pathname)) return;
  let visitorId, sessionId;
  const visitId = crypto.randomUUID();
  try {
    visitorId = localStorage.getItem('mp_anonymous_visitor') || crypto.randomUUID();
    localStorage.setItem('mp_anonymous_visitor', visitorId);
    sessionId = sessionStorage.getItem('mp_anonymous_session') || crypto.randomUUID();
    sessionStorage.setItem('mp_anonymous_session', sessionId);
  } catch (_) { visitorId = crypto.randomUUID(); sessionId = crypto.randomUUID(); }
  let inFlight = false;
  async function heartbeat(visible = !document.hidden) {
    if (inFlight) return;
    inFlight = true;
    try {
      const token = window.MemePerpTelemetryToken?.() || '';
      const response = await fetch('/api/site/presence', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ visitorId, sessionId, visitId, path: location.pathname, visible }),
      });
      if (response.ok) {
        const status = await response.json();
        window.MemePerpSiteStatus = status;
        window.dispatchEvent(new CustomEvent('memeperp:site-status', { detail: status }));
      }
    } catch (_) { /* Visitor counting must never interrupt trading or navigation. */ }
    finally { inFlight = false; }
  }
  heartbeat();
  setInterval(() => { if (!document.hidden) heartbeat(); }, 15000);
  document.addEventListener('visibilitychange', () => heartbeat());
  window.addEventListener('pagehide', () => heartbeat(false));
})();