// Portal TLC | Cloud Function — módulo Empresas
// v1 — 2026.09.21
//
// Primer paso de la migración fuera de Apps Script (Cristian:
// "arrancamos con modulo empresas, que guarde al toque"). Reemplaza
// las 7 acciones de empresas.html que hoy corren en FotoMap.gs
// (Apps Script) — listarEmpresas, guardarEmpresa, borrarEmpresa,
// guardarContacto, borrarContacto, reasignarEmpresaNegocio,
// guardarEmpresaContactoQR. Se eligió este módulo primero porque las
// 7 acciones son Firebase puro — ninguna toca historico.json en
// GitHub (la fuente de casi todos los problemas del 20/09/2026) ni
// ningún otro sistema externo. Riesgo bajo, ideal para probar todo
// el patrón de migración (Cloud Function + Firebase Admin SDK +
// despliegue) antes de animarse con presupuestos/negocios.
//
// Mismo contrato de datos que ya usa el frontend contra Apps Script
// — mismo campo "accion", mismos nombres de campos en cada acción —
// para que el cambio en empresas.html sea SOLO la URL a la que
// apunta, sin tocar la forma de los payloads.
//
// Requiere las variables de entorno (ver notas de despliegue en
// deploy.md): ninguna — usa las credenciales por defecto del
// proyecto de Google Cloud (Application Default Credentials), que
// Cloud Functions ya trae resueltas automáticamente al correr DENTRO
// del mismo proyecto que la base de datos (portal-tlc). Nada de JWT
// armado a mano ni private keys pegadas en Propiedades del script —
// eso era justo una de las partes más fragiles de FotoMap.gs.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

// BUG REAL — el primer despliegue de Cristian falló con "Container
// Healthcheck failed" (el contenedor se rompe al arrancar, antes de
// llegar a escuchar el puerto). Causa probable: admin.initializeApp()
// SIN especificar databaseURL no siempre logra resolver sola cuál es
// la base de Realtime Database del proyecto cuando corre fuera del
// hosting propio de Firebase (a diferencia de Apps Script, que no
// necesita esto para nada) — y si tira una excepción ahí, el
// contenedor entero muere antes de arrancar el servidor HTTP.
// Especificarla explícita saca la adivinanza del medio.
admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();

// ── Helpers Firebase — reemplazan _firebaseGet/_firebaseSet/_firebasePatch/_firebaseDelete de FotoMap.gs ──
// El Admin SDK ya maneja auth, reintentos de red y serialización
// sola — no hay JSON.parse manual sobre una respuesta HTTP cruda,
// así que la familia de bugs que se cazó hoy en Apps Script
// (respuestas vacías con 200 OK rompiendo JSON.parse) no puede pasar
// acá: el SDK nunca devuelve "una respuesta vacía", devuelve `null`
// de forma explícita y tipada cuando no hay dato.
async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}
async function fbSet(path, value) { await db.ref(path).set(value); return value; }
async function fbPatch(path, fields) { await db.ref(path).update(fields); return fields; }
async function fbDelete(path) { await db.ref(path).remove(); }

function idAleatorio(prefijo) {
  return prefijo + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}
function normalizar(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Las 7 acciones — mismo comportamiento que FotoMap.gs, línea por línea ──

async function listarEmpresas() {
  const [empresasRaw, contactosRaw] = await Promise.all([fbGet('empresas'), fbGet('contactos')]);
  const empresas = empresasRaw || {};
  const contactos = contactosRaw || {};
  const contactosPorEmpresa = {};
  Object.keys(contactos).forEach((cid) => {
    const c = contactos[cid];
    const eid = c.empresaId;
    if (!eid) return;
    if (!contactosPorEmpresa[eid]) contactosPorEmpresa[eid] = [];
    contactosPorEmpresa[eid].push({ id: cid, nombre: c.nombre || '', cargo: c.cargo || '', email: c.email || '', telefono: c.telefono || '', dni: c.dni || '', vip: !!c.vip });
  });
  const lista = Object.keys(empresas).map((id) => {
    const e = empresas[id];
    return {
      id, razonSocial: e.razonSocial || '', cuit: e.cuit || '', domicilio: e.domicilio || '', telefono: e.telefono || '',
      domicilioFiscal: e.domicilioFiscal || '', domicilioComercial: e.domicilioComercial || '', domicilioEnvio: e.domicilioEnvio || '',
      comentariosGenerales: e.comentariosGenerales || '', contactos: contactosPorEmpresa[id] || [], negocios: [],
    };
  });
  return { ok: true, empresas: lista };
}

async function guardarEmpresa(data) {
  const razonSocial = String(data.razonSocial || '').trim();
  if (!razonSocial) return { ok: false, error: 'Falta razón social' };
  let id = String(data.id || '').trim();
  let esNueva = !id;

  if (esNueva) {
    const razonNorm = normalizar(razonSocial);
    const empresasExistentes = (await fbGet('empresas')) || {};
    const idEncontrado = Object.keys(empresasExistentes).find((eid) => normalizar(empresasExistentes[eid].razonSocial) === razonNorm);
    if (idEncontrado) { id = idEncontrado; esNueva = false; }
  }

  if (esNueva) id = idAleatorio('e');
  const registro = {
    razonSocial, cuit: String(data.cuit || '').trim(), telefono: String(data.telefono || '').trim(),
    domicilioFiscal: String(data.domicilioFiscal || '').trim(), domicilioComercial: String(data.domicilioComercial || '').trim(),
    domicilioEnvio: String(data.domicilioEnvio || '').trim(), comentariosGenerales: String(data.comentariosGenerales || '').trim(),
  };
  if (data.domicilio !== undefined) registro.domicilio = String(data.domicilio || '').trim();

  if (esNueva) {
    registro.creado_en = new Date().toISOString();
    await fbSet('empresas/' + id, registro);
  } else {
    // BUG REAL — Cristian: "había borrado la q y el 11, lo guardé,
    // sali y volvi a entrar... aparece de nuevo la q y el 11". Causa:
    // este chequeo descartaba un campo si su VALOR daba falsy
    // (String vacío incluido) — pensado para no vaciar CUIT/domicilios
    // si alguna vez llegaba un payload incompleto (ej. el flujo de QR,
    // que no manda todos los campos). Pero el formulario de edición
    // completo SIEMPRE manda los 7 campos, incluso los que el usuario
    // dejó vacíos A PROPÓSITO — y ese borrado intencional se
    // descartaba igual que "no lo mandaron", dejando el valor viejo
    // en la base aunque en pantalla pareciera guardado. Mismo bug
    // exacto ya existía en FotoMap.gs (de donde se portó esta lógica
    // línea por línea) — no es nuevo de la migración. Ahora se
    // pregunta si la CLAVE vino en el payload (data[campo] !==
    // undefined), no si el VALOR resultante es truthy — mismo
    // criterio que domicilio ya usaba una línea arriba. Así, un campo
    // vaciado a propósito (mandado como '') sí se guarda vacío, pero
    // un campo que el llamador ni siquiera mandó (ej. el flujo de QR,
    // que no toca cuit/domicilios) sigue sin tocarse.
    const patchSeguro = {};
    Object.keys(registro).forEach((campo) => { if (data[campo] !== undefined) patchSeguro[campo] = registro[campo]; });
    if (Object.keys(patchSeguro).length) await fbPatch('empresas/' + id, patchSeguro);
  }
  return { ok: true, id, empresaExistente: !esNueva };
}

async function borrarEmpresa(data) {
  if (String(data.vendedorRol || '').trim() !== 'Administrador') return { ok: false, error: 'Solo un Administrador puede borrar una empresa.' };
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  const contactosRaw = (await fbGet('contactos')) || {};
  await Promise.all(Object.keys(contactosRaw).filter((cid) => contactosRaw[cid].empresaId === id).map((cid) => fbDelete('contactos/' + cid)));
  await fbDelete('empresas/' + id);
  return { ok: true };
}

async function guardarContacto(data) {
  const empresaId = String(data.empresaId || '').trim();
  const nombre = String(data.nombre || '').trim();
  if (!empresaId) return { ok: false, error: 'Falta empresaId' };
  if (!nombre) return { ok: false, error: 'Falta nombre' };
  let id = String(data.id || '').trim();
  const esNuevo = !id;
  if (esNuevo) id = idAleatorio('c');
  const registro = { empresaId, nombre, cargo: String(data.cargo || '').trim(), email: String(data.email || '').trim(), telefono: String(data.telefono || '').trim(), dni: String(data.dni || '').trim(), vip: !!data.vip };
  if (esNuevo) { registro.creado_en = new Date().toISOString(); await fbSet('contactos/' + id, registro); }
  else await fbPatch('contactos/' + id, registro);
  return { ok: true, id };
}

async function borrarContacto(data) {
  const id = String(data.id || '').trim();
  if (!id) return { ok: false, error: 'Falta id' };
  await fbDelete('contactos/' + id);
  return { ok: true };
}

async function reasignarEmpresaNegocio(data) {
  const idCot = String(data.idCot || '').trim();
  const empresaId = String(data.empresaId || '').trim();
  if (!idCot) return { ok: false, error: 'Falta idCot' };
  if (!empresaId) return { ok: false, error: 'Falta empresaId' };
  // Mismo saneo de key que _rtdbKeySeguro en FotoMap.gs (Firebase no
  // permite . # $ [ ] en las claves de ruta).
  const idRtdb = idCot.replace(/[.#$[\]]/g, '_');
  const entradaNegocio = await fbGet('cotizaciones/' + idRtdb);
  if (!entradaNegocio) return { ok: false, error: 'Negocio no encontrado: ' + idCot };
  const empresa = await fbGet('empresas/' + empresaId);
  if (!empresa) return { ok: false, error: 'Empresa no encontrada: ' + empresaId };

  const contactoId = String(data.contactoId || '').trim();
  let contactoNuevo = { nombre: '', email: '', telefono: '' };
  if (contactoId) {
    const contacto = await fbGet('contactos/' + contactoId);
    if (contacto) contactoNuevo = { nombre: contacto.nombre || '', email: contacto.email || '', telefono: contacto.telefono || '' };
  }

  const patch = {
    empresaId, razonSocial: empresa.razonSocial || '', cuit: empresa.cuit || '',
    empresa: { razonSocial: empresa.razonSocial || '', cuit: empresa.cuit || '' },
    contactoId: contactoId || '', contacto: contactoNuevo,
    telefono: contactoNuevo.telefono || entradaNegocio.telefono || '',
    actualizado_en: new Date().toISOString(),
  };
  await fbPatch('cotizaciones/' + idRtdb, patch);
  return { ok: true, razonSocial: patch.razonSocial, contacto: contactoNuevo };
}

async function guardarEmpresaContactoQR(data) {
  const nombre = String(data.nombre || '').trim();
  const apellido = String(data.apellido || '').trim();
  const nombreCompleto = (nombre + ' ' + apellido).trim();
  if (!nombreCompleto) return { ok: false, error: 'Falta nombre del contacto' };
  const dni = String(data.dni || '').trim();
  const email = String(data.email || '').trim();
  const telefonoEscaneado = String(data.telefono || '').trim();
  const categoria = String(data.categoria || '').trim();
  const vip = !!data.vip;

  const empresasRaw = (await fbGet('empresas')) || {};
  let empresaId = Object.keys(empresasRaw).find((id) => String(empresasRaw[id].razonSocial || '').trim().toLowerCase() === nombreCompleto.toLowerCase()) || null;
  const empresaCreada = !empresaId;
  if (empresaCreada) {
    empresaId = idAleatorio('e');
    await fbSet('empresas/' + empresaId, { razonSocial: nombreCompleto, cuit: '', domicilio: '', telefono: telefonoEscaneado, domicilioFiscal: '', domicilioComercial: '', domicilioEnvio: '', comentariosGenerales: 'Creada automáticamente desde QR de FacoExtrema.', creado_en: new Date().toISOString() });
  }

  const contactosRaw = (await fbGet('contactos')) || {};
  let contactoId = null;
  let contactoExistente = null;
  Object.keys(contactosRaw).some((cid) => {
    const c = contactosRaw[cid];
    if (c.empresaId !== empresaId) return false;
    const mismoDni = dni && String(c.dni || '').trim() === dni;
    const mismoNombre = String(c.nombre || '').trim().toLowerCase() === nombreCompleto.toLowerCase();
    if (mismoDni || mismoNombre) { contactoId = cid; contactoExistente = c; return true; }
    return false;
  });
  const telefonoFinal = telefonoEscaneado || (contactoExistente ? contactoExistente.telefono : '') || '';
  const resultadoContacto = await guardarContacto({ id: contactoId || '', empresaId, nombre: nombreCompleto, cargo: categoria, email, telefono: telefonoFinal, dni, vip });
  if (!resultadoContacto.ok) return resultadoContacto;
  return { ok: true, empresaId, empresaCreada, contactoId: resultadoContacto.id, telefonoConservado: !telefonoEscaneado && !!(contactoExistente && contactoExistente.telefono) };
}

const ACCIONES = {
  listarEmpresas, guardarEmpresa, borrarEmpresa, guardarContacto, borrarContacto,
  reasignarEmpresaNegocio, guardarEmpresaContactoQR,
};

// ── Punto de entrada HTTP ──────────────────────────────────────────
functions.http('empresas', async (req, res) => {
  // CORS — el mismo origen del Portal (ir.tlcsrl.com.ar) necesita
  // permiso explícito para llamar a esta función desde el navegador.
  res.set('Access-Control-Allow-Origin', 'https://ir.tlcsrl.com.ar');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    // BUG REAL — Cristian, con captura: "Error al guardar: Acción
    // desconocida: undefined". Causa: todo el Portal manda sus POST
    // con Content-Type: text/plain (mismo criterio que Apps Script,
    // a quien nunca le importó el header) — pero Express (la base de
    // Functions Framework) solo interpreta el cuerpo como JSON solo
    // cuando el header dice literalmente application/json. Con
    // text/plain, req.body quedaba vacío, así que data.accion daba
    // undefined siempre, sin importar qué mandara el frontend. Ahora
    // se lee el cuerpo crudo (req.rawBody, que Functions Framework
    // siempre provee sin importar el Content-Type) y se interpreta
    // como JSON a mano — mismo patrón que ya usa doPost() en
    // FotoMap.gs para esto exacto.
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
    console.error('Error en función empresas:', e);
    res.status(200).json({ ok: false, error: e.message || e.toString() });
  }
});
