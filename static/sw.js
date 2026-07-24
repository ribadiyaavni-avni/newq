/* ============================================================
   NEWQ service worker — offline shell cache + notifications
   ============================================================ */
const CACHE = 'newq-v1';
const SHELL = [
  '/offline',
  '/static/css/app.css',
  '/static/js/app.js',
  '/static/js/webrtc.js',
  '/static/js/realtime.js',
  '/static/js/notify.js',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never cache API calls or the socket.
  if (url.pathname.startsWith('/api/')) return;

  // Static assets & uploads: cache-first.
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached ||
        fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // Pages: network-first, fall back to offline page.
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then((cached) => cached || caches.match('/offline'))
    )
  );
});

/* ---- notification clicks (local notifications shown via notify.js) ---- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if (win.url.includes(self.location.origin)) return win.focus();
      }
      return clients.openWindow(target);
    })
  );
});
