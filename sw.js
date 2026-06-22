const CACHE_NAME = 'portal-tlc-v10';
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

// Instalación: cachear assets críticos — si uno falla no bloquea el SW
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Portal TLC v10: cacheando assets...');
            // addAll falla si cualquier recurso da error; usamos add individual
            // con catch para que íconos faltantes o recursos externos no rompan todo
            return Promise.allSettled(
                ASSETS.map(url => cache.add(url).catch(e => console.warn('Cache skip:', url, e.message)))
            );
        })
    );
    self.skipWaiting();
});

// Activación: limpiar caches viejos
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => {
                    console.log('Portal TLC: eliminando caché viejo:', k);
                    return caches.delete(k);
                })
            )
        )
    );
    self.clients.claim();
});

// Fetch: network-first para GAS/RTDB/GitHub API, cache-first para todo lo demás
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Siempre a la red: GAS, Firebase, GitHub API, Power Automate
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

    // Todo lo demás: cache primero, red como fallback
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
