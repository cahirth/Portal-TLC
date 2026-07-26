// Portal TLC | adjuntos.js | Módulo reutilizable de archivos adjuntos
// ══════════════════════════════════════════════════════════════════
// Se usa igual en servicio.html (modulo:'servicio') y cotizaciones.html
// (modulo:'ventas') — mismo componente, mismo backend (acciones
// subirAdjunto/eliminarAdjunto en FotoMap.gs v117).
//
// Arquitectura:
//   - El ARCHIVO en sí va a Firebase Storage (bucket
//     portal-tlc.firebasestorage.app), subido siempre desde el backend
//     (FotoMap.gs), nunca directo desde el navegador — mismo criterio
//     de seguridad que el resto del Portal (reglas de Storage:
//     read:true / write:false).
//   - Los METADATOS (nombre, tipo, tamaño, url, quién lo subió, fecha)
//     van a Firebase RTDB, en un nodo "adjuntos" dentro del ticket
//     (servicio_tecnico/{id}/adjuntos/{adjId}) o del negocio
//     (cotizaciones/{id}/adjuntos/{adjId}).
//
// Cada módulo que lo usa debe:
//   1) Cargar este script después de version.js.
//   2) Tener un contenedor <div id="..."></div> en el HTML del detalle.
//   3) Llamar a adjuntosRenderSeccion(containerId, apiUrl, modulo, id,
//      datosAdjuntosYaCargados, nombreDeQuienEstaLogueado) al renderizar
//      el detalle.
//   4) Definir su propia función global adjuntosRecargar(modulo, id,
//      containerId) — relee los metadatos frescos de RTDB y vuelve a
//      llamar a adjuntosRenderSeccion. Se llama sola después de cada
//      subida/borrado exitoso.
// ══════════════════════════════════════════════════════════════════

const ADJUNTOS_EXT_PERMITIDAS = ['pdf','jpg','jpeg','png','txt','doc','docx','xls','xlsx'];
const ADJUNTOS_TAMANO_MAX = 10 * 1024 * 1024; // 10 MB

function _adjuntosValidarArchivo(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ADJUNTOS_EXT_PERMITIDAS.indexOf(ext) === -1) {
    return 'Formato no permitido ("' + ext + '"). Solo: PDF, JPG, PNG, TXT, DOC, DOCX, XLS, XLSX.';
  }
  if (file.size > ADJUNTOS_TAMANO_MAX) {
    return 'El archivo pesa ' + (file.size / 1024 / 1024).toFixed(1) + 'MB — el máximo permitido es 10MB.';
  }
  return null;
}

function _adjuntosLeerBase64(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = function() { reject(new Error('No se pudo leer el archivo')); };
    reader.readAsDataURL(file);
  });
}

function _adjuntosEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

// Pinta la lista de adjuntos + botón de subir dentro de containerId.
// adjuntosData viene con la forma { adjId1: {...}, adjId2: {...} } tal
// cual sale de RTDB (o null/undefined si todavía no hay ninguno).
function adjuntosRenderSeccion(containerId, apiUrl, modulo, id, adjuntosData, subidoPor) {
  const cont = document.getElementById(containerId);
  if (!cont) return;

  const lista = adjuntosData
    ? Object.keys(adjuntosData).map(function(k) { const a = Object.assign({}, adjuntosData[k]); a._id = k; return a; })
    : [];
  lista.sort(function(a, b) { return new Date(b.fecha || 0) - new Date(a.fecha || 0); });

  const itemsHtml = lista.length ? lista.map(function(a) {
    const kb = a.tamano ? (a.tamano / 1024).toFixed(0) + ' KB' : '';
    return '<div class="adj-item" style="display:flex;align-items:center;gap:8px;padding:8px 10px;' +
        'border:1px solid rgba(148,163,184,.25);border-radius:8px;margin-bottom:6px;">' +
      '<span style="font-size:16px;flex-shrink:0;">📎</span>' +
      '<a href="' + a.url + '" target="_blank" rel="noopener noreferrer" ' +
        'style="flex:1;min-width:0;font-size:12px;color:inherit;text-decoration:none;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;font-weight:600;" title="' + _adjuntosEsc(a.nombre) + '">' +
        _adjuntosEsc(a.nombre || 'archivo') + '</a>' +
      '<span style="font-size:10px;opacity:.55;white-space:nowrap;flex-shrink:0;">' + kb + '</span>' +
      '<button onclick="adjuntosBorrar(\'' + apiUrl + '\',\'' + modulo + '\',\'' + id + '\',\'' + a._id + '\',\'' + containerId + '\')" ' +
        'title="Borrar" style="background:transparent;border:none;cursor:pointer;font-size:14px;color:#f87171;flex-shrink:0;padding:2px 4px;">✕</button>' +
    '</div>';
  }).join('') : '<div style="font-size:11px;opacity:.55;padding:4px 0 8px;">Sin adjuntos todavía.</div>';

  cont.innerHTML =
    '<div id="' + containerId + '-lista">' + itemsHtml + '</div>' +
    '<input type="file" id="' + containerId + '-input" style="display:none;" ' +
      'accept=".pdf,.jpg,.jpeg,.png,.txt,.doc,.docx,.xls,.xlsx" ' +
      'onchange="adjuntosSubir(\'' + apiUrl + '\',\'' + modulo + '\',\'' + id + '\',this,\'' + containerId + '\',\'' + _adjuntosEsc(subidoPor).replace(/'/g,"\\'") + '\')">' +
    '<button onclick="document.getElementById(\'' + containerId + '-input\').click()" ' +
      'style="width:100%;padding:9px;border-radius:8px;background:transparent;border:1px dashed rgba(58,134,255,.4);' +
      'cursor:pointer;font-size:11px;font-weight:700;color:#3a86ff;">+ Adjuntar archivo (máx. 10MB)</button>' +
    '<div id="' + containerId + '-status" style="font-size:10px;margin-top:6px;"></div>';
}

async function adjuntosSubir(apiUrl, modulo, id, inputEl, containerId, subidoPor) {
  const file = inputEl.files[0];
  if (!file) return;
  const statusEl = document.getElementById(containerId + '-status');

  const error = _adjuntosValidarArchivo(file);
  if (error) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">⚠️ ' + _adjuntosEsc(error) + '</span>';
    inputEl.value = '';
    return;
  }

  if (statusEl) statusEl.innerHTML = '<span style="color:#3a86ff;">⏳ Subiendo...</span>';
  try {
    const base64 = await _adjuntosLeerBase64(file);
    const resp = await fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        accion: 'subirAdjunto', modulo: modulo, idRegistro: id,
        nombre: file.name, tipoMime: file.type || 'application/octet-stream',
        base64: base64, subidoPorNombre: subidoPor,
      })
    });
    const textoCrudo = await resp.text();
    let r;
    try { r = JSON.parse(textoCrudo); }
    catch(eParse) {
      if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">⚠️ Respuesta inválida del servidor.</span>';
      console.error('[adjuntos.js] respuesta cruda:', textoCrudo);
      inputEl.value = '';
      return;
    }
    if (!r.ok) {
      if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">⚠️ ' + _adjuntosEsc(r.error || r.message || 'No se pudo subir') + '</span>';
      inputEl.value = '';
      return;
    }
    if (statusEl) statusEl.innerHTML = '<span style="color:#06d6a0;">✅ Subido</span>';
    inputEl.value = '';
    if (typeof adjuntosRecargar === 'function') await adjuntosRecargar(modulo, id, containerId);
  } catch(e) {
    console.error('[adjuntos.js] Error subiendo:', e);
    if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">⚠️ Error de conexión.</span>';
    inputEl.value = '';
  }
}

async function adjuntosBorrar(apiUrl, modulo, id, adjId, containerId) {
  if (!confirm('¿Borrar este adjunto? No se puede deshacer.')) return;
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accion: 'eliminarAdjunto', modulo: modulo, idRegistro: id, adjId: adjId })
    });
    const r = await resp.json();
    if (!r.ok) { alert('No se pudo borrar el adjunto: ' + (r.error || r.message || 'error desconocido')); return; }
    if (typeof adjuntosRecargar === 'function') await adjuntosRecargar(modulo, id, containerId);
  } catch(e) {
    alert('Error de conexión al borrar el adjunto.');
  }
}
