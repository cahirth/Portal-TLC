// Portal TLC | dictado.js | v2026.10.02.1
// Cristian: "¿se podría hacer en mensajes internos dictado por voz?... quiero
// el micrófono en los 3 módulos". Agrega un botón 🎤 al lado de "Enviar" en
// los chats de Cotizaciones, Servicio Técnico y Eventos.
//
// Cómo funciona:
// - Usa el reconocimiento de voz del propio navegador (Web Speech API), en
//   español de Argentina. Sin backend y sin costo.
// - Tocar 🎤 empieza a escuchar; el texto va apareciendo en el cuadro (se
//   agrega a lo que ya estaba escrito). Tocar de nuevo, o tocar "Enviar",
//   lo detiene. NUNCA envía solo: el mensaje se revisa y se envía a mano.
// - Si el navegador no lo soporta (o es la PWA instalada en iPhone, donde
//   el soporte es irregular), el botón no aparece y queda el micrófono del
//   teclado del celular.
// - Los paneles de mensajes se vuelven a dibujar seguido (innerHTML), así
//   que el botón se re-engancha solo con un MutationObserver.
//
// Uso en cada página (antes de cargar este archivo):
//   window.DICTADO_CAMPOS = [{ textarea: 'id-del-textarea', enviar: 'id-del-boton-enviar' }];
(function () {
  'use strict';

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var esPWAInstalada = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (esIOS && esPWAInstalada) return;

  var campos = window.DICTADO_CAMPOS || [];
  if (!campos.length) return;

  var rec = null;          // reconocimiento activo
  var textareaActivo = null;
  var botonActivo = null;

  var estilo = document.createElement('style');
  estilo.textContent =
    '.dictado-btn{flex:0 0 44px;width:44px;border-radius:8px;border:1px solid rgba(58,134,255,.45);' +
    'background:transparent;color:#3a86ff;font-size:17px;cursor:pointer;display:flex;align-items:center;' +
    'justify-content:center;padding:0;line-height:1;}' +
    '.dictado-btn.escuchando{background:#ef4444;border-color:#ef4444;color:#fff;animation:dictadoPulso 1.2s infinite;}' +
    '@keyframes dictadoPulso{0%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}70%{box-shadow:0 0 0 9px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}' +
    '.dictado-fila{display:flex;gap:8px;margin-top:8px;align-items:stretch;}';
  document.head.appendChild(estilo);

  function avisar(msg) {
    if (typeof window.toast === 'function') { try { window.toast(msg); return; } catch (e) {} }
    alert(msg);
  }

  function detener() {
    if (rec) { try { rec.stop(); } catch (e) {} }
  }

  function limpiarEstado() {
    if (botonActivo) { botonActivo.classList.remove('escuchando'); botonActivo.title = 'Dictar por voz'; }
    rec = null; textareaActivo = null; botonActivo = null;
  }

  function empezar(textarea, boton) {
    if (rec) { detener(); return; }

    var r = new SR();
    r.lang = 'es-AR';
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;

    var original = textarea.value;
    var base = original;
    if (base && !/\s$/.test(base)) base += ' ';
    var finales = '';

    r.onresult = function (ev) {
      var provisorio = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var txt = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finales += txt.trim() + ' ';
        else provisorio += txt;
      }
      textarea.value = base + finales + provisorio;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.scrollTop = textarea.scrollHeight;
    };
    r.onerror = function (ev) {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        avisar('🎤 Permití el acceso al micrófono para dictar (ícono del candado, al lado de la dirección).');
      } else if (ev.error === 'no-speech') {
        // silencio: se corta solo, sin aviso
      } else if (ev.error !== 'aborted') {
        console.warn('[dictado.js] error:', ev.error);
      }
    };
    r.onend = function () {
      textarea.value = finales ? (base + finales) : original; // sin nada dictado, queda exactamente como estaba
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      limpiarEstado();
    };

    try {
      r.start();
    } catch (e) {
      console.warn('[dictado.js] no se pudo iniciar:', e);
      return;
    }
    rec = r; textareaActivo = textarea; botonActivo = boton;
    boton.classList.add('escuchando');
    boton.title = 'Escuchando… tocá para terminar';
    textarea.focus();
  }

  function engancharCampo(cfg) {
    var textarea = document.getElementById(cfg.textarea);
    var enviar = document.getElementById(cfg.enviar);
    if (!textarea || !enviar) return;
    if (enviar.parentNode && enviar.parentNode.classList && enviar.parentNode.classList.contains('dictado-fila')) return;

    var fila = document.createElement('div');
    fila.className = 'dictado-fila';
    enviar.parentNode.insertBefore(fila, enviar);

    var boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'dictado-btn';
    boton.title = 'Dictar por voz';
    boton.setAttribute('aria-label', 'Dictar por voz');
    boton.textContent = '🎤';
    boton.addEventListener('click', function () { empezar(textarea, boton); });

    fila.appendChild(boton);
    fila.appendChild(enviar);
    enviar.style.marginTop = '0';
    enviar.style.width = 'auto';
    enviar.style.flex = '1';

    // Enviar corta el dictado (el texto ya quedó en el cuadro)
    enviar.addEventListener('click', function () { if (textareaActivo === textarea) detener(); }, true);

    // Si el panel se re-dibujó mientras se dictaba en el cuadro viejo, cortar
    if (textareaActivo && !document.body.contains(textareaActivo)) detener();
  }

  function revisar() { campos.forEach(engancharCampo); }

  var pendiente = false;
  var obs = new MutationObserver(function () {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(function () { pendiente = false; revisar(); });
  });

  function iniciar() {
    revisar();
    obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  // Al ocultar la pestaña o salir, se corta el micrófono
  document.addEventListener('visibilitychange', function () { if (document.hidden) detener(); });
})();
