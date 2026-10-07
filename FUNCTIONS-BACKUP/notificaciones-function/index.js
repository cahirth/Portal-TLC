// Portal TLC | Cloud Function — módulo Notificaciones
// v2 — 2026.10.07 — Cristian: "en la campanita siempre agrupar los no
//   leídos arriba". listarNotificaciones devuelve primero TODOS los no
//   leídos (más nuevos arriba) y después los leídos. De paso: antes se
//   cortaba en las 40 más nuevas, así que un aviso sin leer más viejo
//   quedaba afuera (ni se veía ni contaba en el número rojo). Ahora los no
//   leídos van siempre (hasta 100) y los leídos completan hasta 40.
// v1 — 2026.09.28
//
// Quinto módulo migrado (después de Empresas, Tareas, Fotos, y la
// mini-migración de Eventos). Transversal — usado en 5 archivos
// (cotizaciones.html, eventos.html, index.html, servicio.html,
// selector-dispositivos.html). Chico, pero el cambio se siente en
// TODA la app a la vez.
//
// 5 acciones, todas Firebase puro: guardarTokenPush,
// listarNotificaciones, marcarNotificacionLeida,
// reaccionarNotificacion, marcarTodasNotificacionesLeidas —
// equivalentes línea por línea a FotoMap.gs.
//
// BUG REAL encontrado de paso: eventos.html manda la acción
// "marcarTodasLeidas" (sin "Notificaciones" en el medio) para el
// botón de marcar todas como leídas — pero el dispatcher de
// FotoMap.gs solo tenía registrada "marcarTodasNotificacionesLeidas".
// Ese botón en Eventos nunca funcionó de verdad (Apps Script
// devolvía "acción desconocida", silenciosamente ignorado). Acá se
// registran los 2 nombres apuntando a la MISMA función — arreglado
// sin necesidad de tocar eventos.html.
//
// Los 3 aprendizajes ya afilados de las migraciones anteriores:
// databaseURL explícito, body leído de req.rawBody (Content-Type:
// text/plain), y CORS para ir.tlcsrl.com.ar.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();

async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}
async function fbSet(path, value) { await db.ref(path).set(value); return value; }
async function fbPatch(path, fields) { await db.ref(path).update(fields); return fields; }

function rtdbKeySeguro(id) {
  let clave = String(id || '').trim().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (clave.length > 200) clave = clave.substring(0, 200);
  return clave;
}

async function guardarTokenPush(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const token = String(data.token || '').trim();
  if (!email) return { ok: false, error: 'Falta email' };
  if (!token) return { ok: false, error: 'Falta token' };
  const patch = {};
  patch[token] = new Date().toISOString();
  await fbPatch('usuarios/' + rtdbKeySeguro(email) + '/fcm_tokens', patch);
  return { ok: true };
}

async function listarNotificaciones(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Falta email' };
  const nodo = await fbGet('notificaciones/' + rtdbKeySeguro(email));
  if (!nodo) return { ok: true, notificaciones: [] };
  const todas = Object.keys(nodo)
    .map((id) => { const n = nodo[id]; n.id = id; return n; })
    .filter((n) => n && typeof n === 'object')
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  const noLeidas = todas.filter((n) => !n.leido).slice(0, 100);
  const leidas = todas.filter((n) => n.leido).slice(0, Math.max(0, 40 - noLeidas.length));
  return { ok: true, notificaciones: noLeidas.concat(leidas) };
}

async function marcarNotificacionLeida(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const id = String(data.id || '').trim();
  if (!email || !id) return { ok: false, error: 'Faltan email o id' };
  await fbPatch('notificaciones/' + rtdbKeySeguro(email) + '/' + id, { leido: true });
  return { ok: true };
}

async function reaccionarNotificacion(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const id = String(data.id || '').trim();
  const reaccion = String(data.reaccion || '').trim();
  if (!email || !id) return { ok: false, error: 'Faltan email o id' };
  if (!['ok', 'no_ok', 'corazon'].includes(reaccion)) return { ok: false, error: 'Reacción inválida' };
  await fbPatch('notificaciones/' + rtdbKeySeguro(email) + '/' + id, { leido: true, reaccion });
  return { ok: true };
}

async function marcarTodasNotificacionesLeidas(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Falta email' };
  const key = rtdbKeySeguro(email);
  const nodo = await fbGet('notificaciones/' + key);
  if (!nodo) return { ok: true };
  const patch = {};
  Object.keys(nodo).forEach((id) => { if (!nodo[id].leido) patch[id + '/leido'] = true; });
  if (Object.keys(patch).length) await fbPatch('notificaciones/' + key, patch);
  return { ok: true };
}

const ACCIONES = {
  guardarTokenPush,
  listarNotificaciones,
  marcarNotificacionLeida,
  reaccionarNotificacion,
  marcarTodasNotificacionesLeidas,
  marcarTodasLeidas: marcarTodasNotificacionesLeidas, // alias — ver nota del bug real arriba
};

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('notificaciones', async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://ir.tlcsrl.com.ar');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    let data;
    try {
      const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
      data = raw ? JSON.parse(raw) : (req.body || {});
    } catch (eParse) {
      data = req.body || {};
    }
    const accion = data.accion;
    const handler = ACCIONES[accion];
    if (!handler) { res.status(400).json({ ok: false, error: 'Acción desconocida: ' + accion }); return; }
    const resultado = await handler(data);
    res.status(200).json(resultado);
  } catch (e) {
    console.error('Error en función notificaciones:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
