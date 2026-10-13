/* BEAM offline shell — install once, then the app opens with zero network.
   Signaling API calls are NEVER cached (they need a live server).
   Pairing without any server at all uses the offline QR ticket mode. */
const CACHE = 'beam-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js',
  '/vendor/qrcode.js', '/vendor/jsQR.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;            // live signaling only
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: url.pathname === '/' });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && (url.pathname === '/' || SHELL.includes(url.pathname))) {
        const c = await caches.open(CACHE); c.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
      throw err;
    }
  })());
});
