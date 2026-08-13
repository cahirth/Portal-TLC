// Portal TLC | permisos.js | v2026.08.13.1 | Validación de acceso a módulos secundarios
// FIX: el fetch al Sheet de Google no tenía ningún límite de tiempo —
// si Google tardaba de más o no respondía (pasa de vez en cuando con
// el endpoint gviz, no es una API pensada para alta disponibilidad),
// el await se quedaba esperando PARA SIEMPRE, colgando la página
// entera en TODOS los módulos que usan esta función (empresas.html,
// eventos.html, servicio.html, cotizaciones.html — los 4 la cargan).
// Ahora corta sola a los 4 segundos y sigue de largo (fail-open, mismo
// criterio que ya tenía el resto de la función). Reportado por
// Cristian: "a veces no carga, da error de timeout... comparalos, y
// acordate que ayer miraba un excel de permisos en gsheet".
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

    // 2) Consulta directa al Sheet publicado (mismo endpoint gviz que
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
