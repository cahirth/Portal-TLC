// ============================================================
// Portal TLC | calculo-financiacion.js | v2026.08.16.1
// Leasing (36 pesos y USD) ahora calcula el Maxicanon y los cánones
// sobre el precio CON IVA (10,5%), no el neto — a diferencia de
// Contado/TLC6/TLC12 (que muestran el neto y aclaran "+ IVA 10,5%"
// aparte, porque esa diferencia la paga el cliente por fuera), en
// Leasing lo que se financia de verdad es la factura completa
// (precio + IVA). El umbral de USD 15.000 para habilitar Leasing ya
// usaba el total con IVA (superaUmbralLeasing) — ahora el CÁLCULO en
// sí también, no solo el chequeo de umbral. Pedido por Cristian: "el
// tema del leasing, el precio base es el precio descontado más IVA,
// diez coma cinco".
// ============================================================
// Portal TLC | calculo-financiacion.js | v2026.08.14.4
// Agregado un log de versión PROPIO en consola (independiente del de
// ficha-equipo.html) — hasta ahora este archivo no tenía ninguna
// forma de confirmar qué versión estaba sirviendo el servidor,
// aunque ficha-equipo.html mostrara su propia versión correcta. Son
// DOS archivos con <script src> separados; uno podía quedar
// actualizado y el otro no, sin manera de detectarlo desde la
// consola. Reportado por Cristian: la TNA de Leasing seguía en 0%
// (canon "—" en pantalla) después de confirmar que ficha-equipo.html
// estaba en la última versión — la causa real era que ESTE archivo
// específico no se había vuelto a subir con el fix de v2026.08.14.3
// (regex tolerante a guion bajo de Firebase). Ahora, al abrir
// cualquier ficha, la consola muestra dos líneas de versión
// separadas — si alguna vez no coinciden con lo esperado, queda
// clarísimo cuál de los dos archivos quedó desactualizado.
// ============================================================
// Portal TLC | calculo-financiacion.js | v2026.08.14.3
// _extraerTnaDeEncabezado ahora entiende TANTO el texto tal cual del
// Excel/GitHub ("TNA: 11,12%", con espacios) COMO el mismo texto
// sanitizado por Firebase RTDB (espacios → "_", ej. "TNA:_11,12%") —
// antes solo reconocía el primer formato, así que si algún día se
// sincroniza este catálogo a Firebase (selector-dispositivos.html ya
// prioriza Firebase por sobre GitHub Pages), las tasas TNA se habrían
// leído como 0% en silencio, sin ningún aviso. _leerColumna (el
// prefijo Habilitar_TLC12_Pesos, etc.) ya era robusto a esto de
// antes, no necesitó cambios — el problema era solo en la extracción
// del número. Detectado en auditoría cruzada con selector-
// dispositivos.html (14/08/2026), antes de que el bug llegara a
// producción.
// ============================================================
// Portal TLC | calculo-financiacion.js | v2026.08.14.2
// Confirmado por Cristian: Leasing 36 USD usa la misma estructura
// que Leasing 36 Pesos (Maxicanon 15% + 35 cánones + 1 en garantía +
// 1 opción de compra), solo cambia la TNA (3,5% en vez de 39%) —
// sacada la marca de "sin confirmar" que tenía calcularLeasing36.
// ============================================================
// Portal TLC | calculo-financiacion.js | v2026.08.14.1
// PRIMERA VERSIÓN — motor único de cálculo de financiación,
// pensado para ser la ÚNICA fuente de verdad de estas fórmulas
// en todo el Portal (hoy consumido por ficha-equipo.html; a
// futuro presupuesto-editor.html debería migrar acá también en
// vez de mantener su propio PARAMS_PAGO por separado — pendiente,
// no se tocó presupuesto-editor.html en esta vuelta).
//
// CÓMO SE USA (arquitectura Padre-Hijo + flags/TNA en Excel):
//   1. El vendedor tilda 0+ módulos (Hijos) de un equipo (Padre).
//   2. Se suma: baseNeto = precioPadre + Σ precios de hijos tildados.
//   3. Para cada uno de los 6 modos de financiación, este archivo:
//      a) Lee si el PADRE tiene ese modo habilitado (columna
//         TRUE/FALSE de Lista_Precios → precios.json). Los Hijos
//         NO tienen columnas propias — siempre heredan del Padre.
//      b) Si está habilitado, calcula anticipo/cuotas en vivo sobre
//         baseNeto, usando la tasa (si aplica) que está escrita en
//         el TÍTULO de esa columna en el Excel.
//
// CÓMO MODIFICAR ESTE ARCHIVO A FUTURO — LEER ANTES DE TOCAR NADA:
//
//   ¿Querés cambiar el % de ANTICIPO de TLC 6 o TLC 12?
//   → Editá las constantes ANTICIPO_TLC6_PCT / ANTICIPO_TLC12_PCT
//     acá abajo. Es el ÚNICO lugar de todo el Portal donde vive
//     ese número (ver nota de arriba: presupuesto-editor.html
//     todavía no migró a este archivo, así que por ahora NO va a
//     tomar este cambio — avisar si hace falta sincronizarlo ahí
//     también a mano).
//
//   ¿Querés cambiar una TASA (TNA) — la de TLC 12 $, Leasing 36 $,
//   o Leasing 36 USD?
//   → NO se toca este archivo. Esas tasas vienen del TÍTULO de la
//     columna correspondiente en la pestaña Lista_Precios del
//     Excel (ej. "Habilitar_Leasing36_Pesos (TNA: 39%)") — cambiás
//     el número ahí, sincronizás precios.json, y este archivo lo
//     lee solo la próxima vez que alguien abra una ficha. El
//     formato "(TNA: X%)" tiene que respetarse tal cual (coma o
//     punto para el decimal, cualquiera de los dos anda) — si el
//     texto no matchea ese patrón, se asume 0% sin avisar.
//
//   ¿Querés cambiar el % de MAXICANON del Leasing, o la cantidad de
//   cuotas/cánones?
//   → Constantes LEASING36_MAXICANON_PCT / LEASING36_CANONES_A_PAGAR
//     acá abajo — aplican igual para pesos y USD (misma estructura
//     comercial, dos monedas).
//
//   ¿Querés cambiar el umbral de USD para habilitar Leasing 36?
//   → Constante LEASING36_UMBRAL_USD acá abajo. Por decisión de
//     Cristian (14/08/2026) esto queda FIJO EN CÓDIGO, no editable
//     desde el Excel.
//
//   ¿Querés agregar un modo de financiación nuevo (ej. "TLC 24")?
//   → Hace falta: (1) una fila de comentario acá explicando el
//     modo, (2) una función calcularX() nueva siguiendo el patrón
//     de las que ya existen, (3) agregar la clave nueva a
//     MODOS_FINANCIACION más abajo, (4) agregar la columna
//     Habilitar_X en Lista_Precios (ver Guía Padre-Hijo). Pedirle
//     este trabajo a Claude con estos 4 pasos como contexto.
// ============================================================

(function (global) {
  'use strict';

  // ── CONSTANTES DE NEGOCIO — los únicos números que se tocan desde
  // este archivo (todo lo demás sale del Excel, ver comentario de
  // arriba) ──
  var ANTICIPO_TLC6_PCT = 35;   // TLC 6 cuotas — pesos Y dólares, mismo %
  var ANTICIPO_TLC12_PCT = 50;  // TLC 12 cuotas — pesos Y dólares, mismo %

  var LEASING36_MAXICANON_PCT = 15;   // % del valor del bien, se paga como adelanto
  var LEASING36_CANONES_A_PAGAR = 35; // + 1 canon en garantía + 1 opción de compra (VR) — no suman al cronograma de 35, van aparte
  var LEASING36_PLAZO_MESES = 36;

  // Leasing 36 (pesos Y dólares) solo se ofrece si el total con IVA
  // de la propuesta supera este umbral. Pedido por Cristian
  // (30/07/2026, extendido a USD el 14/08/2026): "a partir de los
  // quince mil dólares, se habilita el leasing, tanto sea en pesos
  // como en dólares." Fijo en código, no editable desde Excel
  // (decisión explícita de Cristian).
  var LEASING36_UMBRAL_USD = 15000;

  // TLC 6 y TLC 12 en DÓLARES: SIN interés, siempre (confirmado por
  // Cristian: "en dólares no va a tener recargo"). TLC 12 en PESOS
  // SÍ tiene una tasa sobre el saldo (leída del Excel, ver abajo).
  // TLC 6 en pesos: sin tasa.

  // ── Nombres EXACTOS de las 6 columnas de Lista_Precios (deben
  // coincidir con lo agregado en Cotizaciones_Portal_con_flags.xlsx,
  // 14/08/2026). El texto completo (con el "(TNA: X%)" incluido) es
  // la CLAVE real dentro de cada objeto de precios.json — por eso acá
  // buscamos por *prefijo*, no por igualdad exacta, así un ajuste de
  // tasa en el Excel (que cambia el texto del encabezado) no rompe
  // este archivo. ──
  var PREFIJOS_COLUMNAS = {
    tlc6_pesos: 'Habilitar_TLC6_Pesos',
    tlc12_pesos: 'Habilitar_TLC12_Pesos',
    tlc6_usd: 'Habilitar_TLC6_USD',
    tlc12_usd: 'Habilitar_TLC12_USD',
    leasing36_pesos: 'Habilitar_Leasing36_Pesos',
    leasing36_usd: 'Habilitar_Leasing36_USD',
  };

  // Extrae el número de "TNA: 11,12%" o "TNA: 39%" del título de una
  // columna. Devuelve 0 si el texto no matchea el patrón esperado —
  // decisión deliberada de "fallar en silencio a 0%" en vez de tirar
  // una excepción, para que un typo en el Excel no rompa TODA la
  // ficha, aunque sí genere una tasa incorrecta (0%) para ESE modo
  // puntual — visible apenas se mira el resultado en pantalla.
  //
  // Robusto a DOS orígenes de datos con formato distinto:
  //   - precios.json (GitHub Pages) → texto tal cual se escribió en
  //     el Excel: "Habilitar_TLC12_Pesos (TNA: 11,12%)".
  //   - Firebase RTDB → FotoMap.gs sanitiza espacios a "_" antes de
  //     subir (Firebase no admite espacios en las claves), así que el
  //     MISMO título llega como "Habilitar_TLC12_Pesos_(TNA:_11,12%)".
  // Por eso el patrón acepta espacio O guion bajo (o varios seguidos)
  // en cualquiera de los dos huecos alrededor del número — un único
  // archivo que entiende las dos fuentes, en vez de mantener tablas
  // de traducción de headers separadas por archivo.
  function _extraerTnaDeEncabezado(textoEncabezado) {
    if (!textoEncabezado) return 0;
    var m = String(textoEncabezado).match(/TNA:[\s_]*([\d.,]+)[\s_]*%/i);
    if (!m) return 0;
    var numTexto = m[1].replace(',', '.');
    var num = parseFloat(numTexto);
    return isNaN(num) ? 0 : num;
  }

  // Busca, dentro de las claves de un objeto-fila de precios.json, la
  // que empieza con el prefijo dado — y devuelve tanto su valor
  // (TRUE/FALSE) como la tasa embebida en su propio título.
  function _leerColumna(filaProducto, prefijo) {
    var claves = Object.keys(filaProducto || {});
    for (var i = 0; i < claves.length; i++) {
      if (claves[i].indexOf(prefijo) === 0) {
        var valorCrudo = filaProducto[claves[i]];
        var habilitado = (valorCrudo === true || String(valorCrudo).trim().toUpperCase() === 'TRUE');
        return { habilitado: habilitado, tna: _extraerTnaDeEncabezado(claves[i]) };
      }
    }
    return { habilitado: false, tna: 0 };
  }

  // Lee los 6 flags/tasas de financiación de la fila del PADRE. Los
  // Hijos (módulos/accesorios) NUNCA tienen estas columnas propias —
  // siempre heredan lo que diga el Padre (decisión de Cristian,
  // 14/08/2026: "los Hijos heredan del Padre, más simple").
  function leerConfigFinanciacion(filaPadre) {
    var cfg = {};
    Object.keys(PREFIJOS_COLUMNAS).forEach(function (clave) {
      cfg[clave] = _leerColumna(filaPadre, PREFIJOS_COLUMNAS[clave]);
    });
    return cfg;
  }

  // ── TLC 6 — SIN interés, pesos y dólares por igual. baseNeto ya
  // viene en la moneda que corresponda (el caller decide si convertir
  // a pesos con el TC oficial antes de llamar, o dejarlo en USD). ──
  function calcularTLC6(baseNeto) {
    var anticipo = baseNeto * ANTICIPO_TLC6_PCT / 100;
    var saldo = baseNeto - anticipo;
    var cuota = saldo / 6;
    return { anticipo: anticipo, saldo: saldo, cuota: cuota, cuotas: 6, anticipoPct: ANTICIPO_TLC6_PCT, tna: 0 };
  }

  // ── TLC 12 — anticipo 50% siempre. En DÓLARES sin interés (saldo
  // dividido en 12 partes iguales, igual que TLC6). En PESOS, con una
  // tasa TNA sobre el saldo (sistema de cuota fija — misma fórmula
  // francesa que ya usa Leasing en presupuesto-editor.html), leída
  // del título de la columna Habilitar_TLC12_Pesos. ──
  function calcularTLC12(baseNeto, tnaPesosPct) {
    var anticipo = baseNeto * ANTICIPO_TLC12_PCT / 100;
    var saldo = baseNeto - anticipo;
    var cuota;
    var tnaUsada = 0;
    if (tnaPesosPct && tnaPesosPct > 0) {
      var i = (tnaPesosPct / 100) / 12;
      cuota = saldo * i / (1 - Math.pow(1 + i, -12));
      tnaUsada = tnaPesosPct;
    } else {
      cuota = saldo / 12;
    }
    return { anticipo: anticipo, saldo: saldo, cuota: cuota, cuotas: 12, anticipoPct: ANTICIPO_TLC12_PCT, tna: tnaUsada };
  }

  // ── Leasing 36 — misma estructura para pesos y dólares (Maxicanon +
  // 35 cánones fijos + 1 en garantía + 1 opción de compra), cambia
  // solo la TNA y la moneda de la base. Fórmula idéntica a
  // _calcularLeasing36 de presupuesto-editor.html. Confirmado por
  // Cristian (14/08/2026): Leasing 36 USD usa la misma estructura que
  // Leasing 36 Pesos, solo cambia la tasa (3,5% en vez de 39%). ──
  function calcularLeasing36(base, tnaPct) {
    var i = (tnaPct / 100) / 12;
    var n = LEASING36_CANONES_A_PAGAR;
    var maxicanon = base * LEASING36_MAXICANON_PCT / 100;
    var capitalFinanciar = base - maxicanon;
    var canon = capitalFinanciar * i / (1 - Math.pow(1 + i, -n));
    return {
      maxicanon: maxicanon,
      canon: canon,
      canones: n,
      garantia: canon,
      vr: canon,
      tna: tnaPct,
      plazoMeses: LEASING36_PLAZO_MESES,
    };
  }

  // Chequea la regla de negocio del umbral — recibe el total CON IVA
  // ya expresado en USD (si el presupuesto está en pesos, convertir
  // ANTES de llamar a esta función).
  function superaUmbralLeasing(totalConIvaUSD) {
    return (totalConIvaUSD || 0) > LEASING36_UMBRAL_USD;
  }

  // ── Punto de entrada principal — dado un Padre (+ opcionalmente ya
  // sumados los Hijos tildados en baseNetoUSD) y el TC oficial del
  // momento, devuelve TODOS los modos habilitados ya calculados, listos
  // para pintar. baseNetoUSD = precio Padre + Σ precios de Hijos
  // tildados, siempre en USD (moneda interna del catálogo). ──
  function calcularTodosLosModos(filaPadre, baseNetoUSD, tcOficial) {
    var cfg = leerConfigFinanciacion(filaPadre);
    var resultado = {};
    var totalConIvaUSD = baseNetoUSD * 1.105; // mismo IVA 10,5% que usa el resto del Portal para estas tarjetas informativas

    if (cfg.tlc6_pesos.habilitado && tcOficial) {
      resultado.tlc6_pesos = calcularTLC6(baseNetoUSD * tcOficial);
    }
    if (cfg.tlc6_usd.habilitado) {
      resultado.tlc6_usd = calcularTLC6(baseNetoUSD);
    }
    if (cfg.tlc12_pesos.habilitado && tcOficial) {
      resultado.tlc12_pesos = calcularTLC12(baseNetoUSD * tcOficial, cfg.tlc12_pesos.tna);
    }
    if (cfg.tlc12_usd.habilitado) {
      // USD siempre sin interés — se ignora cualquier TNA que
      // pudiera haber quedado escrita por error en el encabezado de
      // esta columna en particular.
      resultado.tlc12_usd = calcularTLC12(baseNetoUSD, 0);
    }
    // Leasing — a diferencia de Contado/TLC6/TLC12 (que muestran el
    // precio NETO y aclaran "+ IVA 10,5%" aparte, porque el cliente
    // paga esa diferencia por fuera), en Leasing el monto que se
    // financia de verdad es la FACTURA COMPLETA — precio + IVA — así
    // que la base para calcular Maxicanon y cánones es totalConIvaUSD
    // (ya calculado arriba, mismo 10,5%), no baseNetoUSD. Pedido por
    // Cristian: "el tema del leasing, el precio base es el precio
    // descontado más IVA, diez coma cinco".
    if (cfg.leasing36_pesos.habilitado && tcOficial && superaUmbralLeasing(totalConIvaUSD)) {
      resultado.leasing36_pesos = calcularLeasing36(totalConIvaUSD * tcOficial, cfg.leasing36_pesos.tna);
    }
    if (cfg.leasing36_usd.habilitado && superaUmbralLeasing(totalConIvaUSD)) {
      resultado.leasing36_usd = calcularLeasing36(totalConIvaUSD, cfg.leasing36_usd.tna);
    }

    return resultado;
  }

  var CalculoFinanciacion = {
    VERSION: '2026.08.16.1',
    leerConfigFinanciacion: leerConfigFinanciacion,
    calcularTLC6: calcularTLC6,
    calcularTLC12: calcularTLC12,
    calcularLeasing36: calcularLeasing36,
    superaUmbralLeasing: superaUmbralLeasing,
    calcularTodosLosModos: calcularTodosLosModos,
    _extraerTnaDeEncabezado: _extraerTnaDeEncabezado, // expuesto para tests
    ANTICIPO_TLC6_PCT: ANTICIPO_TLC6_PCT,
    ANTICIPO_TLC12_PCT: ANTICIPO_TLC12_PCT,
    LEASING36_UMBRAL_USD: LEASING36_UMBRAL_USD,
  };

  // Log propio, independiente del de ficha-equipo.html — hasta ahora
  // este archivo no tenía NINGUNA forma de confirmar en consola qué
  // versión estaba realmente sirviendo el servidor, aunque
  // ficha-equipo.html mostrara su propia versión correcta. Como son
  // DOS archivos separados con <script src="calculo-financiacion.js">,
  // uno podía estar actualizado y el otro no, sin ninguna forma de
  // saberlo desde la consola. Reportado por Cristian: TNA seguía en
  // 0% después de confirmar ficha-equipo.html en la última versión —
  // la causa real terminó siendo que este archivo específico no se
  // había vuelto a subir con el fix (v2026.08.14.3) de la regex
  // tolerante a guion bajo.
  if (typeof window !== 'undefined' && window.console) {
    console.log("%c TLC calculo-financiacion.js v" + CalculoFinanciacion.VERSION + " ", "background:#06d6a0;color:#0f172a;font-weight:bold;border-radius:4px;padding:2px 8px;");
  }

  // UMD chico — funciona tanto en el navegador (window.CalculoFinanciacion)
  // como en Node (para los tests y `node --check`).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CalculoFinanciacion;
  } else {
    global.CalculoFinanciacion = CalculoFinanciacion;
  }
})(typeof window !== 'undefined' ? window : this);
