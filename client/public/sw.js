/* SlickSync PWA service worker - push notifications + app-shell caching.
 *
 * The original version was push-only, on the reasoning that SlickSync is a
 * live dashboard and stale cached DATA would be worse than a network wait.
 * That reasoning still holds and still shapes what gets cached here: API
 * responses are NEVER cached by this worker (the client's own last-known
 * layer in lib/api.ts owns data freshness). What IS cached:
 *
 * - /_next/static/* - cache-first, forever. Next content-hashes these
 *   filenames, so a cached entry can never be wrong, only unused. This is
 *   the bulk of "instant open": megabytes of JS/CSS served from disk.
 * - Navigation documents - network-first with a short timeout, falling
 *   back to the last cached copy of that page's HTML. Normal loads still
 *   always get fresh HTML (which references the newest hashed assets);
 *   the cached copy only ever serves when the network is slow/absent,
 *   where a slightly stale shell beats a white screen.
 *
 * Everything else (API calls, images, external hosts) falls through to the
 * network untouched. */

const STATIC_CACHE = 'slicksync-static-v1';
const PAGES_CACHE = 'slicksync-pages-v1';
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older worker versions, then take over open tabs so
    // caching starts without waiting for the next full reload.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== STATIC_CACHE && n !== PAGES_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(PAGES_CACHE);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), NAV_TIMEOUT_MS)),
        ]);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        // Nothing cached for this exact page - any cached page beats a
        // browser error screen; the app router takes over client-side.
        const any = await cache.match('/');
        if (any) return any;
        throw new Error('offline with empty cache');
      }
    })());
  }
  // All other requests: not handled - straight to the network.
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'SlickSync', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'SlickSync';
  const options = {
    body: data.body || '',
    icon: data.icon || '/android-chrome-192x192.png',
    badge: '/android-chrome-192x192.png',
    // url is read back in notificationclick to decide where to navigate.
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an existing SlickSync tab and navigate it, rather than opening
      // a duplicate, when one is already open.
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
