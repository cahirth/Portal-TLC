// Portal TLC | Cloud Function — módulo Pipelines
// v1 — 2026.09.28
//
// Sexto módulo migrado. Usado en cotizaciones.html (las 3 acciones) y
// ficha-equipo.html (listarPipelines + guardarPipeline).
//
// listarPipelines y guardarPipeline son 100% Firebase puro, sin
// cambios de comportamiento respecto a FotoMap.gs.
//
// eliminarPipeline es distinta A PROPÓSITO — en FotoMap.gs, además de
// borrar el pipeline, escribía en historico.json (GitHub) para
// desvincular el pipeline borrado de las cotizaciones que lo tenían
// asignado. Siguiendo el criterio ya anotado en PLAN-MIGRACION.md
// ("se puede migrar igual, dejando ese único paso escribiendo directo
// a Firebase en cotizaciones/{id} sin pasar por el mecanismo de
// historico completo"), acá el desvincular se hace directo sobre el
// espejo de Firebase (cotizaciones/{id}), sin tocar GitHub para nada
// — coherente con sacar historico.json del camino de las acciones
// comunes. Contrapartida real: esta acción puntual ya NO deja un
// commit de auditoría en GitHub como antes (antes: "pipeline
// eliminado: X (N tarjetas)") — es una decisión consciente, no un
// descuido, dado que es una acción administrativa rara y el objetivo
// es justamente reducir la dependencia de GitHub en el camino común.
//
// Los 3 aprendizajes ya afilados: databaseURL explícito, body leído
// de req.rawBody, CORS para ir.tlcsrl.com.ar.

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
async function fbDelete(path) { await db.ref(path).remove(); }

async function listarPipelines() {
  const raw = (await fbGet('config/pipelines')) || {};
  const pipelines = Object.keys(raw).map((id) => ({ id, nombre: raw[id].nombre || id }));
  return { ok: true, pipelines };
}

async function guardarPipeline(data) {
  const nombre = String(data.nombre || '').trim();
  if (!nombre) return { ok: false, error: 'Falta el nombre del pipeline' };
  let id = String(data.id || '').trim();
  const esNuevo = !id;
  if (esNuevo) id = 'pipe_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const registro = { nombre };
  if (esNuevo) {
    registro.creado_en = new Date().toISOString();
    await fbSet('config/pipelines/' + id, registro);
  } else {
    await fbPatch('config/pipelines/' + id, registro);
  }
  return { ok: true, id };
}

async function eliminarPipeline(data) {
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  await fbDelete('config/pipelines/' + id);

  // Desvincular directo en Firebase (cotizaciones/{id}), sin tocar
  // historico.json/GitHub — ver nota arriba.
  const todas = (await fbGet('cotizaciones')) || {};
  const idsAfectados = Object.keys(todas).filter((key) => todas[key] && todas[key].pipeline_id === id);
  await Promise.all(idsAfectados.map((key) => fbPatch('cotizaciones/' + key, { pipeline_id: '' })));
  return { ok: true, tarjetasAfectadas: idsAfectados.length };
}

const ACCIONES = { listarPipelines, guardarPipeline, eliminarPipeline };

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('pipelines', async (req, res) => {
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
    console.error('Error en función pipelines:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
