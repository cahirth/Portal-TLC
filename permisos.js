// Portal TLC | permisos.js | v2026.10.03.9 — CORRECCIÓN DE SEGURIDAD: se quita el alias Comisiones → "Ver Comisiones" (son permisos distintos; el alias les abría el módulo Comisiones a vendedores externos). || v2026.10.03.8 — Cristian: "que la PWA lea cada vez si el usuario tiene acceso o no a tal módulo". Sin caché: cada apertura de un módulo consulta /permisos en Firebase (sin caché del navegador). Además, si el Rol cambió en Firebase, actualiza la sesión y recarga una vez, para que el módulo use el rol nuevo (Servicio, Cotizaciones, Eventos, Cuenta Corriente y Comisiones lo leen de la sesión). || v2026.09.30.11 — BUG REAL de fondo en Comisiones: en Firebase quedó "Comisiones": 0 (una columna numérica con el mismo nombre pisa a la de tildes al sincronizar) y "Ver_Comisiones": true. Ahora una columna solo cuenta como permiso si su valor es un tilde (true/false); si no, se usa el alias "Ver Comisiones". || v2026.09.30.9 — BUG REAL (Cristian: "está habilitada pero me dice no tenés permiso para este módulo"): el resultado de cada permiso se guardaba 10 min en sessionStorage, incluido el "NO". Si se entraba antes de sincronizar el permiso nuevo, quedaba bloqueado 10 min aunque ya estuviera habilitado. Ahora solo se reutiliza un "SÍ"; un "NO" se vuelve a consultar siempre. (v2026.09.30.8: se acepta la columna "Comisiones" o "Ver Comisiones".)
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
    const res = await fetch(`${RTDB_URL_PERMISOS_JS}/permisos/${clave}.json?_=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('Firebase respondió ' + res.status);
    return await res.json(); // null acá es válido: la clave no existe
  } finally {
    clearTimeout(timeoutId);
  }
}

// Alias de columnas de la hoja Vendedores: la columna de Comisiones se
// llama "Ver Comisiones" en la planilla (así la lee cotizaciones.html),
// pero el inicio y comisiones.html la pedían como "Comisiones". Con el
// nombre equivocado, el inicio la daba por NO habilitada para todos, y
// comisiones.html (fail-open) dejaba entrar a cualquiera por link
// directo. Se acepta cualquiera de los dos nombres.
// SIN ALIAS (v2026.10.03.9): "Ver Comisiones" NO es el permiso del módulo
// Comisiones — es otro permiso (ver el % de comisión en la ficha de equipo
// y en Cotizaciones). Usarlo como respaldo de "Comisiones" (v2026.09.30.8
// a .11) les abría el módulo a vendedores externos que tienen "Ver
// Comisiones" tildado. Cada permiso se lee solo de su propia columna.
// El "Comisiones": 0 de Firebase viene de una SEGUNDA columna llamada
// "Comisiones" en la hoja Vendedores (numérica, un porcentaje) que pisa a
// la de tildes al sincronizar: se arregla renombrando esa columna.
function _claveColumnaConAliasJs(fila, columnaSheet) {
  return _rtdbHeaderSeguroJs(columnaSheet);
}

// Si el Rol o el nombre de la sesión no coinciden con Firebase, actualiza
// la sesión (mismo vencimiento) y devuelve true para que el llamador
// recargue. Al recargar ya coinciden, así que no puede entrar en bucle.
function _actualizarSesionDesdeFilaJs(payload, fila) {
  try {
    const rol = String(fila[_rtdbHeaderSeguroJs('Rol')] || '').trim();
    const nombre = String(fila[_rtdbHeaderSeguroJs('Nombre Vendedor')] || '').trim();
    if (!rol || !payload || !payload.account) return false;
    let cambio = false;
    if (payload.account.rol !== rol) { console.log('[permisos.js] Rol actualizado desde Firebase: ' + (payload.account.rol || '—') + ' → ' + rol); payload.account.rol = rol; cambio = true; }
    if (nombre && payload.account.name !== nombre) { payload.account.name = nombre; cambio = true; }
    if (!cambio) return false;
    localStorage.setItem(SESSION_KEY_PERMISOS_JS, JSON.stringify(payload));
    // Seguro anti-bucle: como mucho una recarga por rol en esta pestaña
    const marca = 'permisos_recarga_' + rol;
    if (sessionStorage.getItem(marca)) return false;
    sessionStorage.setItem(marca, '1');
    return true;
  } catch (e) { return false; }
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

    // 2) SIN CACHÉ — Cristian: "que la PWA lea cada vez si el usuario
    // tiene acceso o no a tal módulo". Cada apertura consulta Firebase
    // (una lectura chica, ~100 ms). Lo que se cambie en la planilla y se
    // sincronice con el botón aplica la próxima vez que se abra el módulo.

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

    // ROL AL DÍA — los módulos usan el rol guardado en la sesión (se
    // guardaba solo al iniciar sesión). Si en Firebase cambió, se
    // actualiza la sesión y se recarga la página UNA vez, para que el
    // módulo arranque con el rol nuevo.
    if (_actualizarSesionDesdeFilaJs(payload, fila)) { window.location.reload(); return false; }

    const claveColumna = _claveColumnaConAliasJs(fila, columnaSheet);
    if (!(claveColumna in fila)) {
      // La columna todavía no existe / no se sincronizó — fail-open
      // (no bloqueamos por una columna que ni siquiera está cargada).
      console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en /permisos — se permite el acceso.');
      return true;
    }

    const valorCrudo = fila[claveColumna];
    const permitido = valorCrudo === true || valorCrudo === 'TRUE' || valorCrudo === 'true' || valorCrudo === 1;

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

    // Sin caché: se consulta Firebase cada vez (ver validarAccesoModulo).
    const fila = await _leerFilaPermisosJs(email);
    if (!fila) return false; // usuario no encontrado — sin acceso

    const claveColumna = _claveColumnaConAliasJs(fila, columnaSheet);
    if (!(claveColumna in fila)) {
      console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en /permisos — se permite mostrar igual.');
      return true;
    }

    const valorCrudo = fila[claveColumna];
    const permitido = valorCrudo === true || valorCrudo === 'TRUE' || valorCrudo === 'true' || valorCrudo === 1;

    return permitido;
  } catch(e) {
    console.warn('[permisos.js] Error consultando permiso visual (fail-open, se muestra igual):', e);
    return true;
  }
}
