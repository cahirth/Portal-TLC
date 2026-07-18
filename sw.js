// Portal TLC | sw.js | v16
// v15: Firebase Cloud Messaging — recepción de push en segundo plano.
//      importScripts de firebase-app + firebase-messaging (compat, es
//      lo único que funciona dentro de un Service Worker clásico sin
//      bundler). onBackgroundMessage muestra la notificación nativa
//      del sistema operativo; notificationclick abre/enfoca el ticket.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyBWErT79w26PGaWDCxzmcbvMzWaRJ-GzDU",
    authDomain: "portal-tlc.firebaseapp.com",
    databaseURL: "https://portal-tlc-default-rtdb.firebaseio.com",
    projectId: "portal-tlc",
    storageBucket: "portal-tlc.firebasestorage.app",
    messagingSenderId: "379089734539",
    appId: "1:379089734539:web:60fc2a3425d572e11cfd8e",
});

const _messaging = firebase.messaging();

_messaging.onBackgroundMessage(function(payload) {
    const titulo = (payload.data && payload.data.title) || 'Portal TLC';
    const cuerpo = (payload.data && payload.data.body) || '';
    const link = (payload.data && payload.data.link) || './servicio.html';
    self.registration.showNotification(titulo, {
        body: cuerpo,
        icon: './icons/icon-512.png',
        badge: './icons/icon-512.png',
        data: { link: link },
    });
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || './servicio.html';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (const c of clientList) {
                if (c.url.includes('servicio.html') && 'focus' in c) { c.navigate(link); return c.focus(); }
            }
            if (clients.openWindow) return clients.openWindow(link);
        })
    );
});

// Portal TLC | sw.js | v14
// v14: Fix "Failed to execute 'put' on 'Cache': Request method 'POST'
//      is unsupported" — la Cache API solo permite cachear pedidos
//      GET. Se agregó guard (event.request.method === 'GET') antes de
//      cada cache.put() para evitar el error en consola (no rompía el
//      flujo real, pero ensuciaba la consola en cada POST a GAS).
// v13: Se agrega version.js (fuente única de versión) a la lista
//      network-first, para que nunca quede cacheado de forma stale.
//      CACHE_NAME bumpeado → fuerza limpieza de cachés viejas al activar.
// v12: Network-first para archivos HTML propios → siempre trae la versión más nueva.
//      Cache-first solo para assets externos (Font Awesome, etc.).
//      Limpia cachés viejas automáticamente al activar.

const CACHE_NAME = 'portal-tlc-v16';

const HTML_LOCAL = [
    './',
    './index.html',
    './cotizaciones.html',
    './selector-dispositivos.html',
    './presupuesto.html',
    './servicio.html',
    './orden-servicio.html',
    './manifest.json',
    './version.js',
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

    // Los pedidos que no son GET (POST, PUT, etc. — ej. llamadas a Apps
    // Script) nunca se cachean: van directo a la red. Evita el error
    // "Failed to execute 'put' on 'Cache': Request method 'POST' is
    // unsupported" que tira la Cache API si se intenta cachear un POST.
    if (event.request.method !== 'GET') {
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
