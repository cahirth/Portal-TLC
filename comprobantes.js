// Portal TLC | comprobantes.js | v2026.10.15.1 (Cristian: "agregar a los gastos, en los módulos que lo soportan, un botón para enviar las fotos de los tickets" — comprobante de compra, en todos los módulos con control de gastos)
// 🧾 Comprobante de cada gasto: botón "📷 Comprobante" para sacar la foto con el
// celular (o elegir una imagen / PDF) y "🧾 Ver" para abrirla.
// - Las fotos se achican antes de subir (máx. 1600 px, JPG) para que suban rápido.
// - Se suben a Firebase Storage con la función servicio (acción
//   subirComprobanteGasto). En el gasto queda solo el link:
//   g.comprobante = { url, tipo, nombre, subido_por, fecha }.
// - Cada módulo guarda el gasto con su propia acción de siempre
//   (st_actualizarGastos, ev_actualizarGastos, cot_actualizarGastos,
//   editarGastoGeneral), así que no cambia nada más.
// Lo usan servicio.html, eventos.html (Eventos / Comex / Regulatoria /
// Contabilidad), cotizaciones.html y cuenta-corriente.html.
(function () {
  if (window.TLCComprobante) return;
  var URL_FN = 'https://us-central1-portal-tlc.cloudfunctions.net/servicio';
  var MAX_LADO = 1600;
  var MAX_BYTES = 10 * 1024 * 1024;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sesion() { try { var r = JSON.parse(localStorage.getItem('tlc_session_v1') || 'null'); return r ? (r.account || r) : null; } catch (e) { return null; } }

  var CSS = '.tlc-comp{display:inline-flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap}' +
    '.tlc-comp button,.tlc-comp a{display:inline-flex;align-items:center;gap:4px;font:700 11.5px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:8px;padding:5px 10px;cursor:pointer;text-decoration:none;border:1px dashed rgba(58,134,255,.55);background:rgba(58,134,255,.07);color:#3a86ff}' +
    '.tlc-comp a.ok{border-style:solid;border-color:rgba(6,214,160,.55);background:rgba(6,214,160,.1);color:#059669}' +
    '.tlc-comp .x{border:none;background:transparent;color:#94a3b8;padding:4px 6px}' +
    '.tlc-comp .sin{font:600 10.5px system-ui,sans-serif;color:#94a3b8}' +
    '.tlc-comp button:disabled{opacity:.6;cursor:wait}' +
    '#tlc-comp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100000;background:#0f172a;color:#fff;font:700 13px system-ui,sans-serif;padding:10px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:none}';
  function css() { if (document.getElementById('tlc-comp-css')) return; var st = document.createElement('style'); st.id = 'tlc-comp-css'; st.textContent = CSS; document.head.appendChild(st); }
  function toast(t, ms) {
    css();
    var el = document.getElementById('tlc-comp-toast');
    if (!el) { el = document.createElement('div'); el.id = 'tlc-comp-toast'; document.body.appendChild(el); }
    el.textContent = t; el.style.display = t ? 'block' : 'none';
    clearTimeout(el._t); if (t && ms) el._t = setTimeout(function () { el.style.display = 'none'; }, ms);
  }

  // Botones para un gasto. opts.subir / opts.quitar: código JS (string) para los onclick.
  // opts.editable: false → solo "🧾 Ver" (o nada si no tiene).
  function html(g, opts) {
    css();
    opts = opts || {};
    var c = g && g.comprobante;
    if (c && c.url) {
      var titulo = 'Comprobante' + (c.subido_por ? ' · subido por ' + c.subido_por : '') + (c.fecha ? ' · ' + new Date(c.fecha).toLocaleString('es-AR') : '');
      return '<div class="tlc-comp"><a class="ok" href="' + esc(c.url) + '" target="_blank" rel="noopener" title="' + esc(titulo) + '">🧾 Ver comprobante</a>' +
        (opts.editable && opts.quitar ? '<button type="button" class="x" title="Quitar el comprobante" onclick="' + esc(opts.quitar) + '">✕</button>' : '') + '</div>';
    }
    if (!opts.editable || !opts.subir) return opts.mostrarSin ? '<div class="tlc-comp"><span class="sin">Sin comprobante</span></div>' : '';
    return '<div class="tlc-comp"><button type="button" title="Sacá una foto del ticket o elegí una imagen / PDF" onclick="' + esc(opts.subir) + '">📷 Comprobante</button></div>';
  }

  function elegirArchivo() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*,application/pdf';
      inp.style.display = 'none';
      inp.onchange = function () { var f = inp.files && inp.files[0]; inp.remove(); resolve(f || null); };
      document.body.appendChild(inp);
      inp.click();
    });
  }
  function leerDataURL(f) {
    return new Promise(function (ok, mal) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = mal; r.readAsDataURL(f); });
  }
  function achicar(dataUrl) {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_LADO / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        ok(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { ok(dataUrl); };
      img.src = dataUrl;
    });
  }

  // Abre la cámara / selector, sube y devuelve el objeto comprobante (o null si se canceló).
  // ctx = { modulo: 'servicio'|'ventas'|'eventos'|'general', idRegistro: '...' }
  function subir(ctx) {
    return elegirArchivo().then(function (f) {
      if (!f) return null;
      var esPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      var esImg = /^image\//.test(f.type);
      if (!esPdf && !esImg) { alert('Elegí una foto o un PDF.'); return null; }
      toast('📤 Subiendo comprobante…');
      return leerDataURL(f).then(function (d) { return esImg ? achicar(d) : d; }).then(function (d) {
        var m = d.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) throw new Error('No se pudo leer el archivo');
        if (Math.floor(m[2].length * 3 / 4) > MAX_BYTES) throw new Error('El archivo pesa más de 10 MB');
        var s = sesion() || {};
        return fetch(URL_FN, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({
          accion: 'subirComprobanteGasto', modulo: ctx.modulo, idRegistro: ctx.idRegistro,
          tipoMime: m[1], base64: m[2], archivo: esPdf ? f.name : 'comprobante.jpg',
          id_ticket: ctx.modulo === 'servicio' ? ctx.idRegistro : undefined,
          email_usuario: s.username || '', subidoPorNombre: s.name || s.username || ''
        }) }).then(function (r) { return r.json(); }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || 'Error al subir');
          toast('✅ Comprobante cargado', 2200);
          return { url: r.url, path: r.path, tipo: m[1], nombre: esPdf ? f.name : 'comprobante.jpg', subido_por: s.name || s.username || '', fecha: new Date().toISOString() };
        });
      }).catch(function (e) { toast(''); alert('No se pudo subir el comprobante: ' + e.message); return null; });
    });
  }

  // Borra el archivo (no crítico si falla). El gasto se limpia en cada módulo.
  function borrarArchivo(c) {
    if (!c || !c.path) return;
    fetch(URL_FN, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ accion: 'borrarComprobanteGasto', path: c.path }) }).catch(function () {});
  }

  window.TLCComprobante = { html: html, subir: subir, borrarArchivo: borrarArchivo, toast: toast };
})();
