// Portal TLC | sw.js | v12
// v12: Network-first para archivos HTML propios → siempre trae la versión más nueva.
//      Cache-first solo para assets externos (Font Awesome, etc.).
//      Limpia cachés viejas automáticamente al activar.

const CACHE_NAME = 'portal-tlc-v12';

const HTML_LOCAL = [
    './',
    './index.html',
    './cotizaciones.html',
    './selector-dispositivos.html',
    './presupuesto.html',
    './servicio.html',
    './orden-servicio.html',
    './manifest.json',
];

const ASSETS_EXTERNOS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Portal TLC SW v12: cacheando assets externos...');
            return Promise.allSettled(
                ASSETS_EXTERNOS.map(url => cache.add(url).catch(e => console.warn('Cache skip:', url, e.message)))
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
                console.log('Portal TLC SW: limpiando caché vieja:', k);
                return caches.delete(k);
            }))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Ignorar esquemas no cacheables
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    // Siempre a la red: APIs externas
    if (
        url.includes('script.google.com') ||
        url.includes('firebaseio.com') ||
        url.includes('firebase.googleapis.com') ||
        url.includes('api.github.com') ||
        url.includes('raw.githubusercontent.com') ||
        url.includes('azure.com') ||
        url.includes('hubapi.com') ||
        url.includes('lh3.googleusercontent.com') ||
        url.includes('dolarapi.com')
    ) {
        event.respondWith(fetch(event.request));
        return;
    }

    // HTML propio → Network-first: intenta red, si falla usa caché
    const isLocalHTML = HTML_LOCAL.some(p => url.endsWith(p.replace('./', '')) || url.endsWith('/'));
    if (isLocalHTML || event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
        );
        return;
    }

    // Assets externos → Cache-first
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
