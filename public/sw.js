// Sunrise Care Connect service worker: offline-friendly app shell + Web Push.
//
// Privacy rule: only the built app shell (HTML, JS, CSS, icons, fonts) is ever cached. API, auth,
// storage, function and realtime calls are never intercepted, so no patient data, prescriptions or
// documents are stored on the device by this worker.
//
// The production build (vite.config.ts → pwaPrecache) replaces the two placeholders below with the
// shell file list and a content hash. In development they stay empty and the worker only handles push.
const PRECACHE = self.__PRECACHE__ || [];
const VERSION = '__SW_VERSION__';
const SHELL = `scc-shell-${VERSION}`;
const ASSETS = `scc-assets-${VERSION}`;
const FONTS = 'scc-fonts';
const NEVER = ['/rest/v1', '/auth/v1', '/storage/v1', '/functions/v1', '/realtime/v1'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const enabled = PRECACHE.length > 0;

self.addEventListener('install', (event) => {
  if (!enabled) return;
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
  // A first install activates at once; an update waits until the page asks (SKIP_WAITING) so a
  // half-filled form is never swapped out from under the user.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS, FONTS]);
    for (const k of await caches.keys()) if (k.startsWith('scc-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (!enabled) return;
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((p) => url.pathname.startsWith(p))) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSETS));
    return;
  }
  if (PRECACHE.includes(url.pathname)) event.respondWith(caches.match(req, { cacheName: SHELL }).then((r) => r || fetch(req)));
});

// Pages: always try the network (fresh HTML after a deploy); offline, fall back to the cached shell,
// which renders the offline banner. Navigation responses themselves are never stored.
async function networkFirstShell(req) {
  try {
    return await fetch(req);
  } catch (e) {
    const shell = await caches.match('/', { cacheName: SHELL });
    if (shell) return shell;
    throw e;
  }
}

// Hashed build files never change, so a cached copy is always right.
async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(name)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => undefined);
  return hit || (await fresh) || Response.error();
}

// Web Push. Messages carry no clinical details; tapping one opens the secure /l/<token> link, which
// asks for sign-in and checks the account.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Sunrise Care', {
    body: data.body || '', tag: data.tag, icon: '/icons/icon-192.png', badge: '/favicon.svg', data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (new URL(c.url).origin === self.location.origin && 'navigate' in c) { await c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
