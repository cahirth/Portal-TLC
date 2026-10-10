// Portal TLC | tutorial.js | v2026.10.10.10 (Cristian: "el de servicio completo" + "Catálogo de Productos, Negocios y Comisiones" — 8 imágenes nuevas de Servicio, 6 de Negocios, 3 del Catálogo y 2 de Comisiones)
// Portal TLC | tutorial.js | v2026.10.10.9 (Cristian: "tutoriales para gestión de eventos y congresos, también para empresas (módulo completo)" — 7 imágenes de Eventos y 5 de Empresas. Además el botón se esconde solo cuando queda encima de un campo o botón, ej. "Agregar ítem" de una tarjeta abierta en el celular.)
// Portal TLC | tutorial.js | v2026.10.10.8 (Cristian: "hacé brochures para Cuenta Corriente, completo" — 6 imágenes, set "cuenta-corriente")
// Portal TLC | tutorial.js | v2026.10.10.7 (Cristian: "podés hacer brochures del módulo Parte del día" — 4 imágenes nuevas, set "parte" para parte.html)
// Portal TLC | tutorial.js | v2026.10.10.1 (Cristian: "se me ocurre poner los brochure en forma de tutorial en cada modulo y hacer un brochure general para que sepa el equipo como mirar el tutorial")
// Botón flotante "❔ Tutorial" (abajo a la izquierda) + carrusel a pantalla completa con
// las imágenes de los brochures (carpeta tutoriales/). Se elige el set solo según la
// página (y ?modulo= en Eventos). La primera vez que alguien entra a un módulo —o cuando
// cambian sus imágenes— se abre solo; mientras no lo vio, el botón dice NUEVO.
// No se abre solo si la página vino con parámetros (ej. calendario.html?nuevo=1 desde
// "Agendar") ni si no hay sesión iniciada (pantalla de login).
// Para sumar/cambiar imágenes: editar SETS y subir el .jpg a tutoriales/.
(function () {
  if (window.TLCTutorial) return;
  var SETS = {
    index:        { titulo: 'Cómo ver los tutoriales', slides: ['general-1', 'general-2'] },
    calendario:   { titulo: 'Agenda', slides: ['agenda-1', 'agenda-2', 'agenda-3', 'agenda-4', 'agenda-5', 'agenda-6', 'agenda-7'] },
    servicio:     { titulo: 'Servicio Técnico', slides: ['servicio-1', 'servicio-2', 'servicio-3', 'servicio-4', 'servicio-5', 'servicio-6', 'servicio-7', 'servicio-8', 'tu-orden', 'tildes', 'campanita', 'ventas-preparacion', 'etiquetas', 'cierre-semana', 'actividad'] },
    cotizaciones: { titulo: 'Negocios', slides: ['negocios-1', 'negocios-2', 'negocios-3', 'negocios-4', 'negocios-5', 'negocios-6', 'gastos-ventas', 'ventas-preparacion', 'tildes', 'campanita'] },
    'selector-dispositivos': { titulo: 'Catálogo de Productos', slides: ['catalogo-1', 'catalogo-2', 'catalogo-3'] },
    comisiones:   { titulo: 'Comisiones', slides: ['comisiones-1', 'comisiones-2'] },
    eventos:      { titulo: 'Eventos y Congresos', slides: ['eventos-1', 'eventos-2', 'eventos-3', 'eventos-4', 'eventos-5', 'eventos-6', 'eventos-7', 'tildes', 'campanita'] },
    empresas:     { titulo: 'Empresas', slides: ['empresas-1', 'empresas-2', 'empresas-3', 'empresas-4', 'empresas-5'] },
    comex:        { titulo: 'Comercio Exterior', slides: ['comex-tablero', 'comex-checklist', 'tildes', 'campanita'] },
    regulatoria:  { titulo: 'Regulatoria', slides: ['regulatoria', 'tildes', 'campanita'] },
    parte:        { titulo: 'Parte del día', slides: ['parte-del-dia-1', 'parte-del-dia-2', 'parte-del-dia-3', 'parte-del-dia-4'] },
    'cuenta-corriente': { titulo: 'Cuenta Corriente', slides: ['cuenta-corriente-1', 'cuenta-corriente-2', 'cuenta-corriente-3', 'cuenta-corriente-4', 'cuenta-corriente-5', 'cuenta-corriente-6'] }
  };
  var CARPETA = 'tutoriales/';
  // La URL se lee al cargar: algunos módulos la limpian después (history.replaceState).
  var BUSQUEDA = location.search;

  function claveSet() {
    var p = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
    if (p === 'eventos') {
      var m = new URLSearchParams(BUSQUEDA).get('modulo');
      if (m === 'comex' || m === 'regulatoria') return m;
    }
    return SETS[p] ? p : null;
  }
  function haySesion() { try { return !!localStorage.getItem('tlc_session_v1'); } catch (e) { return false; } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var CSS = '' +
    '#tlc-tut-btn{position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:9990;display:flex;align-items:center;gap:6px;border:0;cursor:pointer;background:#3a86ff;color:#fff;border-radius:22px;padding:6px 12px 6px 6px;font:800 12.5px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 16px rgba(58,134,255,.4);opacity:.92;transition:opacity .15s,transform .15s}' +
    '#tlc-tut-btn:hover{opacity:1;transform:translateY(-1px)}' +
    '#tlc-tut-btn i{font-style:normal;width:22px;height:22px;border-radius:50%;background:#fff;color:#3a86ff;display:flex;align-items:center;justify-content:center;font-weight:900}' +
    '#tlc-tut-btn b{background:#ef4444;color:#fff;font-size:9px;font-weight:900;padding:1px 6px;border-radius:8px}' +
    '#tlc-tut-btn.mini span{display:none}#tlc-tut-btn.mini{padding:6px}' +
    '#tlc-tut-btn.oculto{opacity:0;pointer-events:none;transform:scale(.6)}' +
    '#tlc-tut{position:fixed;inset:0;z-index:99999;background:rgba(3,7,18,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff;touch-action:pan-y;-webkit-user-select:none;user-select:none}' +
    '#tlc-tut .tt-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px}' +
    '#tlc-tut .tt-tit{flex:1;font-weight:800;font-size:14px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#tlc-tut .tt-x{border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:20px;padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer}' +
    '#tlc-tut .tt-pista{position:relative;width:min(92vw,calc((100vh - 130px) * .8));aspect-ratio:4/5;overflow:hidden;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.5)}' +
    '#tlc-tut .tt-tira{display:flex;height:100%;transition:transform .3s ease}' +
    '#tlc-tut .tt-tira img{flex:0 0 100%;width:100%;height:100%;object-fit:contain;background:#0b1220;-webkit-user-drag:none}' +
    '#tlc-tut .tt-fl{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:24px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '#tlc-tut .tt-fl:disabled{opacity:.2;cursor:default}' +
    '#tlc-tut .tt-ant{left:max(8px,calc(50vw - min(46vw,calc((100vh - 130px) * .4)) - 54px))}' +
    '#tlc-tut .tt-sig{right:max(8px,calc(50vw - min(46vw,calc((100vh - 130px) * .4)) - 54px))}' +
    '@media (max-width:640px){#tlc-tut .tt-fl{display:none}}' +
    '#tlc-tut .tt-dots{display:flex;gap:6px;margin-top:14px}' +
    '#tlc-tut .tt-dots span{width:8px;height:8px;border-radius:50%;background:#475569;cursor:pointer;transition:all .2s}' +
    '#tlc-tut .tt-dots span.on{background:#3a86ff;width:22px;border-radius:4px}' +
    '#tlc-tut .tt-pie{margin-top:10px;font-size:12px;opacity:.6}';

  var estado = null; // { set, i, el }

  function abrir(clave) {
    clave = clave || claveSet();
    var set = SETS[clave];
    if (!set || estado) return;
    var n = set.slides.length;
    var el = document.createElement('div');
    el.id = 'tlc-tut';
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      '<div class="tt-top"><div class="tt-tit">📚 Tutorial · ' + set.titulo + '</div><button class="tt-x" type="button">✕ Cerrar</button></div>' +
      '<div class="tt-pista"><div class="tt-tira">' +
      set.slides.map(function (s, k) { return '<img alt="Tutorial ' + (k + 1) + ' de ' + n + '" draggable="false" ' + (k < 2 ? 'src' : 'data-src') + '="' + CARPETA + s + '.jpg">'; }).join('') +
      '</div></div>' +
      '<button class="tt-fl tt-ant" type="button" aria-label="Anterior">‹</button><button class="tt-fl tt-sig" type="button" aria-label="Siguiente">›</button>' +
      '<div class="tt-dots">' + set.slides.map(function (s, k) { return '<span data-i="' + k + '"></span>'; }).join('') + '</div>' +
      '<div class="tt-pie"></div>';
    document.body.appendChild(el);
    estado = { clave: clave, set: set, i: 0, el: el };
    var tira = el.querySelector('.tt-tira');
    el.querySelector('.tt-x').onclick = cerrar;
    el.querySelector('.tt-ant').onclick = function () { ir(estado.i - 1); };
    el.querySelector('.tt-sig').onclick = function () { ir(estado.i + 1); };
    el.querySelectorAll('.tt-dots span').forEach(function (d) { d.onclick = function () { ir(+d.getAttribute('data-i')); }; });
    el.addEventListener('click', function (ev) { if (ev.target === el) cerrar(); });
    // Swipe
    var x0 = null, y0 = 0, dx = 0, ancho = 1;
    el.addEventListener('touchstart', function (ev) { if (ev.touches.length !== 1) return; x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; ancho = el.querySelector('.tt-pista').offsetWidth || 1; tira.style.transition = 'none'; }, { passive: true });
    el.addEventListener('touchmove', function (ev) {
      if (x0 === null) return;
      dx = ev.touches[0].clientX - x0;
      if (Math.abs(ev.touches[0].clientY - y0) > Math.abs(dx) && Math.abs(dx) < 10) return;
      tira.style.transform = 'translateX(calc(' + (-estado.i * 100) + '% + ' + dx + 'px))';
    }, { passive: true });
    el.addEventListener('touchend', function () {
      if (x0 === null) return;
      tira.style.transition = '';
      var paso = Math.abs(dx) > ancho * 0.18 ? (dx < 0 ? 1 : -1) : 0;
      x0 = null; ir(estado.i + paso);
    });
    document.addEventListener('keydown', teclas);
    document.documentElement.style.overflow = 'hidden';
    ir(0);
    marcarVisto(clave);
  }
  function teclas(ev) {
    if (!estado) return;
    if (ev.key === 'Escape') cerrar();
    else if (ev.key === 'ArrowRight') ir(estado.i + 1);
    else if (ev.key === 'ArrowLeft') ir(estado.i - 1);
  }
  function ir(i) {
    if (!estado) return;
    var n = estado.set.slides.length;
    i = Math.max(0, Math.min(n - 1, i));
    estado.i = i;
    var el = estado.el;
    el.querySelector('.tt-tira').style.transform = 'translateX(' + (-i * 100) + '%)';
    // carga diferida: la actual y la siguiente
    [i, i + 1].forEach(function (k) { var im = el.querySelectorAll('.tt-tira img')[k]; if (im && im.getAttribute('data-src')) { im.src = im.getAttribute('data-src'); im.removeAttribute('data-src'); } });
    el.querySelectorAll('.tt-dots span').forEach(function (d, k) { d.className = k === i ? 'on' : ''; });
    el.querySelector('.tt-ant').disabled = i === 0;
    el.querySelector('.tt-sig').disabled = i === n - 1;
    el.querySelector('.tt-pie').textContent = (i + 1) + ' de ' + n + (i === n - 1 ? ' · ¡listo! ✕ para cerrar' : ' · deslizá →');
  }
  function cerrar() {
    if (!estado) return;
    estado.el.remove();
    estado = null;
    document.removeEventListener('keydown', teclas);
    document.documentElement.style.overflow = '';
  }
  function firma(clave) { return SETS[clave].slides.join(','); }
  function lsClave(clave) { return 'tlc_tutorial_visto_' + clave; }
  function yaVisto(clave) { return lsGet(lsClave(clave)) === firma(clave); }
  function marcarVisto(clave) {
    lsSet(lsClave(clave), firma(clave));
    var b = document.getElementById('tlc-tut-btn');
    if (b) { var nb = b.querySelector('b'); if (nb) nb.remove(); b.classList.add('mini'); b.title = 'Ver el tutorial de este módulo'; }
  }

  function boton(clave) {
    if (document.getElementById('tlc-tut-btn')) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var b = document.createElement('button');
    b.id = 'tlc-tut-btn'; b.type = 'button';
    var visto = yaVisto(clave);
    b.className = visto ? 'mini' : '';
    b.title = 'Ver el tutorial de este módulo';
    b.innerHTML = '<i>?</i><span>Tutorial</span>' + (visto ? '' : '<b>NUEVO</b>');
    b.onclick = function () { abrir(clave); };
    document.body.appendChild(b);
    setInterval(function () { despejar(b); }, 700);
  }
  // Si el botón queda encima de un campo o botón de la pantalla (ej. el
  // "Agregar ítem" de una tarjeta abierta en el celular), se esconde solo
  // y vuelve a aparecer cuando ese lugar queda libre.
  var CONTROLES = 'input,textarea,select,button,[contenteditable="true"]';
  function despejar(b) {
    if (estado) return;
    var r = b.getBoundingClientRect(); if (!r.width) return;
    var pe = b.style.pointerEvents; b.style.pointerEvents = 'none';
    var tapa = false;
    [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 6, r.top + 6], [r.right - 6, r.bottom - 6]].forEach(function (p) {
      var el = document.elementFromPoint(p[0], p[1]);
      if (el && el !== b && !b.contains(el) && el.closest && el.closest(CONTROLES)) tapa = true;
    });
    b.style.pointerEvents = pe;
    b.classList.toggle('oculto', tapa);
  }

  function iniciar() {
    var clave = claveSet();
    if (!clave) return;
    var intentos = 0;
    (function esperarSesion() {
      if (!haySesion()) { if (++intentos < 200) setTimeout(esperarSesion, 3000); return; }
      boton(clave);
      var params = new URLSearchParams(BUSQUEDA); params.delete('modulo');
      if (!yaVisto(clave) && !params.toString()) setTimeout(function () { if (!estado && !yaVisto(clave)) abrir(clave); }, 1200);
    })();
  }

  window.TLCTutorial = { abrir: abrir, cerrar: cerrar, SETS: SETS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
