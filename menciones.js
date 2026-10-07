// Portal TLC | menciones.js | v2026.10.06.7
// Lógica compartida de @menciones y "tildes" de lectura de los mensajes
// internos, usada por servicio.html, cotizaciones.html y eventos.html.
//
// 1) DETECCIÓN DE MENCIONES — igual que siempre: una mención vale solo
//    si el nombre se eligió de la lista que aparece al escribir "@"
//    (queda "@Nombre Apellido" completo y exacto). Cristian: "no quiero
//    que se escriba @Juan a mano... dejalo como antes, @ y lo elegís de
//    la lista". Un mensaje puede mencionar a varios (ej. "@Juan Garro
//    hacé X ... @Cristian Hirth estás informado") y les llega a todos.
//
// 2) TILDES DE LECTURA tipo WhatsApp — Cristian: "¿es posible tener una
//    tilde o dos tildes como WhatsApp? para ver si le llegó y si lo leyó".
//    En los mensajes con @menciones (enviados desde esta versión, que
//    llevan con_lectura:true):
//      ✓✓ gris  = enviado y avisado (campanita + push + mail)
//      ✓✓ azul  = TODOS los mencionados lo leyeron
//    Tocando las tildes se ve el detalle por persona (leído / respondió /
//    sin leer). "Leído" = abrió la tarjeta (el backend guarda la fecha en
//    mensaje.lecturas[<email>]). Responder después o reaccionar al mensaje
//    también cuenta como leído.
(function () {
  function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
  function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Misma clave que usa el backend (rtdbKeySeguro sobre el email en minúscula)
  function claveEmail(email) {
    var c = String(email || '').trim().toLowerCase().replace(/[.#$[\]/]/g, '_').replace(/[\s+]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
    return c.length > 200 ? c.substring(0, 200) : c;
  }

  // Devuelve los emails mencionados en el texto (sin repetir). Solo el
  // nombre completo y exacto, tal como lo deja la lista de "@".
  function detectar(texto, internos) {
    texto = String(texto || '');
    if (texto.indexOf('@') === -1) return [];
    var emails = [];
    (internos || []).forEach(function (p) {
      if (!p || !p.nombre || !p.email) return;
      if (texto.indexOf('@' + p.nombre) !== -1 && emails.indexOf(p.email) === -1) emails.push(p.email);
    });
    return emails;
  }

  // Resalta en azul las menciones (nombre completo) dentro de un texto YA escapado.
  function resaltar(textoEscapado, internos, estilo) {
    if (!textoEscapado || textoEscapado.indexOf('@') === -1 || !internos || !internos.length) return textoEscapado;
    var css = estilo || 'color:#3a86ff;font-weight:700;';
    var nombres = internos.filter(function (p) { return p && p.nombre; }).map(function (p) { return esc(p.nombre); })
      .sort(function (a, b) { return b.length - a.length; });
    if (!nombres.length) return textoEscapado;
    var re = new RegExp('@(' + nombres.map(escRegex).join('|') + ')', 'g');
    return textoEscapado.replace(re, '<span style="' + css + '">$&</span>');
  }

  function nombreDe(email, internos) {
    var e = String(email || '').toLowerCase();
    var p = (internos || []).find(function (x) { return String(x.email || '').toLowerCase() === e; });
    return p ? p.nombre : String(email || '').split('@')[0];
  }

  // Estado de lectura de un mensaje: [{email, nombre, leido(fecha|''), respondio('mensaje'|emoji|'')}]
  function estadoLectura(m, mensajes, indice, internos) {
    if (!m || !m.con_lectura) return null;
    var autor = String(m.autor_email || '').toLowerCase();
    var vistos = {};
    var mencionados = (Array.isArray(m.menciones) ? m.menciones : Object.values(m.menciones || {}))
      .map(function (e) { return String(e || '').toLowerCase(); })
      .filter(function (e) { if (!e || e === autor || vistos[e]) return false; vistos[e] = true; return true; });
    if (!mencionados.length) return null;
    var lecturas = m.lecturas || {};
    var reacciones = m.reacciones || {};
    var EMO = { ok: '👍', no_ok: '👎', corazon: '❤️' };
    return mencionados.map(function (e) {
      var k = claveEmail(e);
      var respondio = '';
      for (var j = indice + 1; j < (mensajes || []).length; j++) {
        if (mensajes[j] && String(mensajes[j].autor_email || '').toLowerCase() === e) { respondio = 'mensaje'; break; }
      }
      if (!respondio && reacciones[k]) {
        var r = reacciones[k];
        respondio = EMO[(r && typeof r === 'object') ? r.reaccion : r] || '👍';
      }
      return { email: e, nombre: nombreDe(e, internos), leido: lecturas[k] || (respondio ? 'si' : ''), respondio: respondio };
    });
  }

  function fechaCorta(iso) {
    if (!iso || iso === 'si') return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // HTML de las tildes (para poner al lado de la fecha del mensaje).
  function htmlTildes(m, mensajes, indice, internos) {
    var est = estadoLectura(m, mensajes, indice, internos);
    if (!est) return '';
    var todos = est.every(function (x) { return x.leido; });
    var algunos = est.filter(function (x) { return x.leido; }).length;
    var color = todos ? '#3a86ff' : '#94a3b8';
    var titulo = todos ? 'Leído por todos' : (algunos ? 'Leído por ' + algunos + ' de ' + est.length : 'Avisado — todavía sin leer');
    var datos = esc(JSON.stringify(est));
    return '<span class="tlc-tildes" role="button" tabindex="0" title="' + titulo + '" data-est="' + datos + '" ' +
      'onclick="TLCMenciones.verDetalle(event,this)" ' +
      'style="cursor:pointer;color:' + color + ';font-weight:800;font-size:12px;letter-spacing:-3px;margin-left:5px;padding:0 4px 0 1px;white-space:nowrap;">✓✓</span>';
  }

  // Popover con el detalle por persona
  function cerrarDetalle() {
    var el = document.getElementById('tlc-tildes-pop');
    if (el) el.remove();
    document.removeEventListener('click', cerrarDetalle, true);
  }
  function verDetalle(ev, el) {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    cerrarDetalle();
    var est = [];
    try { est = JSON.parse(el.getAttribute('data-est') || '[]'); } catch (e) {}
    var oscuro = document.body.classList.contains('light') ? false : getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    var bg = '#ffffff', fg = '#0f172a', mu = '#64748b', bd = '#e2e8f0';
    if (oscuro && oscuro.length >= 3 && (+oscuro[0] + +oscuro[1] + +oscuro[2]) < 200) { bg = '#0f1a30'; fg = '#f1f5f9'; mu = '#94a3b8'; bd = '#1e3050'; }
    var pop = document.createElement('div');
    pop.id = 'tlc-tildes-pop';
    pop.style.cssText = 'position:fixed;z-index:9600;min-width:220px;max-width:300px;background:' + bg + ';color:' + fg + ';border:1px solid ' + bd +
      ';border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.3);padding:10px 12px;font-size:12px;font-family:inherit;';
    pop.innerHTML = '<div style="font-weight:800;margin-bottom:6px;">Estado del mensaje</div>' + est.map(function (x) {
      var estado, color;
      if (x.respondio === 'mensaje') { estado = '↩ Respondió'; color = '#06a77d'; }
      else if (x.respondio) { estado = 'Reaccionó ' + x.respondio; color = '#06a77d'; }
      else if (x.leido) { estado = 'Leído ' + fechaCorta(x.leido); color = '#3a86ff'; }
      else { estado = 'Sin leer'; color = mu; }
      var tic = x.leido ? '<span style="color:#3a86ff;font-weight:800;letter-spacing:-3px;">✓✓</span>' : '<span style="color:' + mu + ';font-weight:800;letter-spacing:-3px;">✓✓</span>';
      return '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid ' + bd + ';">' +
        '<span>' + tic + '&nbsp; ' + esc(x.nombre) + '</span><span style="color:' + color + ';font-weight:700;white-space:nowrap;">' + esc(estado) + '</span></div>';
    }).join('') +
      '<div style="color:' + mu + ';font-size:10.5px;margin-top:6px;line-height:1.35;">✓✓ gris: avisado · ✓✓ azul: lo leyeron todos.<br>"Leído" = abrió la tarjeta.</div>';
    document.body.appendChild(pop);
    var r = el.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    setTimeout(function () { document.addEventListener('click', cerrarDetalle, true); }, 0);
  }

  // ¿Hay mensajes que me mencionan y todavía no marqué como leídos?
  function hayPendientesParaMi(mensajes, miEmail) {
    var yo = String(miEmail || '').toLowerCase();
    if (!yo) return false;
    var k = claveEmail(yo);
    return (mensajes || []).some(function (m) {
      if (!m || !m.con_lectura) return false;
      var men = (Array.isArray(m.menciones) ? m.menciones : Object.values(m.menciones || {})).map(function (e) { return String(e || '').toLowerCase(); });
      return men.indexOf(yo) !== -1 && !(m.lecturas && m.lecturas[k]);
    });
  }

  // Línea "Se va a avisar a: ..." debajo del cuadro de texto, para que
  // quien escribe vea ANTES de enviar a quién le llega el aviso.
  function textoAvisoDestinatarios(texto, internos, miEmail, extraEmails) {
    var yo = String(miEmail || '').toLowerCase();
    var emails = detectar(texto, internos);
    (extraEmails || []).forEach(function (e) { if (e && emails.indexOf(e) === -1) emails.push(e); });
    emails = emails.filter(function (e) { return String(e).toLowerCase() !== yo; });
    if (!emails.length) return '';
    return '🔔 Se va a avisar a: <b>' + emails.map(function (e) { return esc(nombreDe(e, internos)); }).join(', ') + '</b>';
  }

  window.TLCMenciones = {
    normalizar: normalizar, detectar: detectar, resaltar: resaltar, claveEmail: claveEmail,
    estadoLectura: estadoLectura, htmlTildes: htmlTildes, verDetalle: verDetalle, cerrarDetalle: cerrarDetalle,
    hayPendientesParaMi: hayPendientesParaMi, textoAvisoDestinatarios: textoAvisoDestinatarios, nombreDe: nombreDe,
  };
})();
