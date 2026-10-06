// Network-first app-shell cache so the UI still opens when there is no internet.
const CACHE = 'meshnet-v1';
const SHELL = [
  '/', '/app.html', '/dashboard.html', '/css/style.css', '/icon.svg', '/manifest.webmanifest',
  '/js/app.js', '/js/mesh.js', '/js/crypto.js', '/js/store.js', '/js/ui.js', '/js/dashboard.js',
  '/socket.io/socket.io.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
  '/vendor/vis-network/vis-network.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.searchParams.has('EIO')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
