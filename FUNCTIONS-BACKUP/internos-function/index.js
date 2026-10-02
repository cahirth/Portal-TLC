// Portal TLC | Cloud Function — módulo Internos
// v3 — 2026.09.29
//
// Resuelve DE RAÍZ el problema real que reportó Cristian: en Servicio
// Técnico, las menciones (@) a veces no aparecían y el envío se
// sentía lentísimo — no por nada relacionado con el envío del mensaje
// en sí (eso ya estaba migrado y anda rápido), sino porque la lista
// de gente para @mencionar (listarInternos) dependía de Apps Script,
// que sigue siendo "realmente impredecible". Además tenía un bug de
// caché en el frontend: si ese pedido fallaba una vez, la lista
// quedaba vacía para siempre en esa sesión, sin volver a intentarlo
// — de ahí el "a veces aparece, a veces no".
//
// La buena noticia: "Internos" NO es una hoja aparte — es la MISMA
// hoja "Vendedores" que Cristian ya sincroniza a Firebase con su
// propio botón (sincronizarPermisosAFirebase, nodo "permisos"),
// filtrada por su columna "Internos". No hizo falta ninguna decisión
// nueva sobre Sheets ni ninguna pantalla nueva — el dato ya estaba
// en Firebase, solo hacía falta leerlo de ahí en vez de ir a Apps
// Script cada vez.
//
// Usada por 4 archivos: servicio.html, eventos.html, cotizaciones.html,
// cuenta-corriente.html — todos van a esta misma función.
//
// v2 — Cristian: "vayamos de a poco, y si es necesario, función por
// función". Se agregó calcularComisiones (comisiones.html) — mismo
// criterio: confirmada 100% portable sin tocar Sheets (usa permisos,
// precios y cotizaciones, todo ya en Firebase). guardarComisionManual
// (la otra acción de ese archivo) queda en Apps Script a propósito,
// para una próxima vuelta.
//
// v3 — Esa "próxima vuelta": se agregó guardarComisionManual. Con
// esto, comisiones.html queda 100% migrado, las 3 acciones fuera de
// Apps Script.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();

async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}
async function fbPatch(path, fields) { await db.ref(path).update(fields); return fields; }

function rtdbKeySeguro(id) {
  let clave = String(id || '').trim().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
  if (clave.length > 200) clave = clave.substring(0, 200);
  return clave;
}

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function esVerdadero(v) {
  const t = normalizarTexto(v);
  return t === 'true' || t === 'verdadero' || t === 'si' || t === '1' || v === true;
}

async function listarInternos() {
  const permisos = (await fbGet('permisos')) || {};
  const internos = Object.values(permisos)
    .filter((p) => esVerdadero(p.Internos))
    .map((p) => ({ nombre: String(p.Nombre_Vendedor || p.Nombre || '').trim(), email: String(p.Email || '').trim() }))
    .filter((p) => p.nombre && p.email);
  return { ok: true, internos };
}

// Cristian: "vayamos de a poco... función por función". Segunda
// acción de este módulo — calcularComisiones (comisiones.html).
// Confirmada 100% portable, sin necesitar Sheets para nada: usa
// permisos (mismo nodo que listarInternos, ya sincronizado) para
// saber quién es interno, precios (ya sincronizado por
// sincronizarPreciosAFirebase) para el % de comisión por equipo, y
// cotizaciones (Firebase nativo) para los negocios ganados — ningún
// dato nuevo que sincronizar, ninguna decisión pendiente sobre Sheets
// que resolver.
async function calcularComisiones(data) {
  const desdeTs = data.desde ? new Date(data.desde + 'T00:00:00').getTime() : null;
  const hastaTs = data.hasta ? new Date(data.hasta + 'T23:59:59').getTime() : null;

  const permisos = (await fbGet('permisos')) || {};
  const nombresInternos = {};
  Object.values(permisos).forEach((p) => {
    if (esVerdadero(p.Internos)) {
      const nombre = normalizarTexto(p.Nombre_Vendedor || p.Nombre || '');
      if (nombre) nombresInternos[nombre] = true;
    }
  });

  const catalogoRaw = (await fbGet('precios')) || {};
  const comisionPorEquipo = {};
  Object.values(catalogoRaw).forEach((fila) => {
    const nombreEq = normalizarTexto(fila['Nombre de Dispositivo']);
    const pct = parseFloat(fila['COMISIONES']);
    if (nombreEq && !isNaN(pct)) comisionPorEquipo[nombreEq] = pct;
  });

  const cotizacionesRaw = (await fbGet('cotizaciones')) || {};
  const negocios = Object.values(cotizacionesRaw).filter((v) => v && typeof v === 'object');
  const porVendedor = {};

  negocios.forEach((neg) => {
    if (neg.estado !== 'Ganada') return;
    const tsRaw = neg.actualizado_en || neg.fechaCreacion || neg.fecha;
    const ts = tsRaw ? new Date(tsRaw).getTime() : null;
    if (desdeTs && (!ts || ts < desdeTs)) return;
    if (hastaTs && (!ts || ts > hastaTs)) return;

    const vendedorNombre = String(neg.vendedor || '').trim() || 'Sin vendedor';
    const esInterno = !!nombresInternos[normalizarTexto(vendedorNombre)];
    const netoTotal = parseFloat((neg.totales || {}).subtotal_neto) || parseFloat(neg.montoUSD) || 0;

    let comisionCalculada = 0;
    if (esInterno) {
      comisionCalculada = Math.round(netoTotal * 0.01 * 100) / 100;
    } else {
      const carrito = Array.isArray(neg.carrito) ? neg.carrito : [];
      carrito.forEach((it) => {
        const nombreItem = normalizarTexto(it.nombre);
        const pct = comisionPorEquipo[nombreItem];
        if (pct === undefined) return; // equipo sin % de comisión cargado — no suma, no rompe
        const neto = (it.precioNeto != null ? parseFloat(it.precioNeto) : parseFloat(it.precioLista)) || 0;
        const cant = parseFloat(it.cantidad) || 1;
        comisionCalculada += neto * cant * (pct / 100);
      });
      comisionCalculada = Math.round(comisionCalculada * 100) / 100;
    }

    const idCot = String(neg.idCot || neg.id_cotizacion || neg.id || '').trim();
    const tieneOverride = neg.comision_override !== undefined && neg.comision_override !== null && neg.comision_override !== '';
    const comisionFinal = tieneOverride ? parseFloat(neg.comision_override) : comisionCalculada;

    if (!porVendedor[vendedorNombre]) porVendedor[vendedorNombre] = { vendedor: vendedorNombre, esInterno, totalComision: 0, negocios: [] };
    porVendedor[vendedorNombre].totalComision = Math.round((porVendedor[vendedorNombre].totalComision + comisionFinal) * 100) / 100;
    porVendedor[vendedorNombre].negocios.push({
      idCot, razonSocial: neg.razonSocial || (neg.empresa && neg.empresa.razonSocial) || '',
      fecha: tsRaw || '', montoUSD: netoTotal,
      comisionCalculada, comisionOverride: tieneOverride ? parseFloat(neg.comision_override) : null,
      comisionFinal: Math.round(comisionFinal * 100) / 100,
    });
  });

  const vendedores = Object.values(porVendedor).sort((a, b) => b.totalComision - a.totalComision);
  return { ok: true, vendedores };
}

// Tercera acción de este módulo (comisiones.html) — carga o borra el
// override manual de comisión de un negocio puntual. 100% Firebase.
async function guardarComisionManual(data) {
  const idCot = String(data.idCot || '').trim();
  if (!idCot) return { ok: false, error: 'Falta idCot' };
  const idRtdb = rtdbKeySeguro(idCot);
  if (!(await fbGet('cotizaciones/' + idRtdb))) return { ok: false, error: 'Negocio no encontrado: ' + idCot };
  const valorRaw = data.comisionManual;
  const esVaciar = valorRaw === null || valorRaw === undefined || valorRaw === '';
  if (esVaciar) {
    await fbPatch('cotizaciones/' + idRtdb, { comision_override: null });
  } else {
    const valor = parseFloat(valorRaw);
    if (isNaN(valor)) return { ok: false, error: 'El monto de comisión no es un número válido' };
    await fbPatch('cotizaciones/' + idRtdb, { comision_override: valor });
  }
  return { ok: true };
}

const ACCIONES = { listarInternos, calcularComisiones, guardarComisionManual };

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('internos', async (req, res) => {
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
    console.error('Error en función internos:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
