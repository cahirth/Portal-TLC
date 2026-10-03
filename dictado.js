// Portal TLC | dictado.js | v2026.10.03.1 — BUG REAL en Android: repetía las palabras (Chrome Android manda la frase acumulada varias veces como definitiva). Ahora en Android una frase por sesión con reinicio automático, y en todos los navegadores el texto de la sesión se rearma completo en cada evento (nunca se suma).
// (v2026.10.02.1: versión inicial)
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

  var esAndroid = /Android/i.test(navigator.userAgent);
  var quiereEscuchar = false;

  function detener() {
    quiereEscuchar = false;
    if (rec) { try { rec.stop(); } catch (e) {} }
  }

  function limpiarEstado() {
    if (botonActivo) { botonActivo.classList.remove('escuchando'); botonActivo.title = 'Dictar por voz'; }
    rec = null; textareaActivo = null; botonActivo = null; quiereEscuchar = false;
  }

  // ANDROID: con reconocimiento continuo, Chrome en Android manda la frase
  // ACUMULADA una y otra vez ("Hola", "Hola Lore", "Hola Lore todo"...),
  // cada una marcada como definitiva; sumarlas repetía las palabras
  // (Cristian: "fijate que repite las palabras"). Por eso en Android se usa
  // una frase por sesión (continuous=false) y se reinicia sola mientras el
  // usuario siga hablando. Además, en cada evento se REARMA el texto de la
  // sesión desde cero (nunca se suma sobre lo anterior), así un resultado
  // repetido no puede duplicar nada en ningún navegador.
  function empezar(textarea, boton) {
    if (rec || quiereEscuchar) { detener(); return; }

    var original = textarea.value;
    var acumulado = original;           // lo ya confirmado de sesiones anteriores
    quiereEscuchar = true;
    textareaActivo = textarea; botonActivo = boton;
    boton.classList.add('escuchando');
    boton.title = 'Escuchando… tocá para terminar';
    textarea.focus();

    function unir(a, b) {
      b = (b || '').trim();
      if (!b) return a;
      if (a && !/\s$/.test(a)) a += ' ';
      return a + b;
    }

    function sesion() {
      var r = new SR();
      r.lang = 'es-AR';
      r.interimResults = true;
      r.continuous = !esAndroid;
      r.maxAlternatives = 1;
      var textoSesion = '';      // rearmado completo en cada evento
      var huboTexto = false;

      r.onresult = function (ev) {
        var finales = [], provisorio = '';
        if (esAndroid) {
          // En Android el último resultado ya trae la frase completa
          var ult = ev.results[ev.results.length - 1];
          if (ult.isFinal) finales.push(ult[0].transcript); else provisorio = ult[0].transcript;
        } else {
          for (var i = 0; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) finales.push(ev.results[i][0].transcript.trim());
            else provisorio += ev.results[i][0].transcript;
          }
        }
        textoSesion = finales.join(' ').trim();
        if (textoSesion || provisorio.trim()) huboTexto = true;
        textarea.value = unir(unir(acumulado, textoSesion), provisorio);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.scrollTop = textarea.scrollHeight;
      };
      r.onerror = function (ev) {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
          quiereEscuchar = false;
          avisar('🎤 Permití el acceso al micrófono para dictar (ícono del candado, al lado de la dirección).');
        } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
          console.warn('[dictado.js] error:', ev.error);
        }
      };
      r.onend = function () {
        acumulado = unir(acumulado, textoSesion);
        textarea.value = (acumulado === original) ? original : acumulado + ' ';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        // Android: si el usuario sigue en modo dictado y esta frase trajo
        // texto, se abre otra sesión. Si hubo silencio, se termina solo.
        if (esAndroid && quiereEscuchar && huboTexto && document.body.contains(textarea)) {
          try { sesion(); return; } catch (e) {}
        }
        limpiarEstado();
      };
      try { r.start(); rec = r; }
      catch (e) { console.warn('[dictado.js] no se pudo iniciar:', e); limpiarEstado(); }
    }
    sesion();
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
