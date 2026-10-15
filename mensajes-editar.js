// Portal TLC | mensajes-editar.js | v2026.10.15.1 (NUEVO — Cristian: "en ventas, lo podés hacer extensivo para todos los módulos con mensajes?")
// ✎ / ✕ Editar o borrar un mensaje interno PROPIO durante los primeros 2 minutos,
// como en Servicio Técnico. Lo usan Ventas (cotizaciones.html) y Eventos / Comex /
// Regulatoria / Contabilidad (eventos.html). Servicio tiene su propia versión.
// - Solo el autor, y solo 2 minutos (la función lo vuelve a controlar).
// - Pasados los 2 minutos los botones desaparecen solos (revisa cada 10 s).
// - Borrar deja "🚫 Mensaje eliminado" en su lugar (no se corren las respuestas
//   ni los tildes) y la función borra la foto / archivo adjunto.
// - Un mensaje que es solo una foto se puede editar para sumarle texto.
(function () {
  'use strict';
  if (window.TLCMsgEdit) return;
  var VENTANA_MS = 2 * 60 * 1000;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var css = document.createElement('style');
  css.textContent =
    '.tme-btn{background:transparent;border:none;cursor:pointer;font-size:11px;padding:2px 5px;border-radius:5px;color:#94a3b8}' +
    '.tme-btn:hover{color:#3a86ff;background:rgba(58,134,255,.1)}.tme-btn.del:hover{color:#ef4444;background:rgba(239,68,68,.1)}' +
    '.tme-borrado{font-style:italic;color:#94a3b8;font-size:12px}' +
    '.tme-edit textarea{width:100%;min-height:54px;padding:7px 9px;border-radius:8px;border:1.5px solid #3a86ff;background:transparent;color:inherit;font:inherit;font-size:12.5px;resize:vertical}' +
    '.tme-edit div{display:flex;gap:6px;margin-top:5px}' +
    '.tme-edit button{border-radius:7px;padding:5px 12px;font:700 11.5px system-ui,sans-serif;cursor:pointer;border:1px solid #3a86ff}' +
    '.tme-edit .ok{background:#3a86ff;color:#fff}.tme-edit .no{background:transparent;color:#94a3b8;border-color:rgba(148,163,184,.5)}';
  document.head.appendChild(css);

  function puede(m, email) {
    if (!m || m.borrado || !m.fecha || !email) return false;
    if (String(m.autor_email || '').trim().toLowerCase() !== String(email).trim().toLowerCase()) return false;
    return (Date.now() - new Date(m.fecha).getTime()) < VENTANA_MS;
  }

  // Botones ✎ ✕ (string vacío si no corresponde). jsEditar / jsBorrar: código para el onclick.
  function botones(m, email, jsEditar, jsBorrar) {
    if (!puede(m, email)) return '';
    var hasta = new Date(m.fecha).getTime() + VENTANA_MS;
    return '<button type="button" class="tme-btn" data-tme-hasta="' + hasta + '" onclick="' + esc(jsEditar) + '" title="Editar (disponible por 2 min)">✎</button>' +
      '<button type="button" class="tme-btn del" data-tme-hasta="' + hasta + '" onclick="' + esc(jsBorrar) + '" title="Borrar (disponible por 2 min)">✕</button>';
  }

  function borradoHtml() { return '<div class="msg-texto tme-borrado">🚫 Mensaje eliminado</div>'; }

  // Cambia el texto del mensaje por un cuadro para editar.
  // guardar(textoNuevo) → Promise que resuelve cuando se guardó (o rechaza con el error).
  function editar(elTexto, m, guardar, cancelar) {
    if (!elTexto) return;
    elTexto.innerHTML = '<div class="tme-edit"><textarea>' + esc(m.texto || '') + '</textarea><div><button type="button" class="ok">Guardar</button><button type="button" class="no">Cancelar</button></div></div>';
    var ta = elTexto.querySelector('textarea'), ok = elTexto.querySelector('.ok'), no = elTexto.querySelector('.no');
    ta.focus(); ta.selectionStart = ta.value.length;
    no.onclick = function (e) { e.stopPropagation(); cancelar(); };
    ok.onclick = function (e) {
      e.stopPropagation();
      var t = ta.value.trim();
      if (!t && !m.adjunto) { alert('El mensaje no puede quedar vacío — si querés eliminarlo, usá ✕.'); return; }
      if (!puede(m, m.autor_email)) { alert('Ya pasaron los 2 minutos — este mensaje ya no se puede editar.'); cancelar(); return; }
      ok.disabled = true; ok.textContent = 'Guardando…';
      Promise.resolve(guardar(t)).catch(function (err) {
        alert('No se pudo editar el mensaje: ' + ((err && err.message) || err || ''));
        ok.disabled = false; ok.textContent = 'Guardar';
      });
    };
  }

  // Pide confirmación y llama a borrar() → Promise.
  function confirmarBorrar(m, borrar) {
    if (!puede(m, m.autor_email)) { alert('Ya pasaron los 2 minutos — este mensaje ya no se puede borrar.'); return; }
    if (!confirm('¿Borrar este mensaje' + (m.adjunto ? ' (y su archivo adjunto)' : '') + '? No se puede deshacer.')) return;
    Promise.resolve(borrar()).catch(function (err) { alert('No se pudo borrar el mensaje: ' + ((err && err.message) || err || '')); });
  }

  // Llamada a la función: resuelve con r.mensajes o rechaza con el error.
  function pedir(url, cuerpo) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(cuerpo) })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (!r || !r.ok || !Array.isArray(r.mensajes)) throw new Error((r && r.error) || 'Error'); return r.mensajes; });
  }

  // Pasados los 2 minutos, los botones se van solos
  setInterval(function () {
    var ahora = Date.now();
    document.querySelectorAll('[data-tme-hasta]').forEach(function (b) { if (+b.getAttribute('data-tme-hasta') <= ahora) b.remove(); });
  }, 10000);

  window.TLCMsgEdit = { puede: puede, botones: botones, borradoHtml: borradoHtml, editar: editar, confirmarBorrar: confirmarBorrar, pedir: pedir };
})();
