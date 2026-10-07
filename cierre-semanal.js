// Portal TLC | cierre-semanal.js | v2026.10.06.8
// CIERRE DE SEMANA — Cristian: "los viernes al mediodía... que les aparezca
// en el centro de la pantalla un pop-up, difícil de sacar, que tengan que
// contestar sí o sí: tenés 12 servicios por resolver, 3 en preparación, 2
// en reparación... que hagan el informe, que desaparezca la pantalla y que
// les explote la pantalla así ¡Ah!".
//
// Se carga en todos los módulos. Desde el viernes 12:00 (hora de Buenos
// Aires) y hasta que lo completa, a cada persona con equipos a cargo
// (mismo criterio que "Carga por técnico") le aparece un modal que NO se
// puede cerrar: tiene que marcar el estado de cada equipo. Al enviarlo,
// festejo en pantalla. Si no lo hace el viernes, le vuelve a aparecer el
// lunes (o cuando abra el Portal) hasta que lo complete.
//
// Backend: función servicio (st_cierrePendiente / st_guardarCierreSemanal).
// Para verlo sin esperar al viernes: agregar ?probarCierre=1 a la URL de
// cualquier módulo (modo prueba: no anota nada en los tickets ni avisa).
(function () {
  var URL_FN = 'https://us-central1-portal-tlc.cloudfunctions.net/servicio';
  var INICIO = '2026-10-09', HORA = 12;
  var ESTADOS = [
    { k: 'sale', e: '✅', t: 'Sale esta semana / ya salió' },
    { k: 'proxima', e: '🔧', t: 'Sale la semana que viene' },
    { k: 'repuesto', e: '⏳', t: 'Espera repuesto' },
    { k: 'cliente', e: '🧑‍💼', t: 'Espera al cliente' },
    { k: 'trabado', e: '⚠️', t: 'Trabado, necesito ayuda' },
    { k: 'no_mio', e: '🔁', t: 'No me corresponde' },
  ];
  var PLACEHOLDER = {
    sale: 'Nota (opcional)', proxima: '¿Qué día sale? ¿Qué falta? (opcional)',
    repuesto: '¿Qué repuesto? ¿Cuándo llega? (opcional)', cliente: '¿Qué falta del cliente? (opcional)',
    trabado: '¿Qué lo traba? ¿Qué necesitás? (obligatorio)', no_mio: '¿De quién es? (obligatorio)',
  };
  var OBLIGA_NOTA = { trabado: true, no_mio: true };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function sesion() {
    try {
      var raw = JSON.parse(localStorage.getItem('tlc_session_v1') || 'null');
      if (!raw) return null;
      if (raw.expira && Date.now() > raw.expira) return null;
      var a = raw.account || raw;
      return (a && a.username) ? a : null;
    } catch (e) { return null; }
  }
  function semanaActual() {
    var ba = new Date(Date.now() - 3 * 3600 * 1000);
    var atras = (ba.getUTCDay() - 5 + 7) % 7;
    if (atras === 0 && ba.getUTCHours() < HORA) atras = 7;
    var s = new Date(ba.getTime() - atras * 86400000).toISOString().slice(0, 10);
    return s >= INICIO ? s : null;
  }
  function post(body) {
    return fetch(URL_FN, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }

  var estado = { datos: null, resp: {}, cuenta: null, enviando: false };

  function arrancar() {
    if (document.getElementById('tlc-cierre')) return;
    var cuenta = sesion();
    if (!cuenta) return;
    var prueba = /[?&]probarCierre=1/.test(location.search);
    var semana = semanaActual();
    if (!prueba) {
      if (!semana) return;
      var claveOk = 'tlc_cierre_ok_' + semana + '_' + cuenta.username.toLowerCase();
      if (ls(claveOk) === '1') return;
      var ult = +(ss('tlc_cierre_chk_' + semana) || 0);
      if (Date.now() - ult < 20 * 60 * 1000) return; // sin carga hace poco: no volver a consultar
    }
    post({ accion: 'st_cierrePendiente', email: cuenta.username, prueba: prueba }).then(function (r) {
      if (!r || !r.ok) return; // si falla, no bloquea a nadie
      if (!r.pendiente) {
        if (r.hecho) ls('tlc_cierre_ok_' + r.semana + '_' + cuenta.username.toLowerCase(), '1');
        else if (r.semana) ss('tlc_cierre_chk_' + r.semana, String(Date.now()));
        return;
      }
      estado.datos = r; estado.cuenta = cuenta; estado.resp = {};
      // si ya había empezado a completarlo (recargó la página), se recupera
      try { var bor = JSON.parse(ls('tlc_cierre_borrador_' + r.semana) || 'null'); if (bor && bor.email === cuenta.username) estado.resp = bor.resp || {}; } catch (e) {}
      mostrar();
    }).catch(function () {});
  }

  function css() {
    if (document.getElementById('tlc-cierre-css')) return;
    var st = document.createElement('style');
    st.id = 'tlc-cierre-css';
    st.textContent =
      '#tlc-cierre{position:fixed;inset:0;z-index:2147483000;background:rgba(4,10,24,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:12px;font-family:inherit;animation:tlcFadeIn .35s ease}' +
      '@keyframes tlcFadeIn{from{opacity:0}to{opacity:1}}@keyframes tlcPop{from{transform:scale(.9) translateY(20px);opacity:0}to{transform:none;opacity:1}}' +
      '#tlc-cierre .cc-card{width:100%;max-width:580px;max-height:94vh;display:flex;flex-direction:column;background:#f8fafc;color:#0f172a;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);animation:tlcPop .45s cubic-bezier(.2,1.2,.4,1)}' +
      '#tlc-cierre .cc-head{background:linear-gradient(135deg,#1d4ed8,#3a86ff 60%,#06b6d4);color:#fff;padding:18px 20px 16px}' +
      '#tlc-cierre .cc-kick{font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;opacity:.85}' +
      '#tlc-cierre .cc-big{font-size:23px;font-weight:900;line-height:1.15;margin:6px 0 10px}' +
      '#tlc-cierre .cc-big b{font-size:30px}' +
      '#tlc-cierre .cc-chips{display:flex;flex-wrap:wrap;gap:6px}' +
      '#tlc-cierre .cc-chip{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.3);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700}' +
      '#tlc-cierre .cc-sub{font-size:13px;opacity:.92;margin-top:10px;line-height:1.35}' +
      '#tlc-cierre .cc-body{overflow-y:auto;padding:12px 14px 6px;flex:1;-webkit-overflow-scrolling:touch}' +
      '#tlc-cierre .cc-etapa{font-size:11px;font-weight:800;color:#1e40af;letter-spacing:.8px;text-transform:uppercase;margin:10px 4px 6px}' +
      '#tlc-cierre .cc-tk{background:#fff;border:1.5px solid #e2e8f0;border-radius:14px;padding:11px 12px;margin-bottom:9px;transition:border-color .2s}' +
      '#tlc-cierre .cc-tk.ok{border-color:#22c55e}' +
      '#tlc-cierre .cc-tit{font-size:13.5px;font-weight:800;line-height:1.3}' +
      '#tlc-cierre .cc-ant{font-size:11.5px;color:#64748b;margin-top:3px}' +
      '#tlc-cierre .cc-ant.alerta{color:#b45309;font-weight:700}' +
      '#tlc-cierre .cc-ops{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}' +
      '#tlc-cierre .cc-op{border:1.5px solid #e2e8f0;background:#f8fafc;border-radius:10px;padding:8px 8px;font-size:12px;font-weight:700;color:#334155;text-align:left;cursor:pointer;font-family:inherit;line-height:1.2;display:flex;gap:6px;align-items:center}' +
      '#tlc-cierre .cc-op.sel{background:#3a86ff;border-color:#3a86ff;color:#fff}' +
      '#tlc-cierre .cc-op.sel.trabado{background:#ef4444;border-color:#ef4444}' +
      '#tlc-cierre .cc-nota{width:100%;margin-top:8px;border:1.5px solid #e2e8f0;border-radius:10px;padding:8px 10px;font-size:13px;font-family:inherit;color:#0f172a;background:#fff;box-sizing:border-box}' +
      '#tlc-cierre .cc-nota.falta{border-color:#ef4444;background:#fef2f2}' +
      '#tlc-cierre .cc-foot{padding:12px 14px 14px;border-top:1px solid #e2e8f0;background:#fff}' +
      '#tlc-cierre .cc-bar{height:6px;background:#e2e8f0;border-radius:4px;overflow:hidden;margin-bottom:8px}' +
      '#tlc-cierre .cc-bar i{display:block;height:100%;background:linear-gradient(90deg,#3a86ff,#22c55e);transition:width .3s}' +
      '#tlc-cierre .cc-prog{font-size:12px;color:#64748b;font-weight:700;margin-bottom:8px;display:flex;justify-content:space-between}' +
      '#tlc-cierre .cc-send{width:100%;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:900;color:#fff;background:#94a3b8;cursor:not-allowed;font-family:inherit;transition:background .2s,transform .1s}' +
      '#tlc-cierre .cc-send.listo{background:linear-gradient(135deg,#16a34a,#22c55e);cursor:pointer;box-shadow:0 6px 18px rgba(34,197,94,.4)}' +
      '#tlc-cierre .cc-send.listo:active{transform:scale(.98)}' +
      '#tlc-cierre .cc-err{color:#dc2626;font-size:12.5px;font-weight:700;margin-bottom:8px;display:none}' +
      '#tlc-cierre .cc-prueba{background:#fef3c7;color:#92400e;font-size:11.5px;font-weight:700;padding:6px 14px;text-align:center}' +
      '@media (max-width:420px){#tlc-cierre{padding:0}#tlc-cierre .cc-card{max-height:100vh;height:100%;border-radius:0}#tlc-cierre .cc-big{font-size:20px}}';
    document.head.appendChild(st);
  }

  function nombrePila(c) { return String(c.name || c.username || '').trim().split(/\s+/)[0] || ''; }
  function fechaViernes(s) {
    var d = new Date(s + 'T12:00:00Z');
    if (isNaN(d)) return '';
    return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  function mostrar() {
    css();
    var d = estado.datos, tks = d.tickets;
    var porEtapa = [];
    tks.forEach(function (t) {
      var g = porEtapa.find(function (x) { return x.etapa === t.etapa; });
      if (!g) porEtapa.push(g = { etapa: t.etapa, items: [] });
      g.items.push(t);
    });
    var chips = porEtapa.map(function (g) { return '<span class="cc-chip">' + g.items.length + ' en ' + esc(g.etapa) + '</span>'; }).join('');
    var ov = document.createElement('div');
    ov.id = 'tlc-cierre';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.innerHTML =
      '<div class="cc-card">' +
        (d.prueba ? '<div class="cc-prueba">MODO PRUEBA — no se anota nada en los tickets</div>' : '') +
        '<div class="cc-head">' +
          '<div class="cc-kick">📋 Cierre de semana' + (d.prueba ? '' : ' · ' + esc(fechaViernes(d.semana))) + '</div>' +
          '<div class="cc-big">' + esc(nombrePila(estado.cuenta)) + ', tenés <b>' + tks.length + '</b> ' + (tks.length === 1 ? 'servicio' : 'servicios') + ' por resolver</div>' +
          '<div class="cc-chips">' + chips + '</div>' +
          '<div class="cc-sub">Antes de seguir, contá cómo está cada uno. Es un toque por equipo — te lleva 2 minutos.</div>' +
        '</div>' +
        '<div class="cc-body">' + porEtapa.map(function (g) {
          return '<div class="cc-etapa">' + esc(g.etapa) + ' · ' + g.items.length + '</div>' + g.items.map(htmlTicket).join('');
        }).join('') + '</div>' +
        '<div class="cc-foot">' +
          '<div class="cc-err" id="cc-err"></div>' +
          '<div class="cc-prog"><span id="cc-prog-t"></span><span id="cc-prog-p"></span></div>' +
          '<div class="cc-bar"><i id="cc-bar"></i></div>' +
          '<button type="button" class="cc-send" id="cc-send">Enviar cierre</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    document.documentElement.style.overflow = 'hidden';
    ov.addEventListener('click', onClick);
    ov.addEventListener('input', onInput);
    // No se cierra con Escape (si navega a otro módulo, le vuelve a aparecer ahí)
    document.addEventListener('keydown', bloquearEsc, true);
    actualizar();
  }
  function bloquearEsc(e) { if (e.key === 'Escape' && document.getElementById('tlc-cierre')) { e.stopPropagation(); e.preventDefault(); } }

  function htmlTicket(t) {
    var r = estado.resp[t.id] || {};
    var ant = '';
    if (t.anterior && t.anterior.estado) {
      var ea = ESTADOS.find(function (x) { return x.k === t.anterior.estado; });
      var alerta = t.anterior.estado === 'sale';
      ant = '<div class="cc-ant' + (alerta ? ' alerta' : '') + '">' +
        (alerta ? '⚠ La semana pasada dijiste que salía' : 'La semana pasada: ' + (ea ? ea.e + ' ' + ea.t : '')) +
        (t.anterior.nota ? ' — “' + esc(t.anterior.nota) + '”' : '') + '</div>';
    }
    return '<div class="cc-tk' + (completo(t.id) ? ' ok' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="cc-tit">' + (t.prioridad === 'alta' || t.prioridad === 'urgente' ? '🔥 ' : '') + esc(t.titulo) + '</div>' + ant +
      '<div class="cc-ops">' + ESTADOS.map(function (e) {
        var sel = r.estado === e.k;
        return '<button type="button" class="cc-op' + (sel ? ' sel ' + e.k : '') + '" data-estado="' + e.k + '"><span>' + e.e + '</span><span>' + e.t + '</span></button>';
      }).join('') + '</div>' +
      (r.estado ? '<input type="text" class="cc-nota' + (OBLIGA_NOTA[r.estado] && !String(r.nota || '').trim() ? ' falta' : '') + '" maxlength="300" placeholder="' + esc(PLACEHOLDER[r.estado]) + '" value="' + esc(r.nota || '') + '">' : '') +
    '</div>';
  }
  function completo(id) {
    var r = estado.resp[id];
    return !!(r && r.estado && (!OBLIGA_NOTA[r.estado] || String(r.nota || '').trim()));
  }
  function guardarBorrador() {
    ls('tlc_cierre_borrador_' + estado.datos.semana, JSON.stringify({ email: estado.cuenta.username, resp: estado.resp }));
  }
  function onClick(e) {
    var op = e.target.closest('.cc-op');
    if (op) {
      var tk = op.closest('.cc-tk'), id = tk.getAttribute('data-id');
      var r = estado.resp[id] = estado.resp[id] || {};
      r.estado = op.getAttribute('data-estado');
      var t = estado.datos.tickets.find(function (x) { return x.id === id; });
      var nuevo = document.createElement('div');
      nuevo.innerHTML = htmlTicket(t);
      tk.replaceWith(nuevo.firstChild);
      if (OBLIGA_NOTA[r.estado]) {
        var inp = document.querySelector('#tlc-cierre .cc-tk[data-id="' + id.replace(/"/g, '\\"') + '"] .cc-nota');
        if (inp && !inp.value) inp.focus();
      }
      guardarBorrador();
      actualizar();
      return;
    }
    if (e.target.id === 'cc-send') enviar();
  }
  function onInput(e) {
    if (!e.target.classList.contains('cc-nota')) return;
    var id = e.target.closest('.cc-tk').getAttribute('data-id');
    estado.resp[id] = estado.resp[id] || {};
    estado.resp[id].nota = e.target.value;
    var r = estado.resp[id];
    e.target.classList.toggle('falta', !!(OBLIGA_NOTA[r.estado] && !e.target.value.trim()));
    e.target.closest('.cc-tk').classList.toggle('ok', completo(id));
    guardarBorrador();
    actualizar();
  }
  function actualizar() {
    var tks = estado.datos.tickets;
    var n = tks.filter(function (t) { return completo(t.id); }).length;
    var pct = Math.round(n * 100 / tks.length);
    document.getElementById('cc-prog-t').textContent = n + ' de ' + tks.length + ' respondidos';
    document.getElementById('cc-prog-p').textContent = pct + '%';
    document.getElementById('cc-bar').style.width = pct + '%';
    var b = document.getElementById('cc-send');
    var listo = n === tks.length;
    b.classList.toggle('listo', listo);
    b.textContent = estado.enviando ? 'Enviando…' : (listo ? '🚀 Enviar cierre' : 'Faltan ' + (tks.length - n));
  }
  function error(msg) {
    var el = document.getElementById('cc-err');
    el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }
  function enviar() {
    var tks = estado.datos.tickets;
    if (estado.enviando) return;
    var faltan = tks.filter(function (t) { return !completo(t.id); });
    if (faltan.length) {
      error('Te faltan ' + faltan.length + '. ' + (faltan.some(function (t) { return estado.resp[t.id] && OBLIGA_NOTA[estado.resp[t.id].estado]; }) ? 'En "Trabado" y "No me corresponde" contá por qué en una línea.' : ''));
      var el = document.querySelector('#tlc-cierre .cc-tk[data-id="' + faltan[0].id.replace(/"/g, '\\"') + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    error('');
    estado.enviando = true; actualizar();
    post({
      accion: 'st_guardarCierreSemanal', email: estado.cuenta.username, nombre: estado.cuenta.name || '',
      semana: estado.datos.semana, prueba: !!estado.datos.prueba,
      items: tks.map(function (t) { return { id: t.id, estado: estado.resp[t.id].estado, nota: estado.resp[t.id].nota || '' }; }),
    }).then(function (r) {
      estado.enviando = false;
      if (!r || !r.ok) { actualizar(); error((r && r.error) || 'No se pudo enviar. Probá de nuevo.'); return; }
      if (!estado.datos.prueba) ls('tlc_cierre_ok_' + estado.datos.semana + '_' + estado.cuenta.username.toLowerCase(), '1');
      try { localStorage.removeItem('tlc_cierre_borrador_' + estado.datos.semana); } catch (e) {}
      festejar();
    }).catch(function () { estado.enviando = false; actualizar(); error('Error de conexión. Probá de nuevo.'); });
  }

  // ¡Que explote la pantalla!
  function festejar() {
    var ov = document.getElementById('tlc-cierre');
    var card = ov.querySelector('.cc-card');
    card.style.transition = 'transform .35s ease, opacity .35s ease';
    card.style.transform = 'scale(.85)'; card.style.opacity = '0';
    var msg = document.createElement('div');
    msg.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#fff;z-index:2;pointer-events:none;padding:20px';
    msg.innerHTML = '<div id="cc-boom" style="font-size:110px;line-height:1;transform:scale(0);transition:transform .5s cubic-bezier(.2,1.6,.4,1)">💪</div>' +
      '<div style="font-size:34px;font-weight:900;margin-top:14px;text-shadow:0 4px 20px rgba(0,0,0,.4)">¡Semana cerrada!</div>' +
      '<div style="font-size:18px;font-weight:700;margin-top:8px;opacity:.95">Gracias, ' + esc(nombrePila(estado.cuenta)) + '. Buen finde 🙌</div>';
    ov.appendChild(msg);
    setTimeout(function () { var b = document.getElementById('cc-boom'); if (b) b.style.transform = 'scale(1)'; }, 60);
    confeti(ov);
    setTimeout(function () {
      ov.style.transition = 'opacity .5s ease'; ov.style.opacity = '0';
      setTimeout(function () {
        ov.remove();
        document.documentElement.style.overflow = '';
        document.removeEventListener('keydown', bloquearEsc, true);
      }, 520);
    }, 3600);
  }
  function confeti(cont) {
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1;pointer-events:none';
    cont.appendChild(cv);
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    var ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    var colores = ['#3a86ff', '#22c55e', '#facc15', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ffffff'];
    var emojis = ['🎉', '✅', '💪', '⭐', '🔧', '🙌'];
    var P = [];
    function rafaga(x, y, n, fuerza) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, v = (0.35 + Math.random()) * fuerza;
        var esEmoji = Math.random() < 0.08;
        P.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - fuerza * 0.35, g: 0.18 + Math.random() * 0.12,
          w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * 0.4,
          c: colores[(Math.random() * colores.length) | 0], em: esEmoji ? emojis[(Math.random() * emojis.length) | 0] : null, vida: 0 });
      }
    }
    rafaga(W / 2, H / 2, 260, 16);
    setTimeout(function () { rafaga(W * 0.2, H * 0.75, 110, 13); rafaga(W * 0.8, H * 0.75, 110, 13); }, 350);
    setTimeout(function () { rafaga(W / 2, H * 0.35, 140, 12); }, 800);
    var t0 = performance.now();
    (function loop(t) {
      ctx.clearRect(0, 0, W, H);
      P.forEach(function (p) {
        p.vx *= 0.985; p.vy = p.vy * 0.985 + p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vida++;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        if (p.em) { ctx.font = '26px serif'; ctx.fillText(p.em, -13, 9); }
        else { ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.vida / 6))); }
        ctx.restore();
      });
      P = P.filter(function (p) { return p.y < H + 40; });
      if (t - t0 < 4200) requestAnimationFrame(loop);
    })(t0);
  }

  // Exponer para probar a mano desde la consola: TLCCierre.arrancar()
  window.TLCCierre = { arrancar: arrancar };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(arrancar, 800); });
  else setTimeout(arrancar, 800);
  // Si el Portal quedó abierto desde la mañana, el viernes a las 12:00
  // aparece solo (revisa cada 10 minutos; sin red hasta que llega la hora).
  setInterval(arrancar, 10 * 60 * 1000);
})();
