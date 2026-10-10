const CACHE_NAME = 'dsa-tracker-v2';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './cloud.js',
  './firebase-config.js',
  './problems.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];
// The pinned Firebase SDK modules are cached too, so sign-in state and offline queued writes keep working offline.
const SDK_PREFIX = '/firebasejs/';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES.map(path => new URL(path, self.registration.scope).href)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('dsa-tracker-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const isSdk = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith(SDK_PREFIX);
  if (request.method !== 'GET' || (url.origin !== self.location.origin && !isSdk)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(async response => {
          const copy = response.clone();
          await caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(async error => {
          const fallback = await caches.match(request) || await caches.match(new URL('./index.html', self.registration.scope).href);
          if (fallback) return fallback;
          throw error;
        })
    );
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refresh = fetch(request).then(async response => {
      if (response.ok) {
        const copy = response.clone();
        await caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    });
    if (cached) {
      event.waitUntil(refresh.catch(() => undefined));
      return cached;
    }
    return refresh;
  })());
});
