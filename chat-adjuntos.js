// Portal TLC | chat-adjuntos.js | v2026.10.15.4 (Cristian: "en los mensajes internos, adjuntar imagen y enviar el mensaje" → "imágenes, pdfs, xls, comenzá!")
// 📎 Adjuntar una foto, un PDF o un Excel a un mensaje interno (Servicio,
// Ventas, Eventos / Comex / Regulatoria / Contabilidad).
// - Botón 📎 al lado del 🎤 / Enviar. En el celular abre cámara o archivos.
//   En la PC también se puede PEGAR una captura (Ctrl+V) en el cuadro.
// - El archivo sube enseguida (las fotos se achican antes) y queda un
//   "chip" arriba de Enviar; se puede mandar con o sin texto.
// - Al enviar, este archivo agrega el adjunto al pedido de siempre
//   (st_agregarMensaje / cot_agregarMensaje / ev_agregarMensaje); las
//   funciones lo guardan en el mensaje como m.adjunto = { url, tipo, nombre, tamano }.
// - TLCChatAdj.html(m.adjunto): miniatura (se abre en grande) o tarjeta de archivo.
// Usa la misma lista que dictado.js: window.DICTADO_CAMPOS = [{ textarea, enviar }].
(function () {
  'use strict';
  if (window.TLCChatAdj) return;
  var URL_FN = 'https://us-central1-portal-tlc.cloudfunctions.net/servicio';
  var MAX_LADO = 1800, MAX_BYTES = 10 * 1024 * 1024;
  var ACCIONES = { st_agregarMensaje: 1, cot_agregarMensaje: 1, ev_agregarMensaje: 1 };
  var TIPOS = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'application/pdf': 1, 'application/vnd.ms-excel': 1,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1 };
  var EXT = { pdf: 'application/pdf', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var pendientes = {}; // idTextarea -> { estado: 'subiendo'|'listo', adjunto, nombre }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sesion() { try { var r = JSON.parse(localStorage.getItem('tlc_session_v1') || 'null'); return r ? (r.account || r) : null; } catch (e) { return null; } }
  function modulo() { var p = location.pathname.split('/').pop() || ''; return /cotizaciones/.test(p) ? 'ventas' : /eventos/.test(p) ? 'eventos' : 'servicio'; }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function icono(tipo, nombre) { return /pdf/.test(tipo) || /\.pdf$/i.test(nombre) ? '📕' : /sheet|excel/.test(tipo) || /\.xlsx?$/i.test(nombre) ? '📗' : '📄'; }

  var css = document.createElement('style');
  css.textContent =
    '.adj-fila{display:flex;align-items:center;gap:8px;margin-top:8px}.adj-fila>.dictado-fila{flex:1;margin-top:0}.adj-fila>button:last-child{flex:1}' +
    '.adj-btn{flex-shrink:0;width:42px;height:38px;border-radius:10px;border:1px solid rgba(148,163,184,.4);background:transparent;font-size:18px;cursor:pointer}' +
    '.adj-btn:hover{border-color:#3a86ff}' +
    '.adj-chip{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 8px;border:1px dashed rgba(58,134,255,.5);border-radius:10px;font:600 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:rgba(58,134,255,.06)}' +
    '.adj-chip img{width:40px;height:40px;object-fit:cover;border-radius:6px}.adj-chip .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.adj-chip button{border:none;background:transparent;color:#94a3b8;font-size:14px;cursor:pointer}' +
    '.adj-msg-img{display:block;max-width:220px;max-height:220px;border-radius:10px;margin-top:6px;cursor:zoom-in;border:1px solid rgba(148,163,184,.3)}' +
    '.adj-msg-file{display:inline-flex;align-items:center;gap:8px;margin-top:6px;padding:7px 10px;border-radius:10px;border:1px solid rgba(148,163,184,.4);text-decoration:none;color:inherit;font-size:12px;max-width:100%}' +
    '.adj-msg-file b{display:block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.adj-msg-file small{opacity:.7}' +
    '#adj-lightbox{position:fixed;inset:0;z-index:100001;background:rgba(3,7,18,.92);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:14px}' +
    '#adj-lightbox img{max-width:100%;max-height:calc(100vh - 90px);border-radius:10px}' +
    '#adj-lightbox div{display:flex;gap:10px}#adj-lightbox a,#adj-lightbox button{background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:20px;padding:8px 14px;font:700 13px system-ui,sans-serif;text-decoration:none;cursor:pointer}';
  document.head.appendChild(css);

  // ── Subida ─────────────────────────────────────────────────────────
  function leer(f) { return new Promise(function (ok, mal) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = mal; r.readAsDataURL(f); }); }
  function achicar(dataUrl) {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_LADO / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        ok(c.toDataURL('image/jpeg', 0.84));
      };
      img.onerror = function () { ok(dataUrl); };
      img.src = dataUrl;
    });
  }
  function subir(idTa, f) {
    var ext = (String(f.name || '').split('.').pop() || '').toLowerCase();
    var tipo = TIPOS[f.type] ? f.type : (EXT[ext] || f.type);
    var esImg = /^image\//.test(tipo) || /^image\//.test(f.type);
    if (!TIPOS[tipo] && !esImg) { alert('Solo fotos, PDF o Excel (xls / xlsx).'); return; }
    if (f.size > 25 * 1024 * 1024) { alert('El archivo es muy pesado (máx. 10 MB).'); return; }
    var nombre = f.name || (esImg ? 'foto.jpg' : 'archivo');
    pendientes[idTa] = { estado: 'subiendo', nombre: nombre };
    revisar();
    leer(f).then(function (d) { return esImg ? achicar(d) : d; }).then(function (d) {
      var m = d.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) throw new Error('No se pudo leer el archivo');
      var mime = esImg ? 'image/jpeg' : tipo;
      if (esImg) nombre = nombre.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
      if (Math.floor(m[2].length * 3 / 4) > MAX_BYTES) throw new Error('El archivo pesa más de 10 MB');
      return fetch(URL_FN, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({
        accion: 'subirArchivoMensaje', modulo: modulo(), tipoMime: mime, base64: m[2], archivo: nombre }) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || 'Error al subir');
          if (!pendientes[idTa]) return; // lo cancelaron mientras subía
          pendientes[idTa] = { estado: 'listo', nombre: nombre, adjunto: { url: r.url, path: r.path, tipo: mime, nombre: nombre, tamano: r.tamano || 0 } };
          revisar();
          var ta = document.getElementById(idTa); if (ta) ta.focus();
        });
    }).catch(function (e) { delete pendientes[idTa]; revisar(); alert('No se pudo adjuntar: ' + e.message); });
  }
  function elegir(idTa) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*,application/pdf,.pdf,.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    inp.style.display = 'none';
    inp.onchange = function () { var f = inp.files && inp.files[0]; inp.remove(); if (f) subir(idTa, f); };
    document.body.appendChild(inp); inp.click();
  }

  // ── Botón 📎 y chip ────────────────────────────────────────────────
  function chipHtml(p) {
    if (p.estado === 'subiendo') return '⏳ <span class="n">Subiendo ' + esc(p.nombre) + '…</span>';
    var a = p.adjunto;
    return (/^image\//.test(a.tipo) ? '<img src="' + esc(a.url) + '" alt="">' : '<span style="font-size:22px">' + icono(a.tipo, a.nombre) + '</span>') +
      '<span class="n">📎 ' + esc(a.nombre) + '</span><button type="button" title="Quitar">✕</button>';
  }
  function enganchar(cfg) {
    var ta = document.getElementById(cfg.textarea), env = document.getElementById(cfg.enviar);
    if (!ta || !env) return;
    var btn = document.querySelector('.adj-btn[data-for="' + cfg.textarea + '"]');
    if (!btn || !document.body.contains(btn)) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'adj-btn'; btn.setAttribute('data-for', cfg.textarea);
      btn.title = 'Adjuntar foto, PDF o Excel'; btn.textContent = '📎';
      btn.addEventListener('click', function () { elegir(cfg.textarea); });
    }
    // Fila: [📎] [🎤 Enviar] (si hay dictado) o [📎] [Enviar]
    var fila = btn.parentNode && btn.parentNode.classList.contains('adj-fila') ? btn.parentNode : null;
    var objetivo = env.parentNode && env.parentNode.classList && env.parentNode.classList.contains('dictado-fila') ? env.parentNode : env;
    if (!fila || objetivo.parentNode !== fila) {
      if (fila && fila !== objetivo.parentNode) fila.remove();
      fila = document.createElement('div'); fila.className = 'adj-fila';
      objetivo.parentNode.insertBefore(fila, objetivo);
      fila.appendChild(btn); fila.appendChild(objetivo);
      if (objetivo === env) { env.style.marginTop = '0'; }
    }
    // Chip del archivo pendiente
    var chip = document.querySelector('.adj-chip[data-for="' + cfg.textarea + '"]');
    var p = pendientes[cfg.textarea];
    if (!p) { if (chip) chip.remove(); return; }
    if (!chip || !document.body.contains(chip)) {
      chip = document.createElement('div'); chip.className = 'adj-chip'; chip.setAttribute('data-for', cfg.textarea);
      fila.parentNode.insertBefore(chip, fila);
    }
    var firma = p.estado + '|' + (p.adjunto ? p.adjunto.url : p.nombre);
    if (chip.getAttribute('data-firma') !== firma) {
      chip.setAttribute('data-firma', firma);
      chip.innerHTML = chipHtml(p);
      var x = chip.querySelector('button');
      if (x) x.onclick = function () { delete pendientes[cfg.textarea]; revisar(); };
    }
  }
  function campos() { return window.DICTADO_CAMPOS || []; }
  function revisar() { campos().forEach(enganchar); }
  var pend = false;
  new MutationObserver(function () { if (pend) return; pend = true; requestAnimationFrame(function () { pend = false; revisar(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', revisar); else revisar();

  // Pegar una captura (Ctrl+V) en el cuadro del mensaje
  document.addEventListener('paste', function (ev) {
    var t = ev.target; if (!t || !t.id) return;
    if (!campos().some(function (c) { return c.textarea === t.id; })) return;
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f && /^image\//.test(f.type)) { ev.preventDefault(); subir(t.id, f); return; } }
    }
  });

  // ── Agregar el adjunto al pedido de envío ─────────────────────────
  // Envuelve fetch (igual que version.js): si es un envío de mensaje y hay
  // un archivo listo para ese chat, lo suma al pedido; si salió bien, lo limpia.
  var fetchOrig = window.fetch;
  window.fetch = function (url, opts) {
    try {
      if (opts && typeof opts.body === 'string' && opts.body.indexOf('agregarMensaje') !== -1) {
        var b = JSON.parse(opts.body);
        if (ACCIONES[b.accion]) {
          var idTa = (campos()[0] || {}).textarea;
          var p = idTa && pendientes[idTa];
          if (p && p.estado === 'listo') {
            b.adjunto = p.adjunto;
            opts = Object.assign({}, opts, { body: JSON.stringify(b) });
            return fetchOrig.call(this, url, opts).then(function (r) {
              r.clone().json().then(function (j) { if (j && j.ok) { delete pendientes[idTa]; revisar(); } }).catch(function () {});
              return r;
            });
          }
        }
      }
    } catch (e) {}
    return fetchOrig.apply(this, arguments);
  };

  // ── Mostrar un adjunto en el chat ─────────────────────────────────
  function html(a) {
    if (!a || !a.url || String(a.url).indexOf('https://firebasestorage.googleapis.com/') !== 0) return '';
    if (/^image\//.test(a.tipo || '')) return '<img class="adj-msg-img" loading="lazy" src="' + esc(a.url) + '" alt="' + esc(a.nombre || 'foto') + '" onclick="event.stopPropagation();TLCChatAdj.ver(this.src)">';
    return '<a class="adj-msg-file" href="' + esc(a.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()"><span style="font-size:22px">' + icono(a.tipo, a.nombre) + '</span><span><b>' + esc(a.nombre || 'archivo') + '</b><small>' + (a.tamano ? kb(a.tamano) + ' · ' : '') + 'Abrir</small></span></a>';
  }
  function ver(src) {
    var el = document.createElement('div'); el.id = 'adj-lightbox';
    el.innerHTML = '<img src="' + esc(src) + '" alt=""><div><a href="' + esc(src) + '" target="_blank" rel="noopener">⬇️ Abrir / descargar</a><button type="button">✕ Cerrar</button></div>';
    el.onclick = function (ev) { if (ev.target === el || ev.target.tagName === 'BUTTON') el.remove(); };
    document.body.appendChild(el);
  }
  // ¿Hay un archivo listo para mandar? (para dejar enviar sin texto)
  function pendiente(idTa) { var p = pendientes[idTa]; return !!(p && p.estado === 'listo'); }
  function subiendo(idTa) { var p = pendientes[idTa]; return !!(p && p.estado === 'subiendo'); }

  window.TLCChatAdj = { html: html, ver: ver, pendiente: pendiente, subiendo: subiendo, elegir: elegir };
})();
