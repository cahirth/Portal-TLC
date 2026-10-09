// Portal TLC | Cloud Function — Agenda centralizada (calendario.html)
// v1 — 2026.10.09
//
// Reemplaza el calendario de Teams/Outlook (Cristian: "cualquier técnico o
// vendedor nuevo debe ver su agenda de inmediato al loguearse en el Portal").
// Un solo nodo: agenda_operativa/{id}. Todo pasa por esta función (lectura
// y escritura), así el nodo puede quedar cerrado en las reglas de Firebase.
//
// Reglas acordadas con Cristian (09/10/2026):
//  - Permisos (hoja de permisos): "Agenda" = entra y se agenda a sí mismo;
//    "Agenda Equipo" (o Rol Administrador) = agenda a cualquiera, sin
//    invitación.
//  - Choque de horario: solo cuentan eventos CONFIRMADOS de participantes que
//    ACEPTARON. Tentativos, invitaciones pendientes/rechazadas y cancelados no
//    bloquean. Si chocan, se frena con el detalle exacto; "Agendar igual" con
//    motivo solo para Administrador / Agenda Equipo.
//  - Feriados (API ArgentinaDatos, guardada en agenda_config/feriados/{año}):
//    inamovibles y trasladables bloquean igual que un choque; los "puentes"
//    (no laborables) solo avisan.
//  - Invitaciones: quien no tiene "Agenda Equipo" puede sumar a otros como
//    invitados; al invitado le llega a la campanita, y hasta que acepta no le
//    bloquea el horario. Si al aceptar le choca, puede "aceptar igual" solo si
//    tiene Agenda Equipo; si no, rechaza con motivo.
//  - Editar / cancelar: quien lo creó, un participante, o Agenda Equipo.
//  - Avisos: campanita + push siempre; mail solo en invitaciones y en cambios
//    a menos de 24 hs del evento.
//  - Horas: siempre hora de Argentina (UTC-3); los timestamps los calcula
//    este servidor, nunca la pantalla.
//  - Concurrencia: todas las escrituras pasan por un candado (agenda_meta/lock)
//    para que dos personas no agenden a la misma persona a la misma hora al
//    mismo tiempo.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();
const messaging = admin.messaging();

const NODO = 'agenda_operativa';
const IDX = 'agenda_idx';            // agenda_idx/{personaKey}/{eventoId} = { i, f } (solo lo que bloquea)
const TIPOS = ['servicio', 'ventas', 'evento', 'interno'];
const ESTADOS = ['confirmado', 'tentativo'];
const URL_PORTAL = 'https://ir.tlcsrl.com.ar/';
const API_FERIADOS = 'https://api.argentinadatos.com/v1/feriados/';
const FERIADOS_REFRESCO_MS = 7 * 24 * 3600 * 1000;
const MS_24H = 24 * 3600 * 1000;

// ── Firebase ─────────────────────────────────────────────────────
async function fbGet(path) { const s = await db.ref(path).once('value'); return s.exists() ? s.val() : null; }
async function fbSet(path, v) { await db.ref(path).set(v); return v; }
async function fbUpdate(updates) { await db.ref().update(updates); }
function comoArray(v) { if (Array.isArray(v)) return v; if (v && typeof v === 'object') return Object.values(v); return []; }
function rtdbKeySeguro(id) {
  let c = String(id || '').trim().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (c.length > 200) c = c.substring(0, 200);
  return c;
}
function claveEmail(email) { return rtdbKeySeguro(String(email || '').trim().toLowerCase()); }
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function normalizar(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function esVerdadero(v) { const t = normalizar(v); return v === true || t === 'true' || t === 'verdadero' || t === 'si' || t === '1'; }
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fechas (Argentina, UTC-3 fijo) ───────────────────────────────
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
function tsBA(fecha, hora) { return Date.parse(fecha + 'T' + (hora || '00:00') + ':00-03:00'); }
function diaBA(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms == null ? Date.now() : ms)); }
function sumarDias(fecha, n) { const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasEntre(desde, hasta) { const r = []; let f = desde; for (let i = 0; f <= hasta && i < 400; i++) { r.push(f); f = sumarDias(f, 1); } return r; }
function fechaLinda(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  return d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}
function cuandoTexto(ev) {
  if (ev.todo_el_dia) return fechaLinda(ev.fecha) + (ev.fecha_fin && ev.fecha_fin !== ev.fecha ? ' al ' + fechaLinda(ev.fecha_fin) : '') + ' (todo el día)';
  if (ev.fecha_fin && ev.fecha_fin !== ev.fecha) return fechaLinda(ev.fecha) + ' ' + ev.hora_inicio + ' al ' + fechaLinda(ev.fecha_fin) + ' ' + ev.hora_fin;
  return fechaLinda(ev.fecha) + ' ' + ev.hora_inicio + '–' + ev.hora_fin;
}

// ── Permisos (hoja de permisos sincronizada en permisos/{email}) ─
async function actorDe(data) {
  const email = String(data._actor_email || data.email_usuario || '').trim().toLowerCase();
  const nombreEnviado = String(data._actor_nombre || data.nombre_usuario || '').trim();
  if (!email) return { email: '', nombre: '', agenda: false, equipo: false };
  const fila = (await fbGet('permisos/' + rtdbKeySeguro(email))) || {};
  const admin_ = normalizar(fila.Rol) === 'administrador';
  const equipo = admin_ || esVerdadero(fila.Agenda_Equipo);
  const agenda = equipo || esVerdadero(fila.Agenda);
  const nombre = String(fila.Nombre_Vendedor || fila.Nombre || nombreEnviado || email).trim();
  return { email, nombre, agenda, equipo, admin: admin_ };
}
async function personasDelEquipo() {
  const permisos = (await fbGet('permisos')) || {};
  return Object.values(permisos)
    .filter((p) => p && (esVerdadero(p.Internos) || esVerdadero(p.Agenda) || esVerdadero(p.Agenda_Equipo)))
    .map((p) => ({ nombre: String(p.Nombre_Vendedor || p.Nombre || '').trim(), email: String(p.Email || '').trim().toLowerCase() }))
    .filter((p) => p.nombre && p.email)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// ── Candado: una escritura de agenda a la vez ────────────────────
async function conCandado(fn) {
  const yo = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let tengo = false;
  for (let i = 0; i < 50 && !tengo; i++) {
    const r = await db.ref('agenda_meta/lock').transaction((cur) => {
      if (cur && cur.exp > Date.now()) return undefined; // ocupado: abortar
      return { owner: yo, exp: Date.now() + 20000 };
    });
    tengo = !!(r.committed && r.snapshot.val() && r.snapshot.val().owner === yo);
    if (!tengo) await dormir(120 + Math.random() * 120);
  }
  if (!tengo) throw new Error('La agenda está ocupada guardando otro cambio — probá de nuevo en unos segundos.');
  try { return await fn(); } finally {
    try { await db.ref('agenda_meta/lock').transaction((cur) => (cur && cur.owner === yo ? null : undefined)); } catch (e) {}
  }
}

// ── Feriados (ArgentinaDatos) ────────────────────────────────────
async function feriadosDelAnio(anio) {
  const ruta = 'agenda_config/feriados/' + anio;
  const guardado = await fbGet(ruta);
  const fresco = guardado && guardado.actualizado && (Date.now() - Date.parse(guardado.actualizado) < FERIADOS_REFRESCO_MS);
  if (fresco) return { lista: comoArray(guardado.lista), ok: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(API_FERIADOS + anio, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const arr = await resp.json();
    if (!Array.isArray(arr)) throw new Error('Formato inesperado');
    const lista = arr.filter((f) => f && RE_FECHA.test(f.fecha)).map((f) => ({ fecha: f.fecha, tipo: String(f.tipo || ''), nombre: String(f.nombre || '') }));
    await fbSet(ruta, { actualizado: new Date().toISOString(), fuente: 'api.argentinadatos.com', lista });
    return { lista, ok: true };
  } catch (e) {
    console.warn('Feriados ' + anio + ': no se pudo consultar la API:', e.message);
    if (guardado) return { lista: comoArray(guardado.lista), ok: true, viejo: true };
    return { lista: [], ok: false };
  }
}
async function feriadosEnRango(desde, hasta) {
  const anios = [];
  for (let a = +desde.slice(0, 4); a <= +hasta.slice(0, 4) && anios.length < 5; a++) anios.push(a);
  const res = await Promise.all(anios.map(feriadosDelAnio));
  return {
    ok: res.every((r) => r.ok),
    lista: [].concat(...res.map((r) => r.lista)).filter((f) => f.fecha >= desde && f.fecha <= hasta),
  };
}
const BLOQUEA_FERIADO = (f) => f.tipo === 'inamovible' || f.tipo === 'trasladable';

// ── Normalizar lo que manda la pantalla ──────────────────────────
function armarHorario(data) {
  const todo = !!data.todo_el_dia;
  const fecha = String(data.fecha || '').trim();
  const fechaFin = String(data.fecha_fin || data.fecha || '').trim();
  if (!RE_FECHA.test(fecha) || !RE_FECHA.test(fechaFin)) return { error: 'Fecha inválida' };
  if (fechaFin < fecha) return { error: 'La fecha de fin es anterior a la de inicio' };
  if (todo) {
    return { todo_el_dia: true, fecha, fecha_fin: fechaFin, hora_inicio: '', hora_fin: '', ts_inicio: tsBA(fecha), ts_fin: tsBA(sumarDias(fechaFin, 1)) };
  }
  const hi = String(data.hora_inicio || '').trim(), hf = String(data.hora_fin || '').trim();
  if (!RE_HORA.test(hi) || !RE_HORA.test(hf)) return { error: 'Hora inválida (formato HH:MM)' };
  const ti = tsBA(fecha, hi), tf = tsBA(fechaFin, hf);
  if (!(tf > ti)) return { error: 'La hora de fin tiene que ser posterior a la de inicio' };
  return { todo_el_dia: false, fecha, fecha_fin: fechaFin, hora_inicio: hi, hora_fin: hf, ts_inicio: ti, ts_fin: tf };
}
function bloquea(ev, p) { return ev && ev.estado === 'confirmado' && p && p.respuesta === 'aceptado'; }

// Choques de UNA persona contra su índice (excluye el propio evento)
async function choquesDe(email, ini, fin, excluirId) {
  const idx = (await fbGet(IDX + '/' + claveEmail(email))) || {};
  const ids = Object.keys(idx).filter((id) => id !== excluirId && idx[id] && idx[id].i < fin && idx[id].f > ini);
  const evs = await Promise.all(ids.map((id) => fbGet(NODO + '/' + id)));
  return evs.map((ev, k) => ({ ev, id: ids[k] }))
    .filter((x) => x.ev && x.ev.estado === 'confirmado')
    .map((x) => ({ evento_id: x.id, titulo: x.ev.titulo, cuando: cuandoTexto(x.ev), hora_inicio: x.ev.hora_inicio, hora_fin: x.ev.hora_fin, fecha: x.ev.fecha }));
}
// Revisa choques (de los que bloquearían) y feriados
async function revisar(ev, excluirId, soloEmails) {
  const conflictos = [];
  if (ev.estado === 'confirmado') {
    const quienes = Object.values(ev.participantes || {}).filter((p) => p.respuesta === 'aceptado' && (!soloEmails || soloEmails.includes(p.email)));
    for (const p of quienes) {
      const ch = await choquesDe(p.email, ev.ts_inicio, ev.ts_fin, excluirId);
      ch.forEach((c) => conflictos.push(Object.assign({ persona: p.nombre, email: p.email }, c)));
    }
  }
  const fer = await feriadosEnRango(ev.fecha, ev.fecha_fin);
  const diasEv = diasEntre(ev.fecha, ev.fecha_fin);
  const enRango = fer.lista.filter((f) => diasEv.includes(f.fecha));
  return {
    conflictos,
    feriados: enRango.filter(BLOQUEA_FERIADO),
    no_laborables: enRango.filter((f) => !BLOQUEA_FERIADO(f)),
    feriados_sin_verificar: !fer.ok,
  };
}
function hayBloqueo(rev) { return rev.conflictos.length > 0 || rev.feriados.length > 0; }

// Índice: deja agenda_idx coherente con el evento (multi-path)
function updatesIndice(id, antes, despues) {
  const u = {};
  const prev = Object.keys((antes && antes.participantes) || {});
  prev.forEach((k) => { u[IDX + '/' + k + '/' + id] = null; });
  if (despues && despues.estado === 'confirmado') {
    Object.keys(despues.participantes || {}).forEach((k) => {
      if (bloquea(despues, despues.participantes[k])) u[IDX + '/' + k + '/' + id] = { i: despues.ts_inicio, f: despues.ts_fin };
    });
  }
  return u;
}

// ── Avisos ───────────────────────────────────────────────────────
async function registrarNotificacion(email, texto, ev, id, autorNombre) {
  try {
    const idNoti = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    await fbSet('notificaciones/' + claveEmail(email) + '/' + idNoti, {
      tipo: 'agenda', origen: 'agenda', texto, ticket_id: id, ticket_titulo: ev.titulo || '', autor_nombre: autorNombre || '', fecha: new Date().toISOString(), leido: false,
    });
  } catch (e) { console.warn('Notificación falló para', email, e.message); }
}
async function obtenerTokensPush(email) {
  const key = claveEmail(email); const tokens = [];
  try { const m = await fbGet('usuarios/' + key + '/fcm_tokens'); if (m && typeof m === 'object') Object.keys(m).forEach((t) => t && tokens.push(t)); } catch (e) {}
  try { const l = await fbGet('usuarios/' + key + '/fcm_token'); if (l && !tokens.includes(l)) tokens.push(l); } catch (e) {}
  return tokens;
}
async function enviarPush(token, titulo, cuerpo, link) {
  try { await messaging.send({ token, data: { title: titulo, body: cuerpo, link: link || '' } }); } catch (e) { console.warn('Push falló:', e.message); }
}
async function enviarEmailBrevo(email, nombre, asunto, html) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('Falta BREVO_API_KEY — sin mail a', email); return; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Portal TLC', email: 'info@tlcsrl.com.ar' }, to: [{ email, name: nombre || email }], subject: asunto, htmlContent: html }),
    });
    if (r.status !== 201 && r.status !== 202) console.warn('Brevo respondió', r.status, 'para', email);
  } catch (e) { console.warn('Mail falló a', email, e.message); }
}
// aviso a una lista de personas: campanita + push (+ mail si corresponde)
async function avisar(destinos, ev, id, actor, titulo, texto, conMail) {
  const link = URL_PORTAL + 'calendario.html?evento=' + encodeURIComponent(id);
  await Promise.all(destinos.filter((p) => p && p.email && p.email !== actor.email).map(async (p) => {
    await registrarNotificacion(p.email, texto, ev, id, actor.nombre);
    const tokens = await obtenerTokensPush(p.email);
    await Promise.all(tokens.map((t) => enviarPush(t, titulo, texto, link)));
    if (conMail) {
      await enviarEmailBrevo(p.email, p.nombre, titulo + ' — ' + (ev.titulo || ''),
        '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
          '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC · Agenda</h2>' +
          '<p>' + escHtml(texto) + '</p>' +
          '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;color:#0f172a;">' +
            '<b>' + escHtml(ev.titulo) + '</b><br>📅 ' + escHtml(cuandoTexto(ev)) + (ev.cliente ? '<br>🏢 ' + escHtml(ev.cliente) : '') + (ev.notas ? '<br>📝 ' + escHtml(ev.notas) : '') +
          '</div>' +
          '<a href="' + link + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir en la Agenda</a>' +
        '</div>');
    }
  }));
}
const esPronto = (ev) => ev && (ev.ts_inicio - Date.now()) < MS_24H;

// Registro de actividad propio de la agenda (el Parte del día lo va a leer en la Etapa 2)
async function registrarActividad(accion, actor, id, ev, extra) {
  try {
    const reg = Object.assign({ t: new Date().toISOString(), accion, email: actor.email, nombre: actor.nombre, id, titulo: (ev && ev.titulo) || '' }, extra || {});
    await db.ref('agenda_actividad/' + diaBA()).push(reg);
  } catch (e) { console.warn('Actividad agenda:', e.message); }
}

// ── Armar participantes según permisos ───────────────────────────
// entrada: [{email, nombre}] ; previos: participantes actuales (al editar)
function armarParticipantes(entrada, actor, previos, creadorEmail) {
  const res = {};
  const lista = comoArray(entrada).map((p) => ({ email: String((p && p.email) || '').trim().toLowerCase(), nombre: String((p && p.nombre) || '').trim() })).filter((p) => p.email);
  previos = previos || {};
  // Sin "Agenda Equipo": el que crea siempre participa (se agenda a sí mismo)
  if (!actor.equipo && !previos[claveEmail(actor.email)] && !lista.some((p) => p.email === actor.email) && (!creadorEmail || creadorEmail === actor.email)) {
    lista.unshift({ email: actor.email, nombre: actor.nombre });
  }
  // Sin nadie elegido (y sin personas previas): se agenda a sí mismo
  if (!lista.length && !Object.keys(previos).length && actor.email) lista.push({ email: actor.email, nombre: actor.nombre });
  lista.forEach((p) => {
    const k = claveEmail(p.email);
    if (res[k]) return;
    const prev = previos[k];
    const esOrg = p.email === (creadorEmail || actor.email);
    let respuesta;
    if (prev) respuesta = prev.respuesta;                       // se respeta lo que ya respondió
    else if (actor.equipo || p.email === actor.email) respuesta = 'aceptado'; // asignación directa
    else respuesta = 'pendiente';                               // invitación
    res[k] = { email: p.email, nombre: p.nombre || (prev && prev.nombre) || p.email, rol: esOrg ? 'organizador' : 'invitado', respuesta };
    if (prev && prev.respondido_en) res[k].respondido_en = prev.respondido_en;
    if (prev && prev.motivo_rechazo) res[k].motivo_rechazo = prev.motivo_rechazo;
  });
  return res;
}
function puedeEditar(ev, actor) {
  if (!ev || !actor.email) return false;
  if (actor.equipo) return true;
  if (ev.creado_por && ev.creado_por.email === actor.email) return true;
  // "la persona agendada": un invitado que todavía no aceptó (o rechazó) no modifica el evento
  const p = ev.participantes && ev.participantes[claveEmail(actor.email)];
  return !!(p && p.respuesta === 'aceptado');
}
function respuestaBloqueo(rev, actor, extra) {
  const partes = [];
  if (rev.conflictos.length) partes.push(rev.conflictos.map((c) => c.persona + ' ya tiene "' + c.titulo + '" (' + c.cuando + ')').join(' · '));
  if (rev.feriados.length) partes.push('Feriado: ' + rev.feriados.map((f) => fechaLinda(f.fecha) + ' ' + f.nombre).join(', '));
  return Object.assign({ ok: false, bloqueado: true, error: partes.join(' · '), conflictos: rev.conflictos, feriados: rev.feriados, no_laborables: rev.no_laborables, puede_forzar: !!actor.equipo }, extra || {});
}

// ═════════════════════════════ ACCIONES ═════════════════════════

// Lista eventos que tocan [desde, hasta] + feriados + personas + permisos del que mira
async function ag_listar(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, sin_permiso: true, error: 'Necesitás el permiso "Agenda" (hoja de permisos).' };
  const desde = RE_FECHA.test(String(data.desde || '')) ? data.desde : sumarDias(diaBA(), -31);
  const hasta = RE_FECHA.test(String(data.hasta || '')) ? data.hasta : sumarDias(diaBA(), 62);
  const ini = tsBA(desde), fin = tsBA(sumarDias(hasta, 1));
  const [todos, fer, personas] = await Promise.all([fbGet(NODO), feriadosEnRango(desde, hasta), personasDelEquipo()]);
  const eventos = Object.keys(todos || {}).map((id) => Object.assign({ id }, todos[id]))
    .filter((e) => e.ts_inicio < fin && e.ts_fin > ini && (data.incluir_cancelados || e.estado !== 'cancelado'));
  // un evento puntual pedido por link (?evento=) aunque esté fuera de rango
  let evento = null;
  if (data.evento_id) { const e = await fbGet(NODO + '/' + rtdbKeySeguro(data.evento_id)); if (e) evento = Object.assign({ id: rtdbKeySeguro(data.evento_id) }, e); }
  // invitaciones sin responder del que mira, en cualquier fecha futura (para el aviso de arriba)
  const k = claveEmail(actor.email);
  const mis_pendientes = Object.keys(todos || {}).map((id) => Object.assign({ id }, todos[id]))
    .filter((e) => e.estado !== 'cancelado' && e.ts_fin > Date.now() && e.participantes && e.participantes[k] && e.participantes[k].respuesta === 'pendiente')
    .sort((a, b) => a.ts_inicio - b.ts_inicio);
  return { ok: true, desde, hasta, eventos, evento, mis_pendientes, feriados: fer.lista, feriados_sin_verificar: !fer.ok, personas, yo: { email: actor.email, nombre: actor.nombre, equipo: actor.equipo, admin: !!actor.admin } };
}

// Pre-chequeo para la pantalla (no guarda nada)
async function ag_verificar(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, error: 'Sin permiso de Agenda' };
  const h = armarHorario(data); if (h.error) return { ok: false, error: h.error };
  let previos = null, creador = null, excluir = '';
  if (data.id) { const e = await fbGet(NODO + '/' + rtdbKeySeguro(data.id)); if (e) { previos = e.participantes; creador = e.creado_por && e.creado_por.email; excluir = rtdbKeySeguro(data.id); } }
  const ev = Object.assign({ estado: ESTADOS.includes(data.estado) ? data.estado : 'confirmado', participantes: armarParticipantes(data.participantes, actor, previos, creador) }, h);
  const rev = await revisar(ev, excluir);
  return { ok: true, bloqueado: hayBloqueo(rev), conflictos: rev.conflictos, feriados: rev.feriados, no_laborables: rev.no_laborables, feriados_sin_verificar: rev.feriados_sin_verificar, puede_forzar: actor.equipo, participantes: ev.participantes };
}

async function ag_crear(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, error: 'Necesitás el permiso "Agenda" (hoja de permisos).' };
  const titulo = String(data.titulo || '').trim();
  if (!titulo) return { ok: false, error: 'Falta el título' };
  const h = armarHorario(data); if (h.error) return { ok: false, error: h.error };
  return conCandado(async () => {
    const ahora = new Date().toISOString();
    const id = 'AG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
    const ev = Object.assign({
      titulo, tipo: TIPOS.includes(data.tipo) ? data.tipo : 'interno',
      estado: ESTADOS.includes(data.estado) ? data.estado : 'confirmado',
      cliente: String(data.cliente || '').trim(), notas: String(data.notas || '').trim(),
      participantes: armarParticipantes(data.participantes, actor, null, actor.email),
      creado_por: { email: actor.email, nombre: actor.nombre }, creado_en: ahora, actualizado_en: ahora,
    }, h);
    if (!Object.keys(ev.participantes).length) return { ok: false, error: 'Elegí al menos una persona' };
    if (data.referencia && data.referencia.id) {
      ev.referencia = { entidad: String(data.referencia.entidad || ''), id: String(data.referencia.id), etiqueta: String(data.referencia.etiqueta || '') };
    }
    const rev = await revisar(ev, '');
    if (hayBloqueo(rev)) {
      const motivo = String(data.motivo_forzar || '').trim();
      if (!data.forzar) return respuestaBloqueo(rev, actor);
      if (!actor.equipo) return respuestaBloqueo(rev, actor, { error: 'Solo Administrador o "Agenda Equipo" puede agendar igual. ' + respuestaBloqueo(rev, actor).error });
      if (!motivo) return respuestaBloqueo(rev, actor, { falta_motivo: true, error: 'Para agendar igual escribí el motivo.' });
      ev.forzado = { por: actor.nombre, email: actor.email, motivo, en: ahora, conflictos: rev.conflictos.map((c) => ({ persona: c.persona, evento_id: c.evento_id, titulo: c.titulo })), feriados: rev.feriados.map((f) => f.fecha + ' ' + f.nombre) };
    }
    const u = Object.assign({ [NODO + '/' + id]: ev }, updatesIndice(id, null, ev));
    await fbUpdate(u);
    // avisos
    const parts = Object.values(ev.participantes);
    const asignados = parts.filter((p) => p.respuesta === 'aceptado');
    const invitados = parts.filter((p) => p.respuesta === 'pendiente');
    await avisar(asignados, ev, id, actor, '📅 Te agendaron', actor.nombre + ' te agendó: ' + titulo + ' · ' + cuandoTexto(ev), esPronto(ev));
    await avisar(invitados, ev, id, actor, '📨 Invitación a la agenda', actor.nombre + ' te invita: ' + titulo + ' · ' + cuandoTexto(ev) + ' — abrí para aceptar o rechazar', true);
    await registrarActividad('ag_crear', actor, id, ev, ev.forzado ? { forzado: ev.forzado.motivo } : null);
    return { ok: true, id, evento: Object.assign({ id }, ev), no_laborables: rev.no_laborables, feriados_sin_verificar: rev.feriados_sin_verificar };
  });
}

async function ag_editar(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, error: 'Sin permiso de Agenda' };
  const id = rtdbKeySeguro(data.id);
  if (!id) return { ok: false, error: 'Falta el id' };
  return conCandado(async () => {
    const antes = await fbGet(NODO + '/' + id);
    if (!antes) return { ok: false, error: 'El evento ya no existe' };
    if (antes.estado === 'cancelado') return { ok: false, error: 'El evento está cancelado' };
    if (!puedeEditar(antes, actor)) return { ok: false, error: 'Solo puede modificarlo quien lo creó, un participante o "Agenda Equipo".' };
    const h = data.fecha ? armarHorario(data) : {};
    if (h.error) return { ok: false, error: h.error };
    const ev = Object.assign({}, antes, h);
    if (data.titulo !== undefined) { const t = String(data.titulo).trim(); if (!t) return { ok: false, error: 'Falta el título' }; ev.titulo = t; }
    if (data.tipo !== undefined && TIPOS.includes(data.tipo)) ev.tipo = data.tipo;
    if (data.estado !== undefined && ESTADOS.includes(data.estado)) ev.estado = data.estado;
    if (data.cliente !== undefined) ev.cliente = String(data.cliente).trim();
    if (data.notas !== undefined) ev.notas = String(data.notas).trim();
    if (data.participantes !== undefined) {
      const creador = antes.creado_por && antes.creado_por.email;
      // Sin Agenda Equipo: solo quien lo creó cambia la lista de personas
      if (!actor.equipo && creador !== actor.email) return { ok: false, error: 'Solo quien creó el evento (o "Agenda Equipo") puede cambiar las personas.' };
      ev.participantes = armarParticipantes(data.participantes, actor, antes.participantes, creador);
      if (!Object.keys(ev.participantes).length) return { ok: false, error: 'Elegí al menos una persona' };
    }
    ev.actualizado_en = new Date().toISOString();
    ev.actualizado_por = { email: actor.email, nombre: actor.nombre };
    const rev = await revisar(ev, id);
    if (hayBloqueo(rev)) {
      const motivo = String(data.motivo_forzar || '').trim();
      if (!data.forzar) return respuestaBloqueo(rev, actor);
      if (!actor.equipo) return respuestaBloqueo(rev, actor, { error: 'Solo Administrador o "Agenda Equipo" puede agendar igual. ' + respuestaBloqueo(rev, actor).error });
      if (!motivo) return respuestaBloqueo(rev, actor, { falta_motivo: true, error: 'Para agendar igual escribí el motivo.' });
      ev.forzado = { por: actor.nombre, email: actor.email, motivo, en: ev.actualizado_en, conflictos: rev.conflictos.map((c) => ({ persona: c.persona, evento_id: c.evento_id, titulo: c.titulo })), feriados: rev.feriados.map((f) => f.fecha + ' ' + f.nombre) };
    } else if (ev.forzado && (h.fecha || data.participantes !== undefined)) {
      delete ev.forzado; // el nuevo horario ya no choca
    }
    const u = Object.assign({ [NODO + '/' + id]: ev }, updatesIndice(id, antes, ev));
    await fbUpdate(u);
    // avisos: a los de antes y a los de ahora
    const cambioHorario = antes.ts_inicio !== ev.ts_inicio || antes.ts_fin !== ev.ts_fin;
    const nuevos = Object.keys(ev.participantes).filter((k) => !(antes.participantes || {})[k]).map((k) => ev.participantes[k]);
    const quitados = Object.keys(antes.participantes || {}).filter((k) => !ev.participantes[k]).map((k) => antes.participantes[k]);
    const siguen = Object.keys(ev.participantes).filter((k) => (antes.participantes || {})[k]).map((k) => ev.participantes[k]);
    const urgente = esPronto(ev) || esPronto(antes);
    if (cambioHorario) await avisar(siguen, ev, id, actor, '🔁 Cambio en la agenda', actor.nombre + ' reprogramó "' + ev.titulo + '": ahora ' + cuandoTexto(ev) + ' (antes ' + cuandoTexto(antes) + ')', urgente);
    else if (siguen.length) await avisar(siguen, ev, id, actor, '✏️ Cambio en la agenda', actor.nombre + ' modificó "' + ev.titulo + '" (' + cuandoTexto(ev) + ')', false);
    await avisar(nuevos.filter((p) => p.respuesta === 'aceptado'), ev, id, actor, '📅 Te agendaron', actor.nombre + ' te agendó: ' + ev.titulo + ' · ' + cuandoTexto(ev), esPronto(ev));
    await avisar(nuevos.filter((p) => p.respuesta === 'pendiente'), ev, id, actor, '📨 Invitación a la agenda', actor.nombre + ' te invita: ' + ev.titulo + ' · ' + cuandoTexto(ev) + ' — abrí para aceptar o rechazar', true);
    await avisar(quitados, antes, id, actor, '➖ Agenda', actor.nombre + ' te sacó de "' + antes.titulo + '" (' + cuandoTexto(antes) + ')', esPronto(antes));
    await registrarActividad('ag_editar', actor, id, ev, cambioHorario ? { antes: cuandoTexto(antes), despues: cuandoTexto(ev) } : null);
    return { ok: true, id, evento: Object.assign({ id }, ev), no_laborables: rev.no_laborables };
  });
}

async function ag_cancelar(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, error: 'Sin permiso de Agenda' };
  const id = rtdbKeySeguro(data.id);
  return conCandado(async () => {
    const antes = await fbGet(NODO + '/' + id);
    if (!antes) return { ok: false, error: 'El evento ya no existe' };
    if (antes.estado === 'cancelado') return { ok: true, id, ya_estaba: true };
    if (!puedeEditar(antes, actor)) return { ok: false, error: 'Solo puede cancelarlo quien lo creó, un participante o "Agenda Equipo".' };
    const motivo = String(data.motivo || '').trim();
    const ev = Object.assign({}, antes, { estado: 'cancelado', cancelado: { por: actor.nombre, email: actor.email, motivo, en: new Date().toISOString() }, actualizado_en: new Date().toISOString() });
    await fbUpdate(Object.assign({ [NODO + '/' + id]: ev }, updatesIndice(id, antes, ev)));
    await avisar(Object.values(antes.participantes || {}), antes, id, actor, '❌ Evento cancelado', actor.nombre + ' canceló "' + antes.titulo + '" (' + cuandoTexto(antes) + ')' + (motivo ? ' — ' + motivo : ''), esPronto(antes));
    await registrarActividad('ag_cancelar', actor, id, antes, motivo ? { motivo } : null);
    return { ok: true, id };
  });
}

// El invitado acepta o rechaza
async function ag_responder(data) {
  const actor = await actorDe(data);
  if (!actor.agenda) return { ok: false, error: 'Sin permiso de Agenda' };
  const id = rtdbKeySeguro(data.id);
  const respuesta = data.respuesta === 'aceptado' ? 'aceptado' : data.respuesta === 'rechazado' ? 'rechazado' : '';
  if (!respuesta) return { ok: false, error: 'Respuesta inválida' };
  return conCandado(async () => {
    const antes = await fbGet(NODO + '/' + id);
    if (!antes || antes.estado === 'cancelado') return { ok: false, error: 'El evento ya no existe o fue cancelado' };
    const k = claveEmail(actor.email);
    const p = antes.participantes && antes.participantes[k];
    if (!p) return { ok: false, error: 'No estás invitado a este evento' };
    const ev = JSON.parse(JSON.stringify(antes));
    ev.participantes[k].respuesta = respuesta;
    ev.participantes[k].respondido_en = new Date().toISOString();
    const motivo = String(data.motivo || '').trim();
    if (respuesta === 'rechazado') { if (motivo) ev.participantes[k].motivo_rechazo = motivo; else delete ev.participantes[k].motivo_rechazo; }
    if (respuesta === 'aceptado') {
      delete ev.participantes[k].motivo_rechazo;
      const rev = await revisar(ev, id, [actor.email]);
      if (rev.conflictos.length) {
        if (!data.forzar) return respuestaBloqueo({ conflictos: rev.conflictos, feriados: [], no_laborables: [] }, actor);
        if (!actor.equipo) return respuestaBloqueo({ conflictos: rev.conflictos, feriados: [], no_laborables: [] }, actor, { error: 'Te choca con otro evento. Solo "Agenda Equipo" puede aceptar igual: rechazá con un motivo o pedí que lo reprogramen.' });
        if (!motivo) return respuestaBloqueo({ conflictos: rev.conflictos, feriados: [], no_laborables: [] }, actor, { falta_motivo: true, error: 'Para aceptar igual escribí el motivo.' });
        ev.participantes[k].acepto_con_choque = { motivo, conflictos: rev.conflictos.map((c) => c.titulo) };
      }
    }
    ev.actualizado_en = new Date().toISOString();
    await fbUpdate(Object.assign({ [NODO + '/' + id]: ev }, updatesIndice(id, antes, ev)));
    const org = antes.creado_por && antes.creado_por.email ? [{ email: antes.creado_por.email, nombre: antes.creado_por.nombre }] : [];
    await avisar(org, ev, id, actor, respuesta === 'aceptado' ? '✅ Invitación aceptada' : '🚫 Invitación rechazada',
      actor.nombre + (respuesta === 'aceptado' ? ' aceptó' : ' rechazó') + ' "' + ev.titulo + '" (' + cuandoTexto(ev) + ')' + (respuesta === 'rechazado' && motivo ? ' — ' + motivo : ''), false);
    await registrarActividad(respuesta === 'aceptado' ? 'ag_aceptar' : 'ag_rechazar', actor, id, ev, motivo ? { motivo } : null);
    return { ok: true, id, evento: Object.assign({ id }, ev) };
  });
}

async function ag_feriados(data) {
  const anio = /^\d{4}$/.test(String(data.anio || '')) ? String(data.anio) : diaBA().slice(0, 4);
  const r = await feriadosDelAnio(anio);
  return { ok: r.ok, anio, feriados: r.lista };
}

const ACCIONES = { ag_listar, ag_verificar, ag_crear, ag_editar, ag_cancelar, ag_responder, ag_feriados };

functions.http('agenda', async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://ir.tlcsrl.com.ar');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    let data;
    try { const raw = req.rawBody ? req.rawBody.toString('utf8') : ''; data = raw ? JSON.parse(raw) : (req.body || {}); } catch (e) { data = req.body || {}; }
    const handler = ACCIONES[data.accion];
    if (!handler) { res.status(400).json({ ok: false, error: 'Acción desconocida: ' + data.accion }); return; }
    res.status(200).json(await handler(data));
  } catch (e) {
    console.error('Error en función agenda:', e);
    res.status(200).json({ ok: false, error: e.message || String(e) });
  }
});

// Para los tests
module.exports = { _test: { armarHorario, tsBA, armarParticipantes, updatesIndice, ACCIONES } };
