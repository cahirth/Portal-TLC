const CACHE_NAME = 'portal-tlc-v11';
const ASSETS = [
    './',
    './index.html',
    './cotizaciones.html',
    './selector-dispositivos.html',
    './presupuesto.html',
    './servicio.html',
    './orden-servicio.html',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Portal TLC v11: cacheando assets...');
            return Promise.allSettled(
                ASSETS.map(url => cache.add(url).catch(e => console.warn('Cache skip:', url, e.message)))
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Ignorar esquemas no cacheables (extensiones de Chrome, etc.)
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    // Siempre a la red: GAS, Firebase, GitHub API, HubSpot
    if (
        url.includes('script.google.com') ||
        url.includes('firebaseio.com') ||
        url.includes('api.github.com') ||
        url.includes('azure.com') ||
        url.includes('hubapi.com')
    ) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Cache-first para todo lo demás
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => {
            if (event.request.mode === 'navigate') {
                return caches.match('./index.html');
            }
        })
    );
});
