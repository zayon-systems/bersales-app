// Bersales service worker
//
// IMPORTANT lesson carried over from the PER app: a static, never-incremented
// CACHE_NAME with a cache-first strategy caused PER to get stuck serving the
// very first version ever cached, regardless of how many times the site was
// updated. To avoid repeating that bug:
//   1. CACHE_NAME is versioned below — bump it on every release.
//   2. HTML is served network-first (so updates are picked up immediately),
//      falling back to cache only when offline.
//   3. Static assets (css/js/icons) are cache-first for speed, but are keyed
//      to the versioned cache, so a version bump invalidates them too.

const CACHE_VERSION = 'v1.6.1';
const CACHE_NAME = `bersales-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/crypto.js',
  './js/db.js',
  './js/templates.js',
  './js/vault.js',
  './js/scanner.js',
  './js/ocr.js',
  './js/reminders.js',
  './js/debts.js',
  './js/bills.js',
  './js/creditcards.js',
  './js/health.js',
  './js/todos.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('bersales-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for HTML so app updates are picked up on next load.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      });
    })
  );
});
