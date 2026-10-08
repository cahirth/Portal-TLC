// Portal TLC | version.js | Fuente única de la versión de la PWA.
// Se carga desde todos los módulos (index.html, cotizaciones.html,
// servicio.html, selector-dispositivos.html, presupuesto.html,
// orden-servicio.html, remito-ingreso.html, ficha-equipo.html,
// empresas.html, eventos.html, mi-dia.html) para que exista un solo
// número de versión que sincronizar en cada actualización, en vez de
// repetirlo en cada archivo.
//
// Al subir un cambio: actualizar SOLO esta línea. El console.log y el
// texto visible en el menú de avatar de cada módulo lo leen de acá.
const PORTAL_TLC_VERSION = "2026.10.07.3";

// Contador rojo en el ícono de la app instalada (v2026.10.07.2) —
// Cristian: "un contador rojito con números en el ícono de la PWA
// instalada, como WhatsApp". Lo llaman las campanitas de cada módulo con
// la cantidad de avisos sin leer. Funciona en PC (Chrome/Edge, app
// instalada) y en iPhone (app agregada a inicio, con notificaciones
// permitidas). En Android el sistema muestra un puntito solo cuando hay
// una notificación sin abrir. Además guarda el número para que sw.js lo
// siga sumando cuando llega un push con la app cerrada.
function tlcIconoApp(n) {
  n = Math.max(0, parseInt(n, 10) || 0);
  try {
    if (navigator.setAppBadge) { if (n > 0) navigator.setAppBadge(n).catch(function(){}); else navigator.clearAppBadge().catch(function(){}); }
  } catch (e) {}
  try { if (window.caches) caches.open('tlc-badge').then(function(c) { return c.put('./__badge__', new Response(String(n))); }).catch(function(){}); } catch (e) {}
}
