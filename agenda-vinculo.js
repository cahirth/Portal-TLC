// Portal TLC | agenda-vinculo.js | v2026.10.10.2
// Agenda — Etapa 2 (Cristian: "quiero hacer la 1 y 2, es lo que más necesito").
// Lo usan servicio.html (tickets y Órdenes de Preparación) y cotizaciones.html
// (negocios):
//   1) Botón "📅 Agendar" que abre calendario.html con título, cliente, tipo,
//      persona responsable y el vínculo al ticket/negocio precargados; al
//      guardar vuelve solo acá.
//   2) Franja "📅 Próxima visita: mié 14/10 9:30 · Damián 📌 ✓✓ Visto (+1 más)".
//   3) mapaVisitas(): qué tickets tienen visita agendada (para el 📅 de las tarjetas).
// La agenda está cerrada en las reglas de Firebase: todo se pide a la función agenda.
(function () {
  var AGENDA_URL = 'https://us-central1-portal-tlc.cloudfunctions.net/agenda';
  var CACHE_MS = 30000;
  var cache = {};       // entidad|id -> { t, r }
  var enCurso = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sesion() { try { var r = JSON.parse(localStorage.getItem('tlc_session_v1') || 'null'); return r ? (r.account || r) : null; } catch (e) { return null; } }
  function api(datos) {
    var s = sesion() || {};
    return fetch(AGENDA_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(Object.assign({ email_usuario: s.username || '', nombre_usuario: s.name || '' }, datos)) })
      .then(function (r) { return r.json(); });
  }
  function fechaCorta(f) { var d = new Date(f + 'T12:00:00Z'); return isNaN(d) ? f : d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }); }
  function cuando(e) {
    if (e.todo_el_dia) return fechaCorta(e.fecha) + (e.fecha_fin && e.fecha_fin !== e.fecha ? ' al ' + fechaCorta(e.fecha_fin) : '') + ' · todo el día';
    return fechaCorta(e.fecha) + ' · ' + e.hora_inicio + '–' + e.hora_fin;
  }
  function personaHtml(e, p) {
    var nombre = esc(String(p.nombre || p.email || '').split(' ')[0]);
    var creador = e.creado_por && e.creado_por.email === p.email;
    var estado = '';
    if (p.respuesta === 'pendiente') estado = ' <span style="color:#d97706" title="Invitación sin responder">⏳</span>';
    else if (p.respuesta === 'rechazado') return '<span style="opacity:.55;text-decoration:line-through" title="Rechazó">' + nombre + '</span>';
    else if (!creador && !p.respondido_en) estado = ' <span title="Asignado: es firme">📌</span>';
    var visto = creador ? '' : (p.visto_en
      ? ' <b style="color:#3a86ff;letter-spacing:-2px" title="Lo vio">✓✓</b>'
      : ' <b style="color:#94a3b8" title="Todavía no lo abrió">✓</b>');
    return '<span style="white-space:nowrap">' + nombre + estado + visto + '</span>';
  }
  function linkAgendar(o) {
    var q = ['nuevo=1', 'ref_entidad=' + encodeURIComponent(o.entidad), 'ref_id=' + encodeURIComponent(o.id),
      'ref_etiqueta=' + encodeURIComponent(o.etiqueta || o.id), 'titulo=' + encodeURIComponent(o.titulo || ''),
      'cliente=' + encodeURIComponent(o.cliente || ''), 'tipo=' + encodeURIComponent(o.tipo || ''),
      'personas=' + encodeURIComponent((o.personas || []).filter(Boolean).join(',')),
      'notas=' + encodeURIComponent(o.notas || ''), 'volver=' + encodeURIComponent(o.volver || '')];
    return 'calendario.html?' + q.join('&');
  }
  var BTN = 'display:inline-flex;align-items:center;gap:5px;padding:7px 12px;border-radius:9px;font-size:12px;font-weight:800;text-decoration:none;white-space:nowrap;';

  function html(o, r) {
    if (!r || !r.ok) return '';
    var agendar = r.puede_agendar ? '<a href="' + esc(linkAgendar(o)) + '" style="' + BTN + 'background:#ea580c;color:#fff;border:1px solid #ea580c;">📅 Agendar' + (r.proximas.length ? ' otra' : ' visita') + '</a>' : '';
    if (!r.proximas.length) {
      if (!agendar && !r.ultima) return '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:10px;border:1px dashed rgba(234,88,12,.45);background:rgba(234,88,12,.05);">' +
        '<span style="font-size:12.5px;font-weight:700;opacity:.85">📅 Sin visita agendada' + (r.ultima ? ' <span style="font-weight:600;opacity:.75">· última: ' + esc(fechaCorta(r.ultima.fecha)) + '</span>' : '') + '</span>' + agendar + '</div>';
    }
    var e = r.proximas[0];
    var personas = Object.keys(e.participantes || {}).map(function (k) { return personaHtml(e, e.participantes[k]); }).join(' · ');
    var mas = r.proximas.length > 1 ? ' <span style="font-size:11px;font-weight:800;color:#ea580c">+' + (r.proximas.length - 1) + ' más</span>' : '';
    return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-radius:10px;background:rgba(234,88,12,.08);border:1px solid rgba(234,88,12,.4);">' +
      '<a href="calendario.html?evento=' + encodeURIComponent(e.id) + '" style="flex:1;min-width:200px;text-decoration:none;color:inherit;" title="Abrir en la Agenda">' +
        '<span style="display:block;font-size:10.5px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:#ea580c">📅 Próxima visita' + (e.estado === 'tentativo' ? ' · tentativa' : '') + mas + '</span>' +
        '<span style="display:block;font-size:13px;font-weight:800;margin-top:2px">' + esc(cuando(e)) + '</span>' +
        '<span style="display:block;font-size:12px;margin-top:2px">' + personas + '</span>' +
      '</a>' + agendar + '</div>';
  }

  // Pinta la franja en el contenedor (usa caché y refresca en segundo plano)
  function pintar(contenedorId, o) {
    var el = document.getElementById(contenedorId);
    if (!el || !o || !o.id) return;
    var clave = o.entidad + '|' + o.id;
    el.setAttribute('data-ref', clave);
    var c = cache[clave];
    el.innerHTML = c ? html(o, c.r) : '';
    if ((c && Date.now() - c.t < CACHE_MS) || enCurso[clave]) return;
    enCurso[clave] = true;
    api({ accion: 'ag_porReferencia', entidad: o.entidad, id: o.id }).then(function (r) {
      cache[clave] = { t: Date.now(), r: r };
      var el2 = document.getElementById(contenedorId);
      if (el2 && el2.getAttribute('data-ref') === clave) el2.innerHTML = html(o, r);
    }).catch(function () {}).then(function () { delete enCurso[clave]; });
  }

  // { refId: { n, id, fecha, hora_inicio, todo_el_dia } }
  function mapaVisitas(entidad) {
    return api({ accion: 'ag_referenciasConVisita', entidad: entidad }).then(function (r) { return (r && r.ok && r.visitas) || {}; }).catch(function () { return {}; });
  }
  function chip(v) {
    if (!v) return '';
    return '<span title="Visita agendada' + (v.n > 1 ? ' (' + v.n + ')' : '') + '" style="display:inline-block;font-size:9.5px;font-weight:800;padding:2px 6px;border-radius:8px;background:rgba(234,88,12,.14);color:#ea580c;white-space:nowrap;">📅 ' +
      esc(fechaCorta(v.fecha)) + (v.hora_inicio && !v.todo_el_dia ? ' ' + esc(v.hora_inicio) : '') + '</span>';
  }

  window.TLCAgendaVinculo = { pintar: pintar, mapaVisitas: mapaVisitas, chip: chip, linkAgendar: linkAgendar, _html: html };
})();
