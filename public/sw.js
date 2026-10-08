// Cache-first for the immutable assets (sprites, icons) so the board loads instantly and bot games work offline;
// network-first for code/pages so deploys show up on the next load.
const CACHE = 'lab-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  const immutable = /\.(webp|png)$/.test(u.pathname);
  e.respondWith(immutable
    ? caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }))
    : fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html'))));
});
