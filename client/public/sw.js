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
 * - Navigation documents - network-first, falling back to the last cached
 *   copy of that page's HTML ONLY when the network actually fails. It used
 *   to fall back after a 3-second timeout too, which turned out to be a way
 *   to break a working app: a cached shell references the hashed asset
 *   filenames of the build it was cached from, and a deploy replaces those,
 *   so a merely slow connection could hand back a shell whose scripts now
 *   404 on the server. Offline gets a stale shell; slow just waits.
 *
 * Everything else (API calls, images, external hosts) falls through to the
 * network untouched. */

// Bump these names to force every installed client to drop what it has
// cached: the activate handler below deletes any cache whose name is not
// one of the names below. Hashed filenames mean a cached asset can never be
// WRONG, but a navigation served from the pages cache (which only happens
// when the network is slow) hands back HTML that points at an older build's
// hashes - and those are cached forever. One bump clears that out.
const STATIC_CACHE = 'slicksync-static-v2';
const PAGES_CACHE = 'slicksync-pages-v2';
// Resized posters and avatars from this instance's own image cache. Their
// URLs are stable and the responses immutable, so cache-first is safe; the
// cap keeps the store from growing without bound (oldest entries go first).
// This is what makes posters instant on a phone's installed app, whose own
// HTTP cache is small and evicted aggressively.
const IMAGE_CACHE = 'slicksync-images-v1';
const IMAGE_CACHE_MAX = 900;
let imagePutsSinceTrim = 0;
// Hashed assets from every build this install has seen stay cached until
// dropped; past this many, the oldest go first (a few builds' worth).
const STATIC_CACHE_MAX = 800;
let staticPutsSinceTrim = 0;
// The small static "You're offline" page (public/offline.html), stored at
// install so there is always something to show. A navigation that failed
// with nothing cached for it used to throw, and the browser showed its own
// error page - with no address bar to recover from in an installed app.
// Bump the version whenever offline.html changes so every install takes the
// new copy (the old cache is deleted on activate like the others).
const OFFLINE_CACHE = 'slicksync-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Best effort: a failed fetch here must not stop the worker installing,
  // since push goes through it too.
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from older worker versions, then take over open tabs so
    // caching starts without waiting for the next full reload.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== STATIC_CACHE && n !== PAGES_CACHE && n !== IMAGE_CACHE && n !== OFFLINE_CACHE).map((n) => caches.delete(n)));
    // Let the browser start a navigation's network request while this worker
    // is still waking up, instead of after. The navigate handler below picks
    // the preloaded response up when there is one.
    try { if (self.registration.navigationPreload) await self.registration.navigationPreload.enable(); } catch {}
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The self-hosted default fonts are versioned in their filenames, so
  // they get the same cache-first-forever treatment as hashed assets.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        cache.put(req, res.clone()).then(() => {
          staticPutsSinceTrim += 1;
          if (staticPutsSinceTrim < 25) return;
          staticPutsSinceTrim = 0;
          return cache.keys().then((keys) => {
            if (keys.length <= STATIC_CACHE_MAX) return;
            // Cache keys come back in insertion order: drop the oldest.
            return Promise.all(keys.slice(0, keys.length - STATIC_CACHE_MAX + 100).map((k) => cache.delete(k)));
          });
        }).catch(() => {});
      }
      // A hashed asset that the server no longer has means this page came
      // from a build that is gone - the one way a cached shell can leave
      // someone stuck. Drop the cached pages so the next navigation is
      // fetched fresh instead of rebuilding the same broken combination.
      if (res.status === 404) {
        caches.delete(PAGES_CACHE).catch(() => {});
      }
      return res;
    })());
    return;
  }

  if (url.pathname === '/api/img') {
    event.respondWith((async () => {
      const cache = await caches.open(IMAGE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
        cache.put(req, res.clone()).then(() => {
          imagePutsSinceTrim += 1;
          if (imagePutsSinceTrim < 25) return;
          imagePutsSinceTrim = 0;
          return cache.keys().then((keys) => {
            if (keys.length <= IMAGE_CACHE_MAX) return;
            // Cache keys come back in insertion order: drop the oldest.
            return Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_MAX + 100).map((k) => cache.delete(k)));
          });
        }).catch(() => {});
      }
      return res;
    })());
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(PAGES_CACHE);
      try {
        // No timeout race here on purpose - see the note at the top of this
        // file. Waiting on a slow network is correct; substituting a shell
        // from an older build is not.
        const preloaded = await (event.preloadResponse || Promise.resolve(null)).catch(() => null);
        const res = preloaded || await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        // Nothing cached for this exact page - any cached page beats a
        // browser error screen; the app router takes over client-side.
        const any = await cache.match('/');
        if (any) return any;
        // Nothing saved at all: the plain offline page, which reloads by
        // itself once the connection is back.
        const offline = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
        if (offline) return offline;
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
  // App-icon badge, best-effort: the worker doesn't know the real unread
  // count, so a bare dot marks "something's waiting" - the app corrects it
  // to the actual number the next time it opens (NotificationsDropdown).
  try { if (navigator.setAppBadge) navigator.setAppBadge().catch(() => {}); } catch {}
  event.waitUntil(self.registration.showNotification(title, options));
});

// Which kind of device this is, so a re-subscribe can reach the right route.
// The page writes the hint (lib/pushHint.ts) when push is turned on and
// clears it when it is turned off; without a hint nothing is re-sent, so a
// browser holding both an admin session and a person's device can never file
// a new endpoint under the wrong one.
function readPushHint() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('slicksync-push', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const get = open.result.transaction('kv').objectStore('kv').get('hint');
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

function keyFromBase64Url(s) {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The browser rotated or dropped the push subscription: the server would keep
// pushing to a dead endpoint. Best effort - subscribe again with the same key
// and hand the new endpoint to the same route the page used.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const hint = await readPushHint();
      if (!hint || !hint.publicKey) return;
      const oldKey = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      const sub = event.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: oldKey || keyFromBase64Url(hint.publicKey),
      });
      const userAgent = self.navigator ? self.navigator.userAgent : undefined;
      const post = (path, body, headers) => fetch('/api' + path, {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body),
      });
      const person = hint.kind === 'person' && hint.userId && hint.authKey;
      const headers = person ? { 'x-stremio-auth': hint.authKey } : undefined;
      if (person) {
        await post('/public-library/push/subscribe', { userId: hint.userId, subscription: sub.toJSON(), userAgent }, headers);
      } else if (hint.kind === 'admin') {
        await post('/push/subscribe', Object.assign({}, sub.toJSON(), { userAgent }));
      } else {
        return;
      }
      const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
      if (oldEndpoint && oldEndpoint !== sub.endpoint) {
        await (person
          ? post('/public-library/push/unsubscribe', { userId: hint.userId, endpoint: oldEndpoint }, headers)
          : post('/push/unsubscribe', { endpoint: oldEndpoint })).catch(() => {});
      }
    } catch {}
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const targetHref = new URL(target, self.location.origin).href.split('#')[0];
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      const open = () => (self.clients.openWindow ? self.clients.openWindow(target) : undefined);
      // A window already on the target just gets focus.
      const onTarget = clientList.find((c) => 'focus' in c && c.url.split('#')[0] === targetHref);
      if (onTarget) return onTarget.focus();
      // Otherwise reuse a window the person is not looking at. A focused one
      // may be mid-typing, so it is never navigated out from under them.
      const idle = clientList.find((c) => 'focus' in c && 'navigate' in c && !c.focused);
      if (idle) {
        try {
          const moved = await idle.navigate(target);
          return (moved || idle).focus();
        } catch {
          return open();
        }
      }
      return open();
    })
  );
});
