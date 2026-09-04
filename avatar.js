// Portal TLC | avatar.js | v2 (2026.09.04) | Avatar único, fuente de verdad de TODO el Portal.
// ══════════════════════════════════════════════════════════════════
// Pedido por Cristian: "quiero unificar los avatares que estan en
// todos los modulos, lo quiero solo en index" — hasta acá había 4
// copias casi idénticas (index.html, servicio.html, cotizaciones.html,
// empresas.html, cada una con su propio HTML/CSS/JS con ids tipo
// avatar-menu-idx/-st/-cot) más este archivo (versión chica, para
// eventos.html/cuenta-corriente.html, que no tenían header propio).
// Ahora ESTE archivo es la única versión — index.html "gana": el menú
// completo (tema, Saludo WhatsApp, Push, Instalar app, cerrar sesión)
// se ve igual en TODOS los módulos.
//
// Posición: fijo arriba a la derecha (antes era flotante abajo a la
// derecha) — decisión de Cristian: "arriba a la derecha en el header,
// como index hoy". Como se inyecta con position:fixed, funciona igual
// tenga el módulo un header propio o no, sin tener que rearmar el
// layout de cada archivo.
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
// PUSH / INSTALAR APP — FASE APARTE (a propósito, no es un olvido):
// esos 2 botones dependen de infraestructura de Firebase Cloud
// Messaging (SDK cargado, Service Worker, tokens) que HOY solo existe
// en index.html/servicio.html/cotizaciones.html — cada uno ya define
// window._activarNotificacionesPush() y window._manejarClickInstalarApp()
// por su cuenta (esa parte NO se tocó, sigue viviendo en cada archivo).
// Este avatar.js los detecta con feature-detection: si la función
// existe en la página, muestra el botón y lo llama; si no existe
// (empresas.html/eventos.html/cuenta-corriente.html todavía no tienen
// esa infraestructura), el botón directamente no se muestra, en vez
// de mostrar un botón roto. Agregarles esa infraestructura es un paso
// aparte, acordado con Cristian para más adelante.
// ══════════════════════════════════════════════════════════════════
(function() {
  'use strict';
  var SESSION_KEY = 'tlc_session_v1';
  var TEMA_KEY    = 'tlc_tema';
  var WSP_KEY     = 'tlc_wsp_saludo';

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

  // ── Tema ──────────────────────────────────────────────────────
  // Mismo mecanismo exacto que ya usaba cada módulo por separado
  // (_aplicarTemaIdx/_aplicarTemaSt/_aplicarTemaCot/etc.) — misma
  // clave tlc_tema, mismo body.classList.toggle('tema-claro'). Se
  // reimplementa acá para que el toggle del menú funcione al toque
  // sin depender de que el módulo tenga su propia función con un
  // nombre particular.
  function leerTema() {
    try { return localStorage.getItem(TEMA_KEY) || 'dark'; } catch(e) { return 'dark'; }
  }

  function aplicarTema(tema) {
    if (tema === 'light') document.body.classList.add('tema-claro');
    else document.body.classList.remove('tema-claro');
    var btnOsc = document.getElementById('tlc-avatar-tema-oscuro');
    var btnCla = document.getElementById('tlc-avatar-tema-claro');
    if (btnOsc && btnCla) {
      if (tema === 'light') {
        btnOsc.style.background = 'transparent'; btnOsc.style.color = '#64748b';
        btnCla.style.background = '#1a4b8c';     btnCla.style.color = '#fff';
      } else {
        btnOsc.style.background = '#3a86ff'; btnOsc.style.color = '#fff';
        btnCla.style.background = 'transparent'; btnCla.style.color = '#64748b';
      }
    }
  }

  function setTema(tema) {
    try { localStorage.setItem(TEMA_KEY, tema); } catch(e) {}
    aplicarTema(tema);
    // Algunos módulos necesitan re-renderizar algo propio cuando
    // cambia el tema (ej. cotizaciones.html re-pinta el Kanban) —
    // avatar.js no sabe nada de eso, así que solo avisa con un evento
    // y cada módulo decide si le importa o no.
    try { window.dispatchEvent(new CustomEvent('tlc-tema-cambiado', { detail: { tema: tema } })); } catch(e) {}
  }

  // ── Saludo WhatsApp ──────────────────────────────────────────────
  function guardarSaludoWsp(val) {
    try { localStorage.setItem(WSP_KEY, val.trim()); } catch(e) {}
  }

  function initSaludoWsp() {
    var ta = document.getElementById('tlc-avatar-wsp-saludo');
    if (!ta) return;
    try { ta.value = localStorage.getItem(WSP_KEY) || ''; } catch(e) {}
  }

  // ── Push / Instalar app — feature-detection, ver comentario arriba ──
  function actualizarTextoPush() {
    var txt = document.getElementById('tlc-avatar-push-txt');
    if (!txt) return;
    if (!('Notification' in window)) { txt.textContent = 'No disponible en este navegador'; return; }
    if (Notification.permission === 'granted') txt.textContent = '🔔 Notificaciones activadas ✓';
    else if (Notification.permission === 'denied') txt.textContent = '🔔 Notificaciones bloqueadas (revisar navegador)';
    else txt.textContent = '🔔 Activar notificaciones';
  }

  function esStandalonePWA() {
    return (window.navigator.standalone === true) ||
           (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function inyectarCSS() {
    var css = '' +
      '.tlc-avatar-flotante{position:fixed;top:14px;right:14px;z-index:600;}' +
      '.tlc-avatar-btn{width:38px;height:38px;border-radius:50%;background:#1c2541;color:#3a86ff;' +
        'border:1px solid #222e50;font-size:12px;font-weight:800;cursor:pointer;' +
        'display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.28);}' +
      '.tlc-avatar-menu{display:none;position:absolute;top:48px;right:0;width:280px;' +
        'background:#0d1520;border:1px solid #1e3050;border-radius:16px;' +
        'box-shadow:0 16px 48px rgba(0,0,0,.6);overflow:hidden;font-family:inherit;}' +
      '.tlc-avatar-menu.abierto{display:block;animation:tlcAvatarFadeSlide .15s ease;}' +
      '@keyframes tlcAvatarFadeSlide{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:translateY(0);}}' +
      '.tlc-avatar-menu-head{padding:14px;border-bottom:1px solid #1e3050;display:flex;align-items:center;gap:10px;background:#080d14;}' +
      '.tlc-avatar-menu-icon{width:38px;height:38px;border-radius:50%;background:#1c2541;border:2px solid #3a86ff33;' +
        'display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#3a86ff;flex-shrink:0;}' +
      '.tlc-avatar-menu-nombre{font-size:13px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.tlc-avatar-menu-email{font-size:10px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.tlc-avatar-menu-rol{display:inline-block;margin-top:4px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;' +
        'padding:1px 7px;border-radius:20px;background:rgba(58,134,255,.15);color:#3a86ff;border:1px solid rgba(58,134,255,.25);}' +
      '.tlc-avatar-menu-cerrar{background:rgba(100,116,139,.15);border:1px solid #1e3050;border-radius:8px;color:#94a3b8;' +
        'width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:14px;line-height:1;}' +
      '.tlc-avatar-menu-body{padding:12px;display:flex;flex-direction:column;gap:10px;}' +
      '.tlc-avatar-box{background:#080d14;border:1px solid #1e3050;border-radius:10px;padding:10px 12px;}' +
      '.tlc-avatar-box-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:8px;}' +
      '.tlc-avatar-tema-switch{display:flex;background:#0a1628;border-radius:8px;overflow:hidden;border:1px solid #1e3050;}' +
      '.tlc-avatar-tema-switch button{flex:1;padding:8px;border:none;cursor:pointer;font-size:12px;font-weight:600;' +
        'display:flex;align-items:center;justify-content:center;gap:5px;transition:all .15s;}' +
      '.tlc-avatar-wsp-textarea{width:100%;background:#0a1628;border:1px solid #1e3050;border-radius:8px;color:#f1f5f9;' +
        'font-size:12px;padding:8px 10px;resize:none;line-height:1.4;outline:none;font-family:inherit;box-sizing:border-box;}' +
      '.tlc-avatar-menu-item{width:100%;padding:11px;border-radius:10px;background:transparent;border:1px solid #1e3050;' +
        'color:#f1f5f9;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
        'gap:8px;transition:background .15s;box-sizing:border-box;text-decoration:none;}' +
      '.tlc-avatar-menu-item:hover{background:rgba(58,134,255,.08);}' +
      '.tlc-avatar-menu-item-logout{border-color:#2d1a1a;color:#f87171;}' +
      '.tlc-avatar-menu-item-logout:hover{background:rgba(248,113,113,.08);}' +
      '.tlc-avatar-menu-ver{text-align:center;font-size:9px;color:#334155;padding:2px 14px 12px;}' +
      'body.tema-claro .tlc-avatar-btn{background:#e8f0fc !important;color:#1a4b8c !important;border-color:#cbd5e1 !important;}' +
      'body.tema-claro .tlc-avatar-menu{background:#ffffff !important;border-color:#e2e8f0 !important;box-shadow:0 16px 48px rgba(0,0,0,.12) !important;}' +
      'body.tema-claro .tlc-avatar-menu-head{background:#f8fafc !important;border-bottom-color:#e2e8f0 !important;}' +
      'body.tema-claro .tlc-avatar-menu-icon{background:#e8f0fc !important;color:#1a4b8c !important;}' +
      'body.tema-claro .tlc-avatar-menu-nombre{color:#0f172a !important;}' +
      'body.tema-claro .tlc-avatar-menu-email{color:#64748b !important;}' +
      'body.tema-claro .tlc-avatar-menu-rol{background:rgba(26,75,140,.08) !important;color:#1a4b8c !important;border-color:rgba(26,75,140,.2) !important;}' +
      'body.tema-claro .tlc-avatar-box,body.tema-claro .tlc-avatar-wsp-textarea,body.tema-claro .tlc-avatar-tema-switch{background:#ffffff !important;border-color:#cbd5e1 !important;}' +
      'body.tema-claro .tlc-avatar-menu-item{color:#0f172a !important;border-color:#cbd5e1 !important;}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function inyectarAvatar(account) {
    var ini = iniciales(account.name || account.username);
    var version = (typeof PORTAL_TLC_VERSION !== 'undefined') ? PORTAL_TLC_VERSION : '?';
    var rol = account.rol || 'Usuario';

    // Push/Instalar solo se muestran si el módulo YA tiene la función
    // real definida (ver comentario grande al principio del archivo).
    // "Instalar app" además se oculta si ya está corriendo como PWA
    // standalone — mismo criterio que ya usaba _chequearInstalacionIOS
    // en index.html (no tiene sentido ofrecer instalar algo que ya
    // está instalado).
    var hayPush     = typeof window._activarNotificacionesPush === 'function';
    var hayInstalar = typeof window._manejarClickInstalarApp === 'function' && !esStandalonePWA();

    var wrap = document.createElement('div');
    wrap.className = 'tlc-avatar-flotante';
    wrap.innerHTML =
      '<button class="tlc-avatar-btn" id="tlc-avatar-btn" title="' + (account.name || account.username || '') + '">' + ini + '</button>' +
      '<div class="tlc-avatar-menu" id="tlc-avatar-menu">' +
        '<div class="tlc-avatar-menu-head">' +
          '<div class="tlc-avatar-menu-icon">' + ini + '</div>' +
          '<div style="min-width:0;flex:1;">' +
            '<div class="tlc-avatar-menu-nombre">' + (account.name || '—') + '</div>' +
            '<div class="tlc-avatar-menu-email">' + (account.username || '—') + '</div>' +
            '<div class="tlc-avatar-menu-rol">' + rol + '</div>' +
          '</div>' +
          '<button class="tlc-avatar-menu-cerrar" id="tlc-avatar-cerrar-x" title="Cerrar">✕</button>' +
        '</div>' +
        '<div class="tlc-avatar-menu-body">' +
          '<div class="tlc-avatar-box">' +
            '<div class="tlc-avatar-box-label">Apariencia</div>' +
            '<div class="tlc-avatar-tema-switch">' +
              '<button id="tlc-avatar-tema-oscuro">🌙 Oscuro</button>' +
              '<button id="tlc-avatar-tema-claro">☀️ Claro</button>' +
            '</div>' +
          '</div>' +
          '<div class="tlc-avatar-box">' +
            '<div class="tlc-avatar-box-label">💬 Saludo WhatsApp</div>' +
            '<textarea class="tlc-avatar-wsp-textarea" id="tlc-avatar-wsp-saludo" rows="2" placeholder="Hola, le compartimos el presupuesto de TLC SRL: "></textarea>' +
            '<div style="font-size:10px;color:#334155;margin-top:3px;">Se guarda automáticamente · URL se agrega al final</div>' +
          '</div>' +
          (hayPush ? '<button class="tlc-avatar-menu-item" id="tlc-avatar-btn-push"><span id="tlc-avatar-push-txt">🔔 Activar notificaciones</span></button>' : '') +
          (hayInstalar ? '<button class="tlc-avatar-menu-item" id="tlc-avatar-btn-instalar">📲 Cómo instalar la app</button>' : '') +
          '<a class="tlc-avatar-menu-item" href="index.html">🏠 Volver al inicio</a>' +
          '<button class="tlc-avatar-menu-item tlc-avatar-menu-item-logout" id="tlc-avatar-cerrar-sesion">🚪 Cerrar sesión</button>' +
        '</div>' +
        '<div class="tlc-avatar-menu-ver">Portal TLC · v' + version + '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var btn  = document.getElementById('tlc-avatar-btn');
    var menu = document.getElementById('tlc-avatar-menu');
    function abrirMenu() {
      menu.classList.add('abierto');
      aplicarTema(leerTema());
      initSaludoWsp();
      if (hayPush) actualizarTextoPush();
    }
    function cerrarMenu() { menu.classList.remove('abierto'); }
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (menu.classList.contains('abierto')) cerrarMenu(); else abrirMenu();
    });
    document.getElementById('tlc-avatar-cerrar-x').addEventListener('click', function(e) { e.stopPropagation(); cerrarMenu(); });
    document.addEventListener('click', function(e) {
      if (!wrap.contains(e.target)) cerrarMenu();
    });
    document.getElementById('tlc-avatar-tema-oscuro').addEventListener('click', function() { setTema('dark'); });
    document.getElementById('tlc-avatar-tema-claro').addEventListener('click', function() { setTema('light'); });
    document.getElementById('tlc-avatar-wsp-saludo').addEventListener('input', function() { guardarSaludoWsp(this.value); });
    document.getElementById('tlc-avatar-cerrar-sesion').addEventListener('click', cerrarSesionAvatar);
    if (hayPush) {
      document.getElementById('tlc-avatar-btn-push').addEventListener('click', function() {
        window._activarNotificacionesPush();
        setTimeout(actualizarTextoPush, 300); // deja que la promesa de permiso resuelva antes de refrescar el texto
      });
    }
    if (hayInstalar) {
      document.getElementById('tlc-avatar-btn-instalar').addEventListener('click', function() {
        window._manejarClickInstalarApp();
      });
    }

    // Tema aplicado ya desde el arranque (no solo al abrir el menú) —
    // cada módulo ya lo hace por su cuenta ni bien carga la página
    // (para no arrancar en oscuro y "flashear" a claro), esto es
    // solo para que los botones Oscuro/Claro del menú arranquen ya
    // resaltando el que corresponde la primera vez que se abre.
    aplicarTema(leerTema());
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
