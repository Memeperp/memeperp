const CACHE_NAME = 'memeperp-v71';
const CORE_ASSETS = [
  './',
  './home.html',
  './testnet.html',
  './about.html',
  './faq.html',
  './index.html',
  './engine/memePerpEngine.js',
  './engine/evmDesk.js',
  './engine/walletSafety.js',
  './engine/walletConnections.js',
  './engine/solanaApprovals.js',
  './assets/site-telemetry.js',
  './assets/wallet-connections.css',
  './manifest.json',
  './favicon.svg',
  './assets/brand/memeperp-logo.svg',
  './assets/brand/wordmark.css',
  './assets/brand/memeperp-lockup.svg',
  './assets/brand/memeperp-avatar.svg',
  './assets/brand/memeperp-banner.png',
  './assets/brand/memeperp-icon-192.png',
  './assets/brand/memeperp-icon-512.png',
  './assets/brand/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.startsWith('/admin') ||
    new URL(event.request.url).pathname.startsWith('/api/')) return;
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Always fetch navigations and scripts fresh to avoid stale trading logic.
  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  const isScript = req.destination === 'script';
  if (isNavigation || isScript) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .catch(() => caches.match(req).then((cached) => cached || (isNavigation ? caches.match('./home.html') : Response.error())))
    );
    return;
  }

  // For same-origin app shell files: network first, fallback cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || Response.error()))
    );
    return;
  }

  // For external APIs: network first, fallback to cached response when offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
