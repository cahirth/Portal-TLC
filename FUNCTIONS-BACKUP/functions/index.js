// ============================================================
// TLC — Asistente IA (Portal TLC) — Cloud Function v14 — 2026.08.03
// v14: log de diagnóstico ampliado — ahora muestra qué MODELO_GEMINI
//     está activo en cada request (no se podía saber mirando el log
//     si un deploy con cambio de modelo ya estaba corriendo o no) y
//     el tiempo TOTAL de la consulta completa (antes había que sumar
//     las vueltas a mano). Sin cambios de comportamiento, solo
//     visibilidad para diagnosticar velocidad.
// v13: (1) modelo actualizado a gemini-3.6-flash (era 3.5-flash) —
//     Google lo lanzó el 21/07/2026, usa menos pasos de razonamiento/
//     tool calls por tarea, directamente el cuello de botella real
//     que veníamos teniendo (loop de 2 vueltas, 8-11s cada una). (2)
//     corregida la redacción de la confirmación de navegarA — decía
//     "Abriendo..." como si ya hubiese pasado, pero desde el fix
//     anterior es un link clickeable, no automático. Reportado por
//     Cristian: "me dice que lo va a abrir... y no me lo abre, eso es
//     mentira".
// v12: reintento de 503 subido a 3 vueltas (era 2) con backoff más
//     largo (2s/4s/6s); mensaje de error más claro cuando el 503
//     persiste después de todos los reintentos ("Gemini está saturado
//     ... probá de nuevo en unos segundos" en vez de un genérico).
//     Reportado por Cristian con captura + log.
// v11: navegabilidad completa — nueva tool navegarA con 4 tipos:
//     ficha_tecnica (ficha-equipo.html?nombre=), negocio
//     (cotizaciones.html?id=), empresa (empresas.html?empresa=),
//     presupuesto (presupuesto.html?id=, siempre la ÚLTIMA versión).
//     Los contratos de URL de las 4 pantallas se confirmaron contra
//     el código real antes de escribir esto, no se inventaron. Solo
//     se activa con pedido explícito de navegación ("abrí",
//     "mostrame"), nunca al preguntar un dato suelto. Pedido por
//     Cristian.
// v10: memoria de sesión persistida en RTDB (/sesiones/{email}) —
//     preguntas seguidas ("¿cuánto sale el HVS-1?" → "¿y la
//     financiación?") ahora mantienen el hilo sin repetir de qué
//     equipo se habla. Se guarda solo pregunta+respuesta final de
//     cada intercambio (no los pasos intermedios de qué tool se
//     llamó), tope de 10 intercambios, vencimiento a las 24hs
//     (chequeado al leer, sin job de limpieza aparte). Una sola
//     memoria por vendedor, compartida entre todas las pantallas.
//     Pedido por Cristian.
// v9: reintento automático (hasta 2 veces, con backoff 1.5s/3s) para
//     errores 503 "modelo saturado" de Gemini — es un error
//     transitorio del lado de Google, no nuestro. Confirmado con
//     captura y log de Cristian: la tool buscarTicketPorCliente había
//     andado perfecto (5 resultados en 329ms), el 503 pasó recién en
//     la llamada de redacción final del texto.
// v8: timeout de la función subido de 60s (default) a 180s — con el
//     loop de hasta 4 vueltas a Gemini más lecturas de RTDB, algunas
//     consultas se estaban quedando sin tiempo y el navegador veía la
//     conexión cortada de golpe ("Error de conexión con el
//     asistente", sin ningún error prolijo en el log — la función se
//     mataba a mitad de camino). También se agregó log de tiempo por
//     vuelta del loop y por tool ejecutada, para diagnosticar más
//     rápido si vuelve a pasar. Reportado por Cristian con captura.
// v7: mismo fix que v6 pero para Servicio Técnico — consultarKpisServicio
//     ahora trae, por cada una de las 10 etapas abiertas del Kanban,
//     la lista de tickets/clientes que están ahí (antes solo el
//     conteo). Pedido por Cristian: "lo mismo quiero en las etapas de
//     servicio técnico".
// v6: consultarKpisEvento ahora desglosa por CADA etapa real del
//     embudo (Oportunidad reciente=10%, Calificación=25%,
//     Cotización=50%, Negociación=75%, Cierre=90%, Ganada, Perdida)
//     con cantidad, monto y lista de clientes de cada una — antes
//     todo lo que no era Ganada/Perdida se sumaba en un solo bolsón
//     "en negociación" sin distinguir etapas ni decir qué cliente
//     estaba en cuál. Reportado por Cristian: "no distingue etapas
//     10% 90% 75% 50%... tampoco me trae qué cliente está en la
//     etapa 90%".
// v5: se habilita markdown liviano en las respuestas (**negrita**,
//     viñetas "- ") — antes se lo prohibía por completo para no
//     romper la lectura en voz alta, pero el front ahora separa las
//     dos cosas: muestra el markdown formateado en pantalla y le pasa
//     a la síntesis de voz una versión limpia sin símbolos. Pedido
//     por Cristian con feedback externo detallado sobre el frontend.
// v4: agregadas 2 tools de Servicio Técnico — consultarKpisServicio
//     (tickets abiertos por etapa, vencidos, sin técnico, urgentes,
//     ranking por técnico) y buscarTicketPorCliente (ticket puntual
//     por cliente/médico/equipo). Mismo patrón que las de Ventas —
//     nodo RTDB /servicio_tecnico, cálculo en JS puro. Pedido por
//     Cristian: "agregale todas las funciones a servicio como
//     hicimos en el kanban de negocios".
// v3: buscarNegocioPorCliente ampliada — antes solo traía cliente,
//     estado, monto, vendedor y el primer equipo. Ahora también trae
//     CUIT, domicilio, contacto completo (nombre/teléfono/email), a
//     qué pipeline/campaña pertenece (no solo la etapa del embudo),
//     todos los equipos cargados (no solo el primero), y la última
//     nota de seguimiento. Pedido por Cristian: "ampliar el agente de
//     negocios, nombre cliente, empresa contacto etapa, más completo".
// ============================================================
// Diseño: 1 sola función HTTP (asistenteIA) con 3 tools de Gemini
// (consultarKpisEvento, buscarProducto, crearOApilarNegocio). Nada de
// "orquestador + registro de agentes en RTDB" — Gemini decide solo
// cuál tool llamar según la pregunta, sin necesidad de un router
// escrito a mano ni de una Cloud Function separada por página.
//
// consultarKpisEvento la usa el widget de cotizaciones.html (Ventas).
// buscarProducto y crearOApilarNegocio las usa el widget de
// selector-dispositivos.html — dejan preguntar precio/stock de un
// equipo, y crear o apilar un negocio con ese equipo, por texto o voz,
// sin salir del catálogo. Comparten la misma Cloud Function porque el
// costo/latencia de tener más tools declaradas es insignificante, y
// evita duplicar el setup de Gemini + el gate de seguridad.
//
// Gemini se usa SOLO para: (1) elegir qué pipeline_id/producto
// corresponde a la pregunta, y (2) redactar la respuesta final en
// español natural. El CÁLCULO (sumas, conteos, búsquedas en catálogo)
// lo hace JS puro acá abajo — nunca le pedimos a un LLM que sume plata
// o decida montos, no es confiable para eso y además es más caro/lento.
//
// crearOApilarNegocio NO reimplementa la lógica de negocios en RTDB —
// le pega a las mismas acciones de FotoMap.gs que ya usa
// ficha-equipo.html (buscarNegocioAgrupable, apilarFichaTecnica,
// guardarPresupuestoEditor) via fetch al GAS_URL. Se eligió así a
// propósito, en vez de escribir en RTDB directo desde acá: es lógica
// de negocio ya probada (dedup de empresas, agrupación de negocios
// abiertos, cálculo de descuento) — reimplementarla en un segundo
// lugar es un riesgo de que las dos copias se desincronicen con el
// tiempo. Es la única tool de las tres que tiene efectos secundarios
// (escribe datos) — las otras dos son de solo lectura.
//
// Seguridad: esta función NO usa Firebase Auth (el Portal usa su
// propio login por email + OTP, no Firebase Auth) — el gate es
// mínimo: valida que vendedorEmail venga, tenga formato de mail, y
// pertenezca a un dominio conocido de la empresa. No es una
// autenticación fuerte (el resto del sistema tampoco la tiene del
// lado del servidor, ver FotoMap.gs), pero corta el abuso trivial de
// pegarle a la URL desde afuera y generar consumo de la API de
// Gemini (que es paga). Si más adelante querés algo más sólido,
// podemos validar el email contra la hoja "Vendedores" real.
// ============================================================

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { GoogleGenAI, Type } = require('@google/genai');

admin.initializeApp();
const db = admin.database();

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// Mismo deployment fijo de siempre — nunca crear uno nuevo.
const GAS_URL = 'https://script.google.com/macros/s/AKfycbww2WC4wuvCiZnl59SzaKCMLvF99Zm3DSI7jB2sfo9x7nZis3V79YjfElha2KGDG7sC/exec';

// Dominios de email aceptados como "de adentro" — ajustar si hace
// falta agregar otro dominio de la empresa.
const DOMINIOS_PERMITIDOS = ['tlcsrl.com.ar'];

const MODELO_GEMINI = 'gemini-3.6-flash'; // actualizado 03/08/2026 — reemplaza a 3.5-flash, Google dice que usa menos pasos de razonamiento/tool calls por tarea (nuestro cuello de botella real) y sale más barato de salida ($7,50 vs $9 /millón tokens)

// ── CORS manual (mismo patrón simple que ya usa el resto del Portal:
// sin librería aparte, headers a mano) ─────────────────────────────
function _setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function _emailValido(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  return DOMINIOS_PERMITIDOS.some(function(dom) { return e.endsWith('@' + dom); });
}

// ══════════════════════════════════════════════════════════════════
// MEMORIA DE SESIÓN — historial de conversación persistido en RTDB
// (/sesiones/{usuarioId}), pedido por Cristian para que preguntas
// seguidas ("¿cuánto sale el HVS-1?" → "¿y la financiación?")
// mantengan el hilo sin repetir el nombre del equipo.
//
// Decisiones de diseño:
// - Se guarda SOLO la pregunta y la respuesta final de texto de cada
//   intercambio — NO los pasos intermedios de qué tool se llamó ni
//   sus resultados crudos. Eso ya quedó resuelto en la respuesta
//   final, y guardar los resultados de tools infla el prompt (y el
//   costo) de cada pregunta siguiente sin aportar nada extra de
//   contexto real.
// - Tope de 10 intercambios (20 turnos: 10 pregunta + 10 respuesta) —
//   suficiente memoria para una sesión de trabajo, sin dejar crecer
//   el prompt indefinidamente.
// - Vencimiento a las 24hs: se chequea al LEER (no hace falta un job
//   de limpieza aparte) — si la última actividad fue hace más de 24hs,
//   se descarta el historial viejo y arranca de cero, como si fuera la
//   primera pregunta del día.
// - Clave de sesión = email del vendedor (sanitizado para RTDB, que no
//   admite ".", "#", "$", "[", "]" en las keys) — una sola memoria por
//   persona, compartida entre todas las pantallas del Portal (Ventas,
//   Catálogo, Servicio, etc.), no una por módulo.
// ══════════════════════════════════════════════════════════════════
const SESION_MAX_INTERCAMBIOS = 10;
const SESION_VENCIMIENTO_MS = 24 * 60 * 60 * 1000;

function _rtdbKeySeguroEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/[.#$\[\]]/g, '_');
}

async function _leerHistorialSesion(email) {
  try {
    const key = _rtdbKeySeguroEmail(email);
    if (!key) return [];
    const snap = await db.ref('sesiones/' + key).once('value');
    const datos = snap.val();
    if (!datos || !Array.isArray(datos.turnos)) return [];
    if (!datos.ultimaActividad || (Date.now() - datos.ultimaActividad) > SESION_VENCIMIENTO_MS) return [];
    return datos.turnos;
  } catch (e) {
    console.error('Error leyendo historial de sesión:', e);
    return []; // si falla la lectura, seguimos sin memoria en vez de romper la pregunta
  }
}

async function _guardarHistorialSesion(email, turnos) {
  try {
    const key = _rtdbKeySeguroEmail(email);
    if (!key) return;
    // Tope: nos quedamos con los últimos N intercambios (2 turnos cada
    // uno: pregunta + respuesta).
    const tope = SESION_MAX_INTERCAMBIOS * 2;
    const recortado = turnos.slice(-tope);
    await db.ref('sesiones/' + key).set({ turnos: recortado, ultimaActividad: Date.now() });
  } catch (e) {
    console.error('Error guardando historial de sesión:', e); // no interrumpe la respuesta al vendedor
  }
}

// ══════════════════════════════════════════════════════════════════
// CÁLCULO DE KPIs — JS puro, determinístico, nunca se lo pedimos a
// Gemini. Filtra /cotizaciones por pipeline_id (el mismo campo que ya
// usa cotizaciones.html — Fase 1 de Pipelines/Campañas), calcula
// totales, ranking de equipos, y detecta leads fríos (>48hs sin nota
// nueva ni actualización), igual criterio que ya usa
// buscarNegocioAgrupable del lado de FotoMap.gs para "modificado
// hace N días o menos".
// ══════════════════════════════════════════════════════════════════
const CUARENTAYOCHO_HS_MS = 48 * 60 * 60 * 1000;
const ESTADOS_EN_NEGOCIACION = ['10%', '25%', '50%', '75%', '90%'];
// Mismo mapa que ESTADO_INFO en empresas.html — los nombres reales de
// cada etapa del embudo de Ventas, no solo el porcentaje.
const ETAPAS_VENTAS = {
  '10%': 'Oportunidad reciente',
  '25%': 'Calificación y asesoramiento',
  '50%': 'Cotización',
  '75%': 'Negociación',
  '90%': 'Cierre',
  'Ganada': 'Ganada',
  'Perdida': 'Perdida',
};

async function _calcularKpisEvento(pipelineId) {
  const pid = (pipelineId === 'GENERAL' || !pipelineId) ? '' : String(pipelineId).trim();

  const snap = await db.ref('cotizaciones').once('value');
  const raw = snap.val() || {};
  const todos = Object.keys(raw).map(function(k) { return raw[k]; }).filter(Boolean);

  const negocios = todos.filter(function(c) { return (c.pipeline_id || '') === pid; });

  let totalGanadoUSD = 0, totalNegociacionUSD = 0;
  let countGanados = 0, countNegociacion = 0, countPerdidos = 0;
  const conteoEquipos = {}; // nombre → cantidad de menciones
  const leadsFrios = [];
  const ahora = Date.now();

  // Desglose REAL por etapa (no solo "ganado" vs "en negociación" en
  // un bolsón) — cada etapa trae su nombre real, cuántos negocios
  // tiene, el total en USD, y la lista de clientes que están ahí.
  // Esto es lo que responde "¿quién está en Cierre (90%)?" en vez de
  // solo dar el número total. Reportado por Cristian: "no distingue
  // etapas... tampoco me trae qué cliente está en la etapa 90%".
  const porEtapa = {};
  Object.keys(ETAPAS_VENTAS).forEach(function(key) {
    porEtapa[ETAPAS_VENTAS[key]] = { cantidad: 0, totalUSD: 0, clientes: [] };
  });

  negocios.forEach(function(c) {
    const monto = parseFloat(c.montoUSD) || 0;
    const cliente = c.razonSocial || (c.empresa && c.empresa.razonSocial) || c.nombreNegocio || 'Sin nombre';
    const etapaNombre = ETAPAS_VENTAS[c.estado] || c.estado || 'Sin etapa';

    if (!porEtapa[etapaNombre]) porEtapa[etapaNombre] = { cantidad: 0, totalUSD: 0, clientes: [] };
    porEtapa[etapaNombre].cantidad++;
    porEtapa[etapaNombre].totalUSD += monto;
    porEtapa[etapaNombre].clientes.push({ cliente: cliente, montoUSD: monto, vendedor: c.vendedor || 'sin asignar' });

    if (c.estado === 'Ganada') {
      totalGanadoUSD += monto;
      countGanados++;
    } else if (c.estado === 'Perdida') {
      countPerdidos++;
    } else if (ESTADOS_EN_NEGOCIACION.indexOf(c.estado) !== -1) {
      totalNegociacionUSD += monto;
      countNegociacion++;
    }

    (Array.isArray(c.carrito) ? c.carrito : []).forEach(function(it) {
      const nombre = String(it.nombre || '').trim();
      if (!nombre) return;
      conteoEquipos[nombre] = (conteoEquipos[nombre] || 0) + 1;
    });

    // Lead frío: no ganado ni perdido, y sin actividad hace más de 48hs.
    if (c.estado !== 'Ganada' && c.estado !== 'Perdida') {
      const tsRaw = c.actualizado_en || c.fechaCreacion || c.fecha;
      const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
      const sinNotasRecientes = !Array.isArray(c.notas_papiro) || c.notas_papiro.length === 0;
      if (ts && (ahora - ts) > CUARENTAYOCHO_HS_MS) {
        leadsFrios.push({
          cliente: cliente,
          equipo: (Array.isArray(c.carrito) && c.carrito[0] && c.carrito[0].nombre) || '—',
          vendedor: c.vendedor || 'Sin asignar',
          horasSinActividad: Math.round((ahora - ts) / (60 * 60 * 1000)),
          sinNotas: sinNotasRecientes,
        });
      }
    }
  });

  // Redondear totales y capar la lista de clientes por etapa (no
  // inflar el prompt de vuelta a Gemini si hay una etapa con 50
  // negocios — 10 alcanza para que pueda nombrar los más relevantes).
  Object.keys(porEtapa).forEach(function(etapa) {
    porEtapa[etapa].totalUSD = Math.round(porEtapa[etapa].totalUSD * 100) / 100;
    porEtapa[etapa].clientes = porEtapa[etapa].clientes.slice(0, 10);
  });

  const rankingEquipos = Object.keys(conteoEquipos)
    .map(function(nombre) { return { nombre: nombre, menciones: conteoEquipos[nombre] }; })
    .sort(function(a, b) { return b.menciones - a.menciones; })
    .slice(0, 5);

  leadsFrios.sort(function(a, b) { return b.horasSinActividad - a.horasSinActividad; });

  return {
    totalNegocios: negocios.length,
    totalGanadoUSD: Math.round(totalGanadoUSD * 100) / 100,
    totalNegociacionUSD: Math.round(totalNegociacionUSD * 100) / 100,
    countGanados: countGanados,
    countNegociacion: countNegociacion,
    countPerdidos: countPerdidos,
    porEtapa: porEtapa,
    rankingEquipos: rankingEquipos,
    leadsFrios: leadsFrios.slice(0, 15), // tope razonable para no inflar el prompt de vuelta a Gemini
    totalLeadsFrios: leadsFrios.length,
  };
}

// Trae la lista de pipelines reales (mismo nodo que ya lee
// listarPipelines en FotoMap.gs) — se le pasa a Gemini como contexto
// para que elija el pipeline_id correcto en vez de que el código
// intente adivinar por texto libre.
async function _listarPipelinesParaContexto() {
  const snap = await db.ref('config/pipelines').once('value');
  const raw = snap.val() || {};
  const lista = Object.keys(raw).map(function(id) {
    return { id: id, nombre: raw[id].nombre || id };
  });
  lista.push({ id: '', nombre: 'General (sin pipeline asignado)' });
  return lista;
}

// Busca un negocio puntual por nombre de cliente, empresa o contacto
// — a diferencia de consultarKpisEvento (que da números agregados de
// UN pipeline), esta busca en TODOS los negocios sin importar
// pipeline, por texto libre. Es la que responde preguntas del tipo
// "¿Melina Fagotti tiene algún negocio abierto?" en vez de "¿cómo
// viene el pipeline X?".
async function _buscarNegocioPorCliente(query, pipelines) {
  const snap = await db.ref('cotizaciones').once('value');
  const raw = snap.val() || {};
  const todos = Object.keys(raw).map(function(k) { return raw[k]; }).filter(Boolean);
  const palabras = _sinAcentos(query).split(/\s+/).filter(Boolean);
  const mapaPipelines = {};
  pipelines.forEach(function(p) { mapaPipelines[p.id] = p.nombre; });

  const matches = todos.filter(function(c) {
    const texto = _sinAcentos([
      c.razonSocial,
      c.empresa && c.empresa.razonSocial,
      c.nombreNegocio,
      c.cliente && c.cliente.nombre,
      c.contacto && c.contacto.nombre,
      c.nombreMedico,
    ].filter(Boolean).join(' '));
    return palabras.every(function(p) { return texto.indexOf(p) !== -1; });
  });

  const resultado = matches.slice(0, 8).map(function(c) {
    const ultimaNota = Array.isArray(c.notas_papiro) && c.notas_papiro.length
      ? c.notas_papiro[c.notas_papiro.length - 1]
      : null;
    return {
      idCot: c.idCot || c.id_cotizacion || '',
      empresaId: c.empresaId || '',
      cliente: c.razonSocial || (c.empresa && c.empresa.razonSocial) || c.nombreNegocio || 'Sin nombre',
      cuit: (c.empresa && c.empresa.cuit) || c.cuit || '',
      domicilio: c.domicilio || '',
      contacto: {
        nombre: (c.contacto && c.contacto.nombre) || c.nombreMedico || '',
        telefono: (c.contacto && c.contacto.telefono) || c.telefono || '',
        email: (c.contacto && c.contacto.email) || '',
      },
      estado: c.estado || 'sin estado',
      pipeline: mapaPipelines[c.pipeline_id || ''] || 'General',
      montoUSD: parseFloat(c.montoUSD) || 0,
      vendedor: c.vendedor || 'sin asignar',
      equipos: (Array.isArray(c.carrito) ? c.carrito : []).map(function(it) { return it.nombre; }).filter(Boolean),
      ultimaNota: ultimaNota ? { texto: ultimaNota.texto || '', autor: ultimaNota.autor || '', fecha: ultimaNota.fecha || '' } : null,
      actualizado: c.actualizado_en || c.fechaCreacion || c.fecha || '',
    };
  });
  console.log('buscarNegocioPorCliente: query="' + query + '" → ' + resultado.length + ' resultado(s)');
  return { encontrados: resultado, cantidad: resultado.length };
}

// ══════════════════════════════════════════════════════════════════
// SERVICIO TÉCNICO — mismo patrón que Ventas: una tool de KPIs
// agregados (consultarKpisServicio) y una de búsqueda puntual
// (buscarTicketPorCliente). Nodo RTDB: /servicio_tecnico. Las 12
// etapas del Kanban y la lista de técnicos se replican acá tal cual
// están en servicio.html (COLUMNAS_DEF, TECNICOS_LISTA) para poder
// traducir los códigos guardados a nombres legibles.
// ══════════════════════════════════════════════════════════════════
const ETAPAS_SERVICIO = {
  recepcion: 'Recepción', diagnostico: 'Diagnóstico', presupuesto: 'Presupuesto',
  reparacion: 'Reparación', preparacion_control_calidad: 'Preparación / CC',
  para_facturar: 'Para Facturar', para_instalar: 'Para Instalar', seguimiento: 'Seguimiento',
  servicio_remoto: 'Servicio Remoto', consignacion: 'Consignación',
  finalizado: 'Finalizado', cancelado: 'Cancelado',
};
const ETAPAS_CERRADAS = ['finalizado', 'cancelado'];
const TECNICOS_SERVICIO = {
  juan_garro: 'Juan Garro', damian_sosa: 'Damián Sosa', fernando_del_campo: 'Fernando Del Campo',
  cristian_hirth: 'Cristian Hirth', veronica_ribaita: 'Verónica Ribaita',
  lourdes_davalos: 'Lourdes Dávalos', lucio_raineri: 'Lucio Raineri',
};

// fecha_vencimiento se guarda como texto DD/MM/YYYY (mismo formato que
// usa _fechaDDMMYYYYToISO en servicio.html) — se parsea a Date para
// poder comparar contra "hoy" y detectar vencidos.
function _parseFechaDDMMYYYY(s) {
  if (!s || typeof s !== 'string') return null;
  const partes = s.split('/');
  if (partes.length !== 3) return null;
  const d = parseInt(partes[0], 10), m = parseInt(partes[1], 10) - 1, y = parseInt(partes[2], 10);
  const fecha = new Date(y, m, d);
  return isNaN(fecha.getTime()) ? null : fecha;
}

async function _calcularKpisServicio(tecnicoFiltro) {
  const snap = await db.ref('servicio_tecnico').once('value');
  const raw = snap.val() || {};
  let tickets = Object.keys(raw).map(function(k) { return raw[k]; }).filter(Boolean);

  if (tecnicoFiltro) {
    const q = _sinAcentos(tecnicoFiltro);
    tickets = tickets.filter(function(t) {
      const nombreTec = _sinAcentos(TECNICOS_SERVICIO[t.tecnico_asignado] || t.tecnico_asignado || '');
      return nombreTec.indexOf(q) !== -1;
    });
  }

  const abiertos = tickets.filter(function(t) { return ETAPAS_CERRADAS.indexOf(t.deposito) === -1; });
  // Igual que en consultarKpisEvento: cada etapa trae cantidad Y la
  // lista de tickets/clientes que están ahí, no solo el número. Es lo
  // que responde "¿quién está en Reparación?" en vez de solo "hay 4".
  // Reportado por Cristian: "lo mismo quiero en las etapas de
  // servicio técnico".
  const porEtapa = {};
  Object.keys(ETAPAS_SERVICIO).forEach(function(key) {
    if (ETAPAS_CERRADAS.indexOf(key) === -1) porEtapa[ETAPAS_SERVICIO[key]] = { cantidad: 0, tickets: [] };
  });
  abiertos.forEach(function(t) {
    const etapa = ETAPAS_SERVICIO[t.deposito] || t.deposito || 'sin etapa';
    if (!porEtapa[etapa]) porEtapa[etapa] = { cantidad: 0, tickets: [] };
    porEtapa[etapa].cantidad++;
    porEtapa[etapa].tickets.push({
      idTicket: t.id_ticket,
      cliente: t.cliente || t.nombre_medico || 'Sin nombre',
      equipo: [t.equipo_marca, t.equipo_modelo].filter(Boolean).join(' ') || '—',
      tecnico: TECNICOS_SERVICIO[t.tecnico_asignado] || 'sin asignar',
      prioridad: t.prioridad || 'sin definir',
    });
  });
  Object.keys(porEtapa).forEach(function(etapa) { porEtapa[etapa].tickets = porEtapa[etapa].tickets.slice(0, 10); });

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const vencidos = [];
  const sinTecnico = [];
  const urgentes = [];
  const conteoTecnicos = {};

  abiertos.forEach(function(t) {
    const fechaVenc = _parseFechaDDMMYYYY(t.fecha_vencimiento);
    if (fechaVenc && fechaVenc < hoy) {
      vencidos.push({ idTicket: t.id_ticket, cliente: t.cliente || t.nombre_medico || 'Sin nombre', etapa: ETAPAS_SERVICIO[t.deposito] || t.deposito, tecnico: TECNICOS_SERVICIO[t.tecnico_asignado] || 'sin asignar', vencimiento: t.fecha_vencimiento });
    }
    if (!t.tecnico_asignado || t.tecnico_asignado === 'sin_asignar') {
      sinTecnico.push({ idTicket: t.id_ticket, cliente: t.cliente || t.nombre_medico || 'Sin nombre', etapa: ETAPAS_SERVICIO[t.deposito] || t.deposito });
    }
    if (t.prioridad === 'urgente') {
      urgentes.push({ idTicket: t.id_ticket, cliente: t.cliente || t.nombre_medico || 'Sin nombre', etapa: ETAPAS_SERVICIO[t.deposito] || t.deposito, tecnico: TECNICOS_SERVICIO[t.tecnico_asignado] || 'sin asignar' });
    }
    const nombreTec = TECNICOS_SERVICIO[t.tecnico_asignado] || null;
    if (nombreTec) conteoTecnicos[nombreTec] = (conteoTecnicos[nombreTec] || 0) + 1;
  });

  const rankingTecnicos = Object.keys(conteoTecnicos)
    .map(function(nombre) { return { tecnico: nombre, ticketsAbiertos: conteoTecnicos[nombre] }; })
    .sort(function(a, b) { return b.ticketsAbiertos - a.ticketsAbiertos; });

  return {
    totalAbiertos: abiertos.length,
    totalCerrados: tickets.length - abiertos.length,
    porEtapa: porEtapa,
    vencidos: vencidos.slice(0, 10),
    totalVencidos: vencidos.length,
    sinTecnicoAsignado: sinTecnico.slice(0, 10),
    totalSinTecnico: sinTecnico.length,
    urgentes: urgentes.slice(0, 10),
    totalUrgentes: urgentes.length,
    rankingTecnicos: rankingTecnicos,
  };
}

// Busca un ticket puntual por cliente/médico/equipo — igual patrón que
// buscarNegocioPorCliente pero para el Kanban de Servicio Técnico.
async function _buscarTicketPorCliente(query) {
  const snap = await db.ref('servicio_tecnico').once('value');
  const raw = snap.val() || {};
  const todos = Object.keys(raw).map(function(k) { return raw[k]; }).filter(Boolean);
  const palabras = _sinAcentos(query).split(/\s+/).filter(Boolean);

  const matches = todos.filter(function(t) {
    const texto = _sinAcentos([t.cliente, t.nombre_medico, t.equipo_marca, t.equipo_modelo, t.id_ticket].filter(Boolean).join(' '));
    return palabras.every(function(p) { return texto.indexOf(p) !== -1; });
  });

  const resultado = matches.slice(0, 8).map(function(t) {
    return {
      idTicket: t.id_ticket || '',
      cliente: t.cliente || t.nombre_medico || 'Sin nombre',
      telefono: t.telefono || '',
      domicilio: t.domicilio || '',
      equipo: [t.equipo_marca, t.equipo_modelo].filter(Boolean).join(' ') || '—',
      numeroSerie: t.equipo_serie || '',
      etapa: ETAPAS_SERVICIO[t.deposito] || t.deposito || 'sin etapa',
      tecnicoAsignado: TECNICOS_SERVICIO[t.tecnico_asignado] || 'sin asignar',
      prioridad: t.prioridad || 'sin definir',
      estadoProgreso: t.estado_progreso || 'sin definir',
      fechaVencimiento: t.fecha_vencimiento || '',
    };
  });
  console.log('buscarTicketPorCliente: query="' + query + '" → ' + resultado.length + ' resultado(s)');
  return { encontrados: resultado, cantidad: resultado.length };
}

// ══════════════════════════════════════════════════════════════════
// NAVEGACIÓN — navegarA. Resuelve el destino REAL (URL exacta de la
// pantalla correspondiente) en vez de dejar que Gemini invente una
// URL — el frontend solo recibe { url, etiqueta } ya armados y abre.
// Contratos de URL confirmados contra el código real de cada pantalla
// (no inventados):
//   - ficha_tecnica → ficha-equipo.html?nombre=<equipo>
//   - negocio       → cotizaciones.html?id=<idCot>
//   - empresa       → empresas.html?empresa=<empresaId>
//   - presupuesto   → presupuesto.html?id=<idCot> (sin &version=, esa
//                      URL ya lee la ÚLTIMA versión en vivo desde RTDB)
// ══════════════════════════════════════════════════════════════════
async function _buscarEmpresaPorNombre(query) {
  const snap = await db.ref('empresas').once('value');
  const raw = snap.val() || {};
  const palabras = _sinAcentos(query).split(/\s+/).filter(Boolean);
  let encontrada = null;
  Object.keys(raw).some(function(id) {
    const e = raw[id];
    const texto = _sinAcentos(e && e.razonSocial || '');
    if (palabras.every(function(p) { return texto.indexOf(p) !== -1; })) {
      encontrada = { id: id, razonSocial: e.razonSocial };
      return true;
    }
    return false;
  });
  return encontrada;
}

async function _resolverNavegacion(tipo, query, pipelines) {
  if (tipo === 'ficha_tecnica') {
    const matches = await _buscarProductoEnCatalogo(query);
    if (!matches.length) return { encontrado: false, mensaje: 'No encontré "' + query + '" en el catálogo.' };
    return { encontrado: true, tipo: 'ficha_tecnica', url: 'ficha-equipo.html?nombre=' + encodeURIComponent(matches[0].nombre), etiqueta: matches[0].nombre };
  }

  if (tipo === 'negocio' || tipo === 'presupuesto') {
    const r = await _buscarNegocioPorCliente(query, pipelines);
    if (!r.cantidad) return { encontrado: false, mensaje: 'No encontré ningún negocio para "' + query + '".' };
    const n = r.encontrados[0];
    const archivo = (tipo === 'presupuesto') ? 'presupuesto.html' : 'cotizaciones.html';
    return { encontrado: true, tipo: tipo, url: archivo + '?id=' + encodeURIComponent(n.idCot), etiqueta: n.cliente };
  }

  if (tipo === 'empresa') {
    let empresa = await _buscarEmpresaPorNombre(query);
    if (!empresa) {
      // Respaldo: si no está directo en /empresas (ej. cliente viejo
      // sin ficha de empresa creada todavía), buscamos por negocio y
      // usamos el empresaId que tenga vinculado ahí.
      const r = await _buscarNegocioPorCliente(query, pipelines);
      if (r.cantidad && r.encontrados[0].empresaId) {
        empresa = { id: r.encontrados[0].empresaId, razonSocial: r.encontrados[0].cliente };
      }
    }
    if (!empresa) return { encontrado: false, mensaje: 'No encontré ninguna empresa/cliente para "' + query + '".' };
    return { encontrado: true, tipo: 'empresa', url: 'empresas.html?empresa=' + encodeURIComponent(empresa.id), etiqueta: empresa.razonSocial };
  }

  return { encontrado: false, mensaje: 'Tipo de navegación no reconocido.' };
}

// ══════════════════════════════════════════════════════════════════
// CATÁLOGO — buscarProducto. Lectura pura de RTDB (/precios, mismo
// nodo que ya usa selector-dispositivos.html), sin efectos
// secundarios. Busca en los MISMOS 3 campos que usa el buscador
// universal real de selector-dispositivos.html: "Nombre de
// Dispositivo" (el nombre/marca/modelo — ej. "ELI EZER ERK-9100"),
// "Descripcion" (la descripción larga, ej. "Autorrefractómetro,
// Queratómetro...") y "Sub Categoria". Buscar solo en "Descripcion"
// (como estaba antes) era el bug real: el nombre del equipo NO vive
// ahí, vive en "Nombre de Dispositivo" — por eso no encontraba nada
// aunque el equipo sí estuviera en el catálogo. Reportado por
// Cristian con captura.
// ══════════════════════════════════════════════════════════════════
function _sinAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Los precios en Lista_Precios/RTDB vienen como TEXTO en formato
// argentino ("5.940" = cinco mil novecientos cuarenta, el punto es
// separador de miles, no decimal — "16.354,50" = con centavos). Un
// parseFloat común lee "5.940" como 5.94 — 1000 veces menos de lo que
// vale. selector-dispositivos.html ya tiene esta misma función
// (parseNum) para no pisarla con un parseFloat ingenuo; acá se
// replica igual para que los precios que arma el asistente sean
// exactos.
function _parseNumAR(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(s);
}
function _tieneValor(v) {
  return v !== null && v !== undefined && v !== '' && v !== 0 && v !== '0';
}

// Mismas 7 modalidades de financiación que ficha-equipo.html y
// selector-dispositivos.html (constante MODALIDADES) — se replica acá
// para que el asistente pueda listarlas. Cada equipo solo tiene las
// que tengan valor cargado en el catálogo (no todos los equipos
// financian en las 7 formas).
const MODALIDADES_FINANCIACION = [
  { label: 'Directo 6 cuotas AR$',  adelantoKey: 'Adelanto_TLC_$_6',     cuotaKey: 'CUOTA_TLC_$_6',         cuotas: 6,  moneda: 'ARS' },
  { label: 'Directo 12 cuotas AR$', adelantoKey: 'Adelanto_TLC_$_12',    cuotaKey: 'CUOTA_TLC_$_12',        cuotas: 12, moneda: 'ARS' },
  { label: 'Directo 6 cuotas USD',  adelantoKey: 'Adelanto_TLC_USD_6',   cuotaKey: 'CUOTA_TLC_USD_6',       cuotas: 6,  moneda: 'USD' },
  { label: 'Directo 12 cuotas USD', adelantoKey: 'Adelanto_TLC_USD_12',  cuotaKey: 'CUOTA_TLC_USD_12',      cuotas: 12, moneda: 'USD' },
  { label: 'Leasing 36 cuotas AR$', adelantoKey: 'Adelanto_L$_36',       cuotaKey: 'Cuota_L$_36',           cuotas: 36, moneda: 'ARS' },
  { label: 'Leasing 36 cuotas USD', adelantoKey: 'Adelanto_L_USD_36',    cuotaKey: 'Cuota_L_USD_36',        cuotas: 36, moneda: 'USD' },
  { label: 'Crédito Credicoop AR$', adelantoKey: 'Adelanto_$_CREDICOOP', cuotaKey: 'Cuotas_$_CREDICOOP_36', cuotas: 36, moneda: 'ARS' },
];

// Firebase RTDB no admite ciertos caracteres en las keys (espacios,
// "$", etc.) — cuando se sincronizó Lista_Precios a Firebase, esas
// keys quedaron SANITIZADAS con guiones bajos (ej. "Nombre de
// Dispositivo" → "Nombre_de_Dispositivo", "Precio LISTA" →
// "Precio_LISTA", "Adelanto_TLC_$_6" → "Adelanto_TLC___6"). Este es
// el MISMO mapa que usa selector-dispositivos.html
// (_MAPA_HEADERS_FIREBASE + _normalizarProductoFirebase) para
// traducir las keys sanitizadas de vuelta a los nombres originales
// antes de leer cualquier campo — sin esto, buscarProducto buscaba
// campos que directamente no existían con ese nombre en el nodo
// crudo, y por eso no encontraba nada salvo por casualidad en campos
// de una sola palabra (Descripcion, Stock, Foto) que no necesitan
// sanitizar. Bug real encontrado con capturas de Cristian comparando
// contra el buscador real de selector-dispositivos.html.
const _MAPA_HEADERS_FIREBASE = {
  'Sub_Categoria':            'Sub Categoria',
  'Nombre_de_Dispositivo':    'Nombre de Dispositivo',
  'Precio_LISTA':             'Precio LISTA',
  'Precio_CONTADO_CNO':       'Precio CONTADO CNO',
  'Tasa_TNA__':               'Tasa_TNA_$',
  'Adelanto_TLC___6':         'Adelanto_TLC_$_6',
  'CUOTA_TLC___6':            'CUOTA_TLC_$_6',
  'Descripcion_TLC___6':      'Descripcion_TLC_$_6',
  'Adelanto_TLC___12':        'Adelanto_TLC_$_12',
  'CUOTA_TLC___12':           'CUOTA_TLC_$_12',
  'Descripcion_TLC___12':     'Descripcion_TLC_$_12',
  'Adelanto_L__12':           'Adelanto_L$_12',
  'Cuota_L__12':              'Cuota_L$_12',
  'Descripcion_L__12':        'Descripcion_L$_12',
  'Adelanto_L__24':           'Adelanto_L$_24',
  'Cuota_L__24':              'Cuota_L$_24',
  'Descripcion_L__24':        'Descripcion_L$_24',
  'Adelanto_L__36':           'Adelanto_L$_36',
  'Cuota_L__36':              'Cuota_L$_36',
  'Descripcion_L__36':        'Descripcion_L$_36',
  'Adelanto___CREDICOOP':     'Adelanto_$_CREDICOOP',
  'Descripcion___adelanto_CREDICOOP_36': 'Descripcion_$_adelanto_CREDICOOP_36',
  'Cuotas___CREDICOOP_36':    'Cuotas_$_CREDICOOP_36',
  'Descripcion___CREDICOOP_36': 'Descripcion_$_CREDICOOP_36',
};
function _normalizarProductoFirebase(obj) {
  const out = {};
  Object.keys(obj).forEach(function(k) {
    const keyOriginal = _MAPA_HEADERS_FIREBASE[k] || k;
    out[keyOriginal] = obj[k];
  });
  return out;
}

async function _buscarProductoEnCatalogo(query) {
  const snap = await db.ref('precios').once('value');
  const raw = snap.val() || {};
  const items = Object.keys(raw).map(function(k) { return raw[k]; }).filter(Boolean).map(_normalizarProductoFirebase);
  // Match por PALABRAS sueltas (todas tienen que aparecer, en
  // cualquier orden, en cualquiera de los 3 campos combinados) en vez
  // de exigir la frase completa tal cual — así "precio hvs-1" (si
  // Gemini manda la pregunta completa en vez de solo el nombre del
  // equipo) sigue encontrando "HUVITZ HVS-1".
  const palabras = _sinAcentos(query).split(/\s+/).filter(Boolean);
  let matches = items.filter(function(d) {
    const texto = _sinAcentos((d['Nombre de Dispositivo'] || '') + ' ' + (d['Descripcion'] || '') + ' ' + (d['Sub Categoria'] || ''));
    return palabras.every(function(p) { return texto.indexOf(p) !== -1; });
  });
  // Deduplicar por nombre — si el mismo equipo aparece dos veces en el
  // catálogo (ej. una fila vieja/incompleta y la real), nos quedamos
  // con la que tenga Precio LISTA cargado en vez de la primera que
  // aparezca. Reportado por Cristian con captura: el asistente decía
  // "no encuentro el precio" de un equipo que en pantalla se veía con
  // precio completo — sospecha de fila duplicada incompleta.
  const grupos = {};
  matches.forEach(function(d) {
    const clave = _sinAcentos(d['Nombre de Dispositivo'] || d['Descripcion'] || '');
    if (!grupos[clave] || (!_tieneValor(grupos[clave]['Precio LISTA']) && _tieneValor(d['Precio LISTA']))) {
      grupos[clave] = d;
    }
  });
  matches = Object.keys(grupos).map(function(k) { return grupos[k]; });
  const resultado = matches.slice(0, 5).map(function(d) {
    const precioLista = _parseNumAR(d['Precio LISTA']) || 0;
    const precioContado = _parseNumAR(d['Precio CONTADO CNO']) || precioLista;
    const financiacion = MODALIDADES_FINANCIACION
      .filter(function(m) { return _tieneValor(d[m.adelantoKey]); })
      .map(function(m) {
        return {
          modalidad: m.label,
          moneda: m.moneda,
          adelanto: _parseNumAR(d[m.adelantoKey]) || 0,
          cuota: m.cuotaKey && _tieneValor(d[m.cuotaKey]) ? (_parseNumAR(d[m.cuotaKey]) || 0) : null,
          cantidadCuotas: m.cuotas,
        };
      });
    return {
      nombre: d['Nombre de Dispositivo'] || d['Descripcion'] || '',
      descripcion: d['Descripcion'] || '',
      precioLista: precioLista,
      precioContado: precioContado,
      stock: (d['Stock'] !== undefined && d['Stock'] !== null && d['Stock'] !== '') ? d['Stock'] : 'sin dato',
      foto: d['Foto'] || '',
      financiacion: financiacion,
    };
  });
  console.log('buscarProducto: query="' + query + '" → ' + matches.length + ' match(es) crudo(s): ' +
    matches.slice(0, 5).map(function(d) {
      return '[' + (d['Nombre de Dispositivo'] || '?') + ' | Precio LISTA raw="' + d['Precio LISTA'] + '" | Precio CONTADO CNO raw="' + d['Precio CONTADO CNO'] + '" | Stock raw="' + d['Stock'] + '"]';
    }).join(', '));
  return resultado;
}

// ══════════════════════════════════════════════════════════════════
// NEGOCIOS — crearOApilarNegocio. Con efectos secundarios: le pega a
// las MISMAS acciones de FotoMap.gs que ya usa ficha-equipo.html
// (buscarNegocioAgrupable, apilarFichaTecnica, guardarPresupuestoEditor
// con soloRegistrarNegocio) — no reimplementa la lógica de negocio acá,
// reutiliza la que ya está probada en producción.
// ══════════════════════════════════════════════════════════════════
async function _gasPost(body) {
  const resp = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function _crearOApilarNegocio(args, vendedorEmail, vendedorNombre) {
  const nombreProducto = String(args.nombreProducto || '').trim();
  const empresaTexto = String(args.empresaTexto || '').trim();
  const telefono = String(args.telefono || '').trim();
  if (!nombreProducto) return { ok: false, error: 'Falta el nombre del equipo.' };
  if (!empresaTexto) return { ok: false, error: 'Falta el nombre de la empresa/cliente.' };

  const matches = await _buscarProductoEnCatalogo(nombreProducto);
  if (!matches.length) return { ok: false, error: 'No encontré "' + nombreProducto + '" en el catálogo.' };
  const producto = matches[0]; // el match más cercano

  const rBuscar = await _gasPost({ accion: 'buscarNegocioAgrupable', razonSocial: empresaTexto });

  const fichaPayload = {
    nombre: producto.nombre,
    precio: producto.precioLista,
    precioContado: producto.precioContado,
    foto: producto.foto,
    vendedor: vendedorNombre || vendedorEmail,
  };

  if (rBuscar && rBuscar.ok && rBuscar.idCot) {
    const rApilar = await _gasPost({ accion: 'apilarFichaTecnica', idCot: rBuscar.idCot, ficha: fichaPayload });
    if (!rApilar.ok) return { ok: false, error: rApilar.error || 'No se pudo apilar en el negocio existente.' };
    return { ok: true, accion: 'apilado', idCot: rBuscar.idCot, empresa: empresaTexto, producto: producto.nombre, totalFichas: rApilar.total };
  }

  const descuento = producto.precioLista > 0
    ? Math.max(0, Math.round(((producto.precioLista - producto.precioContado) / producto.precioLista) * 10000) / 100)
    : 0;

  const rCrear = await _gasPost({
    accion: 'guardarPresupuestoEditor',
    soloRegistrarNegocio: true,
    idNegocio: '',
    razonSocial: empresaTexto,
    cuit: '',
    telefono: telefono,
    domicilio: '',
    empresaId: '',
    contactoNombre: '',
    contactoTelefono: '',
    vendedor: vendedorNombre || vendedorEmail,
    items: [{
      nombre: producto.nombre,
      precio: producto.precioLista,
      precioContado: producto.precioContado,
      cantidad: 1,
      descuento: descuento,
      iva: 10.5,
      moneda: 'USD',
      foto: producto.foto,
    }],
    formaPago: '', validez: '15', validezFecha: '', tiempoEntrega: 'inmediato', tiempoEntregaCustom: '', lugarEntrega: 'cliente',
    notas: 'Generado automáticamente por el Asistente IA' + (vendedorNombre ? ' — ' + vendedorNombre : '') + '.',
    moneda: 'USD',
    tcOficial: null,
    pipeline_id: '',
  });
  if (!rCrear.ok) return { ok: false, error: rCrear.error || 'No se pudo crear el negocio.' };
  return { ok: true, accion: 'creado', idCot: rCrear.idCot, empresa: empresaTexto, producto: producto.nombre };
}

// ══════════════════════════════════════════════════════════════════
// DEFINICIÓN DE LA TOOL PARA GEMINI (function calling nativo del SDK
// @google/genai) — esto es lo que reemplaza al "orquestador" custom.
// ══════════════════════════════════════════════════════════════════
const TOOLS_ASISTENTE = {
  functionDeclarations: [{
    name: 'consultarKpisEvento',
    description: 'Devuelve las métricas AGREGADAS de un pipeline/evento/campaña puntual del Kanban de Ventas de TLC: ventas ganadas, equipos más pedidos, leads fríos, y un desglose por CADA etapa real del embudo (Oportunidad reciente, Calificación y asesoramiento, Cotización, Negociación, Cierre, Ganada, Perdida) con cantidad, monto y la lista de clientes en cada una. Usar para preguntas sobre el estado GENERAL de un pipeline o quién está en una etapa puntual — no para buscar un negocio de un cliente específico por nombre, para eso usar buscarNegocioPorCliente.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pipeline_id: {
          type: Type.STRING,
          description: 'El id exacto del pipeline elegido de la lista de pipelines disponibles que se te pasó en el contexto. Usar "" (vacío) para "General".',
        },
      },
      required: ['pipeline_id'],
    },
  }, {
    name: 'buscarNegocioPorCliente',
    description: 'Busca un negocio puntual por nombre de cliente, empresa o contacto, en TODOS los pipelines (no uno solo). Devuelve cliente, CUIT, domicilio, contacto (nombre/teléfono/email), etapa del embudo, pipeline/campaña, monto, vendedor asignado, equipos cargados y última nota de seguimiento. Usar cuando el vendedor pregunta por una persona/empresa específica (ej. "¿Melina Fagotti tiene algo abierto?", "¿cómo va lo de CAO Veterinaria?" si es un cliente y no un pipeline).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Nombre de la persona, empresa o contacto a buscar.' },
      },
      required: ['query'],
    },
  }, {
    name: 'buscarProducto',
    description: 'Busca uno o más equipos en el catálogo de TLC por nombre, código o modelo (ej. "HVS-1", "HOCT-1F") y devuelve precio de lista, precio contado, stock, y todas las formas de financiación disponibles para ese equipo (cuotas AR$/USD, leasing, crédito) con su anticipo y valor de cuota. Solo lectura, no modifica nada.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Nombre, código o modelo del equipo a buscar, tal como lo dijo el vendedor (ej. "Huvitz HVS-1", "HOCT-1F", "tonometro").' },
      },
      required: ['query'],
    },
  }, {
    name: 'crearOApilarNegocio',
    description: 'Crea un negocio nuevo en Ventas para un cliente/empresa con un equipo puntual, o si ya existe un negocio abierto para esa empresa, suma el equipo ahí. Usar SOLO cuando el vendedor pidió explícitamente cargar/crear/agregar un negocio — nunca de forma automática solo por preguntar precio o stock.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        nombreProducto: { type: Type.STRING, description: 'Nombre del equipo a cargar.' },
        empresaTexto: { type: Type.STRING, description: 'Nombre de la empresa o cliente para el que se carga el negocio. Si el vendedor no lo dijo, NO llames esta tool todavía — primero preguntale a qué cliente corresponde.' },
        telefono: { type: Type.STRING, description: 'Teléfono de contacto, si el vendedor lo mencionó. Opcional.' },
      },
      required: ['nombreProducto', 'empresaTexto'],
    },
  }, {
    name: 'consultarKpisServicio',
    description: 'Devuelve métricas AGREGADAS del Kanban de Servicio Técnico: cantidad y LISTA de tickets/clientes por cada una de las 10 etapas abiertas (Recepción, Diagnóstico, Presupuesto, Reparación, Preparación / CC, Para Facturar, Para Instalar, Seguimiento, Servicio Remoto, Consignación), cuántos vencidos, cuántos sin técnico asignado, cuántos urgentes, y un ranking de técnicos por carga. Usar para preguntas sobre el estado GENERAL de Servicio Técnico o quién está en una etapa puntual, no para buscar un ticket de un cliente específico por nombre (para eso usar buscarTicketPorCliente).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tecnico: { type: Type.STRING, description: 'Si preguntan por la carga de UN técnico puntual (ej. "¿cuántos tickets tiene Juan Garro?"), poné su nombre acá para filtrar. Dejar vacío para el total general.' },
      },
      required: [],
    },
  }, {
    name: 'buscarTicketPorCliente',
    description: 'Busca un ticket de Servicio Técnico puntual por nombre de cliente, médico o equipo (marca/modelo). Devuelve etapa del Kanban, técnico asignado, prioridad, estado, vencimiento y datos de contacto. Usar cuando preguntan por el service/reparación de una persona o clínica específica.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Nombre del cliente, médico, o equipo a buscar.' },
      },
      required: ['query'],
    },
  }, {
    name: 'navegarA',
    description: 'Abre/navega a una pantalla puntual de la PWA en una pestaña nueva: la ficha técnica de un equipo, el negocio/oportunidad de un cliente, la ficha de una empresa/cliente, o la última versión del presupuesto de un negocio. Usar SOLO cuando el vendedor lo pide explícitamente ("abrí", "mostrame", "andá a", "llevame a") — nunca de forma automática solo porque preguntó un dato de esa persona/equipo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tipo: {
          type: Type.STRING,
          enum: ['ficha_tecnica', 'negocio', 'empresa', 'presupuesto'],
          description: 'ficha_tecnica = ficha de un equipo del catálogo. negocio = pantalla/detalle del negocio de Ventas. empresa = ficha de la empresa/cliente en el CRM. presupuesto = última versión del presupuesto generado para ese negocio.',
        },
        query: { type: Type.STRING, description: 'Nombre del equipo (si tipo=ficha_tecnica) o del cliente/empresa (si tipo=negocio, empresa o presupuesto).' },
      },
      required: ['tipo', 'query'],
    },
  }],
};

function _systemInstruction(pipelines) {
  const listaTexto = pipelines.map(function(p) { return '- id="' + p.id + '" → ' + p.nombre; }).join('\n');
  return 'Sos el asistente interno de ventas de Tecnología Láser Corneal SRL (TLC), una distribuidora de equipos oftalmológicos en Argentina. ' +
    'Un vendedor o técnico te habla por voz o texto, desde distintas pantallas del sistema, y podés recibir siete tipos de pedido:\n' +
    '1) Cómo viene un evento/campaña/pipeline de ventas EN GENERAL, o quién está en una etapa puntual del embudo (ej. "¿quién está en Cierre?", "¿quién está al 90%?") → usá la tool consultarKpisEvento. SIEMPRE llamala antes de responder, nunca inventes números. Devuelve un desglose por etapa real (Oportunidad reciente=10%, Calificación y asesoramiento=25%, Cotización=50%, Negociación=75%, Cierre=90%, Ganada, Perdida) con cantidad, monto total, y la lista de clientes de cada una — usá esos nombres reales de etapa al responder, no solo el número de porcentaje.\n' +
    '   Pipelines disponibles ahora mismo:\n' + listaTexto + '\n' +
    '   Elegí el pipeline_id que mejor matchee lo que preguntó (por nombre, sigla, o tema — ej. "Faco Extrema", "CAO Veterinaria", "el congreso"). Si no estás seguro a cuál se refiere, elegí el más parecido igual y aclaralo en la respuesta.\n' +
    '2) Un negocio puntual de UNA persona/empresa específica (ej. "¿Melina Fagotti tiene algo abierto?") → usá la tool buscarNegocioPorCliente, NO consultarKpisEvento (esa es para números agregados de todo un pipeline, no para encontrar a una persona puntual). Esta tool trae cliente, CUIT, contacto (nombre/teléfono/email), etapa del embudo, a qué pipeline/campaña pertenece, monto, vendedor asignado, equipos cargados y la última nota de seguimiento — mencioná lo que sea relevante para lo que preguntaron, no leas todo el bloque de una si no lo pidieron.\n' +
    '3) Precio, stock o formas de financiación de un equipo del catálogo (por nombre completo O por código de modelo suelto, ej. "HVS-1", "HOCT-1F") → usá la tool buscarProducto. Nunca inventes precios, stock ni financiación, siempre llamá la tool. Si preguntan solo por precio/stock, con decir precio de lista y contado alcanza — no listes las 7 financiaciones salvo que pregunten específicamente por cuotas/financiación/leasing. IMPORTANTE: llamala UNA sola vez con el nombre o código del equipo (sin palabras como "precio" o "cuánto sale", solo el nombre/código) y respondé inmediatamente con lo que te devuelva, aunque sea "cantidad":0 — en ese caso decile al vendedor que no lo encontraste, NO vuelvas a llamar la tool con otra variante del texto.\n' +
    '4) Cargar/crear/agregar un negocio con un equipo para un cliente → usá la tool crearOApilarNegocio. IMPORTANTE: esta tool necesita el nombre de la empresa/cliente. Si el vendedor todavía no lo dijo (ej. "cargalo en un negocio" sin decir para quién), NO llames la tool todavía — respondé preguntando "¿Para qué cliente?" y esperá la respuesta antes de crear nada. Nunca inventes ni asumas un cliente.\n' +
    '5) Cómo viene Servicio Técnico EN GENERAL, o quién está en una etapa puntual del Kanban (ej. "¿quién está en Reparación?", "¿qué hay en Para Facturar?") → usá la tool consultarKpisServicio, nunca inventes números. Devuelve cantidad y lista de tickets/clientes por cada etapa real (Recepción, Diagnóstico, Presupuesto, Reparación, Preparación / CC, Para Facturar, Para Instalar, Seguimiento, Servicio Remoto, Consignación), más vencidos, sin técnico, urgentes y ranking por técnico. Si preguntan por la carga de UN técnico puntual, pasale el nombre en el parámetro tecnico.\n' +
    '6) Un ticket puntual de Servicio Técnico de UN cliente/médico/equipo específico (ej. "¿cómo va el service de tal clínica?") → usá la tool buscarTicketPorCliente, NO consultarKpisServicio. Trae etapa del Kanban, técnico asignado, prioridad, vencimiento y contacto.\n' +
    '7) Pedido EXPLÍCITO de abrir/mostrar/navegar a una pantalla (ej. "abrí la ficha técnica del Sunkingdom LS-1B", "abrí el negocio de tal clínica", "mostrame la ficha de tal empresa", "abrí el último presupuesto de tal cliente") → usá la tool navegarA con el tipo correcto (ficha_tecnica/negocio/empresa/presupuesto). Solo cuando lo piden explícitamente con un verbo de navegación — si solo preguntan un dato (precio, estado, teléfono), NO llames navegarA, respondé el dato con la tool que corresponda. Si navegarA encuentra el destino, confirmá en 1 línea corta MENCIONANDO QUE HAY UN BOTÓN PARA ABRIRLO — NUNCA digas "abriendo" o "te llevo" como si ya hubiese pasado, porque no navega solo, el vendedor tiene que tocar el link que aparece abajo (ej. "Encontré la ficha del Sunkingdom LS-1B — tocá el botón de abajo para abrirla."). Si no lo encuentra, decilo directo.\n' +
    'Cuando tengas los datos de una tool, respondé en español rioplatense, tono directo y compañero de trabajo (nunca "informe" ni "reporte" formal), corto (4-6 líneas como máximo), con los números o datos clave primero. ' +
    'Si hay leads fríos o tickets vencidos/urgentes, mencioná cuántos son y nombrá los 2-3 más urgentes con cliente y responsable asignado, para que sepa a quién llamar ya. ' +
    'Si creaste o apilaste un negocio, confirmalo mencionando el cliente y el equipo cargado. ' +
    'Si una búsqueda puntual (cliente o ticket) no encuentra nada, decilo directo — no asumas que no existe, puede que esté con otro nombre; sugerí revisar el Kanban a mano si insiste. ' +
    'No arranques las respuestas con "Che" ni la uses como muletilla — andá directo al dato. ' +
    'Podés usar markdown LIVIANO para que se lea mejor en pantalla: **negrita** para nombres de equipos o datos clave, y viñetas con "- " cuando enumeres 2 o más ítems (equipos, leads, tickets). No uses otro formato (nada de títulos con #, tablas, código, o negrita+viñeta juntas todo el tiempo) — la pantalla es chica. El texto también se lee en voz alta por separado, ya limpio de símbolos, así que no hace falta que evites el markdown por eso.';
}

// ══════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL — HTTP, POST { pregunta, vendedorEmail }
// ══════════════════════════════════════════════════════════════════
exports.asistenteIA = onRequest({ secrets: [GEMINI_API_KEY], region: 'us-central1', cors: true, timeoutSeconds: 180 }, async (req, res) => {
  _setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no permitido' }); return; }

  try {
    const _t0Total = Date.now();
    const pregunta = String((req.body && req.body.pregunta) || '').trim();
    const vendedorEmail = String((req.body && req.body.vendedorEmail) || '').trim();
    const vendedorNombre = String((req.body && req.body.vendedorNombre) || '').trim();

    if (!pregunta) { res.status(400).json({ ok: false, error: 'Falta la pregunta' }); return; }
    if (!_emailValido(vendedorEmail)) { res.status(401).json({ ok: false, error: 'No autorizado' }); return; }

    const pipelines = await _listarPipelinesParaContexto();
    const geminiKey = GEMINI_API_KEY.value();
    if (!geminiKey) {
      console.error('GEMINI_API_KEY vino vacío — revisar que el secret esté cargado (firebase functions:secrets:set GEMINI_API_KEY).');
      res.status(500).json({ ok: false, error: 'Falta configurar GEMINI_API_KEY del lado del servidor.' });
      return;
    }
    // Log de diagnóstico SEGURO — nunca la key completa, solo largo y
    // primeros 4 caracteres, para detectar keys mal copiadas (con
    // espacios/saltos de línea de más, o el tipo de credencial
    // equivocado) sin exponer el secret en los logs.
    console.log('GEMINI_API_KEY diagnóstico: largo=' + geminiKey.length + ', empieza_con="' + geminiKey.slice(0,4) + '", termina_con="' + geminiKey.slice(-2) + '" — modelo activo: ' + MODELO_GEMINI);
    // vertexai:false fuerza explícitamente el modo API key (Gemini
    // Developer API, generativelanguage.googleapis.com) en vez de que
    // el SDK auto-detecte el entorno de Cloud Functions y trate de
    // usar Vertex AI con OAuth/ADC — eso es lo que producía el 401
    // "ACCESS_TOKEN_TYPE_UNSUPPORTED" reportado por Cristian.
    const ai = new GoogleGenAI({ apiKey: geminiKey, vertexai: false });

    // Reintento automático SOLO para 503 "modelo saturado" — es un
    // error transitorio del lado de Google, no nuestro (confirmado con
    // captura de Cristian: la tool había andado perfecto, el 503 pasó
    // en la llamada de redacción final). Otros errores (400, 401, 429,
    // etc.) no se reintentan — esos sí son reales y hay que verlos.
    async function _generarConReintento(params) {
      const intentos = 4;
      for (let i = 0; i < intentos; i++) {
        try {
          return await ai.models.generateContent(params);
        } catch (e) {
          const es503 = e && (e.status === 503 || /UNAVAILABLE|high demand/i.test(e.message || ''));
          if (!es503 || i === intentos - 1) throw e;
          const espera = 2000 * (i + 1); // 2s, 4s, 6s
          console.log('generateContent devolvió 503 (modelo saturado) — reintento ' + (i + 1) + '/' + (intentos - 1) + ' en ' + espera + 'ms');
          await new Promise(function(r) { setTimeout(r, espera); });
        }
      }
    }

    // Memoria de sesión: el historial (pregunta+respuesta de
    // intercambios anteriores, sin los pasos intermedios de tools) se
    // antepone a la pregunta nueva, para que Gemini mantenga el hilo
    // ("¿cuánto sale el HVS-1?" → "¿y la financiación?" sin repetir el
    // nombre del equipo).
    const historialPrevio = await _leerHistorialSesion(vendedorEmail);
    const contents = historialPrevio.concat([{ role: 'user', parts: [{ text: pregunta }] }]);

    // Loop de function calling — antes esto era un solo "if" que
    // manejaba UNA vuelta de tool y daba por hecho que la 2da
    // respuesta ya iba a traer texto final. Pero Gemini puede
    // encadenar más de una tool en la misma pregunta (ej. primero
    // buscarProducto para confirmar el precio y recién después
    // crearOApilarNegocio), y en ese caso la 2da respuesta también
    // venía sin texto — se perdía y el vendedor veía "No pude armar
    // una respuesta" aunque la Cloud Function no había fallado.
    // Tope de 4 vueltas como red de seguridad ante un loop infinito.
    let response;
    let textoFinal = '';
    let ultimoResultadoTool = null;
    let ultimaToolLlamada = '';
    let navegacionResultado = null; // se completa si Gemini llamó navegarA con éxito
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      const _t0Vuelta = Date.now();
      response = await _generarConReintento({
        model: MODELO_GEMINI,
        contents: contents,
        config: { systemInstruction: _systemInstruction(pipelines), tools: [TOOLS_ASISTENTE] },
      });
      console.log('vuelta ' + vuelta + ': generateContent tardó ' + (Date.now() - _t0Vuelta) + 'ms');

      const llamada = response.functionCalls && response.functionCalls[0];
      if (!llamada) { textoFinal = response.text || ''; break; }
      if (!['consultarKpisEvento', 'buscarNegocioPorCliente', 'buscarProducto', 'crearOApilarNegocio', 'consultarKpisServicio', 'buscarTicketPorCliente', 'navegarA'].includes(llamada.name)) { break; }

      const _t0Tool = Date.now();
      let resultadoTool;
      if (llamada.name === 'consultarKpisEvento') {
        resultadoTool = await _calcularKpisEvento(llamada.args && llamada.args.pipeline_id);
      } else if (llamada.name === 'buscarNegocioPorCliente') {
        resultadoTool = await _buscarNegocioPorCliente(llamada.args && llamada.args.query, pipelines);
      } else if (llamada.name === 'buscarProducto') {
        const encontrados = await _buscarProductoEnCatalogo(llamada.args && llamada.args.query);
        resultadoTool = { encontrados: encontrados, cantidad: encontrados.length };
      } else if (llamada.name === 'consultarKpisServicio') {
        resultadoTool = await _calcularKpisServicio(llamada.args && llamada.args.tecnico);
      } else if (llamada.name === 'buscarTicketPorCliente') {
        resultadoTool = await _buscarTicketPorCliente(llamada.args && llamada.args.query);
      } else if (llamada.name === 'navegarA') {
        resultadoTool = await _resolverNavegacion(llamada.args && llamada.args.tipo, llamada.args && llamada.args.query, pipelines);
        if (resultadoTool.encontrado) navegacionResultado = resultadoTool;
      } else { // crearOApilarNegocio
        resultadoTool = await _crearOApilarNegocio(llamada.args || {}, vendedorEmail, vendedorNombre);
      }
      console.log('vuelta ' + vuelta + ': tool ' + llamada.name + ' tardó ' + (Date.now() - _t0Tool) + 'ms');
      ultimoResultadoTool = resultadoTool;
      ultimaToolLlamada = llamada.name;

      // IMPORTANTE: el turno del modelo se agrega tal cual viene en
      // response.candidates[0].content, NO reconstruido a mano con
      // { role:'model', parts:[{functionCall: llamada}] }. Los modelos
      // Gemini 3 (como gemini-3.5-flash) adjuntan un thought_signature
      // a la parte de functionCall, y hay que devolvérselo intacto en
      // el siguiente turno o tira 400 "missing thought_signature".
      // Reconstruirlo a mano pierde ese campo porque no está expuesto
      // en response.functionCalls (que es solo un atajo con
      // name/args). El objeto candidates[0].content sí lo trae.
      const turnoModelo = (response.candidates && response.candidates[0] && response.candidates[0].content)
        || { role: 'model', parts: [{ functionCall: llamada }] }; // fallback improbable
      contents.push(turnoModelo);
      contents.push({ role: 'user', parts: [{ functionResponse: { name: llamada.name, response: resultadoTool } }] });
    }

    if (!textoFinal && ultimaToolLlamada === 'buscarProducto' && ultimoResultadoTool) {
      // Red de seguridad: Gemini se quedó llamando tools sin cerrar
      // con texto (pasó con "precio hvs-1" — reintentaba la búsqueda
      // en vez de avisar que no encontró nada, o directamente no
      // llegó a redactar). En vez de devolver el mensaje genérico
      // sin ningún dato útil, armamos la respuesta en JS puro con lo
      // que sí tenemos.
      const enc = ultimoResultadoTool.encontrados || [];
      if (!enc.length) {
        textoFinal = 'No encontré ningún equipo que coincida con esa búsqueda en el catálogo.';
      } else {
        textoFinal = enc.map(function(p) {
          let linea = '- **' + p.nombre + '**: lista USD ' + p.precioLista.toLocaleString('es-AR') +
            ', contado USD ' + p.precioContado.toLocaleString('es-AR') +
            ', stock: ' + p.stock;
          if (p.financiacion && p.financiacion.length) {
            linea += '. Financiación: ' + p.financiacion.map(function(f) {
              return f.modalidad + ' (anticipo ' + f.moneda + ' ' + f.adelanto.toLocaleString('es-AR') +
                (f.cuota ? ', cuota ' + f.moneda + ' ' + f.cuota.toLocaleString('es-AR') : '') + ')';
            }).join(', ');
          }
          return linea;
        }).join('\n');
      }
    }
    if (!textoFinal) textoFinal = response.text || 'No pude armar una respuesta — probá reformular la pregunta.';

    // Guardar SOLO la pregunta y la respuesta final en el historial —
    // no los turnos intermedios de function-calling de esta consulta
    // (ver comentario en _leerHistorialSesion/_guardarHistorialSesion
    // sobre por qué). Se espera (await) antes de responder — si no,
    // Cloud Functions puede cortar la ejecución apenas se manda la
    // respuesta HTTP y el guardado del historial se pierde a mitad de
    // camino.
    await _guardarHistorialSesion(vendedorEmail, historialPrevio.concat([
      { role: 'user', parts: [{ text: pregunta }] },
      { role: 'model', parts: [{ text: textoFinal }] },
    ]));

    const cuerpoRespuesta = { ok: true, respuesta: textoFinal };
    if (navegacionResultado) {
      cuerpoRespuesta.navegacion = { tipo: navegacionResultado.tipo, url: navegacionResultado.url, etiqueta: navegacionResultado.etiqueta };
    }
    console.log('TOTAL de la consulta: ' + (Date.now() - _t0Total) + 'ms');
    res.status(200).json(cuerpoRespuesta);
  } catch (e) {
    console.error('asistenteIA error:', e);
    const es503 = e && (e.status === 503 || /UNAVAILABLE|high demand/i.test(e.message || ''));
    const mensaje = es503
      ? 'Gemini está saturado en este momento (ya lo reintenté varias veces) — probá de nuevo en unos segundos.'
      : (e.message || 'Error interno');
    res.status(500).json({ ok: false, error: mensaje });
  }
});
