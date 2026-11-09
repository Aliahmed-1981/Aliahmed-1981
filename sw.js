/* VIA Timetable service worker: offline shell, push notifications, app-icon badge. Bump V to force every device to refresh its cache. */
const V = 'via-tt-v1';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png', 'icons/favicon-64.png'];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('via-tt-') && k !== V && k !== 'via-tt-state').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;                                   // API calls are POSTs to script.google.com: never cached
  const u = new URL(r.url);
  if (u.origin === location.origin && u.pathname.startsWith('/.netlify/')) return;
  if (r.mode === 'navigate') {                                      // the page: network first (new versions arrive at once), cache when offline
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(V).then(x => x.put('index.html', c)); return res }).catch(() => caches.match('index.html').then(m => m || caches.match('./'))));
    return;
  }
  if (u.origin === location.origin || CDN.test(r.url)) {            // static files and libraries: cache first, refresh in the background
    e.respondWith(caches.open(V).then(c => c.match(r, { ignoreSearch: true }).then(hit => {
      const net = fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res }).catch(() => hit);
      return hit || net;
    })));
  }
});

/* ---- push + badge ---- */
async function getCount() { const c = await caches.open('via-tt-state'), m = await c.match('badge'); return m ? +(await m.text()) || 0 : 0 }
async function setCount(n) {
  const c = await caches.open('via-tt-state'); await c.put('badge', new Response(String(n)));
  try { if (n > 0) await self.navigator.setAppBadge(n); else await self.navigator.clearAppBadge() } catch (e) { }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {} } catch (x) { d = { body: e.data && e.data.text() } }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'VIA Timetable', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag || undefined, renotify: !!d.tag,
      data: { url: d.url || './' }, dir: 'auto'
    });
    await setCount((await getCount()) + (d.n || 1));
    (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).forEach(c => c.postMessage({ type: 'push' }));
  })());
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'badge') e.waitUntil(setCount(+e.data.n || 0)) });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
