// Portal TLC | permisos.js | v2026.08.30.1 | Validación de acceso a módulos secundarios
// v2026.08.30.1: BUG DE FONDO REAL resuelto de raíz — hasta ahora,
//      cada llamada (con el caché de sessionStorage vencido) pedía
//      los permisos EN VIVO a Google Sheets (gviz). Es la MISMA
//      familia de problemas que ya se vio con los pipelines ("a veces
//      no aparecen") — gviz no está pensado para alta disponibilidad,
//      y una consulta que falla ahí antes solo tenía el timeout de 4s
//      como red de contención, sin reintento. Cristian: "quiero que
//      todos los permisos del excel... los subamis a firebase
//      manualmente con un boton script como el lista de precios, y
//      asi los cambios son immediatos" — confirmado que "inmediato"
//      significa apenas se toca el botón de sincronizar (mismo
//      criterio que YA rige para Lista_Precios), no en vivo sin tocar
//      nada. Ahora ambas funciones leen de Firebase RTDB
//      (/permisos/{clave}, sincronizado por sincronizarPermisosAFirebase
//      en FotoMap.gs v202) en vez de gviz — mucho más rápido y sin la
//      fragilidad de gviz. La clave en Firebase es el email en
//      minúsculas, saneado con el MISMO criterio que usa el resto del
//      Portal para claves de RTDB (_rtdbKeySeguroJs, replica
//      _rtdbKeySeguro de FotoMap.gs) — y el NOMBRE DE COLUMNA
//      buscado también se sanea igual (_rtdbHeaderSeguroJs, replica
//      _rtdbHeaderSeguro), porque el backend guarda los headers
//      saneados (espacios → "_", ej. "Servicio Tecnico" queda como
//      "Servicio_Tecnico") — sin este segundo saneo, columnas con
//      espacio en el nombre nunca hubieran matcheado. Se mantiene
//      TAL CUAL toda la lógica de sesión, caché de sessionStorage (10
//      min) y fail-open ante cualquier error — solo cambió DE DÓNDE
//      se leen los datos, no el resto del comportamiento.
// v2026.08.19.2: nueva función consultarPermisoModulo() — misma
//      lectura que validarAccesoModulo (columna de Vendedores,
//      TRUE/FALSE por email) pero SIN alert ni redirect en ningún
//      caso, para permisos que solo deciden si MOSTRAR o no un dato
//      en pantalla, no si se puede entrar a un módulo entero.
// ══════════════════════════════════════════════════════════════════
// Se carga DESPUÉS de version.js en cualquier módulo que necesite
// controlar acceso por columna de la solapa "Vendedores". Expone dos
// funciones:
//
//   const ok = await validarAccesoModulo('Empresas');
//   if (!ok) return; // ya mostró el alert y redirigió a index.html
//
//   const puedeVer = await consultarPermisoModulo('Ver Comisiones');
//   if (puedeVer) { /* mostrar el dato, sin bloquear nada más */ }
//
// El nombre de columna que se le pasa tiene que ser EXACTO como está
// escrito en la fila de encabezados de la solapa Vendedores. El saneo
// para buscarlo en Firebase (espacios → "_") lo hace esta librería
// sola, no hace falta pasarlo ya saneado.
//
// Mismo criterio de "fail-open" que ya usa index.html: si falla la
// consulta a Firebase (sin internet, etc.) NO se bloquea al usuario —
// se deja pasar.
// ══════════════════════════════════════════════════════════════════

const RTDB_URL_PERMISOS_JS = 'https://portal-tlc-default-rtdb.firebaseio.com';
const SESSION_KEY_PERMISOS_JS = 'tlc_session_v1';

// Replica EXACTA de _rtdbKeySeguro en FotoMap.gs — tiene que dar la
// MISMA clave para el mismo email en los dos lados, o el lookup en
// Firebase nunca encuentra nada.
function _rtdbKeySeguroJs(s) {
  let clave = String(s || '').trim().replace(/[.#$\[\]\/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (clave.length > 200) clave = clave.substring(0, 200);
  return clave;
}
// Replica EXACTA de _rtdbHeaderSeguro en FotoMap.gs — el backend
// guarda los NOMBRES DE COLUMNA saneados (espacios → "_"), así que
// hay que aplicar el mismo saneo acá para poder encontrarlos.
function _rtdbHeaderSeguroJs(h) {
  return String(h || '').trim().replace(/[.#$\[\]\/\s]/g, '_');
}

// Trae la fila de permisos completa de un usuario desde Firebase.
// Devuelve null SOLO cuando la consulta funcionó bien pero esa clave
// no existe (usuario genuinamente no sincronizado) — eso es una
// respuesta VÁLIDA de Firebase, distinta de una falla de red. Si la
// consulta en sí falla (sin conexión, timeout, Firebase caído),
// TIRA la excepción en vez de devolver null — así el llamador puede
// distinguir "no hay red" (debe fail-open) de "usuario no existe"
// (sin acceso, no es lo mismo). Antes ambos casos devolvían null por
// igual, y una simple falla de red terminaba bloqueando a cualquiera
// como si no existiera en /permisos — bug real encontrado por el
// propio test de esta función.
async function _leerFilaPermisosJs(email) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const clave = _rtdbKeySeguroJs(email.toLowerCase().trim());
    const res = await fetch(`${RTDB_URL_PERMISOS_JS}/permisos/${clave}.json`, { signal: controller.signal });
    if (!res.ok) throw new Error('Firebase respondió ' + res.status);
    return await res.json(); // null acá es válido: la clave no existe
  } finally {
    clearTimeout(timeoutId);
  }
}

async function validarAccesoModulo(columnaSheet) {
  try {
    // 1) Sesión — si no hay sesión válida, ni vale la pena consultar
    // Firebase: directo a index.html (que tiene la pantalla de login).
    const raw = localStorage.getItem(SESSION_KEY_PERMISOS_JS);
    if (!raw) { window.location.href = 'index.html'; return false; }
    let payload;
    try { payload = JSON.parse(raw); } catch(e) { window.location.href = 'index.html'; return false; }
    if (!payload.expira || Date.now() > payload.expira) {
      localStorage.removeItem(SESSION_KEY_PERMISOS_JS);
      window.location.href = 'index.html';
      return false;
    }
    const email = payload.account && payload.account.username;
    if (!email) { window.location.href = 'index.html'; return false; }

    // 2) Caché — si ya se validó este mismo acceso (módulo + email)
    // hace menos de 10 minutos EN ESTA PESTAÑA, se resuelve al
    // instante sin pedir nada de nuevo.
    const TTL_PERMISOS_MS = 10 * 60 * 1000; // 10 minutos
    const claveCache = 'permiso_cache_' + columnaSheet + '_' + email.toLowerCase().trim();
    try {
      const cacheRaw = sessionStorage.getItem(claveCache);
      if (cacheRaw) {
        const cache = JSON.parse(cacheRaw);
        if (cache && typeof cache.permitido === 'boolean' && (Date.now() - cache.ts) < TTL_PERMISOS_MS) {
          if (!cache.permitido) {
            alert('🔒 No tienes permiso para acceder a este módulo');
            window.location.href = 'index.html';
            return false;
          }
          return true;
        }
      }
    } catch(eCacheGet) { /* sessionStorage no disponible o corrupto — se sigue de largo y se pide fresco */ }

    // 3) Leer de Firebase (sincronizado con el botón manual en el
    // Sheet — ver sincronizarPermisosAFirebase en FotoMap.gs).
    const fila = await _leerFilaPermisosJs(email);
    if (!fila) {
      // Usuario no encontrado en /permisos — mismo criterio que antes
      // tenía "email no encontrado en Vendedores": sin acceso.
      alert('🔒 No tienes permiso para acceder a este módulo');
      window.location.href = 'index.html';
      return false;
    }

    const claveColumna = _rtdbHeaderSeguroJs(columnaSheet);
    if (!(claveColumna in fila)) {
      // La columna todavía no existe / no se sincronizó — fail-open
      // (no bloqueamos por una columna que ni siquiera está cargada).
      console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en /permisos — se permite el acceso.');
      return true;
    }

    const valorCrudo = fila[claveColumna];
    const permitido = valorCrudo === true || valorCrudo === 'TRUE' || valorCrudo === 'true' || valorCrudo === 1;

    try { sessionStorage.setItem(claveCache, JSON.stringify({ permitido: permitido, ts: Date.now() })); } catch(eCacheSet) { /* no crítico */ }

    if (!permitido) {
      alert('🔒 No tienes permiso para acceder a este módulo');
      window.location.href = 'index.html';
      return false;
    }
    return true;

  } catch(e) {
    console.warn('[permisos.js] Error validando acceso (fail-open, se permite igual):', e);
    return true;
  }
}

// ══════════════════════════════════════════════════════════════════
// consultarPermisoModulo — misma lectura que validarAccesoModulo
// (columna de la solapa Vendedores, TRUE/FALSE por email), pero SIN
// ningún alert ni redirect en ningún caso. Mismo criterio fail-open:
// ante cualquier error, se resuelve en true (no rompe nada visual por
// un problema de red).
// ══════════════════════════════════════════════════════════════════
async function consultarPermisoModulo(columnaSheet) {
  try {
    const raw = localStorage.getItem(SESSION_KEY_PERMISOS_JS);
    if (!raw) return false; // sin sesión, no hay a quién mostrarle nada
    let payload;
    try { payload = JSON.parse(raw); } catch(e) { return false; }
    if (!payload.expira || Date.now() > payload.expira) return false;
    const email = payload.account && payload.account.username;
    if (!email) return false;

    const TTL_PERMISOS_MS = 10 * 60 * 1000;
    const claveCache = 'permiso_visual_cache_' + columnaSheet + '_' + email.toLowerCase().trim();
    try {
      const cacheRaw = sessionStorage.getItem(claveCache);
      if (cacheRaw) {
        const cache = JSON.parse(cacheRaw);
        if (cache && typeof cache.permitido === 'boolean' && (Date.now() - cache.ts) < TTL_PERMISOS_MS) {
          return cache.permitido;
        }
      }
    } catch(eCacheGet) {}

    const fila = await _leerFilaPermisosJs(email);
    if (!fila) return false; // usuario no encontrado — sin acceso

    const claveColumna = _rtdbHeaderSeguroJs(columnaSheet);
    if (!(claveColumna in fila)) {
      console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en /permisos — se permite mostrar igual.');
      return true;
    }

    const valorCrudo = fila[claveColumna];
    const permitido = valorCrudo === true || valorCrudo === 'TRUE' || valorCrudo === 'true' || valorCrudo === 1;

    try { sessionStorage.setItem(claveCache, JSON.stringify({ permitido: permitido, ts: Date.now() })); } catch(eCacheSet) {}
    return permitido;
  } catch(e) {
    console.warn('[permisos.js] Error consultando permiso visual (fail-open, se muestra igual):', e);
    return true;
  }
}
