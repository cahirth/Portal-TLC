// Portal TLC | Cloud Function — módulo Servicio Técnico (+ 3 acciones
// compartidas de Mi Día)
// v10 — 2026.10.06 — Cierre de semana: st_cierrePendiente,
//   st_guardarCierreSemanal y st_listarCierres (nodo cierres_semanales).
// v9 — 2026.10.06 — Tildes de lectura tipo WhatsApp en los mensajes con
//   @menciones (Servicio y Cotizaciones): los mensajes nuevos con
//   menciones llevan con_lectura:true; nuevas acciones
//   st_marcarMensajesLeidos y cot_marcarMensajesLeidos guardan en
//   mensaje.lecturas[<email>] la fecha en que cada mencionado abrió la
//   tarjeta, y de paso marcan como leídos sus avisos de esa tarjeta en
//   la campanita.
// v8 — 2026.10.04 — Fase 5a: chat de Cotizaciones (cot_listarMensajes,
//   cot_agregarMensaje con menciones por mail/push, cot_reaccionarMensaje).
// v7 — 2026.10.04 — Fase 3: las fotos de los tickets (y la firma de las
//   órdenes) se guardan en Firebase Storage y en el ticket queda el link.
//   st_backupServicio + st_migrarFotosServicio para mover las existentes.
// v6 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 2): adjuntos (subirAdjunto,
//   eliminarAdjunto) para Servicio y Cotizaciones, a Firebase Storage.
// v5 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 2): checklists y POE-8
//   (st_guardarChecklist, registrarChecklistCompletado, reabrirChecklistOrden
//   —nueva, nunca existió en Apps Script— y registrarInstalacionPOE8).
// v4 — 2026.10.04 — Progreso de preparación: "Listo para despacho" con serie y
//   calidad = 100% y cuenta como listo; "Enviado" vale lo mismo y se informa
//   aparte (progreso_st.enviados). Nueva st_recalcularProgresosOrdenes.
// v3 — 2026.10.04 — La garantía (ítem sin cargo de la ficha) ya no entra en
//   las Órdenes de Preparación; nueva st_quitarGarantiasOrden limpia las
//   órdenes ya creadas.
// v2 — 2026.10.03 — Entregas parciales: nueva acción st_dividirOrdenPreparacion
//   (separa equipos de una Orden de Preparación en una orden nueva -E2, -E3...,
//   vinculada al mismo negocio). El progreso y el estado del negocio en Ventas
//   ahora se calculan sobre toda la familia de entregas (estado = la entrega
//   más atrasada).
// v1 — 2026.09.28
//
// Séptimo módulo migrado — el más grande hasta ahora: 19 acciones de
// servicio.html + 2 compartidas con mi-dia.html/cotizaciones.html/
// eventos.html (marcarNegocioUrgente, marcarTarjetaUrgenteEv) + la que
// ya comparten ambos (st_actualizarCampo). servicio.html YA leía su
// listado principal directo de Firebase (RTDB_URL + '/servicio_tecnico.json')
// — nunca pasó por Apps Script para eso, por eso no hay una acción
// "listarTickets" acá.
//
// TODAS confirmadas Firebase-puro tras revisar cada una — con UNA
// excepción real: st_actualizarDeposito, en el caso puntual de una
// orden de preparación de equipos que llega a "para_instalar",
// necesitaba resolver el EMAIL de un vendedor A PARTIR DE SU NOMBRE —
// y eso vivía en Apps Script leyendo la hoja "Vendedores" en vivo.
// Cristian confirmó que esa hoja YA tiene su propio botón que la sube
// a Firebase (sincronizarPermisosAFirebase, nodo "permisos", igual que
// Lista_Precios) — así que acá se resuelve leyendo ESE nodo ya
// sincronizado, sin tocar Sheets para nada.
//
// LECCIÓN APLICADA DESDE EL ARRANQUE — la mayoría de estas acciones
// modifican un array compartido dentro del mismo ticket (mensajes,
// notas, fotos, equipos) con el patrón leer-modificar-escribir que ya
// causó la condición de carrera de Eventos. Acá se usa transacción
// atómica de Firebase (runTransaccionTicket) en TODAS las que
// modifican un array compartido — no solo donde ya se había visto el
// síntoma, para no repetir la misma vuelta.
//
// Los 3 aprendizajes ya afilados: databaseURL explícito, body leído de
// req.rawBody, CORS para ir.tlcsrl.com.ar.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();
const messaging = admin.messaging();

async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}
async function fbSet(path, value) { await db.ref(path).set(value); return value; }
async function fbPatch(path, fields) { await db.ref(path).update(fields); return fields; }
async function fbDelete(path) { await db.ref(path).remove(); }

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

// Transacción atómica sobre un ticket de servicio_tecnico — ver nota
// arriba. fn recibe el ticket actual (puede venir de un reintento si
// hubo conflicto) y devuelve el ticket ya modificado.
async function runTransaccionTicket(idTicket, fn) {
  const ruta = 'servicio_tecnico/' + idTicket;
  const resultado = await db.ref(ruta).transaction((actual) => {
    if (actual === null) return actual; // no existe — el llamador ya validó esto antes
    return fn(actual);
  });
  if (!resultado.committed) throw new Error('No se pudo guardar (conflicto de escrituras) — probá de nuevo');
  return resultado.snapshot.val();
}

// ── Constantes portadas tal cual de FotoMap.gs ──────────────────────
const ST_DEPOSITOS = ['recepcion', 'diagnostico', 'presupuesto', 'reparacion', 'preparacion_control_calidad', 'para_facturar', 'para_instalar', 'seguimiento', 'servicio_remoto', 'consignacion', 'finalizado', 'cancelado'];
const ST_TECNICOS = ['sin_asignar', 'fernando_del_campo', 'cristian_hirth', 'veronica_ribaita', 'lourdes_davalos', 'juan_garro', 'damian_sosa', 'lucio_raineri'];
const TECNICO_EMAIL_MAP = {
  cristian_hirth: 'cristian@tlcsrl.com.ar', veronica_ribaita: 'veronica@tlcsrl.com.ar', lourdes_davalos: 'lourdes@tlcsrl.com.ar',
  fernando_del_campo: 'fernando@tlcsrl.com.ar', lucio_raineri: 'lucio@tlcsrl.com.ar', juan_garro: 'juan@tlcsrl.com.ar', damian_sosa: 'damian@tlcsrl.com.ar',
};
const TECNICO_NOMBRE_MAP = {
  cristian_hirth: 'Cristian Hirth', veronica_ribaita: 'Verónica Ribaita', lourdes_davalos: 'Lourdes Dávalos',
  fernando_del_campo: 'Fernando Del Campo', lucio_raineri: 'Lucio Raineri', juan_garro: 'Juan Garro', damian_sosa: 'Damián Sosa',
};
const ST_CAMPOS_FOTOS = ['fotos', 'fotos_antes_reparar', 'fotos_despues_reparar'];
const ST_MSG_VENTANA_EDICION_MS = 2 * 60 * 1000;
// v4 (2026.10.04) — Cristian: "que Listo para despacho con serie y calidad
// sea 100% y cuente como listo, y que Enviado solo cambie el color o una
// marca". Antes Listo para despacho valía 45 (tope 85%) y solo Enviado
// llegaba a 100%: una orden preparada esperando despacho se veía "0/N
// Listos". Ahora Listo para despacho y Enviado valen lo mismo (60).
const ESCALON_ESTADO_ST = { 'Pendiente': 0, 'Retirado del depósito': 15, 'Verificado': 30, 'Listo para despacho': 60, 'Enviado': 60 };
const CAMPOS_PERMITIDOS_ST = ['tecnico_asignado', 'prioridad', 'estado_progreso', 'fecha_vencimiento', 'cliente', 'nombre_medico', 'domicilio', 'telefono', 'equipo_marca', 'equipo_modelo', 'equipo_serie', 'etiquetas', 'falla_reportada', 'accesorios', 'diagnostico', 'presupuesto_link', 'presupuesto_aprobado', 'partes_utilizadas', 'tareas_realizadas', 'reparado', 'domicilio_envio', 'fecha_limite_despacho', 'tecnico_responsable_nombre'];

function stGenerarId() {
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return 'TLC-ST-' + fecha + '-' + rand;
}

// Mismo nombre-base que FotoMap.gs — recorta "Equipo — variante" a
// solo "Equipo" para el sku/descripción de cada fila de la grilla.
function nombreBaseEquipo(nombreCrudo) {
  nombreCrudo = String(nombreCrudo || '').trim();
  let base = nombreCrudo;
  ['  — ', ' — ', ' / . ', ' / '].some((sep) => {
    const idx = nombreCrudo.indexOf(sep);
    if (idx !== -1) { base = nombreCrudo.slice(0, idx).trim(); return true; }
    return false;
  });
  const TOPE_LARGO = 45;
  if (base.length > TOPE_LARGO) base = base.slice(0, TOPE_LARGO).trim() + '…';
  return base;
}

// ── Notificaciones / push / mail — mismos helpers que ya se probaron en Eventos ──
async function registrarNotificacion(email, tipo, texto, ticketId, ticketTitulo, autorNombre, origen, mensajeIndice) {
  try {
    const idNoti = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const registro = { tipo, origen: origen || 'servicio', texto, ticket_id: ticketId || '', ticket_titulo: ticketTitulo || '', autor_nombre: autorNombre || '', fecha: new Date().toISOString(), leido: false };
    if (mensajeIndice !== undefined && mensajeIndice !== null) registro.mensaje_indice = mensajeIndice;
    await fbSet('notificaciones/' + rtdbKeySeguro(email) + '/' + idNoti, registro);
  } catch (e) { console.warn('No se pudo registrar notificación para', email, ':', e.message); }
}
async function obtenerTokensPush(email) {
  const key = rtdbKeySeguro(email);
  const tokens = [];
  try { const mapa = await fbGet('usuarios/' + key + '/fcm_tokens'); if (mapa && typeof mapa === 'object') Object.keys(mapa).forEach((t) => { if (t) tokens.push(t); }); } catch (e) {}
  try { const legado = await fbGet('usuarios/' + key + '/fcm_token'); if (legado && !tokens.includes(legado)) tokens.push(legado); } catch (e) {}
  return tokens;
}
async function enviarPush(token, titulo, cuerpo, link) {
  try { await messaging.send({ token, data: { title: titulo, body: cuerpo, link: link || '' } }); } catch (e) { console.warn('Push falló para un token:', e.message); }
}
async function enviarEmailBrevo(destinatarioEmail, destinatarioNombre, asunto, htmlBody) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('Falta BREVO_API_KEY — no se pudo mandar el mail a', destinatarioEmail); return; }
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'Portal TLC', email: 'info@tlcsrl.com.ar' }, to: [{ email: destinatarioEmail, name: destinatarioNombre || destinatarioEmail }], subject: asunto, htmlContent: htmlBody }),
    });
    if (resp.status !== 201 && resp.status !== 202) console.warn('Brevo respondió', resp.status, 'para', destinatarioEmail);
  } catch (e) { console.warn('No se pudo mandar el mail a', destinatarioEmail, ':', e.message); }
}

// Resuelve el email de un vendedor A PARTIR DE SU NOMBRE, leyendo el
// nodo "permisos" en Firebase (ya sincronizado por Cristian con su
// propio botón en la hoja Vendedores — sincronizarPermisosAFirebase,
// mismo criterio que Lista_Precios) — NO se lee Google Sheets acá.
async function resolverEmailPorNombreVendedor(nombre) {
  if (!nombre) return '';
  const normalizar = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const objetivo = normalizar(nombre);
  const permisos = (await fbGet('permisos')) || {};
  const match = Object.keys(permisos).find((key) => {
    const p = permisos[key];
    return normalizar(p.Nombre_Vendedor || p.Nombre || '') === objetivo;
  });
  return match ? String(permisos[match].Email || '').trim() : '';
}

async function notificarTicketPorEmail(codigosTecnico, asunto, mensaje, ticket, tipo) {
  const linkTicket = 'https://cahirth.github.io/Portal-TLC/servicio.html?ticket=' + encodeURIComponent(ticket.id_ticket);
  await Promise.all(codigosTecnico.map(async (codigo) => {
    const email = TECNICO_EMAIL_MAP[codigo];
    if (!email) return;
    await enviarEmailBrevo(email, TECNICO_NOMBRE_MAP[codigo] || '', asunto,
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p>' + escHtml(mensaje) + '</p>' +
        '<div style="background:#f1f5f9;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#334155;"><strong>' + escHtml(ticket.id_ticket) + '</strong><br>' + escHtml(ticket.cliente || '') + (ticket.equipo_modelo ? ' — ' + escHtml(ticket.equipo_modelo) : '') + '</div>' +
        '<a href="' + linkTicket + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir ticket</a>' +
      '</div>');
    const tokens = await obtenerTokensPush(email);
    await Promise.all(tokens.map((tok) => enviarPush(tok, asunto, mensaje, linkTicket)));
    await registrarNotificacion(email, tipo || 'etapa', mensaje, ticket.id_ticket, (ticket.cliente || '') + (ticket.equipo_modelo ? ' — ' + ticket.equipo_modelo : ''), '', 'servicio');
  }));
}

async function notificarCambioEtapa(ticket, etapaNueva) {
  const asignado = ticket.tecnico_asignado && ticket.tecnico_asignado !== 'sin_asignar' ? [ticket.tecnico_asignado] : [];
  const reglas = {
    diagnostico: { destinatarios: asignado, asunto: 'Nuevo diagnóstico asignado — Portal TLC', mensaje: 'Se te asignó un nuevo diagnóstico:' },
    presupuesto: { destinatarios: asignado, asunto: 'Presupuesto técnico pendiente — Portal TLC', mensaje: 'Hay un presupuesto técnico pendiente de armar:' },
    reparacion: { destinatarios: asignado, asunto: 'Reparación aprobada — Portal TLC', mensaje: 'El presupuesto fue aprobado, el equipo está listo para reparar:' },
    para_facturar: { destinatarios: ['lourdes_davalos', 'veronica_ribaita'], asunto: 'Equipo listo para facturar — Portal TLC', mensaje: 'Un equipo terminó su reparación y está listo para facturar:' },
    finalizado: { destinatarios: ['cristian_hirth'], asunto: 'Ticket finalizado — Portal TLC', mensaje: 'Se finalizó un ticket de Servicio Técnico:' },
    cancelado: { destinatarios: ['cristian_hirth'].concat(asignado), asunto: 'Ticket cancelado — Portal TLC', mensaje: 'Se canceló un ticket de Servicio Técnico:' },
  };
  const regla = reglas[etapaNueva];
  if (!regla || !regla.destinatarios.length) return;
  const destinatarios = Array.from(new Set(regla.destinatarios));
  await notificarTicketPorEmail(destinatarios, regla.asunto, regla.mensaje, ticket);
}

async function sincronizarNegocioDesdeOrdenPrep(ticket, nuevoDeposito) {
  try {
    if (!ticket || ticket.tipo_orden !== 'preparacion_equipos' || !ticket.negocio_id) return;
    const idNegocio = String(ticket.negocio_id).trim();
    const claveNegocio = 'cotizaciones/' + rtdbKeySeguro(idNegocio);
    const negocio = await fbGet(claveNegocio);
    if (!negocio) return;
    // Entregas parciales: el negocio refleja la entrega MÁS ATRASADA de la
    // familia (si una entrega llegó a Para Instalar y otra sigue en
    // Preparación, el negocio sigue en Preparación). La entrega que avanza
    // deja igual un mensaje en el negocio.
    const esFamilia = !!(ticket.orden_padre || comoArray(ticket.entregas_hijas).length);
    if (esFamilia) {
      const familia = (await familiaOrdenPrep(ticket)).map((x) => (x.id_ticket === ticket.id_ticket ? Object.assign({}, x, { deposito: nuevoDeposito }) : x));
      const activos = familia.filter((x) => x.deposito !== 'cancelado');
      const idx = (d) => { const i = ST_DEPOSITOS.indexOf(d); return i < 0 ? 999 : i; };
      const masAtrasado = activos.reduce((min, x) => (idx(x.deposito) < idx(min) ? x.deposito : min), nuevoDeposito);
      if (nuevoDeposito === 'para_instalar' && masAtrasado !== 'para_instalar') {
        try {
          const mensajesP = comoArray(await fbGet(claveNegocio + '/mensajes'));
          const nroEntrega = ticket.entrega_parcial_nro ? ' ' + ticket.entrega_parcial_nro : '';
          mensajesP.push({ texto: '📦 Entrega parcial' + nroEntrega + ' (' + ticket.id_ticket + ') llegó a "Para Instalar". Quedan otras entregas de este negocio en curso.', autor_nombre: 'Portal TLC (automático)', autor_email: '', menciones: [], fecha: new Date().toISOString() });
          await fbSet(claveNegocio + '/mensajes', mensajesP);
        } catch (eMsgP) { console.warn('No se pudo dejar el mensaje de entrega parcial:', eMsgP.message); }
      }
      if (masAtrasado !== nuevoDeposito) {
        await fbPatch(claveNegocio, { orden_preparacion_estado: masAtrasado });
        return;
      }
      ticket = Object.assign({}, ticket, { equipos: [].concat(...familia.map((x) => comoArray(x.equipos))) });
    }
    const patchNegocio = { orden_preparacion_estado: nuevoDeposito };
    if (nuevoDeposito === 'para_instalar') {
      const equipos = Array.isArray(ticket.equipos) ? ticket.equipos : [];
      const seriesTexto = equipos.filter((eq) => eq.nro_serie).map((eq) => (eq.descripcion || eq.sku || 'Equipo') + ': ' + eq.nro_serie).join('\n');
      patchNegocio.numeros_serie_equipos = seriesTexto;
    }
    await fbPatch(claveNegocio, patchNegocio);
    if (nuevoDeposito === 'para_instalar') {
      try {
        const mensajes = comoArray(await fbGet(claveNegocio + '/mensajes'));
        mensajes.push({ texto: '📦 La Orden de Preparación de este negocio llegó a "Para Instalar" — los equipos ya están listos, con Números de Serie cargados. Podés cargar el N° de comprobante/factura para cerrar el ciclo comercial.', autor_nombre: 'Portal TLC (automático)', autor_email: '', menciones: [], fecha: new Date().toISOString() });
        await fbSet(claveNegocio + '/mensajes', mensajes);
      } catch (eMsg) { console.warn('No se pudo dejar el mensaje automático en el negocio:', eMsg.message); }
      try {
        const emailVendedor = await resolverEmailPorNombreVendedor(negocio.vendedor);
        if (emailVendedor) {
          const linkNeg = 'https://cahirth.github.io/Portal-TLC/cotizaciones.html?id=' + encodeURIComponent(idNegocio);
          await enviarEmailBrevo(emailVendedor, '', '📦 Equipos listos para instalar — ' + (negocio.razonSocial || idNegocio),
            '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
              '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
              '<p>La Orden de Preparación del negocio <strong>' + escHtml(negocio.razonSocial || idNegocio) + '</strong> llegó a "Para Instalar" — los equipos ya están listos, con N° de Serie cargados.</p>' +
              '<a href="' + linkNeg + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir negocio</a>' +
            '</div>');
          const tokens = await obtenerTokensPush(emailVendedor);
          await Promise.all(tokens.map((tok) => enviarPush(tok, 'Equipos listos para instalar', (negocio.razonSocial || idNegocio) + ' — Para Instalar', linkNeg)));
        }
      } catch (eVend) { console.warn('No se pudo notificar al vendedor:', eVend.message); }
    }
  } catch (e) { console.warn('sincronizarNegocioDesdeOrdenPrep:', e.message); }
}

function calcularProgresoST(equipos) {
  equipos = Array.isArray(equipos) ? equipos : [];
  const total = equipos.length;
  if (!total) return { porcentaje: 0, listos: 0, enviados: 0, total: 0 };
  let listos = 0, enviados = 0, sumaPorcentajes = 0;
  equipos.forEach((eq) => {
    if (eq && eq.estado === 'Enviado') enviados++;
    let pct = 0;
    if (eq.nro_serie && String(eq.nro_serie).trim()) pct += 20;
    if (eq.calidad_verificada === true) pct += 20;
    pct += ESCALON_ESTADO_ST[eq.estado] || 0;
    if (pct > 100) pct = 100;
    if (pct === 100) listos++;
    sumaPorcentajes += pct;
  });
  return { porcentaje: Math.round(sumaPorcentajes / total), listos, enviados, total };
}

// ── Entregas parciales: "familia" de órdenes ───────────────────────
// Una Orden de Preparación puede dividirse en varias entregas (ver
// st_dividirOrdenPreparacion). La original guarda entregas_hijas: [ids]
// y cada entrega guarda orden_padre: id. Para el negocio de Ventas, la
// familia completa cuenta como UNA sola orden.
async function familiaOrdenPrep(ticket) {
  if (!ticket) return [];
  const idPadre = ticket.orden_padre || ticket.id_ticket;
  const padre = ticket.orden_padre ? await fbGet('servicio_tecnico/' + idPadre) : ticket;
  if (!padre) return [ticket];
  const familia = [padre];
  for (const idHija of comoArray(padre.entregas_hijas)) {
    if (idHija === ticket.id_ticket) { familia.push(ticket); continue; }
    const hija = await fbGet('servicio_tecnico/' + idHija);
    if (hija) familia.push(hija);
  }
  if (!familia.some((x) => x.id_ticket === ticket.id_ticket)) familia.push(ticket);
  return familia.map((x) => (x.id_ticket === ticket.id_ticket ? ticket : x));
}

async function actualizarProgresoSTEnNegocio(ticket) {
  try {
    if (!ticket || !ticket.negocio_id) return;
    const familia = (ticket.orden_padre || comoArray(ticket.entregas_hijas).length) ? await familiaOrdenPrep(ticket) : [ticket];
    const todosLosEquipos = [].concat(...familia.map((x) => comoArray(x.equipos)));
    const progreso = calcularProgresoST(todosLosEquipos);
    await fbPatch('cotizaciones/' + rtdbKeySeguro(ticket.negocio_id), { progreso_st: progreso });
  } catch (e) { console.warn('No se pudo actualizar progreso_st en el negocio:', e.message); }
}

// ══════════════════════════════════════════════════════════════════
// Puente Ventas → Servicio — Orden de Preparación de Equipos
// ══════════════════════════════════════════════════════════════════
// Cristian: "podemos encarar esto?" — st_crearOrdenPreparacion había
// quedado afuera de la migración original del módulo (la usa
// cotizaciones.html, no servicio.html, así que no apareció en el
// primer barrido). Confirmado Firebase-puro tras revisar el código:
// crea un ticket en servicio_tecnico/{id} (mismo nodo que el resto de
// este módulo) y marca el negocio de origen — se agrega acá, sin
// necesitar una Cloud Function nueva.
// ── GARANTÍA ───────────────────────────────────────────────────────
// Cristian: "el ítem Garantía no quiero que se pase a Preparación... pide
// N° de serie". La ficha de equipo agrega la garantía como un ítem sin
// cargo ("Garantía 1 año" / "Garantía Extendida 3 años"); en el
// presupuesto se sigue mostrando, pero no es un equipo a preparar.
function esItemGarantia(it) {
  const n = String((it && (it.nombre || it.descripcion || it.sku)) || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return n.indexOf('garantia') === 0;
}

// Saca las filas de garantía de una Orden de Preparación ya creada
// (órdenes anteriores a este arreglo). La llama servicio.html sola al
// abrir una orden que todavía las tiene.
async function st_quitarGarantiasOrden(data) {
  const idTicket = String(data.id_ticket || '').trim();
  if (!idTicket) return { ok: false, error: 'Falta id_ticket' };
  let quitadas = 0;
  const t = await runTransaccionTicket(idTicket, (tk) => {
    const equipos = comoArray(tk.equipos);
    const quedan = equipos.filter((eq) => !esItemGarantia(eq));
    quitadas = equipos.length - quedan.length;
    if (!quitadas) return tk;
    tk.equipos = quedan;
    tk.actualizado_en = new Date().toISOString();
    return tk;
  });
  if (!t) return { ok: false, error: 'Orden no encontrada' };
  if (quitadas) await actualizarProgresoSTEnNegocio(t);
  return { ok: true, quitadas, equipos: comoArray(t.equipos) };
}

// Recalcula el progreso_st de TODOS los negocios con Orden de Preparación,
// con la regla de cálculo vigente. Se usa una sola vez al cambiar la regla
// (v4): la llama servicio.html sola, la primera vez que un Administrador
// abre Servicio con la versión nueva.
async function st_recalcularProgresosOrdenes() {
  const todos = (await fbGet('servicio_tecnico')) || {};
  let negocios = 0;
  for (const id of Object.keys(todos)) {
    const t = todos[id];
    if (!t || t.tipo_orden !== 'preparacion_equipos' || !t.negocio_id || t.orden_padre) continue;
    if (!t.id_ticket) t.id_ticket = id;
    await actualizarProgresoSTEnNegocio(t);
    negocios++;
  }
  return { ok: true, negocios };
}

// ══════════════════════════════════════════════════════════════════
// CHECKLISTS Y POE-8 — v5 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 2)
// ══════════════════════════════════════════════════════════════════
// Portadas de FotoMap.gs (st_guardarChecklist, registrarChecklistCompletado,
// registrarInstalacionPOE8), con transacción atómica sobre el ticket en vez
// de leer-todo/escribir-todo, y actualizando el progreso del negocio cuando
// cambia un equipo (el checklist completo marca la calidad). Además
// reabrirChecklistOrden, que el checklist HOCT-1F llamaba pero NUNCA existió
// en Apps Script (el botón "Reabrir" siempre fallaba).

// Checklist general de un ticket de reparación (checklist_tecnico).
async function st_guardarChecklist(data) {
  const id = String(data.id_ticket || '').trim();
  const checklist = data.checklist_tecnico;
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!checklist || typeof checklist !== 'object') return { ok: false, error: 'Falta checklist_tecnico' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let bloqueado = false;
  await runTransaccionTicket(id, (t) => {
    bloqueado = false;
    const actual = t.checklist_tecnico;
    if (actual && actual.completado && !checklist.completado) { bloqueado = true; return t; }
    t.checklist_tecnico = checklist;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (bloqueado) return { ok: false, error: 'Este checklist ya está completado y no se puede editar.' };
  return { ok: true };
}

function _registroIdST(prefijo) { return prefijo + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }
function _indiceEquipoST(v) { return (v !== undefined && v !== null && v !== '') ? parseInt(v, 10) : null; }

// Checklist de UN equipo de una Orden de Preparación: guarda el registro y
// marca el equipo con checklist completo + calidad verificada.
async function registrarChecklistCompletado(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const equipoIndex = _indiceEquipoST(data.equipo_index);
  if (!idTicket || equipoIndex === null || isNaN(equipoIndex)) return { ok: false, error: 'Falta id_ticket o equipo_index' };
  const idRegistro = _registroIdST('checklist');
  await fbSet('checklist_registros/' + idRegistro, {
    id_ticket: idTicket, equipo_index: equipoIndex, modelo: String(data.modelo || '').trim(), serie: String(data.serie || '').trim(),
    tecnico: String(data.tecnico || '').trim(), cliente: String(data.cliente || '').trim(), respuestas: data.respuestas || {},
    observaciones: String(data.observaciones || '').trim(), fecha: data.fecha || new Date().toISOString(), registrado_en: new Date().toISOString(),
  });
  if (await fbGet('servicio_tecnico/' + idTicket)) {
    const t = await runTransaccionTicket(idTicket, (tk) => {
      const equipos = comoArray(tk.equipos);
      if (!equipos[equipoIndex]) return tk;
      equipos[equipoIndex].checklist_completado = true;
      equipos[equipoIndex].checklist_registro_id = idRegistro;
      equipos[equipoIndex].calidad_verificada = true;
      tk.equipos = equipos;
      tk.actualizado_en = new Date().toISOString();
      return tk;
    });
    if (t && t.tipo_orden === 'preparacion_equipos') await actualizarProgresoSTEnNegocio(t);
  }
  return { ok: true, id: idRegistro };
}

// Reabre el checklist de un equipo (solo Administrador): vuelve a quedar
// editable y se desmarca la calidad, porque la marcaba el checklist.
async function reabrirChecklistOrden(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const equipoIndex = _indiceEquipoST(data.equipo_index);
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede reabrir un checklist' };
  if (!idTicket || equipoIndex === null || isNaN(equipoIndex)) return { ok: false, error: 'Falta id_ticket o equipo_index' };
  if (!(await fbGet('servicio_tecnico/' + idTicket))) return { ok: false, error: 'Orden no encontrada' };
  let existe = false;
  const t = await runTransaccionTicket(idTicket, (tk) => {
    const equipos = comoArray(tk.equipos);
    existe = !!equipos[equipoIndex];
    if (!existe) return tk;
    equipos[equipoIndex].checklist_completado = false;
    equipos[equipoIndex].calidad_verificada = false;
    tk.equipos = equipos;
    tk.actualizado_en = new Date().toISOString();
    return tk;
  });
  if (!existe) return { ok: false, error: 'Equipo no encontrado en la orden' };
  if (t && t.tipo_orden === 'preparacion_equipos') await actualizarProgresoSTEnNegocio(t);
  return { ok: true };
}

// POE-8 (instalación): guarda el registro con las firmas y marca el equipo.
async function registrarInstalacionPOE8(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const equipoIndex = _indiceEquipoST(data.equipo_index);
  const idRegistro = _registroIdST('poe8');
  const txt = (k) => String(data[k] || '').trim();
  await fbSet('poe8_registros/' + idRegistro, {
    id_ticket: idTicket, equipo_index: equipoIndex, tecnico: txt('tecnico'), cliente: txt('cliente'), domicilio: txt('domicilio'),
    telefono: txt('telefono'), marca: txt('marca'), modelo: txt('modelo'), serie: txt('serie'), accesorios: txt('accesorios'),
    capacitacion: txt('capacitacion'), observaciones: txt('observaciones'), clienteNombre: txt('clienteNombre'), clienteDni: txt('clienteDni'),
    fecha: data.fecha || new Date().toISOString(), firmaTecnico: data.firmaTecnico || '', firmaCliente: data.firmaCliente || '',
    registrado_en: new Date().toISOString(),
  });
  if (idTicket && equipoIndex !== null && !isNaN(equipoIndex) && (await fbGet('servicio_tecnico/' + idTicket))) {
    await runTransaccionTicket(idTicket, (tk) => {
      const equipos = comoArray(tk.equipos);
      if (!equipos[equipoIndex]) return tk;
      equipos[equipoIndex].poe8_completado = true;
      equipos[equipoIndex].poe8_registro_id = idRegistro;
      tk.equipos = equipos;
      tk.actualizado_en = new Date().toISOString();
      return tk;
    });
  }
  return { ok: true, id: idRegistro };
}

// ══════════════════════════════════════════════════════════════════
// ADJUNTOS — v6 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 2)
// ══════════════════════════════════════════════════════════════════
// subirAdjunto / eliminarAdjunto, portadas de FotoMap.gs. Los usa
// adjuntos.js desde Servicio Técnico (modulo 'servicio') y Cotizaciones
// (modulo 'ventas'). Mismo bucket de Firebase Storage, misma ruta
// (adjuntos/<modulo>/<id>/<adjId>_<nombre>) y misma URL pública que ya
// usaba Apps Script, así que los adjuntos viejos siguen funcionando igual.
const bucketAdjuntos = admin.storage().bucket('portal-tlc.firebasestorage.app');
const ADJUNTOS_MAX_BYTES = 10 * 1024 * 1024;

// ── FOTOS EN STORAGE — v7 — 2026.10.04 (Fase 3) ────────────────────
// Cristian: "para cargar Servicio es lento". Las fotos de los tickets se
// guardaban como base64 ADENTRO de cada ticket (~11 MB la lista entera).
// Ahora se suben a Firebase Storage (mismo bucket y misma forma de link
// que los adjuntos) y en el ticket queda solo el link. Las páginas que
// las muestran no cambian: una imagen se ve igual con el link.
function _esFotoEmbebida(f) {
  const v = (f && typeof f === 'object') ? f.data : f;
  return typeof v === 'string' && (v.indexOf('data:') === 0 || (v.length > 500 && v.indexOf('http') !== 0));
}
async function _subirFotoStorage(idTicket, campo, foto) {
  let v = (foto && typeof foto === 'object') ? String(foto.data || '') : String(foto || '');
  let mime = 'image/jpeg';
  const m = v.match(/^data:([^;]+);base64,/);
  if (m) { mime = m[1]; v = v.substring(m[0].length); }
  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  const ruta = 'adjuntos/fotos_servicio/' + idTicket + '/' + campo + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6) + '.' + ext;
  await bucketAdjuntos.file(ruta).save(Buffer.from(v, 'base64'), { contentType: mime, resumable: false });
  return 'https://firebasestorage.googleapis.com/v0/b/portal-tlc.firebasestorage.app/o/' + encodeURIComponent(ruta) + '?alt=media';
}
function _rutaStorageDeUrl(url) {
  const m = String(url || '').match(/\/o\/([^?]+)\?alt=media/);
  return m ? decodeURIComponent(m[1]) : null;
}
const ADJUNTOS_TIPOS_PERMITIDOS = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
function _nodoAdjuntos(modulo) {
  return modulo === 'servicio' ? 'servicio_tecnico/' : (modulo === 'eventos' ? 'eventos/' : (modulo === 'ventas' ? 'cotizaciones/' : null));
}
async function subirAdjunto(data) {
  const modulo = String(data.modulo || '').trim();
  const idRegistro = String(data.idRegistro || '').trim();
  const nombre = String(data.nombre || '').trim();
  const tipoMime = String(data.tipoMime || '').trim();
  const base64 = String(data.base64 || '');
  const subidoPorNombre = String(data.subidoPorNombre || '').trim();
  const nodoBase = _nodoAdjuntos(modulo);
  if (!nodoBase) return { ok: false, error: 'Módulo inválido: ' + modulo };
  if (!idRegistro) return { ok: false, error: 'Falta idRegistro' };
  if (!nombre) return { ok: false, error: 'Falta nombre de archivo' };
  if (!base64) return { ok: false, error: 'Falta el contenido del archivo' };
  if (!ADJUNTOS_TIPOS_PERMITIDOS[tipoMime]) {
    const ext = (nombre.split('.').pop() || '').toLowerCase();
    if (Object.values(ADJUNTOS_TIPOS_PERMITIDOS).indexOf(ext) === -1) return { ok: false, error: 'Tipo de archivo no permitido — solo PDF, JPG, PNG, TXT, DOC, DOCX, XLS, XLSX.' };
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > ADJUNTOS_MAX_BYTES) return { ok: false, error: 'El archivo pesa más de 10MB — no se puede subir.' };
  const adjId = 'adj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const pathStorage = 'adjuntos/' + modulo + '/' + idRegistro + '/' + adjId + '_' + nombre;
  await bucketAdjuntos.file(pathStorage).save(buffer, { contentType: tipoMime || 'application/octet-stream', resumable: false });
  const metadata = {
    nombre, tipo: tipoMime, url: 'https://firebasestorage.googleapis.com/v0/b/portal-tlc.firebasestorage.app/o/' + encodeURIComponent(pathStorage) + '?alt=media',
    path: pathStorage, tamano: buffer.length, subido_por_nombre: subidoPorNombre, fecha: new Date().toISOString(),
  };
  await fbPatch(nodoBase + idRegistro + '/adjuntos', { [adjId]: metadata });
  return { ok: true, adjId, adjunto: metadata };
}
async function eliminarAdjunto(data) {
  const modulo = String(data.modulo || '').trim();
  const idRegistro = String(data.idRegistro || '').trim();
  const adjId = String(data.adjId || '').trim();
  const nodoBase = _nodoAdjuntos(modulo);
  if (!nodoBase) return { ok: false, error: 'Módulo inválido' };
  if (!idRegistro || !adjId) return { ok: false, error: 'Faltan datos' };
  const ruta = nodoBase + idRegistro + '/adjuntos/' + adjId;
  const adjunto = await fbGet(ruta);
  if (adjunto && adjunto.path) {
    try { await bucketAdjuntos.file(adjunto.path).delete(); }
    catch (e) { if (e.code !== 404) console.warn('No se pudo borrar el archivo de Storage (se borra igual la referencia):', e.message); }
  }
  await db.ref(ruta).remove();
  return { ok: true };
}

// ── MIGRACIÓN ÚNICA DE FOTOS A STORAGE (Fase 3) ───────────────────
// 1) st_backupServicio: copia servicio_tecnico entero a
//    backups/servicio_tecnico_<fecha> ANTES de tocar nada.
// 2) st_migrarFotosServicio: en tandas (para no pasar el límite de tiempo
//    de la función), sube a Storage las fotos embebidas de cada ticket
//    (fotos, fotos_antes_reparar, fotos_despues_reparar y firma_digital) y
//    deja el link. Con transacción por ticket: si mientras tanto alguien
//    agregó o borró una foto, se respeta. Devuelve cuántos tickets quedan;
//    la página la llama hasta que quedan 0.
async function st_backupServicio(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador' };
  const todo = await fbGet('servicio_tecnico');
  if (!todo) return { ok: false, error: 'servicio_tecnico vacío' };
  const marca = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').substring(0, 13);
  const destino = 'backups/servicio_tecnico_' + marca;
  await fbSet(destino, todo);
  return { ok: true, destino, tickets: Object.keys(todo).length };
}

function _ticketTieneFotosEmbebidas(t) {
  if (!t) return false;
  if (ST_CAMPOS_FOTOS.some((c) => comoArray(t[c]).some(_esFotoEmbebida))) return true;
  return _esFotoEmbebida(t.firma_digital);
}

async function st_migrarFotosServicio(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador' };
  const tanda = Math.min(Math.max(parseInt(data.tanda, 10) || 8, 1), 25);
  const todo = (await fbGet('servicio_tecnico')) || {};
  const pendientes = Object.keys(todo).filter((id) => _ticketTieneFotosEmbebidas(todo[id]));
  let migrados = 0, fotosSubidas = 0;
  const conError = [];
  for (const id of pendientes.slice(0, tanda)) {
    const t = todo[id];
    // Subir primero (fuera de la transacción) y armar el reemplazo
    const reemplazos = {}; // valor embebido -> link
    try {
      for (const campo of ST_CAMPOS_FOTOS) {
        for (const f of comoArray(t[campo])) {
          if (!_esFotoEmbebida(f)) continue;
          const clave = (f && typeof f === 'object') ? String(f.data) : String(f);
          if (!reemplazos[clave]) { reemplazos[clave] = await _subirFotoStorage(id, campo, f); fotosSubidas++; }
        }
      }
      if (_esFotoEmbebida(t.firma_digital)) { reemplazos[String(t.firma_digital)] = await _subirFotoStorage(id, 'firma', t.firma_digital); fotosSubidas++; }
    } catch (eSub) { conError.push(id + ': ' + eSub.message); continue; }
    await runTransaccionTicket(id, (tk) => {
      ST_CAMPOS_FOTOS.forEach((campo) => {
        if (!tk[campo]) return;
        tk[campo] = comoArray(tk[campo]).map((f) => {
          const clave = (f && typeof f === 'object') ? String(f.data) : String(f);
          return reemplazos[clave] || f;
        });
      });
      if (tk.firma_digital && reemplazos[String(tk.firma_digital)]) tk.firma_digital = reemplazos[String(tk.firma_digital)];
      return tk;
    });
    migrados++;
  }
  const quedan = Math.max(0, pendientes.length - migrados);
  return { ok: true, migrados, fotosSubidas, quedan, errores: conError };
}

// ══════════════════════════════════════════════════════════════════
// CHAT DE COTIZACIONES — v8 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 5a)
// ══════════════════════════════════════════════════════════════════
// Viven en esta función (y no en "cotizaciones") porque acá ya están el
// mail por Brevo, el push y el registro de notificaciones que usan las
// menciones. Misma lógica que FotoMap.gs, con transacción sobre la lista
// de mensajes del negocio (cotizaciones/<id>/mensajes).
function _rutaMensajesCot(id) { return 'cotizaciones/' + rtdbKeySeguro(id) + '/mensajes'; }

async function cot_listarMensajes(data) {
  const id = String(data.id_cotizacion || '').trim();
  if (!id) return { ok: false, error: 'Falta id_cotizacion' };
  return { ok: true, mensajes: comoArray(await fbGet(_rutaMensajesCot(id))) };
}

async function cot_agregarMensaje(data) {
  const id = String(data.id_cotizacion || '').trim();
  const texto = String(data.texto || '').trim();
  const titulo = String(data.titulo || '').trim();
  const autorNombre = String(data.autor_nombre || '').trim();
  const autorEmail = String(data.autor_email || '').trim();
  const menciones = Array.isArray(data.menciones) ? data.menciones.filter(Boolean) : [];
  if (!id || !texto) return { ok: false, error: 'Faltan id_cotizacion o texto' };
  if (!(await fbGet('cotizaciones/' + rtdbKeySeguro(id)))) return { ok: false, error: 'Negocio no encontrado: ' + id };
  const respuestaA = (data.respuesta_a && typeof data.respuesta_a.indice === 'number')
    ? { indice: data.respuesta_a.indice, autor_nombre: String(data.respuesta_a.autor_nombre || '').trim(), texto_snippet: String(data.respuesta_a.texto_snippet || '').trim() }
    : null;
  let indiceMensajeNuevo = -1;
  const res = await db.ref(_rutaMensajesCot(id)).transaction((actual) => {
    const mensajes = comoArray(actual);
    const nuevo = { texto, autor_nombre: autorNombre, autor_email: autorEmail, menciones, fecha: new Date().toISOString() };
    if (respuestaA) nuevo.respuesta_a = respuestaA;
    if (_tieneMencionadosAjenos(menciones, autorEmail)) nuevo.con_lectura = true;
    mensajes.push(nuevo);
    indiceMensajeNuevo = mensajes.length - 1;
    return mensajes;
  });
  if (!res.committed) return { ok: false, error: 'No se pudo guardar el mensaje — probá de nuevo' };
  const mensajes = comoArray(res.snapshot.val());
  const linkCot = 'https://cahirth.github.io/Portal-TLC/cotizaciones.html?id=' + encodeURIComponent(id);
  await Promise.all(menciones.filter((email) => email && email !== autorEmail).map(async (email) => {
    await enviarEmailBrevo(email, '', 'Te mencionaron en una cotización — ' + (titulo || id),
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(autorNombre || autorEmail) + '</strong> te mencionó en la cotización <strong>' + escHtml(id) + '</strong>' + (titulo ? ' (' + escHtml(titulo) + ')' : '') + ':</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(texto) + '</div>' +
        '<a href="' + linkCot + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir cotización</a>' +
      '</div>');
    const tokens = await obtenerTokensPush(email);
    await Promise.all(tokens.map((tok) => enviarPush(tok, 'Te mencionaron en una cotización', (autorNombre || autorEmail) + ': ' + texto, linkCot)));
    await registrarNotificacion(email, 'mencion', texto, id, titulo, autorNombre || autorEmail, 'cotizacion', indiceMensajeNuevo);
  }));
  return { ok: true, mensajes };
}

async function cot_reaccionarMensaje(data) {
  const id = String(data.id_cotizacion || '').trim();
  const indice = parseInt(data.indice, 10);
  const email = String(data.autor_email || '').trim();
  const nombre = String(data.autor_nombre || '').trim();
  const reaccion = String(data.reaccion || '').trim();
  const titulo = String(data.titulo || '').trim();
  if (!id || isNaN(indice)) return { ok: false, error: 'Faltan id_cotizacion o indice' };
  const emailKey = rtdbKeySeguro(email.toLowerCase());
  if (!emailKey) return { ok: false, error: 'Falta email' };
  if (!['ok', 'no_ok', 'corazon'].includes(reaccion)) return { ok: false, error: 'Reacción inválida' };
  let errorValidacion = null, esNueva = false, autorMsgEmail = '', textoMsg = '';
  const res = await db.ref(_rutaMensajesCot(id)).transaction((actual) => {
    const mensajes = comoArray(actual);
    errorValidacion = null;
    if (!mensajes[indice]) { errorValidacion = 'Mensaje no encontrado'; return actual; }
    if (!mensajes[indice].reacciones) mensajes[indice].reacciones = {};
    const yaExiste = mensajes[indice].reacciones[emailKey];
    esNueva = !yaExiste || yaExiste.reaccion !== reaccion;
    if (yaExiste && yaExiste.reaccion === reaccion) delete mensajes[indice].reacciones[emailKey];
    else mensajes[indice].reacciones[emailKey] = { reaccion, nombre: nombre || email };
    autorMsgEmail = String(mensajes[indice].autor_email || '').trim();
    textoMsg = String(mensajes[indice].texto || '');
    return mensajes;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  if (esNueva && autorMsgEmail && autorMsgEmail.toLowerCase() !== email.toLowerCase()) {
    const emoji = ({ ok: '👍', no_ok: '👎', corazon: '❤️' })[reaccion] || '';
    const quien = nombre || email || 'Alguien';
    await registrarNotificacion(autorMsgEmail, 'reaccion', quien + ' reaccionó ' + emoji + ' a tu mensaje: "' + textoMsg.slice(0, 80) + '"', id, titulo, quien, 'cotizacion');
    await enviarEmailBrevo(autorMsgEmail, '', quien + ' reaccionó a tu mensaje en Portal TLC',
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(quien) + '</strong> reaccionó ' + emoji + ' a tu mensaje:</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(textoMsg) + '</div>' +
      '</div>');
  }
  return { ok: true, mensajes: comoArray(res.snapshot.val()) };
}

async function st_crearOrdenPreparacion(data) {
  const idNegocio = String(data.id_negocio || '').trim();
  const fechaLimite = String(data.fecha_limite_despacho || '').trim();
  const tecnicoEmail = String(data.tecnico_email || '').trim();
  const tecnicoNombre = String(data.tecnico_nombre || '').trim();
  if (!idNegocio) return { ok: false, error: 'Falta id_negocio' };
  const negocio = await fbGet('cotizaciones/' + rtdbKeySeguro(idNegocio));
  if (!negocio) return { ok: false, error: 'Negocio no encontrado' };

  let domicilioContacto = '';
  let domicilioEnvio = '';
  if (negocio.empresaId) {
    const empresa = await fbGet('empresas/' + negocio.empresaId);
    if (empresa) {
      domicilioContacto = empresa.domicilioComercial || empresa.domicilioFiscal || empresa.domicilio || '';
      domicilioEnvio = empresa.domicilioEnvio || domicilioContacto || empresa.domicilio || '';
    }
  }
  if (!domicilioContacto) domicilioContacto = negocio.domicilio || '';
  if (!domicilioEnvio) domicilioEnvio = negocio.domicilio || '';

  const carrito = Array.isArray(negocio.carrito) ? negocio.carrito : [];
  const equipos = [];
  carrito.forEach((it) => {
    if (esItemGarantia(it)) return; // la garantía no es un equipo físico: no se prepara ni lleva N° de serie
    const cant = it.cantidad || 1;
    for (let i = 0; i < cant; i++) equipos.push({ cantidad: 1, sku: nombreBaseEquipo(it.nombre), descripcion: it.nombre || '', nro_serie: '', calidad_verificada: false, estado: 'Pendiente' });
  });

  const idTicket = 'PREP-' + stGenerarId().replace('TLC-ST-', '');
  const registro = {
    id_ticket: idTicket, tipo_orden: 'preparacion_equipos', negocio_id: idNegocio,
    cliente: negocio.razonSocial || (negocio.empresa && negocio.empresa.razonSocial) || '', nombre_medico: '',
    telefono: negocio.telefono || (negocio.contacto && negocio.contacto.telefono) || '', domicilio: domicilioContacto,
    domicilio_envio: domicilioEnvio, fecha_limite_despacho: fechaLimite, tecnico_responsable_email: tecnicoEmail,
    tecnico_responsable_nombre: tecnicoNombre, equipos, deposito: 'preparacion_control_calidad',
    estado_progreso: 'activo', mensajes: [], firma_digital: null, creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(),
  };
  await fbSet('servicio_tecnico/' + idTicket, registro);
  try {
    await fbPatch('cotizaciones/' + rtdbKeySeguro(idNegocio), {
      orden_preparacion_estado: 'preparacion_control_calidad',
      orden_preparacion_ticket_id: idTicket,
      progreso_st: calcularProgresoST(equipos), // arranca en 0% — todos los equipos nacen 'Pendiente'
    });
  } catch (ePatchNeg) { console.warn('No se pudo marcar el estado inicial en el negocio:', ePatchNeg.message); }

  if (tecnicoEmail) {
    const linkTicket = 'https://cahirth.github.io/Portal-TLC/servicio.html?ticket=' + encodeURIComponent(idTicket);
    await registrarNotificacion(tecnicoEmail, 'ticket_nuevo', 'Nueva Orden de Preparación: ' + registro.cliente + ' (' + equipos.length + ' equipo' + (equipos.length !== 1 ? 's' : '') + ')', idTicket, registro.cliente, 'Sistema', 'servicio');
    const tokens = await obtenerTokensPush(tecnicoEmail);
    await Promise.all(tokens.map((tok) => enviarPush(tok, '📦 Nueva Orden de Preparación', registro.cliente + ' — ' + equipos.length + ' equipo(s) para preparar', linkTicket)));
    await enviarEmailBrevo(tecnicoEmail, tecnicoNombre, '📦 Nueva Orden de Preparación — ' + registro.cliente,
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC — Orden de Preparación</h2>' +
        '<p>Tenés una nueva orden de preparación de equipos pendiente:</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;color:#0f172a;">' +
          '<strong>Cliente:</strong> ' + escHtml(registro.cliente) + '<br>' +
          '<strong>Domicilio de envío:</strong> ' + escHtml(domicilioEnvio || 'No cargado') + '<br>' +
          '<strong>Equipos:</strong> ' + equipos.length + '<br>' +
          (fechaLimite ? '<strong>Fecha límite de despacho:</strong> ' + escHtml(fechaLimite) : '') +
        '</div>' +
        '<a href="' + linkTicket + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir orden</a>' +
      '</div>');
  }
  return { ok: true, id_ticket: idTicket, ticket: registro };
}

// ══════════════════════════════════════════════════════════════════
// Acciones compartidas con Mi Día
// ══════════════════════════════════════════════════════════════════

async function marcarNegocioUrgente(data) {
  const idCot = String(data.idCot || '').trim();
  if (!idCot) return { ok: false, error: 'Falta idCot' };
  const idRtdb = rtdbKeySeguro(idCot);
  if (!(await fbGet('cotizaciones/' + idRtdb))) return { ok: false, error: 'Negocio no encontrado: ' + idCot };
  const activo = data.activo !== false;
  if (!activo) { await fbPatch('cotizaciones/' + idRtdb, { urgente: null }); return { ok: true, activo: false }; }
  await fbPatch('cotizaciones/' + idRtdb, { urgente: { activo: true, nota: String(data.nota || '').trim(), marcado_por: String(data.vendedor || '').trim(), fecha: new Date().toISOString() } });
  return { ok: true, activo: true };
}

async function marcarTarjetaUrgenteEv(data) {
  const idEvento = String(data.id_evento || '').trim();
  const idTarjeta = String(data.id_tarjeta || '').trim();
  if (!idEvento || !idTarjeta) return { ok: false, error: 'Faltan datos' };
  const ruta = 'eventos/' + idEvento + '/tarjetas/' + idTarjeta;
  if (!(await fbGet(ruta))) return { ok: false, error: 'Tarjeta no encontrada: ' + idTarjeta };
  const activo = data.activo !== false;
  if (!activo) { await fbPatch(ruta, { urgente: null }); return { ok: true, activo: false }; }
  await fbPatch(ruta, { urgente: { activo: true, nota: String(data.nota || '').trim(), marcado_por: String(data.vendedor || '').trim(), fecha: new Date().toISOString() } });
  return { ok: true, activo: true };
}

// ══════════════════════════════════════════════════════════════════
// Servicio Técnico
// ══════════════════════════════════════════════════════════════════

async function st_crearTicket(data) {
  const id = stGenerarId();
  const fechaISO = new Date().toISOString();
  const fotosRecibidas = Array.isArray(data.fotos) ? data.fotos.slice(0, 3) : [];
  // Fase 3: las fotos de ingreso van a Storage; en el ticket queda el link.
  for (let i = 0; i < fotosRecibidas.length; i++) {
    if (_esFotoEmbebida(fotosRecibidas[i])) {
      try { fotosRecibidas[i] = await _subirFotoStorage(id, 'fotos', fotosRecibidas[i]); }
      catch (eF) { console.warn('No se pudo subir la foto de ingreso a Storage (queda embebida):', eF.message); }
    }
  }
  const ticket = {
    id_ticket: id, cliente: String(data.cliente || '').trim(), nombre_medico: String(data.nombre_medico || '').trim(),
    domicilio: String(data.domicilio || '').trim(), telefono: String(data.telefono || '').trim(),
    equipo_marca: String(data.equipo_marca || '').trim(), equipo_modelo: String(data.equipo_modelo || '').trim(),
    equipo_serie: String(data.equipo_serie || '').trim(), accesorios: String(data.accesorios || '').trim(),
    falla_reportada: String(data.falla_reportada || '').trim(),
    tecnico_asignado: ST_TECNICOS.includes(data.tecnico_asignado) ? data.tecnico_asignado : 'sin_asignar',
    deposito: ST_DEPOSITOS.includes(data.deposito) ? data.deposito : 'recepcion',
    prioridad: ['urgente', 'importante', 'media', 'baja'].includes(data.prioridad) ? data.prioridad : 'media',
    estado_progreso: ['atrasada', 'no_iniciada', 'en_curso', 'completada'].includes(data.estado_progreso) ? data.estado_progreso : 'no_iniciada',
    fecha_vencimiento: String(data.fecha_vencimiento || '').trim(),
    etiquetas: (typeof data.etiquetas === 'object' && data.etiquetas) ? data.etiquetas : {},
    notas_comentarios: [], gastos: [], fotos: fotosRecibidas, fotos_bloqueadas: fotosRecibidas.length,
    creado_por: String(data.creado_por || '').trim(), creado_en: fechaISO, actualizado_en: fechaISO,
  };
  if (data.nota_inicial && String(data.nota_inicial).trim()) {
    ticket.notas_comentarios.push({ texto: String(data.nota_inicial).trim(), autor: ticket.creado_por, fecha: fechaISO });
  }
  await fbSet('servicio_tecnico/' + id, ticket);
  try {
    const tecnicosRealesParaAvisoNuevo = ['juan_garro', 'damian_sosa'];
    const descripcionEquipo = ((ticket.equipo_marca || '') + ' ' + (ticket.equipo_modelo || '') + (ticket.cliente ? ' — ' + ticket.cliente : '')).trim();
    await notificarTicketPorEmail(tecnicosRealesParaAvisoNuevo, 'Nuevo equipo ingresado — Portal TLC', 'Ingresó un nuevo equipo a Servicio Técnico: ' + descripcionEquipo, ticket, 'ticket_nuevo');
  } catch (en) { console.warn('Notificación de ticket nuevo falló:', en.message); }
  return { ok: true, id_ticket: id };
}

async function st_duplicarTicket(data) {
  const idOrigen = String(data.id_ticket || '').trim();
  if (!idOrigen) return { ok: false, error: 'Falta id_ticket' };
  const original = await fbGet('servicio_tecnico/' + idOrigen);
  if (!original) return { ok: false, error: 'Ticket no encontrado: ' + idOrigen };
  const id = stGenerarId();
  const ahora = new Date().toISOString();
  const nuevo = {
    id_ticket: id, cliente: original.cliente || '', nombre_medico: original.nombre_medico || '',
    domicilio: original.domicilio || '', telefono: original.telefono || '',
    equipo_marca: original.equipo_marca || '', equipo_modelo: original.equipo_modelo || '',
    equipo_serie: original.equipo_serie || '', accesorios: original.accesorios || '',
    falla_reportada: original.falla_reportada || '', tecnico_asignado: original.tecnico_asignado || 'sin_asignar',
    deposito: 'recepcion', prioridad: original.prioridad || 'media', estado_progreso: 'no_iniciada',
    fecha_vencimiento: '', etiquetas: original.etiquetas || {},
    notas_comentarios: [], gastos: [], fotos: [], fotos_bloqueadas: 0, mensajes: [],
    creado_por: String(data.creado_por || '').trim(), creado_en: ahora, actualizado_en: ahora,
  };
  await fbSet('servicio_tecnico/' + id, nuevo);
  return { ok: true, ticket: nuevo };
}

async function st_eliminarTicket(data) {
  const id = String(data.id_ticket || '').trim();
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  await fbDelete('servicio_tecnico/' + id);
  return { ok: true };
}

async function st_actualizarCampo(data) {
  const id = String(data.id_ticket || '').trim();
  const campo = String(data.campo || '').trim();
  if (!id || !campo) return { ok: false, error: 'Faltan id_ticket o campo' };
  if (!CAMPOS_PERMITIDOS_ST.includes(campo)) return { ok: false, error: 'Campo no permitido: ' + campo };
  const patch = { actualizado_en: new Date().toISOString() };
  patch[campo] = data.valor;
  await fbPatch('servicio_tecnico/' + id, patch);
  return { ok: true };
}

async function st_actualizarDeposito(data) {
  const id = String(data.id_ticket || '').trim();
  const deposito = String(data.deposito || '').trim();
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!ST_DEPOSITOS.includes(deposito)) return { ok: false, error: 'Depósito inválido: ' + deposito };
  const ticket = await fbGet('servicio_tecnico/' + id);
  const depositoAnterior = ticket ? ticket.deposito : null;
  const patch = { deposito, actualizado_en: new Date().toISOString() };
  const tecnicoAsignado = String(data.tecnico_asignado || '').trim();
  if (tecnicoAsignado && ST_TECNICOS.includes(tecnicoAsignado)) patch.tecnico_asignado = tecnicoAsignado;
  await fbPatch('servicio_tecnico/' + id, patch);
  if (ticket && depositoAnterior !== deposito) {
    if (patch.tecnico_asignado) ticket.tecnico_asignado = patch.tecnico_asignado;
    try { await notificarCambioEtapa(ticket, deposito); } catch (en) { console.warn('Notificación de cambio de etapa falló:', en.message); }
    try { await sincronizarNegocioDesdeOrdenPrep(ticket, deposito); } catch (esync) { console.warn('Sincronización con Ventas falló:', esync.message); }
  }
  return { ok: true };
}

async function st_actualizarNotas(data) {
  const id = String(data.id_ticket || '').trim();
  const notas = data.notas;
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!Array.isArray(notas)) return { ok: false, error: 'notas debe ser un array' };
  await fbPatch('servicio_tecnico/' + id, { notas_comentarios: notas, actualizado_en: new Date().toISOString() });
  return { ok: true };
}

async function st_agregarNota(data) {
  const id = String(data.id_ticket || '').trim();
  const texto = String(data.texto || '').trim();
  const autor = String(data.autor || '').trim();
  if (!id || !texto) return { ok: false, error: 'Faltan id_ticket o texto' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  await runTransaccionTicket(id, (t) => {
    const notas = comoArray(t.notas_comentarios);
    notas.unshift({ texto, autor, fecha: new Date().toISOString() });
    t.notas_comentarios = notas;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  return { ok: true };
}

async function st_actualizarGastos(data) {
  const id = String(data.id_ticket || '').trim();
  const gastos = data.gastos;
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!Array.isArray(gastos)) return { ok: false, error: 'gastos debe ser un array' };
  await fbPatch('servicio_tecnico/' + id, { gastos, actualizado_en: new Date().toISOString() });
  return { ok: true };
}

async function st_agregarFoto(data) {
  const id = String(data.id_ticket || '').trim();
  let foto = String(data.foto || '').trim();
  const campo = ST_CAMPOS_FOTOS.includes(data.campo) ? data.campo : 'fotos';
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!foto) return { ok: false, error: 'Falta foto' };
  const previoFoto = await fbGet('servicio_tecnico/' + id);
  if (!previoFoto) return { ok: false, error: 'Ticket no encontrado: ' + id };
  if (comoArray(previoFoto[campo]).length >= 3) return { ok: false, error: 'Este ticket ya tiene el máximo de 3 fotos en "' + campo + '"' };
  // Fase 3: la foto va a Storage; en el ticket se guarda solo el link.
  if (_esFotoEmbebida(foto)) foto = await _subirFotoStorage(id, campo, foto);
  let errorLimite = null;
  const ticket = await runTransaccionTicket(id, (t) => {
    const fotos = comoArray(t[campo]);
    if (fotos.length >= 3) { errorLimite = 'Este ticket ya tiene el máximo de 3 fotos en "' + campo + '"'; return t; }
    fotos.push(foto);
    t[campo] = fotos;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorLimite) return { ok: false, error: errorLimite };
  return { ok: true, fotos: comoArray(ticket[campo]) };
}

async function st_eliminarFoto(data) {
  const id = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  const campo = ST_CAMPOS_FOTOS.includes(data.campo) ? data.campo : 'fotos';
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (isNaN(indice)) return { ok: false, error: 'Índice inválido' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let errorValidacion = null, fotoBorrada = null;
  const ticket = await runTransaccionTicket(id, (t) => {
    const fotos = comoArray(t[campo]);
    if (indice < 0 || indice >= fotos.length) { errorValidacion = 'Índice fuera de rango'; return t; }
    if (campo === 'fotos') {
      const bloqueadas = parseInt(t.fotos_bloqueadas) || 0;
      if (indice < bloqueadas) { errorValidacion = 'Esta foto se cargó en el ingreso del equipo y no se puede eliminar (queda como evidencia).'; return t; }
    }
    fotoBorrada = fotos[indice];
    fotos.splice(indice, 1);
    t[campo] = fotos;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  const rutaBorrar = _rutaStorageDeUrl(fotoBorrada);
  if (rutaBorrar) { try { await bucketAdjuntos.file(rutaBorrar).delete(); } catch (eDel) { if (eDel.code !== 404) console.warn('No se pudo borrar la foto de Storage:', eDel.message); } }
  return { ok: true, fotos: comoArray(ticket[campo]) };
}

async function st_agregarMensaje(data) {
  const id = String(data.id_ticket || '').trim();
  const texto = String(data.texto || '').trim();
  const autorNombre = String(data.autor_nombre || '').trim();
  const autorEmail = String(data.autor_email || '').trim();
  const menciones = Array.isArray(data.menciones) ? data.menciones.filter(Boolean) : [];
  if (!id || !texto) return { ok: false, error: 'Faltan id_ticket o texto' };
  const ticketOriginal = await fbGet('servicio_tecnico/' + id);
  if (!ticketOriginal) return { ok: false, error: 'Ticket no encontrado: ' + id };
  const respuestaA = (data.respuesta_a && typeof data.respuesta_a.indice === 'number')
    ? { indice: data.respuesta_a.indice, autor_nombre: String(data.respuesta_a.autor_nombre || '').trim(), texto_snippet: String(data.respuesta_a.texto_snippet || '').trim() }
    : null;
  let indiceMensajeNuevo = -1;
  const ticket = await runTransaccionTicket(id, (t) => {
    const mensajes = comoArray(t.mensajes);
    const nuevoMensaje = { texto, autor_nombre: autorNombre, autor_email: autorEmail, menciones, fecha: new Date().toISOString() };
    if (respuestaA) nuevoMensaje.respuesta_a = respuestaA;
    if (_tieneMencionadosAjenos(menciones, autorEmail)) nuevoMensaje.con_lectura = true;
    mensajes.push(nuevoMensaje);
    indiceMensajeNuevo = mensajes.length - 1;
    t.mensajes = mensajes;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  const linkTicket = 'https://cahirth.github.io/Portal-TLC/servicio.html?ticket=' + encodeURIComponent(id);
  await Promise.all(menciones.filter((email) => email && email !== autorEmail).map(async (email) => {
    await enviarEmailBrevo(email, '', 'Te mencionaron en un ticket — ' + (ticketOriginal.equipo_modelo || ticketOriginal.cliente || id),
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(autorNombre || autorEmail) + '</strong> te mencionó en el ticket <strong>' + escHtml(id) + '</strong> (' + escHtml(ticketOriginal.cliente || '') + ' — ' + escHtml(ticketOriginal.equipo_modelo || '') + '):</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(texto) + '</div>' +
        '<a href="' + linkTicket + '" style="display:inline-block;padding:10px 20px;background:#3a86ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Abrir ticket</a>' +
      '</div>');
    const tokens = await obtenerTokensPush(email);
    await Promise.all(tokens.map((tok) => enviarPush(tok, 'Te mencionaron en un ticket', (autorNombre || autorEmail) + ': ' + texto, linkTicket)));
    await registrarNotificacion(email, 'mencion', texto, id, (ticketOriginal.cliente || '') + (ticketOriginal.equipo_modelo ? ' — ' + ticketOriginal.equipo_modelo : ''), autorNombre || autorEmail, 'servicio', indiceMensajeNuevo);
  }));
  return { ok: true, mensajes: comoArray(ticket.mensajes) };
}

function validarMensajePropioEditable(mensajes, indice, autorEmail) {
  if (!Array.isArray(mensajes) || !mensajes[indice]) return { ok: false, error: 'Mensaje no encontrado' };
  const msg = mensajes[indice];
  const autorMsg = String(msg.autor_email || '').trim().toLowerCase();
  const autorPedido = String(autorEmail || '').trim().toLowerCase();
  if (!autorPedido || autorMsg !== autorPedido) return { ok: false, error: 'No podés editar o borrar un mensaje de otra persona' };
  const edadMs = Date.now() - new Date(msg.fecha || 0).getTime();
  if (isNaN(edadMs) || edadMs >= ST_MSG_VENTANA_EDICION_MS) return { ok: false, error: 'Ya pasaron los 2 minutos — este mensaje ya no se puede editar ni borrar' };
  return { ok: true };
}

async function st_editarMensaje(data) {
  const id = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  const texto = String(data.texto || '').trim();
  const autorEmail = String(data.autor_email || '').trim();
  if (!id || isNaN(indice)) return { ok: false, error: 'Faltan id_ticket o indice' };
  if (!texto) return { ok: false, error: 'El mensaje no puede quedar vacío' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(id, (t) => {
    const mensajes = comoArray(t.mensajes);
    const val = validarMensajePropioEditable(mensajes, indice, autorEmail);
    if (!val.ok) { errorValidacion = val.error; return t; }
    mensajes[indice].texto = texto;
    mensajes[indice].editado = true;
    t.mensajes = mensajes;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  return { ok: true, mensajes: comoArray(ticket.mensajes) };
}

async function st_borrarMensaje(data) {
  const id = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  const autorEmail = String(data.autor_email || '').trim();
  if (!id || isNaN(indice)) return { ok: false, error: 'Faltan id_ticket o indice' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(id, (t) => {
    const mensajes = comoArray(t.mensajes);
    const val = validarMensajePropioEditable(mensajes, indice, autorEmail);
    if (!val.ok) { errorValidacion = val.error; return t; }
    mensajes.splice(indice, 1);
    t.mensajes = mensajes;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  return { ok: true, mensajes: comoArray(ticket.mensajes) };
}

async function st_reaccionarMensaje(data) {
  const id = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  const email = String(data.autor_email || '').trim();
  const nombre = String(data.autor_nombre || '').trim();
  const reaccion = String(data.reaccion || '').trim();
  if (!id || isNaN(indice)) return { ok: false, error: 'Faltan id_ticket o indice' };
  const emailKey = rtdbKeySeguro(email.toLowerCase());
  if (!emailKey) return { ok: false, error: 'Falta email' };
  if (!['ok', 'no_ok', 'corazon'].includes(reaccion)) return { ok: false, error: 'Reacción inválida' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let errorValidacion = null;
  let esNueva = false;
  let autorMsgEmail = '';
  let textoMsg = '';
  const ticket = await runTransaccionTicket(id, (t) => {
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
  if (esNueva && autorMsgEmail && autorMsgEmail.toLowerCase() !== email.toLowerCase()) {
    const EMOJIS_REACCION = { ok: '👍', no_ok: '👎', corazon: '❤️' };
    const emoji = EMOJIS_REACCION[reaccion] || '';
    const quien = nombre || email || 'Alguien';
    const textoNoti = quien + ' reaccionó ' + emoji + ' a tu mensaje: "' + textoMsg.slice(0, 80) + '"';
    const ticketRef = await fbGet('servicio_tecnico/' + id);
    await registrarNotificacion(autorMsgEmail, 'reaccion', textoNoti, id, ticketRef ? ((ticketRef.cliente || '') + (ticketRef.equipo_modelo ? ' — ' + ticketRef.equipo_modelo : '')) : '', quien, 'servicio');
    await enviarEmailBrevo(autorMsgEmail, '', quien + ' reaccionó a tu mensaje en Portal TLC',
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="color:#1a4b8c;margin-bottom:8px;">Portal TLC</h2>' +
        '<p><strong>' + escHtml(quien) + '</strong> reaccionó ' + emoji + ' a tu mensaje:</p>' +
        '<div style="background:#f1f5f9;border-left:4px solid #3a86ff;padding:12px 16px;border-radius:8px;margin:16px 0;font-style:italic;color:#0f172a;">' + escHtml(textoMsg) + '</div>' +
      '</div>');
  }
  return { ok: true, mensajes: comoArray(ticket.mensajes) };
}

async function st_separarEquipoOrden(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  if (!idTicket || isNaN(indice)) return { ok: false, error: 'Faltan datos' };
  if (!(await fbGet('servicio_tecnico/' + idTicket))) return { ok: false, error: 'Ticket no encontrado' };
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(idTicket, (t) => {
    const equipos = comoArray(t.equipos);
    const original = equipos[indice];
    if (!original) { errorValidacion = 'Equipo no encontrado en esa posición'; return t; }
    const cant = original.cantidad || 1;
    if (cant <= 1) { errorValidacion = 'Este equipo ya tiene cantidad 1 — no hay nada para separar.'; return t; }
    const filasNuevas = [];
    for (let i = 0; i < cant; i++) filasNuevas.push({ cantidad: 1, sku: original.sku || '', descripcion: original.descripcion || '', nro_serie: '', calidad_verificada: false, estado: 'Pendiente' });
    equipos.splice(indice, 1, ...filasNuevas);
    t.equipos = equipos;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  await actualizarProgresoSTEnNegocio(ticket);
  return { ok: true, equipos: comoArray(ticket.equipos) };
}

// ══════════════════════════════════════════════════════════════════
// DIVIDIR ENTREGA — v2 — 2026.10.03
// ══════════════════════════════════════════════════════════════════
// Cristian: "el único problema que veo es si al cliente se le hace una
// entrega parcial" → "me gusta, hacelo". Separa los equipos elegidos
// (indices) de una Orden de Preparación en una ORDEN NUEVA (entrega
// parcial), con su propio remito, etiquetas y seguimiento, vinculada al
// mismo negocio. La original se queda con los pendientes.
// - Id de la entrega: <id original>-E2, -E3, ...
// - Si todos los equipos de la entrega ya están "Listo para despacho" o
//   "Enviado", nace a nombre de quien despacha (RESPONSABLE_DESPACHO);
//   si no, del mismo técnico que la original.
// - La original no puede quedar vacía: hay que dejar al menos 1 equipo.
// - Las etiquetas de cajas ya generadas en la original se borran (los
//   equipos cambiaron): hay que volver a generarlas en cada orden.
const RESPONSABLE_DESPACHO = 'Lourdes Dávalos';
async function st_dividirOrdenPreparacion(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const indices = Array.isArray(data.indices) ? [...new Set(data.indices.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n) && n >= 0))] : [];
  const autor = String(data.autor_nombre || '').trim() || 'Portal TLC';
  if (!idTicket || !indices.length) return { ok: false, error: 'Elegí al menos un equipo para la entrega' };
  const previo = await fbGet('servicio_tecnico/' + idTicket);
  if (!previo) return { ok: false, error: 'Orden no encontrada' };
  if (previo.tipo_orden !== 'preparacion_equipos') return { ok: false, error: 'Solo se pueden dividir Órdenes de Preparación' };
  if (previo.orden_padre) return { ok: false, error: 'Esta ya es una entrega parcial — dividí la orden original' };

  const ahora = new Date().toISOString();
  let errorValidacion = null, extraidos = [], idHija = '', nroEntrega = 0;
  const original = await runTransaccionTicket(idTicket, (t) => {
    errorValidacion = null; extraidos = [];
    const equipos = comoArray(t.equipos);
    if (indices.some((i) => !equipos[i])) { errorValidacion = 'La lista de equipos cambió — recargá e intentá de nuevo'; return t; }
    if (indices.length >= equipos.length) { errorValidacion = 'Tiene que quedar al menos un equipo en la orden original'; return t; }
    extraidos = indices.slice().sort((a, b) => a - b).map((i) => equipos[i]);
    const hijas = comoArray(t.entregas_hijas);
    nroEntrega = hijas.length + 2; // la original es la entrega 1
    idHija = idTicket + '-E' + nroEntrega;
    t.equipos = equipos.filter((_, i) => indices.indexOf(i) === -1);
    t.entregas_hijas = hijas.concat([idHija]);
    t.etiquetas_cajas = null; t.etiquetas_generadas_en = null;
    const mensajes = comoArray(t.mensajes);
    mensajes.push({ texto: '✂️ ' + autor + ' separó ' + extraidos.length + ' equipo(s) en la entrega parcial ' + nroEntrega + ' (' + idHija + '). En esta orden quedan ' + t.equipos.length + '.', autor_nombre: 'Portal TLC (automático)', autor_email: '', menciones: [], fecha: ahora });
    t.mensajes = mensajes;
    t.actualizado_en = ahora;
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };

  const todoListo = extraidos.every((eq) => eq && (eq.estado === 'Listo para despacho' || eq.estado === 'Enviado'));
  const hija = {
    id_ticket: idHija, tipo_orden: 'preparacion_equipos', negocio_id: original.negocio_id || '',
    orden_padre: idTicket, entrega_parcial_nro: nroEntrega,
    cliente: original.cliente || '', nombre_medico: original.nombre_medico || '', telefono: original.telefono || '',
    domicilio: original.domicilio || '', domicilio_envio: original.domicilio_envio || '',
    fecha_limite_despacho: original.fecha_limite_despacho || '', prioridad: original.prioridad || 'media',
    tecnico_responsable_email: original.tecnico_responsable_email || '',
    tecnico_responsable_nombre: todoListo ? RESPONSABLE_DESPACHO : (original.tecnico_responsable_nombre || ''),
    // Un solo responsable: el código va siempre junto con el nombre
    tecnico_asignado: todoListo ? 'lourdes_davalos' : (original.tecnico_asignado || 'sin_asignar'),
    equipos: extraidos, deposito: 'preparacion_control_calidad', estado_progreso: 'activo',
    mensajes: [{ texto: '✂️ Entrega parcial ' + nroEntrega + ' de la orden ' + idTicket + ', creada por ' + autor + ' con ' + extraidos.length + ' equipo(s).', autor_nombre: 'Portal TLC (automático)', autor_email: '', menciones: [], fecha: ahora }],
    firma_digital: null, creado_en: ahora, actualizado_en: ahora,
  };
  await fbSet('servicio_tecnico/' + idHija, hija);

  try {
    if (original.negocio_id) {
      const claveNegocio = 'cotizaciones/' + rtdbKeySeguro(original.negocio_id);
      const mensajesN = comoArray(await fbGet(claveNegocio + '/mensajes'));
      mensajesN.push({ texto: '✂️ La Orden de Preparación se dividió: entrega parcial ' + nroEntrega + ' con ' + extraidos.length + ' equipo(s) (' + idHija + '). El resto sigue en ' + idTicket + '.', autor_nombre: 'Portal TLC (automático)', autor_email: '', menciones: [], fecha: ahora });
      await fbSet(claveNegocio + '/mensajes', mensajesN);
    }
  } catch (eN) { console.warn('No se pudo avisar la división en el negocio:', eN.message); }
  await actualizarProgresoSTEnNegocio(original);

  return { ok: true, id_hija: idHija, nro_entrega: nroEntrega, equipos_original: comoArray(original.equipos), responsable_hija: hija.tecnico_responsable_nombre };
}

async function st_actualizarEquipoOrden(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const indice = parseInt(data.indice, 10);
  if (!idTicket || isNaN(indice)) return { ok: false, error: 'Faltan datos' };
  if (!(await fbGet('servicio_tecnico/' + idTicket))) return { ok: false, error: 'Ticket no encontrado' };
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(idTicket, (t) => {
    const equipos = comoArray(t.equipos);
    if (!equipos[indice]) { errorValidacion = 'Equipo no encontrado en esa posición'; return t; }
    ['nro_serie', 'calidad_verificada', 'estado', 'sku', 'descripcion'].forEach((campo) => { if (data[campo] !== undefined) equipos[indice][campo] = data[campo]; });
    t.equipos = equipos;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  await actualizarProgresoSTEnNegocio(ticket);
  return { ok: true, equipos: comoArray(ticket.equipos) };
}

async function st_guardarEtiquetasCajas(data) {
  const idTicket = String(data.id_ticket || '').trim();
  const cajas = Array.isArray(data.cajas) ? data.cajas : [];
  if (!idTicket) return { ok: false, error: 'Falta id_ticket' };
  if (!cajas.length) return { ok: false, error: 'No hay cajas para guardar' };
  await fbPatch('servicio_tecnico/' + idTicket, { etiquetas_cajas: cajas, etiquetas_transporte: String(data.transporte || '').trim(), etiquetas_generadas_en: new Date().toISOString(), actualizado_en: new Date().toISOString() });
  return { ok: true };
}

async function eliminarVersionPresupuestoTicket(data) {
  const ticketId = String(data.ticketId || '').trim();
  const version = parseInt(data.version, 10);
  if (!ticketId) return { ok: false, error: 'Falta ticketId' };
  if (isNaN(version)) return { ok: false, error: 'Falta version' };
  if (!(await fbGet('servicio_tecnico/' + ticketId))) return { ok: false, error: 'Ticket no encontrado: ' + ticketId };
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(ticketId, (t) => {
    if (!Array.isArray(t.presupuestos)) { errorValidacion = 'Este ticket no tiene versiones'; return t; }
    const idx = t.presupuestos.findIndex((v) => v.version === version);
    if (idx === -1) { errorValidacion = 'Versión no encontrada: v' + version; return t; }
    t.presupuestos.splice(idx, 1);
    t.presupuesto_link = t.presupuestos.length ? t.presupuestos[t.presupuestos.length - 1].link : '';
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
  return { ok: true, presupuestos: comoArray(ticket.presupuestos) };
}

async function guardarAsignadosEtapa(data) {
  const etapa = String(data.etapa || '').trim();
  if (!etapa) return { ok: false, error: 'Falta etapa' };
  const codigos = Array.isArray(data.codigos) ? data.codigos.filter((c) => ST_TECNICOS.includes(c)) : [];
  await fbSet('servicio_config/asignados_por_etapa/' + etapa, codigos);
  return { ok: true };
}

// ── Tildes de lectura (v9) ──────────────────────────────────────────
// Cristian: "¿es posible tener una tilde o dos tildes como WhatsApp? para
// empezar a ver si le llegó y si lo leyó". Cada mensaje con @menciones
// guarda lecturas[<email>] = fecha en que ESE mencionado abrió la tarjeta.
function _tieneMencionadosAjenos(menciones, autorEmail) {
  const autor = String(autorEmail || '').trim().toLowerCase();
  return (menciones || []).some((e) => e && String(e).trim().toLowerCase() !== autor);
}
function _claveLectura(email) { return rtdbKeySeguro(String(email || '').trim().toLowerCase()); }
function _mensajesPendientesDeLeer(mensajes, email) {
  const yo = String(email || '').trim().toLowerCase();
  const k = _claveLectura(yo);
  return comoArray(mensajes).some((m) => m && m.con_lectura &&
    comoArray(m.menciones).some((e) => String(e || '').trim().toLowerCase() === yo) && !(m.lecturas && m.lecturas[k]));
}
function _marcarLecturas(mensajes, email) {
  const yo = String(email || '').trim().toLowerCase();
  const k = _claveLectura(yo);
  const ahora = new Date().toISOString();
  let marcados = 0;
  mensajes.forEach((m) => {
    if (!m || !m.con_lectura) return;
    if (!comoArray(m.menciones).some((e) => String(e || '').trim().toLowerCase() === yo)) return;
    if (!m.lecturas) m.lecturas = {};
    if (m.lecturas[k]) return;
    m.lecturas[k] = ahora;
    marcados++;
  });
  return marcados;
}
// Al abrir la tarjeta, sus avisos en la campanita quedan leídos.
async function _marcarAvisosLeidosDeTarjeta(email, ticketId) {
  try {
    const ruta = 'notificaciones/' + rtdbKeySeguro(email);
    const notis = await fbGet(ruta);
    if (!notis || typeof notis !== 'object') return 0;
    const cambios = {};
    Object.keys(notis).forEach((k) => {
      const n = notis[k];
      if (n && !n.leido && String(n.ticket_id || '') === String(ticketId)) cambios[k + '/leido'] = true;
    });
    if (Object.keys(cambios).length) await db.ref(ruta).update(cambios);
    return Object.keys(cambios).length;
  } catch (e) { console.warn('No se pudieron marcar avisos leídos:', e.message); return 0; }
}

async function st_marcarMensajesLeidos(data) {
  const id = String(data.id_ticket || '').trim();
  const email = String(data.email || '').trim();
  if (!id || !email) return { ok: false, error: 'Faltan id_ticket o email' };
  const t0 = await fbGet('servicio_tecnico/' + id);
  if (!t0) return { ok: false, error: 'Ticket no encontrado: ' + id };
  let marcados = 0;
  let mensajes = comoArray(t0.mensajes);
  if (_mensajesPendientesDeLeer(mensajes, email)) {
    const ticket = await runTransaccionTicket(id, (t) => {
      const ms = comoArray(t.mensajes);
      marcados = _marcarLecturas(ms, email);
      t.mensajes = ms;
      return t;
    });
    mensajes = comoArray(ticket.mensajes);
  }
  const avisos = await _marcarAvisosLeidosDeTarjeta(email, id);
  return { ok: true, marcados, avisos_leidos: avisos, mensajes };
}

async function cot_marcarMensajesLeidos(data) {
  const id = String(data.id_cotizacion || '').trim();
  const email = String(data.email || '').trim();
  if (!id || !email) return { ok: false, error: 'Faltan id_cotizacion o email' };
  let mensajes = comoArray(await fbGet(_rutaMensajesCot(id)));
  let marcados = 0;
  if (_mensajesPendientesDeLeer(mensajes, email)) {
    const res = await db.ref(_rutaMensajesCot(id)).transaction((actual) => {
      if (actual === null) return actual;
      const ms = comoArray(actual);
      marcados = _marcarLecturas(ms, email);
      return ms;
    });
    if (res.committed) mensajes = comoArray(res.snapshot.val());
  }
  const avisos = await _marcarAvisosLeidosDeTarjeta(email, id);
  return { ok: true, marcados, avisos_leidos: avisos, mensajes };
}

// ── Cierre de semana (v10) ──────────────────────────────────────────
// Cristian: "los viernes al mediodía... que ellos se comprometan y sean
// responsables de su carga laboral... que no apaguen la computadora y
// vuelvan el lunes como si nada". Desde el viernes 12:00 (hora de
// Buenos Aires), a cada persona con equipos a cargo le aparece en el
// Portal un modal que no se puede cerrar hasta que marca el estado de
// cada uno (cierre-semanal.js). Se guarda en
// cierres_semanales/<viernes>/<email>, y cada estado queda además como
// nota de seguimiento en su ticket.
const CIERRE_INICIO = '2026-10-09';            // primer viernes con cierre
const CIERRE_HORA = 12;                         // viernes desde las 12:00
const CIERRE_AVISAR_A = ['cristian@tlcsrl.com.ar']; // aviso si alguien marca "trabado" o "no me corresponde"
const CIERRE_ETAPAS = [
  { key: 'diagnostico', label: 'Diagnóstico' },
  { key: 'presupuesto', label: 'Presupuesto' },
  { key: 'reparacion', label: 'Reparación' },
  { key: 'preparacion_control_calidad', label: 'Preparación' },
  { key: 'para_facturar', label: 'Para facturar' },
];
const CIERRE_ESTADOS = {
  sale: '✅ Sale esta semana / ya salió',
  proxima: '🔧 En trabajo, sale la semana que viene',
  repuesto: '⏳ Espera repuesto',
  cliente: '🧑‍💼 Espera al cliente',
  trabado: '⚠️ Trabado, necesito ayuda',
  no_mio: '🔁 No me corresponde',
};

// Fecha/hora "de pared" en Buenos Aires (UTC-3, sin horario de verano)
function _ahoraBA() { return new Date(Date.now() - 3 * 3600 * 1000); }
function _ymd(d) { return d.toISOString().slice(0, 10); }
// Viernes (YYYY-MM-DD) del cierre vigente: el último viernes 12:00 ya pasado.
function semanaCierreActual() {
  const ba = _ahoraBA();
  const dia = ba.getUTCDay(); // 5 = viernes
  let atras = (dia - 5 + 7) % 7;
  if (atras === 0 && ba.getUTCHours() < CIERRE_HORA) atras = 7;
  const viernes = new Date(ba.getTime() - atras * 86400000);
  const semana = _ymd(viernes);
  return semana >= CIERRE_INICIO ? semana : null;
}
function _semanaAnterior(semana) { return _ymd(new Date(new Date(semana + 'T12:00:00Z').getTime() - 7 * 86400000)); }
function _normNombre(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

// Email del responsable de un ticket — mismo criterio que la "Carga por
// técnico" de servicio.html (_codTecnicoTicket).
function _emailResponsableTicket(t) {
  if (!t) return '';
  let cod = (t.tecnico_asignado && t.tecnico_asignado !== 'sin_asignar') ? t.tecnico_asignado : '';
  if (!cod && t.tipo_orden === 'preparacion_equipos' && t.tecnico_responsable_nombre) {
    const n = _normNombre(t.tecnico_responsable_nombre);
    cod = Object.keys(TECNICO_NOMBRE_MAP).find((c) => _normNombre(TECNICO_NOMBRE_MAP[c]) === n) || '';
  }
  return cod ? String(TECNICO_EMAIL_MAP[cod] || '').toLowerCase() : '';
}
function _tituloTicketCierre(t) {
  const cliente = String(t.cliente || t.nombre_medico || '').trim() || 'Sin cliente';
  let equipo = '';
  if (t.tipo_orden === 'preparacion_equipos') {
    const eq = comoArray(t.equipos);
    if (eq.length) equipo = String(eq[0].descripcion || eq[0].sku || '').trim() + (eq.length > 1 ? ' (+' + (eq.length - 1) + ')' : '');
  } else {
    const marca = String(t.equipo_marca || '').trim(), modelo = String(t.equipo_modelo || '').trim();
    equipo = (marca && modelo && modelo.toLowerCase().indexOf(marca.toLowerCase()) === 0) ? modelo : [marca, modelo].filter(Boolean).join(' ');
  }
  return cliente + ' — ' + (equipo || 'Sin equipo');
}
// Tickets a cargo de cada email, en las etapas de la carga
function _cargaPorEmail(todos) {
  const porEmail = {};
  Object.keys(todos || {}).forEach((id) => {
    const t = todos[id];
    if (!t || !CIERRE_ETAPAS.some((e) => e.key === t.deposito)) return;
    const email = _emailResponsableTicket(t);
    if (!email) return;
    (porEmail[email] = porEmail[email] || []).push({
      id: t.id_ticket || id,
      titulo: _tituloTicketCierre(t),
      deposito: t.deposito,
      etapa: (CIERRE_ETAPAS.find((e) => e.key === t.deposito) || {}).label || t.deposito,
      prioridad: t.prioridad || '',
      es_orden: t.tipo_orden === 'preparacion_equipos',
    });
  });
  Object.keys(porEmail).forEach((e) => porEmail[e].sort((a, b) =>
    CIERRE_ETAPAS.findIndex((x) => x.key === a.deposito) - CIERRE_ETAPAS.findIndex((x) => x.key === b.deposito)));
  return porEmail;
}

async function st_cierrePendiente(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Falta email' };
  const prueba = !!data.prueba;
  const semana = prueba ? 'prueba' : semanaCierreActual();
  if (!semana) return { ok: true, pendiente: false };
  const key = rtdbKeySeguro(email);
  if (!prueba && await fbGet('cierres_semanales/' + semana + '/' + key)) return { ok: true, pendiente: false, semana, hecho: true };
  const tickets = _cargaPorEmail(await fbGet('servicio_tecnico'))[email] || [];
  if (!tickets.length) return { ok: true, pendiente: false, semana, sin_carga: true };
  const anterior = await fbGet('cierres_semanales/' + (prueba ? semanaCierreActual() || CIERRE_INICIO : _semanaAnterior(semana)) + '/' + key);
  const prev = {};
  comoArray(anterior && anterior.items).forEach((it) => { if (it && it.id) prev[it.id] = { estado: it.estado, nota: it.nota || '' }; });
  tickets.forEach((t) => { if (prev[t.id]) t.anterior = prev[t.id]; });
  return { ok: true, pendiente: true, semana, prueba, tickets, estados: CIERRE_ESTADOS };
}

async function st_guardarCierreSemanal(data) {
  const email = String(data.email || '').trim().toLowerCase();
  const nombre = String(data.nombre || '').trim() || email;
  const prueba = !!data.prueba;
  if (!email) return { ok: false, error: 'Falta email' };
  const semana = prueba ? 'prueba' : semanaCierreActual();
  if (!semana) return { ok: false, error: 'Todavía no hay cierre de semana habilitado' };
  if (!prueba && String(data.semana || '') !== semana) return { ok: false, error: 'La semana cambió — recargá la página' };
  const carga = _cargaPorEmail(await fbGet('servicio_tecnico'))[email] || [];
  const porId = {};
  carga.forEach((t) => { porId[t.id] = t; });
  const items = [];
  for (const it of comoArray(data.items)) {
    const t = porId[String(it && it.id || '')];
    if (!t) continue; // ya no está a su cargo (lo movieron mientras completaba)
    const estado = String(it.estado || '');
    if (!CIERRE_ESTADOS[estado]) return { ok: false, error: 'Falta el estado de ' + t.titulo };
    const nota = String(it.nota || '').trim().slice(0, 500);
    if ((estado === 'trabado' || estado === 'no_mio') && !nota) return { ok: false, error: 'Contá en una línea por qué: ' + t.titulo };
    items.push({ id: t.id, titulo: t.titulo, deposito: t.deposito, etapa: t.etapa, estado, nota });
  }
  const faltan = carga.filter((t) => !items.some((i) => i.id === t.id));
  if (faltan.length) return { ok: false, error: 'Falta completar: ' + faltan.map((t) => t.titulo).join(', ') };
  const registro = { email, nombre, fecha: new Date().toISOString(), items };
  const key = rtdbKeySeguro(email);
  if (prueba) {
    await fbSet('cierres_semanales_prueba/' + key, registro);
    return { ok: true, prueba: true, total: items.length };
  }
  await fbSet('cierres_semanales/' + semana + '/' + key, registro);
  // Cada estado queda también en las notas de seguimiento del ticket
  await Promise.all(items.map((it) => runTransaccionTicket(it.id, (t) => {
    const notas = comoArray(t.notas_comentarios);
    notas.unshift({ texto: '📋 Cierre de semana: ' + CIERRE_ESTADOS[it.estado] + (it.nota ? ' — ' + it.nota : ''), autor: nombre, fecha: registro.fecha });
    t.notas_comentarios = notas;
    return t;
  }).catch((e) => console.warn('Cierre: no se pudo anotar en', it.id, e.message))));
  // Aviso inmediato si hay algo trabado o mal asignado
  const urgentes = items.filter((i) => i.estado === 'trabado' || i.estado === 'no_mio');
  if (urgentes.length) {
    const texto = nombre + ' cerró la semana con ' + urgentes.length + ' para revisar: ' +
      urgentes.map((u) => (u.estado === 'trabado' ? '⚠️ ' : '🔁 ') + u.titulo + ' (' + u.nota + ')').join(' · ');
    await Promise.all(CIERRE_AVISAR_A.filter((e) => e !== email).map(async (dest) => {
      await registrarNotificacion(dest, 'cierre', texto, '', 'Cierre de semana', nombre, 'servicio');
      const tokens = await obtenerTokensPush(dest);
      await Promise.all(tokens.map((tok) => enviarPush(tok, 'Cierre de semana — ' + nombre, texto, 'https://cahirth.github.io/Portal-TLC/cierres.html')));
    }));
  }
  return { ok: true, total: items.length, urgentes: urgentes.length };
}

// Resumen para administradores (cierres.html)
async function st_listarCierres(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador' };
  const actual = semanaCierreActual();
  const semana = String(data.semana || '').trim() || actual || CIERRE_INICIO;
  const todas = await db.ref('cierres_semanales').once('value');
  const semanas = [];
  todas.forEach((ch) => { semanas.push(ch.key); });
  if (actual && !semanas.includes(actual)) semanas.push(actual);
  semanas.sort().reverse();
  const cierres = comoArray(await fbGet('cierres_semanales/' + semana));
  // Quién tiene carga HOY y todavía no cerró (solo tiene sentido para la semana vigente)
  let pendientes = [];
  if (semana === actual) {
    const carga = _cargaPorEmail(await fbGet('servicio_tecnico'));
    const hechos = cierres.map((c) => String(c.email || '').toLowerCase());
    pendientes = Object.keys(carga).filter((e) => !hechos.includes(e)).map((e) => {
      const cod = Object.keys(TECNICO_EMAIL_MAP).find((c) => TECNICO_EMAIL_MAP[c] === e);
      return { email: e, nombre: (cod && TECNICO_NOMBRE_MAP[cod]) || e, total: carga[e].length };
    });
  }
  return { ok: true, semana, actual, semanas, cierres, pendientes, estados: CIERRE_ESTADOS };
}

const ACCIONES = {
  marcarNegocioUrgente, marcarTarjetaUrgenteEv, st_crearOrdenPreparacion,
  st_crearTicket, st_duplicarTicket, st_eliminarTicket,
  st_actualizarCampo, st_actualizarDeposito, st_actualizarNotas, st_actualizarGastos,
  st_agregarNota, st_agregarFoto, st_eliminarFoto,
  st_agregarMensaje, st_editarMensaje, st_borrarMensaje, st_reaccionarMensaje,
  st_separarEquipoOrden, st_actualizarEquipoOrden, st_dividirOrdenPreparacion, st_quitarGarantiasOrden, st_recalcularProgresosOrdenes,
  st_guardarChecklist, registrarChecklistCompletado, reabrirChecklistOrden, registrarInstalacionPOE8,
  subirAdjunto, eliminarAdjunto,
  st_backupServicio, st_migrarFotosServicio,
  cot_listarMensajes, cot_agregarMensaje, cot_reaccionarMensaje,
  st_marcarMensajesLeidos, cot_marcarMensajesLeidos,
  st_cierrePendiente, st_guardarCierreSemanal, st_listarCierres,
  st_guardarEtiquetasCajas, eliminarVersionPresupuestoTicket, guardarAsignadosEtapa,
};

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('servicio', async (req, res) => {
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
    console.error('Error en función servicio:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
