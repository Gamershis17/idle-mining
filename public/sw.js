// Idle Mining service worker — offline-capable PWA shell.
// Static assets: cache-first. API: network-first (never serve stale saves).
const CACHE = 'idle-mining-v2';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/game.js',
  '/js/audio.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/maskable-192.png',
  '/assets/maskable-512.png',
  '/assets/rock.png',
  '/assets/pickaxe-ember.png',
  '/assets/pickaxe-frost.png',
  '/assets/pickaxe-dragonfire.png',
  '/assets/mine-shaft.png',
  '/assets/sunset-grove.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API calls: network first, fall back to cache only if the network fails.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin static assets: cache first, then network (and cache the result).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        });
      })
    );
  }
});
