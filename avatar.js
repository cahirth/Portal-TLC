// Portal TLC | avatar.js | Avatar flotante reusable, con versión.
// ══════════════════════════════════════════════════════════════════
// Se carga DESPUÉS de version.js (para tener PORTAL_TLC_VERSION
// disponible) en cualquier módulo que no tenga su propio avatar en el
// header — hoy eventos.html y mi-dia.html. index.html tiene su propio
// avatar en el header (no usa este archivo, es más rico: campanita de
// notificaciones, saludo por WhatsApp, etc.) — este es la versión
// simple para el resto de los módulos.
//
//   <script src="version.js"></script>
//   <script src="avatar.js"></script>
//
// No hace falta llamar a ninguna función — se inyecta solo en cuanto
// el DOM está listo, leyendo la sesión de localStorage (tlc_session_v1,
// mismo criterio que el resto del Portal). Si no hay sesión, no
// muestra nada (cada módulo ya redirige a index.html por su cuenta si
// hace falta login).
//
// Pedido por Cristian: "mi dia y eventos no tienen avatar, podria
// haber 1 solo avatar flotante" — mismo patrón de "una sola fuente
// compartida" que ya usan version.js y permisos.js, en vez de repetir
// el HTML/CSS del avatar en cada archivo nuevo.
// ══════════════════════════════════════════════════════════════════
(function() {
  'use strict';
  var SESSION_KEY = 'tlc_session_v1';

  function leerSesion() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var payload = JSON.parse(raw);
      if (!payload.expira || Date.now() > payload.expira) return null;
      return payload.account || payload;
    } catch(e) { return null; }
  }

  function iniciales(nombre) {
    var partes = String(nombre || '').trim().split(' ').filter(Boolean);
    if (partes.length >= 2) return (partes[0][0] + partes[partes.length-1][0]).toUpperCase();
    return String(nombre || '?').substring(0,2).toUpperCase();
  }

  function cerrarSesionAvatar() {
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
    location.href = 'index.html';
  }

  function inyectarCSS() {
    var css = '' +
      '.tlc-avatar-flotante{position:fixed;bottom:18px;right:18px;z-index:60;}' +
      '.tlc-avatar-btn{width:44px;height:44px;border-radius:50%;background:var(--accent-blue,#3a86ff);color:#fff;' +
        'border:2px solid var(--panel-dark,#0f172a);font-size:14px;font-weight:800;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.28);}' +
      '.tlc-avatar-menu{display:none;position:absolute;bottom:52px;right:0;width:230px;' +
        'background:var(--panel-dark,#0f172a);border:1px solid var(--border-glow,#1e3050);border-radius:12px;' +
        'box-shadow:0 12px 36px rgba(0,0,0,.35);overflow:hidden;font-family:inherit;}' +
      '.tlc-avatar-menu.abierto{display:block;}' +
      '.tlc-avatar-menu-head{padding:12px 14px;border-bottom:1px solid var(--border-glow,#1e3050);}' +
      '.tlc-avatar-menu-nombre{font-size:13px;font-weight:700;color:var(--text-main,#f1f5f9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.tlc-avatar-menu-email{font-size:10px;color:var(--text-muted,#94a3b8);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.tlc-avatar-menu-rol{display:inline-block;margin-top:5px;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;' +
        'background:rgba(58,134,255,.15);color:var(--accent-blue,#3a86ff);}' +
      '.tlc-avatar-menu-item{display:block;width:100%;text-align:left;padding:10px 14px;font-size:12px;font-weight:600;' +
        'color:var(--text-main,#f1f5f9);background:none;border:none;cursor:pointer;text-decoration:none;box-sizing:border-box;}' +
      '.tlc-avatar-menu-item:hover{background:var(--panel-darker,#0a1424);}' +
      '.tlc-avatar-menu-ver{text-align:center;font-size:9px;color:var(--text-dim,#64748b);padding:8px 14px;border-top:1px solid var(--border-glow,#1e3050);}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function inyectarAvatar(account) {
    var ini = iniciales(account.name || account.username);
    var version = (typeof PORTAL_TLC_VERSION !== 'undefined') ? PORTAL_TLC_VERSION : '?';

    var wrap = document.createElement('div');
    wrap.className = 'tlc-avatar-flotante';
    wrap.innerHTML =
      '<button class="tlc-avatar-btn" id="tlc-avatar-btn" title="' + (account.name || account.username || '') + '">' + ini + '</button>' +
      '<div class="tlc-avatar-menu" id="tlc-avatar-menu">' +
        '<div class="tlc-avatar-menu-head">' +
          '<div class="tlc-avatar-menu-nombre">' + (account.name || '—') + '</div>' +
          '<div class="tlc-avatar-menu-email">' + (account.username || '—') + '</div>' +
          (account.rol ? '<div class="tlc-avatar-menu-rol">' + account.rol + '</div>' : '') +
        '</div>' +
        '<a class="tlc-avatar-menu-item" href="index.html">🏠 Volver al inicio</a>' +
        '<button class="tlc-avatar-menu-item" id="tlc-avatar-cerrar-sesion">🚪 Cerrar sesión</button>' +
        '<div class="tlc-avatar-menu-ver">Portal TLC · v' + version + '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var btn = document.getElementById('tlc-avatar-btn');
    var menu = document.getElementById('tlc-avatar-menu');
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      menu.classList.toggle('abierto');
    });
    document.addEventListener('click', function(e) {
      if (!wrap.contains(e.target)) menu.classList.remove('abierto');
    });
    document.getElementById('tlc-avatar-cerrar-sesion').addEventListener('click', cerrarSesionAvatar);
  }

  function init() {
    var account = leerSesion();
    if (!account) return; // sin sesión, no hay nada que mostrar acá
    inyectarCSS();
    inyectarAvatar(account);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
