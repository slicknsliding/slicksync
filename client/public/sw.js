/* SlickSync PWA service worker - push notifications only.
 *
 * Deliberately minimal: no offline caching (SlickSync is a live dashboard,
 * stale cached data would be worse than a network wait). Its only jobs are
 * to receive push events and route a tapped notification to the right page. */

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
