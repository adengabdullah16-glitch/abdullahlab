// Service worker sederhana untuk Asisten Berwajah.
// Strategi "jaringan dulu": selalu memakai versi terbaru dari GitHub Pages bila online,
// dan memakai salinan tersimpan hanya saat offline. Panggilan ke OpenRouter/Supabase tidak disentuh.
const CACHE = 'asisten-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const salin = res.clone(); caches.open(CACHE).then(c => c.put(req, salin)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
