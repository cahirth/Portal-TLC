const CACHE_NAME = 'portal-tlc-v9';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2'
];

// Instalación: cachear todos los assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Portal TLC: cacheando assets...');
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activación: limpiar caches viejos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch: cache-first para assets locales, network-first para Power Automate
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Las llamadas a Power Automate/Azure van siempre a la red
    if (url.includes('logic.azure.com') || url.includes('powerautomate')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Todo lo demás: cache primero, red como fallback
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                // Cachear respuestas nuevas dinámicamente
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => {
            // Si no hay red ni cache, mostrar index (útil offline)
            if (event.request.mode === 'navigate') {
                return caches.match('./index.html');
            }
        })
    );
});
