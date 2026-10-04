# Plan de migración — Apps Script → Cloud Functions

**Última actualización:** 04/10/2026 (frontend en `v2026.10.04.8`) — Fases 1, 2 y 4 completas

**Objetivo:** sacar el Portal TLC de Apps Script por completo, sacar `historico.json` (y los datos en general) del repositorio de código, y eliminar todo lo que ralentiza la app. Se hace módulo por módulo, con el patrón ya probado: una Cloud Function equivalente, testeada, con su propia URL, apuntada desde el frontend sin tocar el resto.

**Cómo usar este archivo:** es la fuente única del estado de la migración. Al empezar un chat nuevo, alcanza con decir "seguimos con el plan": Claude lee este archivo, el frontend y el backend (`FUNCTIONS-BACKUP/`) directamente del repo. Al terminar cada sesión, se actualiza este archivo.

---

## 🗂️ Dónde está cada cosa en el repo

| Qué | Dónde |
|---|---|
| Frontend (páginas y scripts compartidos) | raíz: `*.html`, `adjuntos.js`, `permisos.js`, `dictado.js`, `version.js`, `sw.js`, `avatar.js` |
| Checklists y POE | `Check lists/`, `POE/` |
| Cloud Functions (respaldo del código desplegado) | `FUNCTIONS-BACKUP/<modulo>-function/` (`index.js` + `package.json`) |
| Asistente IA | `FUNCTIONS-BACKUP/functions/` |
| Apps Script | `FUNCTIONS-BACKUP/apps-script/fotomap.gs.txt` |
| Este plan | `FUNCTIONS-BACKUP/PLAN-MIGRACION.md` |

**Regla:** cada vez que se despliega una Cloud Function, se sube el mismo `index.js` a su carpeta en `FUNCTIONS-BACKUP/`, para que el respaldo coincida con lo que corre.

**Desplegar una función (CMD, en la carpeta con `index.js` y `package.json`):**
```
gcloud functions deploy <nombre> --gen2 --region=us-central1 --runtime=nodejs22 --source=. --entry-point=<nombre> --trigger-http --allow-unauthenticated
```

---

## 📊 Estado en números (relevado del código el 04/10)

- **59 llamadas** a Apps Script en el frontend (eran 66 el 30/09), repartidas en 13 archivos. Lo que queda es Cotizaciones, Cuenta Corriente, Checklists/POE, Login y el selector.
- **Ya no llaman a Apps Script:** `presupuesto-editor.html`, `mi-dia.html`, `comisiones.html`.
- **Commits de datos al repo:** ~113 por día (57 de `sincronizarRTDBaGitHub` + 56 de `precios.json`). Cada uno dispara un build de GitHub Pages.
- **El mayor problema de velocidad que queda:** `servicio_tecnico.json` pesa ~11 MB por las fotos en base64, y lo descargan completo **Servicio Técnico, Cuenta Corriente y Tareas**.

---

## ✅ Ya migrado

| Módulo | Acciones | Cloud Function |
|---|---|---|
| Empresas | listarEmpresas, guardarEmpresa, borrarEmpresa, guardarContacto, borrarContacto, reasignarEmpresaNegocio | `empresas` |
| Tareas | crearTarea, listarTareas, completarTarea, eliminarTarea | `tareas` |
| Fotos | lectura del mapa de fotos | `fotos` |
| Eventos (completo) | 33 acciones: checklist, notas, listado, eventos, logo, columnas, tarjetas, gastos, portada, mensajes, reacciones, adjuntos | `eventosChecklist` |
| Notificaciones | guardarTokenPush, listarNotificaciones, marcarNotificacionLeida, reaccionarNotificacion, marcarTodasNotificacionesLeidas | `notificaciones` |
| Pipelines | listarPipelines, guardarPipeline, eliminarPipeline | `pipelines` |
| Servicio Técnico | 21 acciones `st_*` + marcarNegocioUrgente, marcarTarjetaUrgenteEv, st_crearOrdenPreparacion | `servicio` |
| Internos | listarInternos | `internos` |
| Comisiones | calcularComisiones, guardarComisionManual | `internos` |
| Cotizaciones (parcial) | guardarPresupuestoEditor | `cotizaciones` (v2) |
| Pipelines (parcial Cotizaciones) | asignarPipelineNegocio | `pipelines` (v2) |
| Empresas desde Ficha de equipo y Cotizaciones | listarEmpresas, guardarEmpresa, guardarContacto | `empresas` (ya existían; se redirigió el frontend) |
| Reacciones desde la campanita (Servicio y Eventos) | st_reaccionarMensaje, ev_reaccionarMensaje | `servicio` / `eventosChecklist` |
| Radar de Inicio | lectura de negocios | Firebase directo (antes `historico.json` de GitHub) |
| Cuenta Corriente (completo) | 8 acciones + cc_gastosOrigenes | `cuentaCorriente` (nueva) |
| Cotizaciones — lectura de mensajes | cot_listarMensajes lee directo `cotizaciones/{id}/mensajes` de Firebase (Apps Script solo como respaldo) | — (Firebase directo) |

---

## 🆕 Hecho entre el 30/09 y el 03/10

| Versión | Qué |
|---|---|
| .09.30.1 | **Dueño del negocio:** editar un presupuesto ya no cambia el vendedor. Solo un Administrador puede reasignarlo, y con confirmación. |
| .09.30.2 | **Mensajes al instante** en Cotizaciones (Firebase directo) y Eventos (abre la tarjeta al toque, refresco cada 10 s). Arreglados 2 bugs: el refresco de mensajes de Cotizaciones nunca funcionó y las reacciones dentro del chat no hacían nada; en Eventos con caché los mensajes nuevos nunca se mostraban. **Adjuntos:** confirmación visible, reintento y botón bloqueado mientras sube. |
| .09.30.3 | `index.html`: eliminado el escaneo QR de FacoExtrema. |
| .09.30.4 | Cuenta Corriente abre al instante (caché) y bloquea escrituras hasta tener datos frescos. |
| .09.30.5 | Tareas (Mi Día) abre al instante (caché); eliminada la URL de Apps Script sin uso. |
| .09.30.6 | `empresas.html`: eliminado el escaneo QR completo. |
| .09.30.7 | Oculto el botón flotante del Asistente IA en los 7 módulos (el código queda). |
| .09.30.8 → .11 | **Permisos de Comisiones:** ver lecciones 8 y 9. |
| .09.30.12 | Comisiones: cálculo en paralelo con el permiso + apertura al instante (caché). |
| .09.30.13 | **Adjuntos en Servicio:** se subían pero no aparecían hasta refrescar (ver lección 13). |
| .10.02.1 | **Dictado por voz 🎤** en el chat de Cotizaciones, Servicio y Eventos (`dictado.js`, compartido). |
| Función `cotizaciones` v2 | `guardarPresupuestoEditor` ya no pisa el vendedor de un negocio existente (blindaje del lado del servidor). En el repo ✅ · desplegada ⏳ *(confirmar)*. |
| Backend | Subidas las 10 Cloud Functions a `FUNCTIONS-BACKUP/`. Sin claves en el código (Brevo y Gemini por variables de entorno). |

---

## 🆕 Hecho el 03 y 04/10

| Versión | Qué |
|---|---|
| .10.03.1 | Dictado 🎤: arreglado en Android (repetía palabras). |
| .10.03.2 → .4 | **Servicio — métricas de carga por técnico** (tabla por etapa: Diagnóstico, Presupuesto, Reparación, Preparación, Para facturar; personas = asignados de cada columna; verde = menos carga). Administrador ve todo; el resto, su fila. |
| .10.03.4 | Orden de Preparación: cuando todos los equipos quedan "Listo para despacho", el responsable pasa solo a Lourdes. |
| .10.03.5 + función `servicio` v2 | **Dividir entrega (envío parcial)**: órdenes -E2, -E3… con su propio remito/etiquetas; el negocio refleja la entrega más atrasada. |
| .10.03.6 | **Responsable único** en Órdenes de Preparación (tarjeta, detalle, filtro y métricas usan el mismo dato). |
| .10.03.7 → .9 | **Permisos**: cada módulo consulta Firebase en cada apertura (sin caché); el rol de la sesión se actualiza solo; se quitó el alias "Ver Comisiones" (abría Comisiones a externos). |
| .10.03.10 | Servicio reconoce al técnico por su email real (arregla "Mi carga" y "Asignados a mí"). |
| .10.03.11 | Cuenta Corriente: liquidar/deshacer según el tilde **"Liquidar Gastos"** de la hoja Vendedores. |
| .10.03.12 | Tarjetas de Servicio pasan solas a **"En curso"** cuando el asignado trabaja en ellas. |
| .10.04.1 + `servicio` v3 | La **Garantía** ya no entra en las Órdenes de Preparación (y se limpia sola en las viejas). Editor de presupuesto: **filas ordenables** arrastrando ⠿. |
| .10.04.2 + `servicio` v4 | **Progreso de preparación**: "Listo para despacho" con serie y calidad = 100 %; "Enviado" es solo una marca (🚚, violeta). |
| .10.04.3 + `pipelines` v2 | **Fase 1 completa** (ver Orden de trabajo). |

## 📍 Lo que todavía llama a Apps Script (por archivo)

| Archivo | Acciones | Destino propuesto |
|---|---|---|
| `cotizaciones.html` | actualizarCheckCierre, actualizarColaborador, actualizarContactoCotizacion, actualizarCotizacion, actualizarEstado, actualizarTelefono, agregarNota, editarNota, eliminarNota, cot_agregarMensaje, cot_reaccionarMensaje, eliminarDeal, eliminarVersionPresupuesto, reasignarVendedor, subirCotizacion · respaldo de cot_listarMensajes | `cotizaciones` (Fase 5) |
| `ficha-equipo.html` | agregarNota, apilarFichaTecnica, buscarNegocioAgrupable | `cotizaciones` (Fase 5) |
| `index.html`, `selector-dispositivos.html` | solicitarCodigoLogin, verificarCodigoLogin (LOGIN) | Cloud Function nueva, con fallback |
| `selector-dispositivos.html` | registrarCotizacion · consultarCliente (ARCA) y sincronizarHubSpot (a borrar) | `cotizaciones` |
| `empresas.html` | crearNegocioVacio | `cotizaciones` |
| `index.html`, `eventos.html`, `servicio.html`, `cotizaciones.html` | reacción desde la campanita a un mensaje de **Cotizaciones** (cot_reaccionarMensaje) | `cotizaciones` (Fase 5) |
| Triggers de Apps Script | sincronizarPermisosAFirebase, sincronizarPreciosAFirebase, sincronizarRTDBaGitHub | Ver Fase 6 y 8 |

---

## ❌ Dado de baja — se elimina, no se migra

Decidido el 28/09/2026: **ARCA** (validación de CUIT) y **contacto por QR**.

- ✅ QR eliminado de `index.html` y `empresas.html`.
- ✅ QR eliminado también de `ficha-equipo.html` (04/10).
- ⏳ ARCA: ya no está en `empresas.html`; queda `consultarCliente` en `selector-dispositivos.html`, dentro del flujo de registrar cotización → se borra en la Fase 5 junto con `registrarCotizacion`.
- `sincronizarHubSpot`: HubSpot está desactivado, se borra junto con ARCA.

---

## 🔎 Correcciones al plan anterior (29/09)

1. **Checklists y POE8 NO son código muerto.** La búsqueda anterior no entró en las subcarpetas `Check lists/` y `POE/`. `listarTecnicos`, `st_guardarChecklist`, `registrarChecklistCompletado`, `reabrirChecklistOrden` y `registrarInstalacionPOE8` **están en uso**. **No borrarlas de `FotoMap.gs`.**
2. **Empresas (Negocios Asociados) ya lee de Firebase.** El único lector directo de `historico.json` en GitHub que queda es el **Radar de Inicio**. Cotizaciones lo usa solo como respaldo.
3. **Cuenta Corriente no figuraba en el plan:** 7 acciones en Apps Script.
4. **Adjuntos de Servicio y Cotizaciones** siguen en Apps Script (solo los de Eventos estaban migrados).
5. `ficha-equipo.html` sí usa `PIPELINES_URL` para pipelines, pero sigue llamando a Apps Script para empresas y contactos aunque `empresas` ya existe.

---

## 📚 Lecciones aprendidas

1. `admin.initializeApp()` necesita `databaseURL` explícito.
2. El body del POST se lee de `req.rawBody` (el Portal manda `text/plain`).
3. `package.json` y `package-lock.json` son archivos distintos: revisar que cada uno tenga su contenido.
4. Firebase RTDB rechaza claves con punto (`.`): codificar nombres de archivo, emails, etc.
5. **Condiciones de carrera:** para arrays/objetos compartidos usar `db.ref(path).transaction(fn)`, nunca leer-todo → modificar → escribir-todo.
6. La caché de localStorage del frontend también hay que mantenerla al día cuando se edita, no solo al cargar.
7. **Buscar siempre en subcarpetas** del repo (`Check lists/`, `POE/`, etc.) antes de declarar una acción "sin uso".
8. **Columnas con el mismo nombre en la planilla se pisan al sincronizar.** En la hoja Vendedores hay dos columnas "Comisiones" (la de tildes y una numérica); en Firebase quedó `"Comisiones": 0`. Un permiso solo cuenta si su valor es un tilde (`true`/`false`); si no, se usa el alias "Ver Comisiones".
9. **Nunca cachear un "NO".** `permisos.js` guardaba 10 minutos también el "sin permiso". Ahora solo se reutiliza un "SÍ".
10. **Un mismo criterio en todos lados.** Si el inicio y el módulo deciden un permiso con reglas distintas, aparece "botón habilitado + acceso denegado".
11. **La clave de un email en Firebase conserva la `@`** (solo se reemplazan los puntos): `permisos/cristian@tlcsrl_com_ar`. Para ver los permisos de alguien: `https://portal-tlc-default-rtdb.firebaseio.com/permisos/<email-con-puntos-como-_>.json`.
12. Al reemplazar una lectura por Firebase directo, verificar primero dónde vive el dato.
13. **Funciones que llaman los scripts compartidos tienen que estar en `window`.** `servicio.html` envuelve todo en `(function(){...})()`, así que `adjuntos.js` no veía `adjuntosRecargar`. Toda función que un `.js` compartido necesite llamar se publica con `window.nombre = nombre`.
14. **Un arreglo no está terminado hasta probarlo en el flujo real.** El arreglo de adjuntos del 30/09 corrigió la función, pero no detectó que no se podía llamar.

---

## 🐢 Lentitud — diagnóstico y estado

| Módulo | Causa | Estado |
|---|---|---|
| Servicio Técnico | `servicio_tecnico.json` ~11 MB por fotos base64 | ✅ Fase 3 (fotos a Storage; falta correr la optimización) |
| Cuenta Corriente | Bajaba Servicio + Eventos completos + 3 llamadas a Apps Script | ✅ Resuelto (Fase 4: solo gastos, por Cloud Function) |
| Tareas (Mi Día) | Baja Ventas + Servicio + Eventos completos | ✅ Mitigado (caché) · ⏳ fondo: Fase 3 |
| Comisiones | Cálculo en la Cloud Function, esperaba al permiso en fila | ✅ Mitigado (paralelo + caché) · ⏳ revisar `calcularComisiones` |
| Cotizaciones — mensajes | Apps Script 1-3 s + polling por Apps Script | ✅ Resuelto (Firebase directo) |
| Eventos — abrir tarjeta | Esperaba la Cloud Function sin caché | ✅ Resuelto (abre al instante) |
| Precios (selector) | Consulta la API de GitHub (límite 60/hora por IP, compartida en la oficina); la caché se invalida con cada commit de precios | ⏳ Fase 1 |
| Radar de Inicio | Lee `historico.json` de GitHub (hasta ~10 min de atraso) | ⏳ Fase 1 |

### Fotos de Servicio a un nodo aparte (Fase 3)
Guardar las fotos en `servicio_tecnico_fotos/{id}` y que el detalle las pida al abrirse. La lista pasa a leer un nodo chico.
- Migración única de las fotos ya guardadas, **con backup antes**, con calma, lejos de un evento.
- Páginas que leen fotos del ticket: `servicio.html`, `orden-servicio.html` (`fotos`, `fotos_antes_reparar`, `fotos_despues_reparar`), `remito-ingreso.html` (`fotos`), `orden-preparacion.html` (`firma_digital`, evaluar).
- Cloud Function `servicio`: `st_crearTicket`, `st_agregarFoto`, `st_eliminarFoto`, `st_duplicarTicket` escriben en el nodo nuevo.
- Mejora a la vez Servicio, Cuenta Corriente y Tareas.

---

## 🗄️ Sacar `historico.json` y los datos del repo

- **Lectores:** solo el Radar de Inicio (directo) y Cotizaciones (respaldo).
- **Escritores con dependencia real:** solo `eliminarVersionPresupuesto` (las versiones viven solo ahí). Hay que pasarlas a `cotizaciones/{id}/versiones_presupuesto`.
- **Orden:**
  1. Radar lee Firebase primero (Fase 1).
  2. `eliminarVersionPresupuesto` con versiones en Firebase (Fase 5).
  3. Respaldo diario fuera del repo para `historico.json` y `precios.json`; se cortan los ~113 commits de datos por día (Fase 6).
  4. Retirar `_leerHistorico`/`_escribirHistorico`/`_pushHistoricoEntry` y el fallback a GitHub de `cotizaciones.html`.

---

## 🗺️ Orden de trabajo

### Fase 1 — Victorias rápidas ✅ (04/10, v2026.10.04.3)
- [x] `cotizaciones.html`: `listarEmpresas` → `empresas`; `asignarPipelineNegocio` → `pipelines` (agregada a la función, v2).
- [x] `ficha-equipo.html`: `listarEmpresas`, `guardarEmpresa`, `guardarContacto` → `empresas`; código QR eliminado.
- [x] Reacciones desde la campanita (`st_`/`ev_`) → `servicio` / `eventosChecklist` (en index, cotizaciones, eventos y servicio).
- [x] Radar de Inicio lee Firebase (`cotizaciones.json`); GitHub solo de respaldo.
- [x] Precios del selector: ya leían Firebase primero; se borró la función sin uso que consultaba la API de GitHub.
- [→] ARCA y `sincronizarHubSpot`: viven en el flujo de registrar cotización del selector → pasan a la Fase 5.

### Fase 2 — Módulos chicos, Firebase puro
- [x] Checklists (5 archivos) y POE8 → `servicio` v5 + `internos` v3 (listarTecnicos). De paso: **"Reabrir checklist" funciona por primera vez** (la acción nunca existió en Apps Script). (04/10, v2026.10.04.5)
- [x] `adjuntos.js` (Servicio y Cotizaciones) → `servicio` v6 (Firebase Storage, mismas rutas; los adjuntos viejos siguen andando). (04/10, v2026.10.04.6)

**Fase 2 completa.**

### Fase 3 — Fotos de Servicio a Firebase Storage (04/10, v2026.10.04.8 + `servicio` v7)
- [x] En vez de un nodo aparte: las fotos se suben a **Firebase Storage** (mismo bucket que los adjuntos) y en el ticket queda el **link**. Las páginas que las muestran no cambian.
- [x] Fotos nuevas (ingreso, antes/después de reparar) y firma de órdenes → Storage. Borrar una foto borra también el archivo.
- [x] Migración de las existentes: botón **"Optimizar ahora"** en Servicio (solo Administrador), con **backup completo** previo en `backups/servicio_tecnico_<fecha>` y migración en tandas.
- [ ] Correr "Optimizar ahora" y confirmar que la carga de Servicio quedó liviana.
- [ ] Después de unos días sin problemas, borrar el backup de Firebase (`backups/…`) para no ocupar lugar.

### Fase 4 — Cuenta Corriente
- [x] Nueva Cloud Function **`cuentaCorriente`** con las 8 acciones (gastos generales, saldo inicial, liquidaciones, liquidar y revertir con transacciones). Nueva `cc_gastosOrigenes`: devuelve solo los gastos de Servicio y Eventos (pocos KB) en vez de que el celular descargue `servicio_tecnico.json` (~11 MB) y `eventos.json` completos. Los gastos de tarjetas se guardan en `servicio` / `eventosChecklist`. (04/10, v2026.10.04.7)

**Fase 4 completa.**

### Fase 5 — Cotizaciones, función por función
- [ ] 5a — Firebase: chat (agregar, reaccionar), notas, estado, teléfono, contacto, colaborador, vendedor, check de cierre.
- [ ] Borrar `consultarCliente` (ARCA) y `sincronizarHubSpot` del selector.
- [ ] 5b — atadas a `historico.json`: subirCotizacion, actualizarCotizacion, eliminarVersionPresupuesto (con versiones a Firebase), eliminarDeal, crearNegocioVacio, registrarCotizacion, apilarFichaTecnica, buscarNegocioAgrupable.
- [ ] Bug conocido: `actualizarCotizacion` no regenera `cotizaciones/{id}/presupuesto` en RTDB.

### Fase 6 — Cortar los commits de datos
- [ ] Respaldo diario fuera del repo (historico y precios); sacar el fallback a GitHub.

### Fase 7 — Login
- [ ] `solicitarCodigoLogin` / `verificarCodigoLogin` con envío por Brevo probado y fallback a Apps Script unos días.

### Fase 8 — Sheets y apagado
- [ ] Decidir qué reemplaza a la planilla (precios, Vendedores/permisos): pantalla de edición en el Portal o seguir con la planilla como paso manual.
- [ ] Mover los triggers de sincronización.
- [ ] Dejar `FotoMap.gs` sin tráfico unos días mirando logs, borrar `APPS_SCRIPT_URL`/`GAS_URL` de todos los archivos y apagarlo.

---

## 📌 Pendientes sueltos

- [ ] **Pasar las funciones a `nodejs22` antes del 30/10/2026** (después Google no deja desplegar con nodejs20). Ya están en 22: `servicio`, `pipelines`, `internos`, `cuentaCorriente`. Faltan: `cotizaciones`, `empresas`, `eventosChecklist`, `fotos`, `notificaciones`, `tareas`, `asistenteIA`.
- [ ] **Sincronizar permisos** se cortó por tiempo (03/10) — confirmar que la hoja Vendedores llegue completa a Firebase (rol "Administrativo" de Lourdes, columna `Liquidar Gastos`) y renombrar la 2ª columna "Comisiones" (numérica).
- [ ] Tildes de capacidades pendientes de decidir: `Ver Todos los Negocios` (Cotizaciones — Lourdes lo necesita para facturar), `Ver Métricas de Todos`, `Administrar Eventos`, `Reasignar Vendedor`.

- [ ] Renombrar la columna numérica "Comisiones" de la hoja Vendedores (lección 8), después de confirmar en `FotoMap.gs` y en `internos` que nada la lee por ese nombre.
- [ ] Revisar `calcularComisiones` (función `internos`) para acelerar el cálculo.
- [ ] Adjuntos de Eventos: confirmar que también aparecen bien en la lista después de subir.
- [ ] Probar el dictado 🎤 con voz real en PC y Android.
- [ ] Negocios que cambiaron de dueño por el bug del 30/09: reasignarlos a mano desde el selector de Vendedor.

Cada fase es independiente: se puede pausar en cualquier punto sin dejar nada roto a medio camino.
