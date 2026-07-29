// ScanLog service worker — cache the app shell for offline use.
// Note: the OCR engine (tesseract.js CDN + language data) still needs
// network on first OCR use; barcode scanning works fully offline.
const CACHE = 'scanlog-v1.4';
const ASSETS = [
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon.svg',
    './lib/theme.js',
    './lib/html5-qrcode.min.js'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(hit => hit || fetch(e.request))
    );
});
