// Portal TLC | Cloud Function — módulo Tareas (mi-dia.html)
// v1 — 2026.09.22
//
// Segundo módulo migrado fuera de Apps Script (después de Empresas).
// Mismo criterio de selección: 4 acciones (crearTarea, listarTareas,
// completarTarea, eliminarTarea), todas Firebase puro sobre un único
// nodo por tarea (tareas/{id}), sin tocar historico.json en GitHub ni
// compartir lógica con ningún otro módulo — mi-dia.html usa ADEMÁS
// marcarNegocioUrgente/marcarTarjetaUrgenteEv/st_actualizarCampo,
// pero esas 3 las usan también cotizaciones.html/eventos.html/
// servicio.html directamente, así que quedan en Apps Script por ahora
// (migrarlas implicaría tocar 4 archivos a la vez, no solo éste).
//
// Ya con los 2 aprendizajes de la migración de Empresas aplicados
// desde el vamos:
// 1. admin.initializeApp() con databaseURL explícito — sin esto, el
//    contenedor puede no arrancar (Container Healthcheck failed).
// 2. El cuerpo del POST se lee de req.rawBody, no de req.body — el
//    Portal manda Content-Type: text/plain (mismo criterio que Apps
//    Script) y Express solo llena req.body solo si el header dice
//    literalmente application/json.

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

// Mismo formato de ID que _tareaGenerarId() en FotoMap.gs:
// TAREA-YYYYMMDD-XXXX (fecha en huso horario de Argentina).
function tareaGenerarId() {
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return 'TAREA-' + fecha + '-' + rand;
}

// ── Las 4 acciones — mismo comportamiento que FotoMap.gs, línea por línea ──

async function crearTarea(data) {
  const titulo = String(data.titulo || '').trim();
  const usuarioEmail = String(data.usuario_email || '').trim();
  if (!titulo) return { ok: false, error: 'Falta el título de la tarea' };
  if (!usuarioEmail) return { ok: false, error: 'Falta usuario_email (a quién pertenece la tarea)' };

  const id = tareaGenerarId();
  const ahoraIso = new Date().toISOString();
  const tarea = {
    id, titulo,
    descripcion: String(data.descripcion || '').trim(),
    usuario_email: usuarioEmail,
    usuario_nombre: String(data.usuario_nombre || '').trim(),
    fecha: String(data.fecha || '').trim(),
    completada: false,
    creado_en: ahoraIso,
    completada_en: null,
    creado_por_email: String(data.creado_por_email || usuarioEmail).trim(),
    creado_por_nombre: String(data.creado_por_nombre || data.usuario_nombre || '').trim(),
  };
  await fbSet('tareas/' + id, tarea);
  return { ok: true, tarea };
}

async function listarTareas(data) {
  const usuarioEmail = String(data.usuario_email || '').trim();
  if (!usuarioEmail) return { ok: false, error: 'Falta usuario_email' };
  const solicitanteEmail = String(data.solicitante_email || '').trim();
  const esAdmin = String(data.solicitante_rol || '') === 'Administrador';
  if (!esAdmin && solicitanteEmail.toLowerCase() !== usuarioEmail.toLowerCase()) {
    return { ok: false, error: 'No tenés permiso para ver las tareas de otro usuario' };
  }

  const todas = (await fbGet('tareas')) || {};
  const tareas = Object.values(todas).filter((t) => t && String(t.usuario_email || '').toLowerCase() === usuarioEmail.toLowerCase());
  tareas.sort((a, b) => String(a.fecha || '9999').localeCompare(String(b.fecha || '9999')));
  return { ok: true, tareas };
}

async function completarTarea(data) {
  const id = String(data.id_tarea || '').trim();
  if (!id) return { ok: false, error: 'Falta id_tarea' };
  const ruta = 'tareas/' + id;
  const entrada = await fbGet(ruta);
  if (!entrada) return { ok: false, error: 'Tarea no encontrada: ' + id };

  const completada = data.completada !== false;
  await fbPatch(ruta, { completada, completada_en: completada ? new Date().toISOString() : null });
  return { ok: true, completada };
}

async function eliminarTarea(data) {
  const id = String(data.id_tarea || '').trim();
  if (!id) return { ok: false, error: 'Falta id_tarea' };
  const ruta = 'tareas/' + id;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarea no encontrada: ' + id };
  await fbSet(ruta, null); // Firebase borra el nodo con un set a null
  return { ok: true };
}

const ACCIONES = { crearTarea, listarTareas, completarTarea, eliminarTarea };

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('tareas', async (req, res) => {
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
    console.error('Error en función tareas:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
