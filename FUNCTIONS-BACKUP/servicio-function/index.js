// Portal TLC | Cloud Function — módulo Servicio Técnico (+ 3 acciones
// compartidas de Mi Día)
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
const ESCALON_ESTADO_ST = { 'Pendiente': 0, 'Retirado del depósito': 15, 'Verificado': 30, 'Listo para despacho': 45, 'Enviado': 60 };
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
  if (!total) return { porcentaje: 0, listos: 0, total: 0 };
  let listos = 0, sumaPorcentajes = 0;
  equipos.forEach((eq) => {
    let pct = 0;
    if (eq.nro_serie && String(eq.nro_serie).trim()) pct += 20;
    if (eq.calidad_verificada === true) pct += 20;
    pct += ESCALON_ESTADO_ST[eq.estado] || 0;
    if (pct > 100) pct = 100;
    if (pct === 100) listos++;
    sumaPorcentajes += pct;
  });
  return { porcentaje: Math.round(sumaPorcentajes / total), listos, total };
}

async function actualizarProgresoSTEnNegocio(ticket) {
  try {
    if (!ticket || !ticket.negocio_id) return;
    const progreso = calcularProgresoST(ticket.equipos);
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
  const foto = String(data.foto || '').trim();
  const campo = ST_CAMPOS_FOTOS.includes(data.campo) ? data.campo : 'fotos';
  if (!id) return { ok: false, error: 'Falta id_ticket' };
  if (!foto) return { ok: false, error: 'Falta foto' };
  if (!(await fbGet('servicio_tecnico/' + id))) return { ok: false, error: 'Ticket no encontrado: ' + id };
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
  let errorValidacion = null;
  const ticket = await runTransaccionTicket(id, (t) => {
    const fotos = comoArray(t[campo]);
    if (indice < 0 || indice >= fotos.length) { errorValidacion = 'Índice fuera de rango'; return t; }
    if (campo === 'fotos') {
      const bloqueadas = parseInt(t.fotos_bloqueadas) || 0;
      if (indice < bloqueadas) { errorValidacion = 'Esta foto se cargó en el ingreso del equipo y no se puede eliminar (queda como evidencia).'; return t; }
    }
    fotos.splice(indice, 1);
    t[campo] = fotos;
    t.actualizado_en = new Date().toISOString();
    return t;
  });
  if (errorValidacion) return { ok: false, error: errorValidacion };
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

const ACCIONES = {
  marcarNegocioUrgente, marcarTarjetaUrgenteEv, st_crearOrdenPreparacion,
  st_crearTicket, st_duplicarTicket, st_eliminarTicket,
  st_actualizarCampo, st_actualizarDeposito, st_actualizarNotas, st_actualizarGastos,
  st_agregarNota, st_agregarFoto, st_eliminarFoto,
  st_agregarMensaje, st_editarMensaje, st_borrarMensaje, st_reaccionarMensaje,
  st_separarEquipoOrden, st_actualizarEquipoOrden,
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
