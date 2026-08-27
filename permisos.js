// Portal TLC | permisos.js | v2026.08.19.2 | Validación de acceso a módulos secundarios
// v2026.08.19.2: nueva función consultarPermisoModulo() — misma
//      lectura que validarAccesoModulo (columna de Vendedores,
//      TRUE/FALSE por email) pero SIN alert ni redirect en ningún
//      caso, para permisos que solo deciden si MOSTRAR o no un dato
//      en pantalla, no si se puede entrar a un módulo entero. Usada
//      por ficha-equipo.html para la columna "Ver Comisiones" (el %
//      de comisión de cada equipo, visible solo para vendedores
//      logueados con esa columna tildada — puramente informativo).
//      Ver comentario largo de la función para el detalle completo.
// BUG REAL DE FONDO — validarAccesoModulo hacía un pedido de red EN
// VIVO a Google Sheets (gviz) en CADA carga de página, en los 4
// módulos que lo usan (empresas.html, eventos.html, servicio.html,
// cotizaciones.html), esperado con await ANTES de pintar cualquier
// cosa — el timeout de 4s (v2026.08.13.1) evitaba que se colgara para
// siempre, pero el caso NORMAL (Google responde bien) igual tenía que
// esperar el viaje completo cada vez, sin excepción. Esto anulaba
// cualquier estrategia de "caché-first" que tuviera el módulo en sí
// (ver eventos.html) — no importaba qué tan rápido estuviera el
// tablero en caché, esta validación corría primero e igual bloqueaba
// todo. Reportado por Cristian: "siempre lento, lento, lento... si lo
// refresco anda bien, pero de una no anda" — el "de una no anda"
// coincide con esto exacto (cada carga NUEVA paga el viaje completo);
// el "si refresco anda bien" es muy probablemente el caché HTTP propio
// del navegador sirviendo la MISMA URL pedida segundos antes, no algo
// que el código estuviera haciendo a propósito.
//
// FIX: el resultado (permitido/no permitido) se guarda en
// sessionStorage por 10 minutos, por combinación de módulo+email. Si
// ya se validó ese mismo acceso hace menos de 10 minutos EN ESTA
// PESTAÑA, no se vuelve a pedir nada — resuelve al instante. Se
// vuelve a pedir solo si pasaron los 10 minutos, o al abrir una
// pestaña nueva (sessionStorage no persiste entre pestañas ni al
// cerrar el navegador, a propósito — para que un cambio de permisos
// en el Sheet no tarde demasiado en reflejarse).
// ══════════════════════════════════════════════════════════════════
// Se carga DESPUÉS de version.js en cualquier módulo que necesite
// controlar acceso por columna de la solapa "Vendedores" (empresas.html
// hoy; tareas.html / comercio-exterior.html / administracion.html el
// día que se construyan). Expone una sola función:
//
//   const ok = await validarAccesoModulo('Empresas');
//   if (!ok) return; // ya mostró el alert y redirigió a index.html
//
// El nombre de columna que se le pasa tiene que ser EXACTO como está
// escrito en la fila de encabezados de la solapa Vendedores (ej.
// 'Empresas', 'Tareas', 'Comercio Exterior', 'Administracion' — sin
// tilde, así está cargada hoy).
//
// Mismo criterio de "fail-open" que ya usa index.html: si falla la
// consulta al Sheet (sin internet, Google caído, etc.) NO se bloquea
// al usuario — se deja pasar. La prioridad es no dejar a nadie afuera
// del Portal por un problema de red ajeno a los permisos en sí.
// ══════════════════════════════════════════════════════════════════

const SHEET_ID_PERMISOS_JS = '1WNEOD8qtHJfyM0wVgQqCEKOkDNg4Z6mJU1KrCIfh2nU';
const SESSION_KEY_PERMISOS_JS = 'tlc_session_v1';

async function validarAccesoModulo(columnaSheet) {
  try {
    // 1) Sesión — si no hay sesión válida, ni vale la pena consultar el
    // Sheet: directo a index.html (que tiene la pantalla de login).
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
    // instante sin pedir nada a Google. Ver comentario de v2026.08.16.1
    // arriba para la explicación completa del problema que esto
    // resuelve.
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

    // 3) Consulta directa al Sheet publicado (mismo endpoint gviz que
    // usa index.html — sin pasar por el GAS, lectura pública).
    //
    // TIMEOUT REAL — antes este fetch no tenía ningún límite de
    // tiempo. Si el endpoint de Google tardaba mucho o directamente
    // no respondía (pasa de vez en cuando con gviz, no es una API
    // pensada para alta disponibilidad), el await se quedaba
    // esperando PARA SIEMPRE — y como esta función se llama con
    // await antes de pintar cualquier cosa en TODOS los módulos que
    // la usan, la página entera quedaba colgada sin ningún aviso.
    // Ahora, si Google no responde en 4 segundos, se corta sola y
    // sigue de largo (mismo criterio fail-open que ya tenía el resto
    // de la función para cualquier otro error). Reportado por
    // Cristian: "a veces no carga, da error de timeout y se torna
    // lento... comparalos".
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID_PERMISOS_JS}/gviz/tq?tqx=out:json&sheet=Vendedores`;
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    const text = await res.text();
    const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
    if (!match) return true; // respuesta rara del Sheet — fail-open

    const json = JSON.parse(match[1]);
    const rows = json.table.rows;
    const cols = json.table.cols.map(c => c.label);

    const emailIdx = cols.indexOf('Email');
    const colIdx   = cols.indexOf(columnaSheet);

    if (colIdx === -1) {
      // La columna todavía no existe en el Sheet — fail-open (no
      // bloqueamos por una columna que ni siquiera está cargada).
      console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en Vendedores — se permite el acceso.');
      return true;
    }

    const fila = rows.find(r => {
      const v = r.c[emailIdx]?.v || '';
      return v.toLowerCase().trim() === email.toLowerCase().trim();
    });

    const permitido = fila
      ? (fila.c[colIdx]?.v === true || fila.c[colIdx]?.v === 'TRUE' || fila.c[colIdx]?.v === 'true' || fila.c[colIdx]?.v === 1)
      : false; // email no encontrado en Vendedores → sin acceso

    try { sessionStorage.setItem(claveCache, JSON.stringify({ permitido: permitido, ts: Date.now() })); } catch(eCacheSet) { /* no crítico — solo significa que la próxima carga vuelve a pedir */ }

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
// ningún alert ni redirect en ningún caso. Para permisos que solo
// deciden si MOSTRAR o no un dato en pantalla (no si se puede entrar
// a un módulo entero) — ej. "Ver Comisiones" en ficha-equipo.html,
// que decide si ese vendedor ve el % de comisión de cada equipo, sin
// bloquear el resto de la ficha para nadie. Mismo criterio fail-open:
// ante cualquier error, se resuelve en true (no rompe nada visual por
// un problema de red).
//
//   const puedeVer = await consultarPermisoModulo('Ver Comisiones');
//   if (puedeVer) { /* mostrar el dato */ }
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID_PERMISOS_JS}/gviz/tq?tqx=out:json&sheet=Vendedores`;
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    const text = await res.text();
    const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
    if (!match) return true;

    const json = JSON.parse(match[1]);
    const rows = json.table.rows;
    const cols = json.table.cols.map(c => c.label);
    const emailIdx = cols.indexOf('Email');
    const colIdx   = cols.indexOf(columnaSheet);
    if (colIdx === -1) { console.warn('[permisos.js] Columna "' + columnaSheet + '" no encontrada en Vendedores — se permite mostrar igual.'); return true; }

    const fila = rows.find(r => { const v = r.c[emailIdx]?.v || ''; return v.toLowerCase().trim() === email.toLowerCase().trim(); });
    const permitido = fila
      ? (fila.c[colIdx]?.v === true || fila.c[colIdx]?.v === 'TRUE' || fila.c[colIdx]?.v === 'true' || fila.c[colIdx]?.v === 1)
      : false;

    try { sessionStorage.setItem(claveCache, JSON.stringify({ permitido: permitido, ts: Date.now() })); } catch(eCacheSet) {}
    return permitido;
  } catch(e) {
    console.warn('[permisos.js] Error consultando permiso visual (fail-open, se muestra igual):', e);
    return true;
  }
}
