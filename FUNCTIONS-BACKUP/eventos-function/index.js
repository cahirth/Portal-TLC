// Portal TLC | Cloud Function — Eventos: Checklist + Notas + Listado
// v4 — 2026.10.08 — También tableros de Regulatoria (modulo 'regulatoria'),
//   para registros y trámites ANMAT: un tablero nuevo arranca con columnas
//   del trámite (Por iniciar → Armando documentación → Presentado en ANMAT →
//   Observado / a responder → Aprobado → Por renovar).
// v3 — 2026.10.08 — Tableros de Comercio Exterior: cada tablero tiene un
//   "modulo" ('eventos' por defecto, o 'comex'). ev_listarEventos lo
//   devuelve, ev_crearEvento lo acepta, y la nueva ev_moverModulo
//   (Administrador) pasa un tablero de Eventos a Comercio Exterior o al
//   revés, con todo su contenido (es el mismo tablero, no una copia).
// v2 — 2026.10.06 — Tildes de lectura tipo WhatsApp en los mensajes con
//   @menciones (con_lectura + lecturas[<email>]); nueva acción
//   ev_marcarMensajesLeidos. Corrige además el aviso de mención: guardaba
//   el índice del mensaje en tarjeta_id (en vez de la tarjeta), así que
//   tocar el aviso en la campanita no llevaba a la tarjeta correcta.
// v1 — 2026.09.27
//
// Cuarto módulo migrado — pero DISTINTO a los anteriores: no es "todo
// Eventos" (32+ acciones), es un recorte urgente de 12 acciones
// puntuales. Cristian, con el congreso del 1-2 de octubre encima:
// "estoy trabajando para un congreso... y estoy sufriendo el modulo
// eventos... guardar checklist, listar tarjetas, guardar notas, es un
// suplicio". El resto de Eventos (crear/editar/mover tarjetas, fotos,
// mensajes, etc.) queda en Apps Script por ahora — se migra completo
// más adelante, con más calma, siguiendo PLAN-MIGRACION.md.
//
// Las 12 acciones acá: ev_listarEventos, ev_crearChecklistGrupo,
// ev_editarChecklistGrupo, ev_borrarChecklistGrupo,
// ev_agregarChecklistItem, ev_toggleChecklistItem,
// ev_reordenarChecklistItems, ev_eliminarChecklistItem,
// ev_editarChecklistItem, ev_agregarNota, ev_editarNota,
// ev_eliminarNota — equivalentes línea por línea a FotoMap.gs.
//
// Incluye el efecto secundario real que tenían en Apps Script:
// notificar (push + mail) a quien te mencionan en un ítem de
// checklist, o al responsable de la tarjeta cuando se completa una
// subtarea — usando firebase-admin's messaging() para el push (mucho
// más simple que el JWT/FCM REST manual de Apps Script) y un fetch
// directo a Brevo para el mail.
//
// Mismos 3 aprendizajes ya probados en Empresas/Tareas/Fotos:
// databaseURL explícito, body leído de req.rawBody (Content-Type:
// text/plain), y CORS para ir.tlcsrl.com.ar.
//
// Variable de entorno nueva que esta función SÍ necesita (a
// diferencia de las anteriores): BREVO_API_KEY — ver DESPLIEGUE.md.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();
const messaging = admin.messaging();
const bucket = admin.storage().bucket('portal-tlc.firebasestorage.app');

// Sube un archivo a Firebase Storage (logos, adjuntos) — mismo bucket
// y misma forma de URL pública que ya usaba FotoMap.gs vía la API
// REST de Cloud Storage; acá el SDK de Admin lo hace en una llamada.
async function storageSubirArchivo(path, base64Data, contentType) {
  const buffer = Buffer.from(base64Data, 'base64');
  const file = bucket.file(path);
  await file.save(buffer, { contentType, resumable: false });
  const publicUrl = 'https://firebasestorage.googleapis.com/v0/b/portal-tlc.firebasestorage.app/o/' + encodeURIComponent(path) + '?alt=media';
  return { ok: true, url: publicUrl, path, size: buffer.length };
}
async function storageBorrarArchivo(path) {
  try { await bucket.file(path).delete(); } catch (e) { if (e.code !== 404) throw e; }
  return true;
}

async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}
async function fbGetShallow(path) {
  // El Admin SDK no tiene un "shallow" nativo como la REST API de
  // Apps Script — pero acá solo se usa para saber CUÁLES hijos
  // existen (los ids), así que alcanza con pedir el nodo completo;
  // con el volumen real de datos de este Portal el costo es mínimo.
  return fbGet(path);
}
async function fbSet(path, value) { await db.ref(path).set(value); return value; }
async function fbPatch(path, fields) { await db.ref(path).update(fields); return fields; }
async function fbDelete(path) { await db.ref(path).remove(); }

// BUG REAL — Cristian: "cuando lista los items del check list no
// trae el ultimo agregado, como q le cuesta refrescar el ultimo
// ingresado o los ultimos ingresados". Causa: leer la tarjeta,
// modificar el array de checklists/notas en memoria, y volver a
// escribirlo entero (el mismo patrón que ya traía FotoMap.gs) tiene
// una condición de carrera clásica — si 2 pedidos se superponen
// (agregar 2 ítems rápido, uno atrás del otro, ANTES de que el
// primero termine) ambos leen el MISMO estado inicial, y el que
// escribe último pisa por completo lo que escribió el primero,
// perdiendo su ítem sin ningún error visible. Con Apps Script esto
// ya pasaba, pero al ser más lento el margen para que se solaparan 2
// pedidos era menor — con la Cloud Function, mucho más rápida, el
// mismo diseño se dispara con más facilidad. La solución de fondo:
// una transacción atómica de Firebase sobre la tarjeta — si 2
// pedidos chocan, Firebase reintenta solo el que llegó después con
// el dato YA actualizado por el primero, en vez de dejar que se
// pisen. runTransaccionTarjeta(ruta, fn) hace exactamente eso: fn
// recibe la tarjeta actual (puede ser la MISMA que leyó otro pedido a
// medio camino) y devuelve la tarjeta ya modificada — Firebase se
// encarga de reintentar solo si hiciera falta.
async function runTransaccionTarjeta(ruta, fn) {
  const resultado = await db.ref(ruta).transaction((tarjetaActual) => {
    if (tarjetaActual === null) return tarjetaActual; // no existe — no crear nada, el llamador ya validó esto antes
    return fn(tarjetaActual);
  });
  if (!resultado.committed) throw new Error('No se pudo guardar (conflicto de escrituras) — probá de nuevo');
  return resultado.snapshot.val();
}

function comoArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') return Object.values(val);
  return [];
}
function rtdbKeySeguro(id) {
  let clave = String(id || '').trim().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (clave.length > 200) clave = clave.substring(0, 200);
  return clave;
}
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function registrarNotificacion(email, tipo, texto, ticketId, ticketTitulo, autorNombre, origen, tarjetaId, mensajeIndice) {
  try {
    const idNoti = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const registro = { tipo, origen: origen || 'evento', texto, ticket_id: ticketId || '', ticket_titulo: ticketTitulo || '', autor_nombre: autorNombre || '', fecha: new Date().toISOString(), leido: false };
    if (tarjetaId) registro.tarjeta_id = tarjetaId;
    if (mensajeIndice !== undefined && mensajeIndice !== null && mensajeIndice >= 0) registro.mensaje_indice = mensajeIndice;
    await fbSet('notificaciones/' + rtdbKeySeguro(email) + '/' + idNoti, registro);
  } catch (e) {
    console.warn('No se pudo registrar notificación para', email, ':', e.message);
  }
}

async function obtenerTokensPush(email) {
  const key = rtdbKeySeguro(email);
  const tokens = [];
  try {
    const mapa = await fbGet('usuarios/' + key + '/fcm_tokens');
    if (mapa && typeof mapa === 'object') Object.keys(mapa).forEach((t) => { if (t) tokens.push(t); });
  } catch (e) {}
  try {
    const legado = await fbGet('usuarios/' + key + '/fcm_token');
    if (legado && !tokens.includes(legado)) tokens.push(legado);
  } catch (e) {}
  return tokens;
}

async function enviarPush(token, titulo, cuerpo, link) {
  // admin.messaging().send() hace todo lo que en Apps Script requería
  // armar el JWT/OAuth2 a mano y pegarle a la API REST de FCM — acá
  // es una sola llamada, el SDK se encarga del resto.
  try {
    await messaging.send({ token, data: { title: titulo, body: cuerpo, link: link || '' } });
  } catch (e) {
    console.warn('Push falló para un token:', e.message);
  }
}

async function enviarEmailBrevo(destinatarioEmail, destinatarioNombre, asunto, htmlBody) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('Falta BREVO_API_KEY — no se pudo mandar el mail a', destinatarioEmail); return; }
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Portal TLC', email: 'info@tlcsrl.com.ar' },
        to: [{ email: destinatarioEmail, name: destinatarioNombre || destinatarioEmail }],
        subject: asunto,
        htmlContent: htmlBody,
      }),
    });
    if (resp.status !== 201 && resp.status !== 202) console.warn('Brevo respondió', resp.status, 'para', destinatarioEmail);
  } catch (e) {
    console.warn('No se pudo mandar el mail a', destinatarioEmail, ':', e.message);
  }
}

// ── Listado ──────────────────────────────────────────────────────

async function reconstruirResumenEventos() {
  const idsEventos = await fbGetShallow('eventos');
  if (!idsEventos) { await fbSet('eventos_resumen', {}); return {}; }
  const ids = Object.keys(idsEventos);
  const resumen = {};
  await Promise.all(ids.map(async (id) => {
    const [nombre, creado_en, logo, tarjetas, modulo] = await Promise.all([
      fbGet('eventos/' + id + '/nombre'),
      fbGet('eventos/' + id + '/creado_en'),
      fbGet('eventos/' + id + '/logo'),
      fbGet('eventos/' + id + '/tarjetas'),
      fbGet('eventos/' + id + '/modulo'),
    ]);
    resumen[id] = { nombre: nombre || 'Sin nombre', creado_en: creado_en || '', cantidadTarjetas: tarjetas ? Object.keys(tarjetas).length : 0, logo: logo || null, modulo: modulo || 'eventos' };
  }));
  await fbSet('eventos_resumen', resumen);
  return resumen;
}

async function ev_listarEventos() {
  let resumen = await fbGet('eventos_resumen');
  if (!resumen) resumen = await reconstruirResumenEventos();
  const lista = Object.keys(resumen).map((id) => {
    const r = resumen[id] || {};
    return { id, nombre: r.nombre || 'Sin nombre', creado_en: r.creado_en || '', cantidadTarjetas: r.cantidadTarjetas || 0, logo: r.logo || null, modulo: r.modulo || 'eventos' };
  }).sort((a, b) => (a.creado_en || '').localeCompare(b.creado_en || ''));
  return { ok: true, eventos: lista };
}

// ── Checklist ────────────────────────────────────────────────────

async function ev_crearChecklistGrupo(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const titulo = String(data.titulo || 'Nuevo Checklist').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    checklists.push({ id: 'cl' + Date.now(), titulo, items: [] });
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_editarChecklistGrupo(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const titulo = String(data.titulo || '').trim();
  if (!idEvento || !idTarjeta || !idGrupo || !titulo) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    grupo.titulo = titulo;
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Checklist no encontrado' };
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_borrarChecklistGrupo(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  if (!idEvento || !idTarjeta || !idGrupo) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    t.checklists = comoArray(t.checklists).filter((g) => g.id !== idGrupo);
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_agregarChecklistItem(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const texto = String(data.texto || '').trim();
  const menciones = Array.isArray(data.menciones) ? data.menciones.filter(Boolean) : [];
  if (!idEvento || !idTarjeta || !idGrupo || !texto) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  const tarjetaOriginal = await fbGet(ruta);
  if (!tarjetaOriginal) return { ok: false, error: 'Tarjeta no encontrada' };
  const autorNombre = String(data.autor_nombre || '').trim();
  const autorEmail = String(data.autor_email || '').trim();
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    grupo.items = comoArray(grupo.items);
    grupo.items.push({ id: 'i' + Date.now(), texto, hecho: false, menciones, creado_por: autorNombre, creado_en: new Date().toISOString() });
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Checklist no encontrado' };

  // Los efectos secundarios (notificar/push/mail) van DESPUÉS de que
  // la transacción ya cerró — nunca adentro del callback de arriba,
  // que Firebase puede llegar a correr más de una vez si hubo
  // conflicto con otro pedido en simultáneo (no queremos mandar el
  // mismo mail 2 veces por eso).
  const evento = await fbGet('eventos/' + idEvento);
  const linkEvento = 'https://cahirth.github.io/Portal-TLC/eventos.html?id=' + encodeURIComponent(idEvento) + '&tarjeta=' + encodeURIComponent(idTarjeta);
  await Promise.all(menciones.filter((email) => email && email !== autorEmail).map(async (email) => {
    await registrarNotificacion(email, 'mencion', (autorNombre || autorEmail) + ' te asignó una subtarea en "' + (tarjetaOriginal.titulo || '') + '": ' + texto, idEvento, (evento && evento.nombre) || '', autorNombre || autorEmail, 'evento', idTarjeta);
    const tokens = await obtenerTokensPush(email);
    await Promise.all(tokens.map((tok) => enviarPush(tok, 'Te asignaron una subtarea', (autorNombre || autorEmail) + ': ' + texto, linkEvento)));
    await enviarEmailBrevo(email, '', 'Te asignaron una subtarea — ' + (tarjetaOriginal.titulo || ''),
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(autorNombre || autorEmail) + '</strong> te asignó una subtarea en <strong>' + escHtml(tarjetaOriginal.titulo || '') + '</strong>' + (evento ? ' (' + escHtml(evento.nombre) + ')' : '') + ':</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;color:#0f172a;">' + escHtml(texto) + '</div>' +
        '<a href="' + linkEvento + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir tarjeta</a>' +
      '</div>');
  }));
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_toggleChecklistItem(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const idItem = String(data.id_item || '').trim();
  if (!idEvento || !idTarjeta || !idGrupo || !idItem) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  const tarjetaOriginal = await fbGet(ruta);
  if (!tarjetaOriginal) return { ok: false, error: 'Tarjeta no encontrada' };
  const quienTildoNombre = String(data.autor_nombre || '').trim();
  let noEncontrado = false;
  let quedoHecho = false;
  let textoItem = '';
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    const item = comoArray(grupo.items).find((i) => i.id === idItem);
    if (!item) { noEncontrado = true; return t; }
    item.hecho = !item.hecho;
    if (item.hecho) { item.hecho_por = quienTildoNombre; item.hecho_en = new Date().toISOString(); }
    else { delete item.hecho_por; delete item.hecho_en; }
    quedoHecho = item.hecho;
    textoItem = item.texto;
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Ítem o checklist no encontrado' };

  const quienTildoEmail = String(data.autor_email || '').trim();
  if (quedoHecho && tarjetaOriginal.responsable_email && tarjetaOriginal.responsable_email !== quienTildoEmail) {
    await registrarNotificacion(tarjetaOriginal.responsable_email, 'mencion', (quienTildoNombre || quienTildoEmail) + ' completó la subtarea "' + textoItem + '" en "' + (tarjetaOriginal.titulo || '') + '"', idEvento, '', quienTildoNombre, 'evento', idTarjeta);
  }
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_reordenarChecklistItems(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const orden = Array.isArray(data.orden) ? data.orden : [];
  if (!idEvento || !idTarjeta || !idGrupo || !orden.length) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    const itemsActuales = comoArray(grupo.items);
    const porId = {};
    itemsActuales.forEach((i) => { porId[i.id] = i; });
    const nuevosOrdenados = orden.map((id) => porId[id]).filter(Boolean);
    itemsActuales.forEach((i) => { if (!nuevosOrdenados.includes(i)) nuevosOrdenados.push(i); });
    grupo.items = nuevosOrdenados;
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Checklist no encontrado' };
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_eliminarChecklistItem(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const idItem = String(data.id_item || '').trim();
  if (!idEvento || !idTarjeta || !idGrupo || !idItem) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    grupo.items = comoArray(grupo.items).filter((i) => i.id !== idItem);
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Checklist no encontrado' };
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

async function ev_editarChecklistItem(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idGrupo = String(data.id_grupo || '').trim();
  const idItem = String(data.id_item || '').trim();
  const texto = String(data.texto || '').trim();
  if (!idEvento || !idTarjeta || !idGrupo || !idItem || !texto) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const checklists = comoArray(t.checklists);
    const grupo = checklists.find((g) => g.id === idGrupo);
    if (!grupo) { noEncontrado = true; return t; }
    const item = comoArray(grupo.items).find((i) => i.id === idItem);
    if (!item) { noEncontrado = true; return t; }
    item.texto = texto;
    t.checklists = checklists;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Ítem o checklist no encontrado' };
  return { ok: true, checklists: comoArray(tarjeta.checklists) };
}

// ── Notas ────────────────────────────────────────────────────────

async function ev_agregarNota(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const texto = String(data.texto || '').trim();
  const autorNombre = String(data.autor_nombre || '').trim();
  if (!idEvento || !idTarjeta || !texto) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const notas = comoArray(t.notas);
    notas.unshift({ id: 'n' + Date.now(), texto, autor: autorNombre, fecha: new Date().toISOString() });
    t.notas = notas;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  return { ok: true, notas: comoArray(tarjeta.notas) };
}

async function ev_editarNota(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede modificar una nota.' };
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idNota = String(data.id_nota || '').trim();
  const texto = String(data.texto || '').trim();
  if (!idEvento || !idTarjeta || !idNota || !texto) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let noEncontrado = false;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const notas = comoArray(t.notas);
    const nota = notas.find((n) => n.id === idNota);
    if (!nota) { noEncontrado = true; return t; }
    nota.texto = texto;
    nota.editada_en = new Date().toISOString();
    t.notas = notas;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (noEncontrado) return { ok: false, error: 'Nota no encontrada' };
  return { ok: true, notas: comoArray(tarjeta.notas) };
}

async function ev_eliminarNota(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede borrar una nota.' };
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const idNota = String(data.id_nota || '').trim();
  if (!idEvento || !idTarjeta || !idNota) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    t.notas = comoArray(t.notas).filter((n) => n.id !== idNota);
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  return { ok: true, notas: comoArray(tarjeta.notas) };
}

// ══════════════════════════════════════════════════════════════════
// Resto de Eventos — tarjetas, columnas, eventos, adjuntos, logo
// ══════════════════════════════════════════════════════════════════
// Cristian: "avanza con eventos" — las 30+ acciones que habían quedado
// afuera de la mini-migración urgente de checklist/notas/listado.
// Todas confirmadas Firebase-puro tras revisar FotoMap.gs. Mismos 2
// aprendizajes de siempre aplicados donde corresponde: transacción
// atómica en todo lo que modifica un array compartido (columnas,
// mensajes) o un contador compartido (cantidadTarjetas del resumen).

const COLUMNAS_DEFAULT_EVENTO = [
  { id: 'c1', nombre: 'Por hacer', orden: 0, color: '#3a86ff' },
  { id: 'c2', nombre: 'En curso', orden: 1, color: '#f8961e' },
  { id: 'c3', nombre: 'Hecho', orden: 2, color: '#06d6a0' },
];
const COLUMNAS_REGULATORIA = [
  { id: 'c1', nombre: 'Por iniciar', orden: 0, color: '#64748b' },
  { id: 'c2', nombre: 'Armando documentación', orden: 1, color: '#3a86ff' },
  { id: 'c3', nombre: 'Presentado en ANMAT', orden: 2, color: '#8b5cf6' },
  { id: 'c4', nombre: 'Observado / a responder', orden: 3, color: '#f8961e' },
  { id: 'c5', nombre: 'Aprobado', orden: 4, color: '#06d6a0' },
  { id: 'c6', nombre: 'Por renovar', orden: 5, color: '#ef4444' },
];
const MODULOS_TABLERO = ['eventos', 'comex', 'regulatoria'];
function _moduloValido(m) { return MODULOS_TABLERO.includes(m) ? m : 'eventos'; }
const ADJUNTOS_MAX_BYTES = 10 * 1024 * 1024;
const ADJUNTOS_TIPOS_PERMITIDOS = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function notaInicialEvento() {
  return [{ id: 'n' + Date.now(), texto: '📌 El Responsable Principal de esta tarjeta es quien responde por su cumplimiento — incluidas las subtareas asignadas a otras personas en las listas de comprobación — y por respetar la fecha límite.', autor: 'Portal TLC', fecha: new Date().toISOString() }];
}

// Ajusta +1/-1 el contador de tarjetas del resumen — con transacción
// (no get-then-patch como en FotoMap.gs): crear/borrar 2 tarjetas casi
// al mismo tiempo en el mismo evento podía perder un +1 o un -1 con el
// patrón viejo.
async function ajustarContadorTarjetasResumen(idEvento, delta) {
  try {
    await db.ref('eventos_resumen/' + idEvento).transaction((actual) => {
      if (actual === null) return actual;
      actual.cantidadTarjetas = Math.max(0, (actual.cantidadTarjetas || 0) + delta);
      return actual;
    });
  } catch (e) { console.warn('ajustarContadorTarjetasResumen:', e.message); }
}

// Reacciones a un mensaje — genérico, reutilizado por
// ev_reaccionarMensaje. Misma lógica que _reaccionarMensajeGenerico en
// FotoMap.gs, pero con transacción sobre la tarjeta entera (la ruta
// que recibe siempre es .../tarjetas/{id}/mensajes) en vez de
// leer/escribir solo el array de mensajes por separado.
async function reaccionarMensajeEnTarjeta(idEvento, idTarjeta, indice, email, nombre, reaccion) {
  const emailKey = rtdbKeySeguro(String(email || '').trim().toLowerCase());
  if (!emailKey) return { ok: false, error: 'Falta email' };
  if (!['ok', 'no_ok', 'corazon'].includes(reaccion)) return { ok: false, error: 'Reacción inválida' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada' };
  let errorValidacion = null, esNueva = false, autorMsgEmail = '', textoMsg = '';
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const mensajes = comoArray(t.mensajes);
    if (!mensajes[indice]) { errorValidacion = 'Mensaje no encontrado'; return t; }
    if (!mensajes[indice].reacciones) mensajes[indice].reacciones = {};
    const yaExiste = mensajes[indice].reacciones[emailKey];
    esNueva = !yaExiste || yaExiste.reaccion !== reaccion;
    if (yaExiste && yaExiste.reaccion === reaccion) delete mensajes[indice].reacciones[emailKey];
    else mensajes[indice].reacciones[emailKey] = { reaccion, nombre: nombre || email };
    autorMsgEmail = String(mensajes[indice].autor_email || '').trim();
    textoMsg = String(mensajes[indice].texto || '');
    t.mensajes = mensajes;
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  if (esNueva && autorMsgEmail && autorMsgEmail.toLowerCase() !== String(email).toLowerCase()) {
    const emoji = { ok: '👍', no_ok: '👎', corazon: '❤️' }[reaccion] || '';
    const quien = nombre || email || 'Alguien';
    const evento = await fbGet('eventos/' + idEvento);
    await registrarNotificacion(autorMsgEmail, 'reaccion', quien + ' reaccionó ' + emoji + ' a tu mensaje: "' + textoMsg.slice(0, 80) + '"', idEvento, (evento && evento.nombre) || '', quien, 'evento', idTarjeta);
    await enviarEmailBrevo(autorMsgEmail, '', quien + ' reaccionó a tu mensaje en Portal TLC',
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(quien) + '</strong> reaccionó ' + emoji + ' a tu mensaje:</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(textoMsg) + '</div>' +
      '</div>');
  }
  return { ok: true, mensajes: comoArray(tarjeta.mensajes) };
}

// ── Eventos (crear/borrar/duplicar/obtener) ─────────────────────────

async function ev_crearEvento(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede crear un evento nuevo.' };
  const nombre = String(data.nombre || '').trim();
  if (!nombre) return { ok: false, error: 'Falta el nombre del evento' };
  const id = 'EV-' + new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const creadoEn = new Date().toISOString();
  const modulo = _moduloValido(data.modulo);
  await fbSet('eventos/' + id, { nombre, creado_en: creadoEn, columnas: modulo === 'regulatoria' ? COLUMNAS_REGULATORIA : COLUMNAS_DEFAULT_EVENTO, modulo });
  await fbSet('eventos_resumen/' + id, { nombre, creado_en: creadoEn, cantidadTarjetas: 0, logo: null, modulo });
  return { ok: true, id };
}

// Pasa un tablero entre Eventos y Comercio Exterior (mismo tablero, con todo)
async function ev_moverModulo(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede mover un tablero.' };
  const id = String(data.id || '').trim();
  const modulo = _moduloValido(data.modulo);
  if (!id || !(await fbGet('eventos/' + id + '/nombre'))) return { ok: false, error: 'Tablero no encontrado' };
  await fbSet('eventos/' + id + '/modulo', modulo);
  if (await fbGet('eventos_resumen/' + id)) await fbSet('eventos_resumen/' + id + '/modulo', modulo);
  return { ok: true, id, modulo };
}

async function ev_borrarEvento(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede borrar un evento.' };
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const evento = await fbGet('eventos/' + id);
  if (!evento) return { ok: false, error: 'Evento no encontrado' };
  const tarjetas = evento.tarjetas || {};
  await Promise.all(Object.keys(tarjetas).map(async (tid) => {
    const adjuntos = tarjetas[tid].adjuntos || {};
    await Promise.all(Object.keys(adjuntos).map((aid) => adjuntos[aid].path ? storageBorrarArchivo(adjuntos[aid].path).catch(() => {}) : null));
  }));
  if (evento.logo && evento.logo.path) await storageBorrarArchivo(evento.logo.path).catch(() => {});
  await fbDelete('eventos/' + id);
  await fbDelete('eventos_resumen/' + id);
  return { ok: true };
}

async function ev_duplicarEvento(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede duplicar un evento.' };
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const original = await fbGet('eventos/' + id);
  if (!original) return { ok: false, error: 'Evento no encontrado' };
  const idNuevo = 'EV-' + new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const columnas = Array.isArray(original.columnas) ? original.columnas : COLUMNAS_DEFAULT_EVENTO;
  let contadorId = 0;
  const tarjetasNuevas = {};
  comoArray(original.tarjetas).forEach((t) => {
    contadorId++;
    const idT = 'T' + Date.now() + '_' + contadorId + Math.random().toString(36).slice(2, 5);
    const checklistsCopia = (Array.isArray(t.checklists) ? t.checklists : []).map((g) => {
      contadorId++;
      return { id: 'cl' + Date.now() + '_' + contadorId + Math.random().toString(36).slice(2, 5), titulo: g.titulo, items: comoArray(g.items).map((it) => { contadorId++; return { id: 'i' + Date.now() + '_' + contadorId + Math.random().toString(36).slice(2, 5), texto: it.texto, hecho: false, menciones: it.menciones || [] }; }) };
    });
    tarjetasNuevas[idT] = {
      titulo: t.titulo || 'Sin título', descripcion: t.descripcion || '', categoria: t.categoria || '',
      responsable_email: t.responsable_email || '', responsable_nombre: t.responsable_nombre || '', fecha_limite: t.fecha_limite || '',
      columna_id: t.columna_id, orden: t.orden || Date.now(), checklists: checklistsCopia, notas: notaInicialEvento(),
      adjuntos: [], mensajes: [], creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
    };
  });
  const nombreNuevo = (original.nombre || 'Sin nombre') + ' (copia)';
  const creadoEnNuevo = new Date().toISOString();
  const moduloNuevo = _moduloValido(original.modulo);
  await fbSet('eventos/' + idNuevo, { nombre: nombreNuevo, creado_en: creadoEnNuevo, columnas, tarjetas: tarjetasNuevas, modulo: moduloNuevo });
  await fbSet('eventos_resumen/' + idNuevo, { nombre: nombreNuevo, creado_en: creadoEnNuevo, cantidadTarjetas: Object.keys(tarjetasNuevas).length, logo: null, modulo: moduloNuevo });
  return { ok: true, id: idNuevo };
}

async function ev_obtenerEvento(data) {
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const evento = await fbGet('eventos/' + id);
  if (!evento) return { ok: false, error: 'Evento no encontrado' };
  evento.id = id;
  if (!Array.isArray(evento.columnas) || !evento.columnas.length) evento.columnas = COLUMNAS_DEFAULT_EVENTO;
  const tarjetasRaw = evento.tarjetas || {};
  evento.tarjetas = Object.keys(tarjetasRaw).map((tid) => {
    const t = tarjetasRaw[tid];
    t.id = tid;
    t.checklists = comoArray(t.checklists).map((g) => ({ id: g.id, titulo: g.titulo, items: comoArray(g.items).map((it) => ({ id: it.id, hecho: !!it.hecho })) }));
    t.notas = [];
    t.mensajes = [];
    const adjuntosRaw = t.adjuntos || {};
    t.adjuntos = Object.keys(adjuntosRaw).map((aid) => { const a = adjuntosRaw[aid]; a.id = aid; return a; });
    return t;
  });
  return { ok: true, evento };
}

async function ev_obtenerTarjetaEv(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const t = await fbGet('eventos/' + idEvento + '/tarjetas/' + idTarjeta);
  if (!t) return { ok: false, error: 'Tarjeta no encontrada' };
  t.id = idTarjeta;
  t.checklists = comoArray(t.checklists);
  t.notas = comoArray(t.notas);
  t.mensajes = comoArray(t.mensajes);
  const adjuntosRaw = t.adjuntos || {};
  t.adjuntos = Object.keys(adjuntosRaw).map((aid) => { const a = adjuntosRaw[aid]; a.id = aid; return a; });
  return { ok: true, tarjeta: t };
}

// ── Logo del evento ──────────────────────────────────────────────

async function ev_subirLogoEvento(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede cambiar el logo del evento.' };
  const id = String(data.id || '').trim();
  const nombre = String(data.nombre || '').trim();
  const tipoMime = String(data.tipoMime || '').trim();
  const base64 = String(data.base64 || '');
  if (!id || !base64) return { ok: false, error: 'Faltan datos' };
  if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'].includes(tipoMime)) return { ok: false, error: 'Formato no permitido — usá PNG, JPG, WEBP o SVG.' };
  if (Math.floor(base64.length * 3 / 4) > 3 * 1024 * 1024) return { ok: false, error: 'El logo pesa más de 3MB — subí uno más liviano.' };
  const evento = await fbGet('eventos/' + id);
  if (!evento) return { ok: false, error: 'Evento no encontrado' };
  if (evento.logo && evento.logo.path) await storageBorrarArchivo(evento.logo.path).catch(() => {});
  const pathStorage = 'eventos_logo/' + id + '/' + Date.now() + '_' + nombre;
  const subida = await storageSubirArchivo(pathStorage, base64, tipoMime);
  const logo = { url: subida.url, path: pathStorage, nombre };
  await fbPatch('eventos/' + id, { logo });
  await fbPatch('eventos_resumen/' + id, { logo });
  return { ok: true, logo };
}

async function ev_quitarLogoEvento(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede quitar el logo del evento.' };
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const evento = await fbGet('eventos/' + id);
  if (!evento) return { ok: false, error: 'Evento no encontrado' };
  if (evento.logo && evento.logo.path) await storageBorrarArchivo(evento.logo.path).catch(() => {});
  await fbDelete('eventos/' + id + '/logo');
  await fbDelete('eventos_resumen/' + id + '/logo');
  return { ok: true };
}

// ── Columnas ─────────────────────────────────────────────────────

async function ev_crearColumna(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede crear columnas nuevas.' };
  const idEvento = String(data.id_evento || '').trim();
  const nombre = String(data.nombre || '').trim();
  const color = String(data.color || '#3a86ff').trim();
  if (!idEvento || !nombre) return { ok: false, error: 'Faltan id_evento o nombre' };
  if (!(await fbGet('eventos/' + idEvento))) return { ok: false, error: 'Evento no encontrado' };
  const nuevaId = 'c' + Date.now();
  const evento = await runTransaccionTarjeta('eventos/' + idEvento, (e) => {
    const columnas = Array.isArray(e.columnas) ? e.columnas : COLUMNAS_DEFAULT_EVENTO.slice();
    const ordenMax = columnas.reduce((max, c) => Math.max(max, c.orden || 0), -1);
    columnas.push({ id: nuevaId, nombre, orden: ordenMax + 1, color });
    e.columnas = columnas;
    return e;
  });
  return { ok: true, id: nuevaId, columnas: evento.columnas };
}

async function ev_editarColumna(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idColumna = String(data.id_columna || '').trim();
  const nombre = String(data.nombre || '').trim();
  if (!idEvento || !idColumna || !nombre) return { ok: false, error: 'Faltan datos' };
  if (!(await fbGet('eventos/' + idEvento))) return { ok: false, error: 'Evento no encontrado' };
  let errorValidacion = null;
  const evento = await runTransaccionTarjeta('eventos/' + idEvento, (e) => {
    if (!Array.isArray(e.columnas)) { errorValidacion = 'Evento no encontrado'; return e; }
    const cambios = { nombre };
    if (data.color !== undefined) cambios.color = String(data.color || '').trim();
    e.columnas = e.columnas.map((c) => (c.id === idColumna ? Object.assign({}, c, cambios) : c));
    return e;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  return { ok: true, columnas: evento.columnas };
}

async function ev_borrarColumna(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede borrar una columna.' };
  const idEvento = String(data.id_evento || '').trim();
  const idColumna = String(data.id_columna || '').trim();
  if (!idEvento || !idColumna) return { ok: false, error: 'Faltan datos' };
  const evento0 = await fbGet('eventos/' + idEvento);
  if (!evento0) return { ok: false, error: 'Evento no encontrado' };
  const tarjetas0 = evento0.tarjetas || {};
  if (Object.keys(tarjetas0).some((tid) => tarjetas0[tid].columna_id === idColumna)) return { ok: false, error: 'Esta columna tiene tarjetas adentro — movelas a otra columna antes de borrarla.' };
  const evento = await runTransaccionTarjeta('eventos/' + idEvento, (e) => {
    e.columnas = (e.columnas || []).filter((c) => c.id !== idColumna);
    return e;
  });
  return { ok: true, columnas: evento.columnas };
}

// ── Tarjetas ─────────────────────────────────────────────────────

async function ev_crearTarjeta(data) {
  const idEvento = String(data.id_evento || '').trim();
  const titulo = String(data.titulo || '').trim();
  const idColumna = String(data.columna_id || '').trim();
  if (!idEvento || !titulo || !idColumna) return { ok: false, error: 'Faltan datos' };
  const idTarjeta = 'T' + Date.now() + Math.random().toString(36).slice(2, 5);
  const registro = {
    titulo, descripcion: String(data.descripcion || '').trim(), categoria: String(data.categoria || '').trim(),
    responsable_email: String(data.responsable_email || '').trim(), responsable_nombre: String(data.responsable_nombre || '').trim(),
    fecha_limite: String(data.fecha_limite || '').trim(), columna_id: idColumna, orden: Date.now(),
    checklists: [], notas: notaInicialEvento(), adjuntos: [], mensajes: [],
    creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
  };
  await fbSet('eventos/' + idEvento + '/tarjetas/' + idTarjeta, registro);
  await ajustarContadorTarjetasResumen(idEvento, 1);
  registro.id = idTarjeta;
  return { ok: true, tarjeta: registro };
}

async function ev_editarTarjeta(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const cambios = {};
  ['titulo', 'descripcion', 'categoria', 'responsable_email', 'responsable_nombre', 'fecha_limite'].forEach((campo) => { if (data[campo] !== undefined) cambios[campo] = String(data[campo] || '').trim(); });
  cambios.actualizado_en = new Date().toISOString();
  await fbPatch('eventos/' + idEvento + '/tarjetas/' + idTarjeta, cambios);
  return { ok: true };
}

async function ev_moverTarjeta(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const columnaId = String(data.columna_id || '').trim();
  const orden = data.orden !== undefined ? Number(data.orden) : Date.now();
  if (!idEvento || !idTarjeta || !columnaId) return { ok: false, error: 'Faltan datos' };
  await fbPatch('eventos/' + idEvento + '/tarjetas/' + idTarjeta, { columna_id: columnaId, orden, actualizado_en: new Date().toISOString() });
  return { ok: true };
}

async function ev_borrarTarjeta(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const tarjeta = await fbGet('eventos/' + idEvento + '/tarjetas/' + idTarjeta);
  const adjuntos = (tarjeta && tarjeta.adjuntos) || {};
  await Promise.all(Object.keys(adjuntos).map((aid) => adjuntos[aid].path ? storageBorrarArchivo(adjuntos[aid].path).catch(() => {}) : null));
  await fbDelete('eventos/' + idEvento + '/tarjetas/' + idTarjeta);
  await ajustarContadorTarjetasResumen(idEvento, -1);
  return { ok: true };
}

async function ev_duplicarTarjeta(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const original = await fbGet('eventos/' + idEvento + '/tarjetas/' + idTarjeta);
  if (!original) return { ok: false, error: 'Tarjeta no encontrada' };
  let contadorId = 0;
  const checklistsCopia = (Array.isArray(original.checklists) ? original.checklists : []).map((g) => {
    contadorId++;
    return { id: 'cl' + Date.now() + '_' + contadorId + Math.random().toString(36).slice(2, 5), titulo: g.titulo, items: comoArray(g.items).map((it) => { contadorId++; return { id: 'i' + Date.now() + '_' + contadorId + Math.random().toString(36).slice(2, 5), texto: it.texto, hecho: false, menciones: it.menciones || [] }; }) };
  });
  const idNueva = 'T' + Date.now() + Math.random().toString(36).slice(2, 5);
  const registro = {
    titulo: (original.titulo || 'Sin título') + ' (copia)', descripcion: original.descripcion || '', categoria: original.categoria || '',
    responsable_email: original.responsable_email || '', responsable_nombre: original.responsable_nombre || '', fecha_limite: original.fecha_limite || '',
    columna_id: original.columna_id, orden: Date.now(), checklists: checklistsCopia, notas: notaInicialEvento(),
    adjuntos: [], mensajes: [], creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
  };
  await fbSet('eventos/' + idEvento + '/tarjetas/' + idNueva, registro);
  await ajustarContadorTarjetasResumen(idEvento, 1);
  registro.id = idNueva;
  return { ok: true, tarjeta: registro };
}

async function ev_actualizarGastos(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const gastos = data.gastos;
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  if (!Array.isArray(gastos)) return { ok: false, error: 'gastos debe ser un array' };
  await fbPatch('eventos/' + idEvento + '/tarjetas/' + idTarjeta, { gastos, actualizado_en: new Date().toISOString() });
  return { ok: true };
}

async function ev_marcarPortada(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const adjId = String(data.adjId || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta + '/adjuntos';
  const adjuntos = (await fbGet(ruta)) || {};
  if (adjId && !adjuntos[adjId]) return { ok: false, error: 'Adjunto no encontrado' };
  const patch = {};
  Object.keys(adjuntos).forEach((aid) => { patch[aid + '/esPortada'] = (aid === adjId); });
  await fbPatch(ruta, patch);
  return { ok: true };
}

async function ev_agregarMensaje(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const texto = String(data.texto || '').trim();
  const autorNombre = String(data.autor_nombre || '').trim();
  const autorEmail = String(data.autor_email || '').trim();
  const menciones = Array.isArray(data.menciones) ? data.menciones.filter(Boolean) : [];
  if (!idEvento || !idTarjeta || !texto) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  const tarjetaOriginal = await fbGet(ruta);
  if (!tarjetaOriginal) return { ok: false, error: 'Tarjeta no encontrada' };
  const respuestaA = (data.respuesta_a && typeof data.respuesta_a.indice === 'number')
    ? { indice: data.respuesta_a.indice, autor_nombre: String(data.respuesta_a.autor_nombre || '').trim(), texto_snippet: String(data.respuesta_a.texto_snippet || '').trim() }
    : null;
  let indiceMensajeNuevo = -1;
  const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
    const mensajes = comoArray(t.mensajes);
    const nuevoMensaje = { texto, autor_nombre: autorNombre, autor_email: autorEmail, menciones, fecha: new Date().toISOString() };
    if (respuestaA) nuevoMensaje.respuesta_a = respuestaA;
    if (menciones.some((e) => String(e).trim().toLowerCase() !== autorEmail.toLowerCase())) nuevoMensaje.con_lectura = true;
    mensajes.push(nuevoMensaje);
    indiceMensajeNuevo = mensajes.length - 1;
    t.mensajes = mensajes;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  const evento = await fbGet('eventos/' + idEvento);
  const linkEvento = 'https://cahirth.github.io/Portal-TLC/eventos.html?id=' + encodeURIComponent(idEvento) + '&tarjeta=' + encodeURIComponent(idTarjeta);
  await Promise.all(menciones.filter((email) => email && email !== autorEmail).map(async (email) => {
    await registrarNotificacion(email, 'mencion', texto, idEvento, (evento && evento.nombre) || '', autorNombre || autorEmail, 'evento', idTarjeta, indiceMensajeNuevo);
    const tokens = await obtenerTokensPush(email);
    await Promise.all(tokens.map((tok) => enviarPush(tok, 'Te mencionaron en una tarjeta', (autorNombre || autorEmail) + ': ' + texto, linkEvento)));
    await enviarEmailBrevo(email, '', 'Te mencionaron en "' + (tarjetaOriginal.titulo || '') + '"',
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(autorNombre || autorEmail) + '</strong> te mencionó en <strong>' + escHtml(tarjetaOriginal.titulo || '') + '</strong>' + (evento ? ' (' + escHtml(evento.nombre) + ')' : '') + ':</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(texto) + '</div>' +
        '<a href="' + linkEvento + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir tarjeta</a>' +
      '</div>');
  }));
  return { ok: true, mensajes: comoArray(tarjeta.mensajes) };
}

async function ev_reaccionarMensaje(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const indice = parseInt(data.indice, 10);
  if (!idEvento || !idTarjeta || isNaN(indice)) return { ok: false, error: 'Faltan datos' };
  return reaccionarMensajeEnTarjeta(idEvento, idTarjeta, indice, data.autor_email, data.autor_nombre, data.reaccion);
}

// ── Adjuntos (compartido servicio/ventas/eventos en FotoMap.gs — acá
// solo lo llama eventos.html, confirmado; si en el futuro
// servicio.html/cotizaciones.html empiezan a usarlo, agregar esta
// misma acción a sus Cloud Functions también) ──

async function subirAdjunto(data) {
  const modulo = String(data.modulo || '').trim();
  const idRegistro = String(data.idRegistro || '').trim();
  const nombre = String(data.nombre || '').trim();
  const tipoMime = String(data.tipoMime || '').trim();
  const base64 = String(data.base64 || '');
  const subidoPorNombre = String(data.subidoPorNombre || '').trim();
  if (!['servicio', 'ventas', 'eventos'].includes(modulo)) return { ok: false, error: 'Módulo inválido: ' + modulo };
  if (!idRegistro) return { ok: false, error: 'Falta idRegistro' };
  if (!nombre) return { ok: false, error: 'Falta nombre de archivo' };
  if (!base64) return { ok: false, error: 'Falta el contenido del archivo' };
  if (!ADJUNTOS_TIPOS_PERMITIDOS[tipoMime]) {
    const extDelNombre = (nombre.split('.').pop() || '').toLowerCase();
    if (!Object.values(ADJUNTOS_TIPOS_PERMITIDOS).includes(extDelNombre)) return { ok: false, error: 'Tipo de archivo no permitido — solo PDF, JPG, PNG, TXT, DOC, DOCX, XLS, XLSX.' };
  }
  if (Math.floor(base64.length * 3 / 4) > ADJUNTOS_MAX_BYTES) return { ok: false, error: 'El archivo pesa más de 10MB — no se puede subir.' };
  const adjId = 'adj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const pathStorage = 'adjuntos/' + modulo + '/' + idRegistro + '/' + adjId + '_' + nombre;
  const subida = await storageSubirArchivo(pathStorage, base64, tipoMime);
  const metadata = { nombre, tipo: tipoMime, url: subida.url, path: pathStorage, tamano: subida.size, subido_por_nombre: subidoPorNombre, fecha: new Date().toISOString(), esPortada: false };
  const nodoBase = modulo === 'servicio' ? 'servicio_tecnico/' : (modulo === 'eventos' ? 'eventos/' : 'cotizaciones/');
  const patchAdjuntos = {}; patchAdjuntos[adjId] = metadata;
  await fbPatch(nodoBase + idRegistro + '/adjuntos', patchAdjuntos);
  return { ok: true, adjId, adjunto: metadata };
}

async function eliminarAdjunto(data) {
  const modulo = String(data.modulo || '').trim();
  const idRegistro = String(data.idRegistro || '').trim();
  const adjId = String(data.adjId || '').trim();
  if (!['servicio', 'ventas', 'eventos'].includes(modulo)) return { ok: false, error: 'Módulo inválido' };
  if (!idRegistro || !adjId) return { ok: false, error: 'Faltan datos' };
  const nodoBase = modulo === 'servicio' ? 'servicio_tecnico/' : (modulo === 'eventos' ? 'eventos/' : 'cotizaciones/');
  const adjunto = await fbGet(nodoBase + idRegistro + '/adjuntos/' + adjId).catch(() => null);
  if (adjunto && adjunto.path) await storageBorrarArchivo(adjunto.path).catch((e) => console.warn('No se pudo borrar el archivo de Storage (no crítico):', e.message));
  await fbDelete(nodoBase + idRegistro + '/adjuntos/' + adjId);
  return { ok: true };
}

// ── Tildes de lectura (v2) — ver servicio-function v9 ───────────────
async function ev_marcarMensajesLeidos(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  const email = String(data.email || '').trim();
  if (!idEvento || !idTarjeta || !email) return { ok: false, error: 'Faltan datos' };
  const yo = email.toLowerCase();
  const k = rtdbKeySeguro(yo);
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  const t0 = await fbGet(ruta);
  if (!t0) return { ok: false, error: 'Tarjeta no encontrada' };
  const meMenciona = (m) => m && m.con_lectura && comoArray(m.menciones).some((e) => String(e || '').trim().toLowerCase() === yo);
  let mensajes = comoArray(t0.mensajes);
  let marcados = 0;
  if (mensajes.some((m) => meMenciona(m) && !(m.lecturas && m.lecturas[k]))) {
    const ahora = new Date().toISOString();
    const tarjeta = await runTransaccionTarjeta(ruta, (t) => {
      const ms = comoArray(t.mensajes);
      marcados = 0;
      ms.forEach((m) => {
        if (!meMenciona(m)) return;
        if (!m.lecturas) m.lecturas = {};
        if (m.lecturas[k]) return;
        m.lecturas[k] = ahora;
        marcados++;
      });
      t.mensajes = ms;
      return t;
    });
    mensajes = comoArray(tarjeta.mensajes);
  }
  // Al abrir la tarjeta, sus avisos en la campanita quedan leídos
  let avisos = 0;
  try {
    const rutaN = 'notificaciones/' + rtdbKeySeguro(email);
    const notis = await fbGet(rutaN);
    const cambios = {};
    if (notis && typeof notis === 'object') Object.keys(notis).forEach((nk) => {
      const n = notis[nk];
      if (n && !n.leido && String(n.ticket_id || '') === idEvento && String(n.tarjeta_id || '') === idTarjeta) cambios[nk + '/leido'] = true;
    });
    avisos = Object.keys(cambios).length;
    if (avisos) await db.ref(rutaN).update(cambios);
  } catch (e) { console.warn('No se pudieron marcar avisos leídos:', e.message); }
  return { ok: true, marcados, avisos_leidos: avisos, mensajes };
}

const ACCIONES = {
  ev_listarEventos, ev_crearChecklistGrupo, ev_editarChecklistGrupo, ev_borrarChecklistGrupo,
  ev_agregarChecklistItem, ev_toggleChecklistItem, ev_reordenarChecklistItems, ev_eliminarChecklistItem,
  ev_editarChecklistItem, ev_agregarNota, ev_editarNota, ev_eliminarNota,
  ev_crearEvento, ev_borrarEvento, ev_duplicarEvento, ev_obtenerEvento, ev_obtenerTarjetaEv,
  ev_subirLogoEvento, ev_quitarLogoEvento,
  ev_crearColumna, ev_editarColumna, ev_borrarColumna,
  ev_crearTarjeta, ev_editarTarjeta, ev_moverTarjeta, ev_borrarTarjeta, ev_duplicarTarjeta,
  ev_actualizarGastos, ev_marcarPortada, ev_agregarMensaje, ev_reaccionarMensaje, ev_marcarMensajesLeidos, ev_moverModulo,
  subirAdjunto, eliminarAdjunto,
};

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('eventosChecklist', async (req, res) => {
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
    console.error('Error en función eventosChecklist:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
