// Portal TLC | Cloud Function — Cuenta Corriente y Rendición de Gastos
// v4 — 2026.10.08 — 💸 Gastos de Ventas: cc_gastosOrigenes también devuelve
//   los gastos de los negocios (cotizaciones/<id>/gastos, origen "venta"), y
//   crearLiquidacion / revertirLiquidacion los marcan y desmarcan igual que
//   los de Servicio y Eventos.
// v3 — 2026.10.05 — Los gastos en pesos se liquidan con el TC del día en que se
//   cargaron (tc_al_cargar), no con el de hoy. Gastos generales guardan su TC.
// v2 — 2026.10.05 — eliminarGastoGeneral (borrar un gasto pendiente).
// v1 — 2026.10.04 — MUERTE A APPS SCRIPT (Fase 4)
//
// Cristian: "vamos con cuenta corriente". Porta de FotoMap.gs las 8
// acciones del módulo (listarGastosGeneralesPendientes, agregarGastoGeneral,
// editarGastoGeneral, crearLiquidacion, listarLiquidaciones,
// revertirLiquidacion, obtenerSaldoInicial, guardarSaldoInicial) con la
// misma lógica y las mismas validaciones, y agrega:
//
// - cc_gastosOrigenes: devuelve SOLO los gastos de Servicio Técnico y de
//   las tarjetas de Eventos (con los datos mínimos para mostrarlos). Antes
//   el celular descargaba servicio_tecnico.json completo (~11 MB por las
//   fotos) y eventos.json completo para quedarse con los gastos. Ahora esa
//   lectura pesada la hace la función adentro de Google, y al celular le
//   llegan unos pocos KB.
// - Escrituras atómicas (transacciones de Firebase) al marcar gastos como
//   pagados o al revertir: si dos personas tocan la misma tarjeta a la vez,
//   no se pisan (lección 5 del plan).
//
// Seguridad: igual que en Apps Script, los permisos llegan del frontend
// (solicitante_es_admin = tilde "Liquidar Gastos"; solicitante_es_interno =
// tilde "Internos"), que los lee de Firebase en cada apertura.

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
function normalizarNombre(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function comoArray(v) { return Array.isArray(v) ? v : (v ? Object.values(v) : []); }

function fechaHoyAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function generarId(prefijo) {
  return prefijo + '-' + fechaHoyAR().replace(/-/g, '') + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

async function obtenerTCOficial() {
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/oficial');
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d.venta) || null;
  } catch (e) { console.warn('obtenerTCOficial:', e.message); return null; }
}

// ── NUEVA: solo los gastos de Servicio y Eventos ────────────────────
// Devuelve las tarjetas que tienen al menos un gasto, con el array de
// gastos COMPLETO (el frontend lo necesita para editar/agregar sin pisar
// los de otros) y solo los datos que muestra Cuenta Corriente.
async function cc_gastosOrigenes() {
  const [st, ev, cots] = await Promise.all([fbGet('servicio_tecnico'), fbGet('eventos'), fbGet('cotizaciones')]);
  const servicio = {};
  Object.keys(st || {}).forEach((id) => {
    const t = st[id];
    if (!t || !t.gastos) return;
    const gastos = comoArray(t.gastos);
    if (!gastos.length) return;
    servicio[id] = { id_ticket: t.id_ticket || id, cliente: t.cliente || '', equipo_modelo: t.equipo_modelo || '', gastos };
  });
  const eventos = {};
  Object.keys(ev || {}).forEach((idEvento) => {
    const e = ev[idEvento];
    if (!e || !e.tarjetas) return;
    const tarjetas = {};
    Object.keys(e.tarjetas).forEach((k) => {
      const t = e.tarjetas[k];
      if (!t || !t.gastos) return;
      const gastos = comoArray(t.gastos);
      if (!gastos.length) return;
      tarjetas[k] = { id: t.id || '', titulo: t.titulo || '', gastos };
    });
    if (Object.keys(tarjetas).length) eventos[idEvento] = { nombre: e.nombre || '', tarjetas };
  });
  // v4: gastos de los negocios de Ventas
  const ventas = {};
  Object.keys(cots || {}).forEach((key) => {
    const c = cots[key];
    if (!c || !c.gastos) return;
    const gastos = comoArray(c.gastos);
    if (!gastos.length) return;
    const cliente = c.razonSocial || (c.empresa && c.empresa.razonSocial) || (c.cliente && c.cliente.nombre) || c.nombreMedico || '';
    ventas[key] = { id_cot: c.idCot || c.id_cotizacion || key, cliente, vendedor: c.vendedor || '', gastos };
  });
  return { ok: true, servicio, eventos, ventas };
}

// ── Gastos generales ────────────────────────────────────────────────
async function listarGastosGeneralesPendientes(data) {
  const aFavorDe = String(data.a_favor_de || '').trim();
  if (!aFavorDe) return { ok: false, error: 'Falta a_favor_de' };
  const solicitanteEmail = String(data.solicitante_email || '').trim().toLowerCase();
  const aFavorDeEmail = String(data.a_favor_de_email || aFavorDe).trim().toLowerCase();
  if (data.solicitante_es_interno !== true && solicitanteEmail !== aFavorDeEmail) {
    return { ok: false, error: 'No tenés permiso para ver los gastos generales de otro usuario' };
  }
  const objetivo = normalizarNombre(aFavorDe);
  const todos = (await fbGet('gastos_generales')) || {};
  const gastos = Object.values(todos).filter((g) => g && normalizarNombre(g.a_favor_de) === objetivo && g.estado === 'PENDIENTE');
  gastos.sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')));
  return { ok: true, gastos };
}

async function agregarGastoGeneral(data) {
  const aFavorDe = String(data.a_favor_de || '').trim();
  if (!aFavorDe) return { ok: false, error: 'Falta a_favor_de (a quién pertenece el gasto)' };
  const id = generarId('GG');
  const gasto = {
    id, fecha: String(data.fecha || '').trim() || fechaHoyAR(), descripcion: String(data.descripcion || '').trim(),
    importe: parseFloat(data.importe) || 0, moneda: data.moneda === 'ARS' ? 'ARS' : 'USD', tc_al_cargar: parseFloat(data.tc_al_cargar) || null,
    creado_por: String(data.creado_por || '').trim(), creado_en: new Date().toISOString(), a_favor_de: aFavorDe, estado: 'PENDIENTE',
  };
  await fbSet('gastos_generales/' + id, gasto);
  return { ok: true, gasto };
}

async function editarGastoGeneral(data) {
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const ruta = 'gastos_generales/' + id;
  const gasto = await fbGet(ruta);
  if (!gasto) return { ok: false, error: 'Gasto no encontrado: ' + id };
  if (gasto.estado === 'PAGADO') return { ok: false, error: 'Este gasto ya fue liquidado — no se puede modificar.' };
  const campos = {};
  ['fecha', 'descripcion', 'moneda'].forEach((c) => { if (data[c] !== undefined) campos[c] = String(data[c]).trim(); });
  if (data.importe !== undefined) campos.importe = parseFloat(data.importe) || 0;
  if (data.tc_al_cargar !== undefined && !gasto.tc_al_cargar) campos.tc_al_cargar = parseFloat(data.tc_al_cargar) || null;
  if (data.a_favor_de !== undefined && String(data.a_favor_de).trim()) {
    if (data.solicitante_es_interno !== true) return { ok: false, error: 'Solo usuarios Internos pueden reasignar el beneficiario de un gasto.' };
    const nombre = String(data.a_favor_de).trim();
    campos.a_favor_de = nombre;
    campos.creado_por = gasto.creado_por || nombre;
  }
  await fbPatch(ruta, campos);
  return { ok: true };
}

// v2 — 2026.10.05 — Cristian: "en Cuenta Corriente, ¿podemos implementar
// borrar o eliminar ítem de gasto?". Borra un gasto general PENDIENTE (uno
// ya liquidado no se puede borrar: hay que revertir la liquidación antes).
// Puede borrarlo quien lo cargó o quien tiene el tilde "Liquidar Gastos".
async function eliminarGastoGeneral(data) {
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const ruta = 'gastos_generales/' + id;
  const gasto = await fbGet(ruta);
  if (!gasto) return { ok: false, error: 'Gasto no encontrado (puede que ya se haya borrado)' };
  if (gasto.estado === 'PAGADO') return { ok: false, error: 'Este gasto ya fue liquidado — para borrarlo primero hay que deshacer la liquidación.' };
  const solicitante = normalizarNombre(data.solicitante_nombre);
  if (data.solicitante_es_admin !== true && (!solicitante || solicitante !== normalizarNombre(gasto.creado_por))) {
    return { ok: false, error: 'Solo puede borrarlo quien lo cargó o alguien con el tilde "Liquidar Gastos".' };
  }
  await db.ref(ruta).remove();
  return { ok: true };
}

// ── Saldo inicial ───────────────────────────────────────────────────
const SALDO_VACIO = { monto_ars: 0, monto_usd: 0, fecha_corte: '', estado: 'PAGADO' };
async function obtenerSaldoInicial(data) {
  const email = String(data.usuario_email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Falta usuario_email' };
  const solicitanteEmail = String(data.solicitante_email || '').trim().toLowerCase();
  if (data.solicitante_es_interno !== true && solicitanteEmail !== email) {
    return { ok: false, error: 'No tenés permiso para ver el saldo inicial de otro usuario' };
  }
  const saldo = await fbGet('saldo_inicial/' + rtdbKeySeguro(email));
  return { ok: true, saldo_inicial: saldo || SALDO_VACIO };
}

async function guardarSaldoInicial(data) {
  if (data.solicitante_es_interno !== true) return { ok: false, error: 'No tenés permiso para cargar el saldo inicial (solo usuarios Internos).' };
  const email = String(data.usuario_email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Falta usuario_email' };
  const montoArs = parseFloat(data.monto_ars) || 0, montoUsd = parseFloat(data.monto_usd) || 0;
  await fbSet('saldo_inicial/' + rtdbKeySeguro(email), {
    monto_ars: montoArs, monto_usd: montoUsd, fecha_corte: String(data.fecha_corte || '').trim(),
    estado: (montoArs === 0 && montoUsd === 0) ? 'PAGADO' : 'PENDIENTE',
  });
  return { ok: true };
}

// ── Liquidaciones ───────────────────────────────────────────────────
async function listarLiquidaciones(data) {
  const beneficiarioEmail = String(data.usuario_email || '').trim().toLowerCase();
  if (!beneficiarioEmail) return { ok: false, error: 'Falta usuario_email' };
  const solicitanteEmail = String(data.solicitante_email || '').trim().toLowerCase();
  if (data.solicitante_es_interno !== true && solicitanteEmail !== beneficiarioEmail) {
    return { ok: false, error: 'No tenés permiso para ver las liquidaciones de otro usuario' };
  }
  const todas = (await fbGet('liquidaciones')) || {};
  const liquidaciones = Object.values(todas).filter((l) => l && String(l.beneficiario_email || '').toLowerCase() === beneficiarioEmail);
  liquidaciones.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  return { ok: true, liquidaciones };
}

function rutaGastosOrigen(item) {
  if (item.origen_tipo === 'servicio') return 'servicio_tecnico/' + String(item.id_ticket || '').trim() + '/gastos';
  if (item.origen_tipo === 'evento') return 'eventos/' + String(item.id_evento || '').trim() + '/tarjetas/' + String(item.id_tarjeta || '').trim() + '/gastos';
  if (item.origen_tipo === 'venta') return 'cotizaciones/' + rtdbKeySeguro(String(item.id_cot || '').trim()) + '/gastos';
  return null;
}

async function crearLiquidacion(data) {
  if (data.solicitante_es_admin !== true) return { ok: false, error: 'No tenés permiso para liquidar gastos.' };
  const beneficiarioEmail = String(data.beneficiario_email || '').trim().toLowerCase();
  const beneficiarioNombre = String(data.beneficiario_nombre || '').trim();
  if (!beneficiarioEmail) return { ok: false, error: 'Falta beneficiario_email' };
  const fecha = String(data.fecha || '').trim();
  if (!fecha) return { ok: false, error: 'Falta la fecha de pago' };
  const medio = String(data.medio || '').trim();
  if (!medio) return { ok: false, error: 'Falta el medio de pago' };
  const items = Array.isArray(data.items) ? data.items : [];
  const incluyeSaldoInicial = (parseFloat(data.saldo_inicial_ars) > 0) || (parseFloat(data.saldo_inicial_usd) > 0);
  if (!items.length && !incluyeSaldoInicial) return { ok: false, error: 'No hay nada seleccionado para liquidar.' };

  // El tipo de cambio se pide UNA vez y antes de tocar nada: si falta y
  // hay gastos en pesos, se corta sin haber marcado nada como pagado.
  let tc = null;
  const idLiquidacion = generarId('PAY');
  let totalArs = 0, totalUsd = 0;
  const detalleItems = [];

  for (const item of items) {
    let g = null;
    const ruta = rutaGastosOrigen(item);
    if (ruta) {
      const idx = parseInt(item.gasto_index, 10);
      const previo = comoArray(await fbGet(ruta))[idx];
      if (!previo || previo.estado === 'PAGADO') continue; // borrado o ya pagado por otra vía
      if ((previo.moneda || 'USD') === 'ARS' && !parseFloat(previo.tc_al_cargar) && tc === null) {
        tc = await obtenerTCOficial();
        if (!tc) return { ok: false, error: 'No se pudo obtener el tipo de cambio oficial — no se pudo calcular el monto en pesos. Probá de nuevo en un momento.' };
      }
      // Transacción: lee el array actual, marca SOLO ese gasto, escribe.
      const r = await db.ref(ruta).transaction((actual) => {
        if (actual === null) return actual;
        const arr = comoArray(actual);
        if (!arr[idx] || arr[idx].estado === 'PAGADO') { g = null; return arr; }
        arr[idx].estado = 'PAGADO';
        arr[idx].liquidacion_id = idLiquidacion;
        g = Object.assign({}, arr[idx]);
        return arr;
      });
      if (!r.committed || !g) continue;
    } else if (item.origen_tipo === 'general') {
      const rutaGeneral = 'gastos_generales/' + String(item.id_gasto || '').trim();
      const previo = await fbGet(rutaGeneral);
      if (!previo || previo.estado === 'PAGADO') continue;
      if ((previo.moneda || 'USD') === 'ARS' && !parseFloat(previo.tc_al_cargar) && tc === null) {
        tc = await obtenerTCOficial();
        if (!tc) return { ok: false, error: 'No se pudo obtener el tipo de cambio oficial — no se pudo calcular el monto en pesos. Probá de nuevo en un momento.' };
      }
      const r = await db.ref(rutaGeneral).transaction((actual) => {
        if (!actual || actual.estado === 'PAGADO') { g = null; return actual; }
        actual.estado = 'PAGADO';
        actual.liquidacion_id = idLiquidacion;
        g = Object.assign({}, actual);
        return actual;
      });
      if (!r.committed || !g) continue;
    } else {
      continue;
    }

    const moneda = g.moneda || 'USD';
    const montoUSD = parseFloat(g.importe) || 0;
    // v3: un gasto en pesos se paga por lo que se cargó: TC del día de carga
    // (tc_al_cargar); el de hoy solo si el gasto no lo tiene guardado.
    const tcGasto = parseFloat(g.tc_al_cargar) || tc;
    const monto = moneda === 'ARS' ? Math.round(montoUSD * tcGasto * 100) / 100 : montoUSD;
    if (moneda === 'ARS') totalArs += monto; else totalUsd += monto;
    detalleItems.push({
      concepto: g.descripcion || '', fecha: g.fecha || '', moneda, monto, cargado_por: g.creado_por || '', origen_tipo: item.origen_tipo,
      origen_id: item.origen_tipo === 'servicio' ? String(item.id_ticket || '')
        : item.origen_tipo === 'venta' ? String(item.id_cot || '')
        : item.origen_tipo === 'evento' ? (String(item.id_evento || '') + '/' + String(item.id_tarjeta || ''))
        : String(item.id_gasto || ''),
      origen_label: String(item.origen_label || '').trim(),
    });
  }

  let saldoInicialDetalle = null;
  if (incluyeSaldoInicial) {
    const claveSaldo = 'saldo_inicial/' + rtdbKeySeguro(beneficiarioEmail);
    const saldoActual = await fbGet(claveSaldo);
    if (saldoActual) {
      const aArs = Math.min(parseFloat(data.saldo_inicial_ars) || 0, parseFloat(saldoActual.monto_ars) || 0);
      const aUsd = Math.min(parseFloat(data.saldo_inicial_usd) || 0, parseFloat(saldoActual.monto_usd) || 0);
      if (aArs > 0 || aUsd > 0) {
        saldoInicialDetalle = { ars: aArs, usd: aUsd };
        totalArs += aArs; totalUsd += aUsd;
        const nuevoArs = Math.max(0, (parseFloat(saldoActual.monto_ars) || 0) - aArs);
        const nuevoUsd = Math.max(0, (parseFloat(saldoActual.monto_usd) || 0) - aUsd);
        await fbPatch(claveSaldo, { monto_ars: nuevoArs, monto_usd: nuevoUsd, estado: (nuevoArs === 0 && nuevoUsd === 0) ? 'PAGADO' : 'PENDIENTE' });
      }
    }
  }

  if (totalArs === 0 && totalUsd === 0) {
    return { ok: false, error: 'No se liquidó nada — puede que todo lo seleccionado ya estuviera pagado por otra vía.' };
  }

  const liquidacion = {
    id: idLiquidacion, fecha, medio, referencia: String(data.referencia || '').trim(),
    monto_ars: totalArs, monto_usd: totalUsd, beneficiario_email: beneficiarioEmail, beneficiario_nombre: beneficiarioNombre,
    detalle_items: detalleItems, saldo_inicial_detalle: saldoInicialDetalle,
    comprobante_nombre: String(data.comprobante_nombre || '').trim(), comprobante_url: String(data.comprobante_url || '').trim(),
    creado_por_email: String(data.creado_por_email || '').trim(), creado_por_nombre: String(data.creado_por_nombre || '').trim(),
    creado_en: new Date().toISOString(),
  };
  await fbSet('liquidaciones/' + idLiquidacion, liquidacion);
  return { ok: true, liquidacion };
}

async function revertirLiquidacion(data) {
  if (data.solicitante_es_admin !== true) return { ok: false, error: 'No tenés permiso para revertir liquidaciones.' };
  const idLiquidacion = String(data.id_liquidacion || '').trim();
  if (!idLiquidacion) return { ok: false, error: 'Falta id_liquidacion' };
  const liquidacion = await fbGet('liquidaciones/' + idLiquidacion);
  if (!liquidacion) return { ok: false, error: 'No se encontró la liquidación: ' + idLiquidacion };
  const detalleItems = Array.isArray(liquidacion.detalle_items) ? liquidacion.detalle_items : [];

  // 1) Verificar ANTES de tocar nada que cada gasto siga existiendo y
  //    marcado con esta liquidación (mismo criterio que Apps Script: si
  //    falta uno, no se toca absolutamente nada).
  const necesarios = {}; // ruta de array -> cantidad de gastos de esta liquidación
  const generales = [];
  const noEncontrados = [];
  for (const item of detalleItems) {
    if (item.origen_tipo === 'servicio' || item.origen_tipo === 'evento' || item.origen_tipo === 'venta') {
      let ruta;
      if (item.origen_tipo === 'servicio') ruta = 'servicio_tecnico/' + String(item.origen_id || '').trim() + '/gastos';
      else if (item.origen_tipo === 'venta') ruta = 'cotizaciones/' + rtdbKeySeguro(String(item.origen_id || '').trim()) + '/gastos';
      else { const p = String(item.origen_id || '').split('/'); ruta = 'eventos/' + p[0] + '/tarjetas/' + p[1] + '/gastos'; }
      necesarios[ruta] = (necesarios[ruta] || 0) + 1;
    } else if (item.origen_tipo === 'general') {
      const rutaGeneral = 'gastos_generales/' + String(item.origen_id || '').trim();
      const g = await fbGet(rutaGeneral);
      if (g && g.liquidacion_id === idLiquidacion) generales.push(rutaGeneral);
      else noEncontrados.push(item);
    } else {
      noEncontrados.push(item);
    }
  }
  for (const ruta of Object.keys(necesarios)) {
    const marcados = comoArray(await fbGet(ruta)).filter((g) => g && g.liquidacion_id === idLiquidacion).length;
    if (marcados < necesarios[ruta]) noEncontrados.push({ concepto: '(' + (necesarios[ruta] - marcados) + ' gasto(s) en ' + ruta + ')' });
  }
  if (noEncontrados.length) {
    return { ok: false, error: 'No se encontró ' + noEncontrados.length + ' gasto(s) — no se tocó absolutamente nada (ni siquiera los que sí se encontraron). Detalle: ' + noEncontrados.map((n) => n.concepto || n.origen_id || '?').join(', ') };
  }

  // 2) Revertir, con transacción por tarjeta.
  let revertidos = 0;
  for (const ruta of Object.keys(necesarios)) {
    await db.ref(ruta).transaction((actual) => {
      if (actual === null) return actual;
      const arr = comoArray(actual);
      arr.forEach((g) => { if (g && g.liquidacion_id === idLiquidacion) { delete g.liquidacion_id; g.estado = 'PENDIENTE'; revertidos++; } });
      return arr;
    });
  }
  for (const rutaGeneral of generales) {
    await fbPatch(rutaGeneral, { estado: 'PENDIENTE', liquidacion_id: null });
    revertidos++;
  }
  if (liquidacion.saldo_inicial_detalle) {
    const claveSaldo = 'saldo_inicial/' + rtdbKeySeguro(String(liquidacion.beneficiario_email || '').trim().toLowerCase());
    const saldoActual = (await fbGet(claveSaldo)) || { monto_ars: 0, monto_usd: 0 };
    await fbPatch(claveSaldo, {
      monto_ars: (parseFloat(saldoActual.monto_ars) || 0) + (parseFloat(liquidacion.saldo_inicial_detalle.ars) || 0),
      monto_usd: (parseFloat(saldoActual.monto_usd) || 0) + (parseFloat(liquidacion.saldo_inicial_detalle.usd) || 0),
      estado: 'PENDIENTE',
    });
  }
  await db.ref('liquidaciones/' + idLiquidacion).remove();
  return { ok: true, revertidos };
}

const ACCIONES = {
  cc_gastosOrigenes, listarGastosGeneralesPendientes, agregarGastoGeneral, editarGastoGeneral, eliminarGastoGeneral,
  obtenerSaldoInicial, guardarSaldoInicial, listarLiquidaciones, crearLiquidacion, revertirLiquidacion,
};

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('cuentaCorriente', async (req, res) => {
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
    const handler = ACCIONES[data.accion];
    if (!handler) { res.status(400).json({ ok: false, error: 'Acción desconocida: ' + data.accion }); return; }
    res.status(200).json(await handler(data));
  } catch (e) {
    console.error('Error en función cuentaCorriente:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
