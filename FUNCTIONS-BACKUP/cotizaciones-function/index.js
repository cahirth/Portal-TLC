// Portal TLC | Cloud Function — módulo Cotizaciones
// v2 — 2026.10.01 — Cristian: "no quiero que se cambie solo de dueño...
//   porque se editó". guardarPresupuestoEditor ya no pisa el vendedor de
//   un negocio existente (solo lo asigna si es nuevo o no tiene dueño), y
//   el presupuesto guardado muestra al dueño real del negocio. Complementa
//   el arreglo del frontend (presupuesto-editor.html v2026.09.30.1).
// v1 — 2026.09.29
//
// Cristian: "vayamos de a poco... función por función... podemos
// avanzar en alguna función de cotizaciones? ej, guardar presupuesto
// editor, encaremos el punto 4.1". Cotizaciones como módulo entero
// sigue marcado "no conviene migrar todavía" en PLAN-MIGRACION.md
// (la mayoría de sus 17 acciones restantes siguen atadas a
// historico.json/GitHub) — pero guardarPresupuestoEditor específicamente
// YA es 100% Firebase en sus 3 ramas desde el arreglo de velocidad
// del 29/09 (FotoMap.gs v226) — no arrastra ese problema, así que
// migrarla sola, aparte del resto del módulo, es seguro.
//
// Primera acción de esta Cloud Function nueva — las próximas acciones
// de Cotizaciones que se vayan resolviendo (función por función) se
// suman acá.
//
// LECCIÓN APLICADA: guardarPresupuestoEditor empuja una nueva versión
// al array versiones_presupuesto del negocio — mismo patrón de
// lectura-modificación-escritura que ya causó la condición de carrera
// de Eventos/Servicio. Acá se usa transacción atómica sobre el
// negocio completo, no solo un get-then-patch.
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

function rtdbKeySeguro(id) {
  let clave = String(id || '').trim().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (clave.length > 200) clave = clave.substring(0, 200);
  return clave;
}

// Transacción atómica sobre un negocio — mismo patrón ya probado en
// Eventos/Servicio (runTransaccionTarjeta/runTransaccionTicket).
async function runTransaccionNegocio(idRtdb, fn) {
  const ruta = 'cotizaciones/' + idRtdb;
  const resultado = await db.ref(ruta).transaction((actual) => fn(actual));
  if (!resultado.committed) throw new Error('No se pudo guardar (conflicto de escrituras) — probá de nuevo');
  return resultado.snapshot.val();
}

function generarIdCotizacion() {
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return 'TLC-' + fecha + '-' + rand;
}

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

function generarNombreNegocio(razonSocial, carrito) {
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const ahora = new Date();
  const mesAno = MESES[ahora.getMonth()] + ' ' + ahora.getFullYear();
  const empresa = String(razonSocial || '').trim() || 'Sin empresa';
  const items = (Array.isArray(carrito) ? carrito : []).filter((it) => it && String(it.nombre || '').trim());
  let parteEquipo;
  if (!items.length) parteEquipo = 'Consulta General';
  else {
    const primero = nombreBaseEquipo(items[0].nombre);
    const extras = items.length - 1;
    parteEquipo = extras > 0 ? (primero + ' (+' + extras + ')') : primero;
  }
  return empresa + ' - ' + parteEquipo + ' - ' + mesAno;
}

async function stAgregarPresupuestoAlTicket(ticketId, entrada) {
  await db.ref('servicio_tecnico/' + ticketId).transaction((ticket) => {
    if (ticket === null) return ticket;
    const historial = Array.isArray(ticket.presupuestos) ? ticket.presupuestos : [];
    const nroVersion = historial.length + 1;
    historial.push({ version: nroVersion, idCot: entrada.idCot, fecha: entrada.fecha, monto: entrada.monto, moneda: entrada.moneda || 'USD', link: entrada.link });
    ticket.presupuestos = historial;
    ticket.presupuesto_link = entrada.link;
    ticket.actualizado_en = new Date().toISOString();
    return ticket;
  });
}

async function guardarPresupuestoEditor(data) {
  const idCot = String(data.idNegocio || data.presupuestoIdPreview || '').trim() || generarIdCotizacion();
  const razonSocial = String(data.razonSocial || '').trim();
  const cuit = String(data.cuit || '').trim();
  const telefono = String(data.telefono || '').trim();
  const domicilio = String(data.domicilio || '').trim();
  const vendedor = String(data.vendedor || '').trim();
  const moneda = String(data.moneda || 'USD').trim();
  const tcOficial = data.tcOficial ? parseFloat(data.tcOficial) : null;
  const soloRegistrarNegocio = !!data.soloRegistrarNegocio;
  const itemsRaw = Array.isArray(data.items) ? data.items : [];
  const carrito = itemsRaw.map((it) => {
    const precio = parseFloat(it.precio) || 0;
    const cantidad = parseInt(it.cantidad, 10) || 1;
    const descuentoValor = Math.max(0, parseFloat(it.descuento) || 0);
    const descuentoTipo = (it.descuentoTipo === 'USD') ? 'USD' : '%';
    const ivaPct = (it.iva !== undefined && it.iva !== null && it.iva !== '') ? parseFloat(it.iva) : 10.5;
    const bruto = precio * cantidad;
    const conDescuentoTotal = descuentoTipo === 'USD' ? Math.max(0, bruto - descuentoValor) : bruto * (1 - descuentoValor / 100);
    const precioNeto = Math.round((conDescuentoTotal / cantidad) * 100) / 100;
    return {
      nombre: String(it.nombre || '').trim(), precioLista: precio, precioContado: parseFloat(it.precioContado) || precio,
      descuentoTipo, descuentoValor, precioNeto, cantidad, ivaPct, moneda: String(it.moneda || 'USD').trim(),
      foto: it.foto || '', linkFolleto: it.linkFolleto || '', linkVideo: it.linkVideo || '',
    };
  });
  let subtotalNeto = 0, ivaTotal = 0;
  carrito.forEach((it) => { const lineaNeta = it.precioNeto * it.cantidad; subtotalNeto += lineaNeta; ivaTotal += lineaNeta * (it.ivaPct || 0) / 100; });
  subtotalNeto = Math.round(subtotalNeto * 100) / 100;
  ivaTotal = Math.round(ivaTotal * 100) / 100;
  const totalConIva = Math.round((subtotalNeto + ivaTotal) * 100) / 100;
  const condicionesComerciales = {
    formaPago: String(data.formaPago || '').trim(), validez: String(data.validez || '').trim(),
    validezFecha: String(data.validezFecha || '').trim(), tiempoEntrega: String(data.tiempoEntrega || '').trim(),
    tiempoEntregaCustom: String(data.tiempoEntregaCustom || '').trim(), lugarEntrega: String(data.lugarEntrega || '').trim(),
    notas: String(data.notas || '').trim(),
  };

  // ── Rama 1: presupuesto vinculado a un ticket de Servicio (sin negocio en Ventas) ──
  const ticketVinculado = String(data.ticket || '').trim();
  if (ticketVinculado) {
    const fechaISO = new Date().toISOString();
    const ticketActual = await fbGet('servicio_tecnico/' + ticketVinculado);
    if (!ticketActual) return { ok: false, error: 'Ticket no encontrado: ' + ticketVinculado };
    const nroVersion = (Array.isArray(ticketActual.presupuestos) ? ticketActual.presupuestos.length : 0) + 1;
    const presupuestoData = {
      idCot, fecha: fechaISO, vendedor,
      nombreMedico: data.contactoNombre || ticketActual.nombre_medico || '', contactoTelefono: data.contactoTelefono || '',
      razonSocial: razonSocial || ticketActual.cliente || '', cuit, telefono: telefono || ticketActual.telefono || '',
      domicilio: domicilio || ticketActual.domicilio || '', carrito,
      formaPago: condicionesComerciales.formaPago, validez: condicionesComerciales.validez,
      validezFecha: condicionesComerciales.validezFecha, tiempoEntrega: condicionesComerciales.tiempoEntrega,
      tiempoEntregaCustom: condicionesComerciales.tiempoEntregaCustom, lugarEntrega: condicionesComerciales.lugarEntrega,
      notas: condicionesComerciales.notas, monedaTotales: moneda, tcOficial,
      modalidadPago: data.modalidadPago || null, ticketId: ticketVinculado,
      totales: { subtotal_neto: subtotalNeto, iva_total: ivaTotal, total_con_iva: totalConIva },
    };
    await fbSet('cotizaciones/' + rtdbKeySeguro(idCot) + '/presupuesto', presupuestoData);
    await fbSet('cotizaciones/' + rtdbKeySeguro(idCot) + '/historial_versiones/v' + nroVersion, presupuestoData);
    const montoParaHistorial = (moneda === 'ARS' && tcOficial) ? Math.round(totalConIva * tcOficial * 100) / 100 : totalConIva;
    await stAgregarPresupuestoAlTicket(ticketVinculado, {
      idCot, fecha: fechaISO, monto: montoParaHistorial, moneda,
      link: 'https://ir.tlcsrl.com.ar/presupuesto.html?id=' + encodeURIComponent(idCot) + '&ticket=' + encodeURIComponent(ticketVinculado),
    });
    return { ok: true, idCot, ticketVinculado, nroVersion };
  }

  // ── Rama 2 y 3: negocio de Ventas (soloRegistrarNegocio, o con versión de presupuesto) ──
  const idRtdb = rtdbKeySeguro(idCot);
  const fechaISO = new Date().toISOString();
  let esNuevo = false;
  let nroVersion = null;
  const entradaFinal = await runTransaccionNegocio(idRtdb, (actual) => {
    esNuevo = actual === null;
    const entrada = esNuevo
      ? { idCot, id: idCot, fecha: fechaISO, fechaCreacion: fechaISO, nombreNegocio: '', vendedor, estado: '50%', notas_papiro: [], contacto: {}, empresa: {} }
      : actual;
    entrada.razonSocial = razonSocial || entrada.razonSocial || '';
    entrada.cuit = cuit || entrada.cuit || '';
    entrada.telefono = telefono || entrada.telefono || '';
    entrada.domicilio = domicilio || entrada.domicilio || '';
    entrada.empresa = { razonSocial: entrada.razonSocial, cuit: entrada.cuit };
    entrada.empresaId = data.empresaId || entrada.empresaId || '';
    if (data.contactoNombre) {
      entrada.contacto = { nombre: data.contactoNombre, email: data.contactoEmail || '', telefono: data.contactoTelefono || '' };
      entrada.contactoId = data.contactoId || '';
    }
    if (Array.isArray(data.contactosAdicionales)) {
      entrada.contactosAdicionales = data.contactosAdicionales
        .map((ct) => ({ id: String(ct.id || '').trim(), nombre: String(ct.nombre || '').trim(), email: String(ct.email || '').trim(), telefono: String(ct.telefono || '').trim() }))
        .filter((ct) => ct.nombre);
    }
    // DUEÑO DEL NEGOCIO (v2): editar NUNCA cambia el vendedor. Solo se
    // asigna en un negocio nuevo o si el existente no tiene dueño.
    // Reasignar es exclusivo del Administrador, por reasignarVendedor.
    if (vendedor && (esNuevo || !entrada.vendedor)) entrada.vendedor = vendedor;
    entrada.carrito = carrito;
    entrada.nombreNegocio = generarNombreNegocio(entrada.razonSocial, carrito);
    entrada.montoUSD = totalConIva;
    entrada.totales = { subtotal_neto: subtotalNeto, iva_total: ivaTotal, total_con_iva: totalConIva };
    entrada.condicionesComerciales = condicionesComerciales;
    entrada.monedaTotales = moneda;
    entrada.tcOficial = tcOficial;
    if (data.modalidadPago !== undefined) entrada.modalidadPago = data.modalidadPago || null;
    if (data.pipeline_id !== undefined) entrada.pipeline_id = data.pipeline_id === 'GENERAL' ? '' : String(data.pipeline_id || '').trim();
    if (esNuevo || entrada.estado === '10%') entrada.estado = '50%';
    if (!soloRegistrarNegocio) {
      if (!Array.isArray(entrada.versiones_presupuesto)) entrada.versiones_presupuesto = [];
      nroVersion = entrada.versiones_presupuesto.length + 1;
      entrada.versiones_presupuesto.push({ version: nroVersion, fecha: fechaISO, monto_neto: subtotalNeto, total_iva: totalConIva, link: null, carrito });
    }
    entrada.actualizado_en = fechaISO;
    return entrada;
  });

  if (!soloRegistrarNegocio) {
    try {
      const presupuestoData = {
        idCot, fecha: fechaISO, vendedor: entradaFinal.vendedor || vendedor, nombreMedico: data.contactoNombre || '',
        contactoTelefono: data.contactoTelefono || (entradaFinal.contacto && entradaFinal.contacto.telefono) || '',
        razonSocial: entradaFinal.razonSocial, cuit: entradaFinal.cuit, telefono: entradaFinal.telefono, domicilio: entradaFinal.domicilio,
        carrito, formaPago: condicionesComerciales.formaPago, validez: condicionesComerciales.validez,
        validezFecha: condicionesComerciales.validezFecha, tiempoEntrega: condicionesComerciales.tiempoEntrega,
        tiempoEntregaCustom: condicionesComerciales.tiempoEntregaCustom, lugarEntrega: condicionesComerciales.lugarEntrega,
        notas: condicionesComerciales.notas, monedaTotales: moneda, tcOficial, modalidadPago: data.modalidadPago || null,
        ticketId: String(data.ticket || '').trim(), totales: { subtotal_neto: subtotalNeto, iva_total: ivaTotal, total_con_iva: totalConIva },
      };
      await fbSet('cotizaciones/' + idRtdb + '/presupuesto', presupuestoData);
      await fbSet('cotizaciones/' + idRtdb + '/historial_versiones/v' + nroVersion, presupuestoData);
    } catch (efb) {
      console.warn('RTDB push de /presupuesto y /historial_versiones falló (no crítico):', efb.message);
    }
  }
  return { ok: true, idCot, nuevo: esNuevo, entrada: entradaFinal };
}

const ACCIONES = { guardarPresupuestoEditor };

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('cotizaciones', async (req, res) => {
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
    console.error('Error en función cotizaciones:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
