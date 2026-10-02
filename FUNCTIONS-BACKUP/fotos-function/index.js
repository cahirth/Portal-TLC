// Portal TLC | Cloud Function — módulo Fotos (fotoMap)
// v1 — 2026.09.23
//
// Tercer módulo migrado fuera de Apps Script. Distinto a Empresas y
// Tareas: acá no hay acciones de "guardar" — es una función de LECTURA
// pura, pensada para reemplazar FOTO_MAP_URL (Apps Script) en
// ficha-equipo.html, selector-dispositivos.html e index.html.
//
// Cristian: "quiero que las fotos se carguen al instante y no ahora
// que tardan y tardan y tardan". La causa real era que Apps Script
// (doGet en FotoMap.gs) recorría TODA la carpeta de fotos en Drive,
// archivo por archivo, en CADA pedido — sin caché. Esta función NO
// hace ese trabajo — solo lee un mapa YA ARMADO desde Firebase
// (nodo foto_map), que Cristian corre a mano (sincronizarFotoMapAFirebase
// en FotoMap.gs, sin trigger automático — las fotos no cambian tan
// seguido como para justificar uno) después de subir fotos nuevas.
// Leer un nodo de Firebase es prácticamente instantáneo, sin
// comparación con recorrer Drive en el momento.
//
// Mismos 2 aprendizajes de Empresas/Tareas aplicados desde el vamos:
// databaseURL explícito, y el body (para las pocas acciones POST que
// tiene, todas administrativas) leído de req.rawBody.

const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

admin.initializeApp({ databaseURL: 'https://portal-tlc-default-rtdb.firebaseio.com' });
const db = admin.database();

async function fbGet(path) {
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}

// BUG REAL — Cristian: "Firebase PUT foto_map → HTTP 400". Firebase
// no permite un punto (.) en las claves, y todos los nombres de
// archivo lo tienen (la extensión) — FotoMap.gs ahora guarda cada
// foto como {clave_seguraB64: {nombre, url}} en vez de usar el
// nombre COMO clave. Esta función arma de vuelta el mapa plano
// {nombre_archivo: url} — el frontend sigue recibiendo EXACTAMENTE
// la misma forma de siempre, sin ningún cambio de su lado.
function _reconstruirMapaPlano(crudo) {
  const plano = {};
  if (!crudo) return plano;
  Object.values(crudo).forEach((entrada) => {
    if (entrada && entrada.nombre && entrada.url) plano[entrada.nombre] = entrada.url;
  });
  return plano;
}

// ── Punto de entrada HTTP ──────────────────────────────────────────
// Se llama SIN accion — simplemente GET o POST, cualquiera de los 2
// devuelve el mapa completo. Mismo contrato de respuesta que el
// doGet() viejo de Apps Script (un objeto {nombre_archivo: url}),
// para que el frontend no necesite cambiar cómo interpreta la
// respuesta, solo A QUÉ URL se la pide.
functions.http('fotos', async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://ir.tlcsrl.com.ar');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  try {
    const crudo = await fbGet('foto_map');
    res.status(200).json(_reconstruirMapaPlano(crudo));
  } catch (e) {
    console.error('Error en función fotos:', e);
    res.status(200).json({ error: e.message || e.toString() });
  }
});
