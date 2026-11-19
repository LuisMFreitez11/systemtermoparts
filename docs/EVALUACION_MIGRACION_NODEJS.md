# Evaluación: migrar el backend de PHP a Node.js + Express

**Fecha:** 2026-11-18
**Alcance:** backend de `TERMOPARTALMACEN` (WMS Termo Parts FW)
**Estado:** migración ejecutada. El backend Node (`server/`) es el activo y el
PHP quedó archivado en `legacy/backend` (no se despliega).

> **Nota de rutas:** en este documento `backend/` se refiere al backend PHP
> original; hoy vive en `legacy/backend/`. El backend activo es `server/` y las
> funciones serverless están en `api/`.

---

## 1. Veredicto

**Viable y recomendable, con una condición: conviene hacerlo como segundo backend
en paralelo (`server/`), no reescribiendo el PHP de golpe.**

El código es pequeño y muy regular: 2.644 líneas PHP, 6 entidades, 16 acciones de
escritura y cero dependencias de Composer. No hay ORM, ni framework, ni magia:
todo es PDO + `switch`. Eso hace que la conversión sea mecánica y verificable.

El argumento decisivo **no** es el rendimiento, es el despliegue: hoy Vercel no
puede ejecutar PHP, por eso el proyecto quedó partido en dos plataformas y con
cookies `SameSite=None`. Con Node + Express el backend corre **como función
serverless en el mismo Vercel**, misma origin, sin CORS y sin problemas de cookies.
Es la diferencia entre "dos despliegues y un dominio extra" y "un solo `vercel
--prod`".

| Criterio | PHP actual | Node + Express |
|---|---|---|
| Despliegue | Hosting PHP aparte + Vercel | **Un solo Vercel** (serverless) |
| CORS / cookies cross-site | Necesarios | **Innecesarios** (mismo origen) |
| Sesiones | Archivos en el servidor | Cookie firmada stateless (HMAC) |
| Cold start | N/A | 200–600 ms (aceptable) |
| Pool de conexiones | Persistente | Pooler de Supabase (puerto 6543) |
| Concurrencia idempotente | SELECT+INSERT (carrera) | `INSERT ... ON CONFLICT` atómico |
| N+1 en activos | 4 consultas por material | 1 consulta por lote |

**Esfuerzo realista:** 26–34 h de trabajo senior (≈ 4 jornadas), incluidos tests.
**Riesgo:** medio-bajo. **Costo de mantenimiento futuro:** menor (un solo lenguaje
en todo el stack, tipado con JSDoc/TS opcional).

---

## 2. Qué se conserva y qué cambia

| Capa | Acción |
|---|---|
| Base de datos (Supabase/PostgreSQL 17) | **Sin cambios.** Mismo esquema, mismos datos, RLS intacto |
| MariaDB de respaldo | Se mantiene la abstracción de driver (`pg` / `mysql2`) |
| Frontend (HTML/CSS/JS, PWA, IndexedDB, outbox) | **Sin reescritura.** Solo `config.js` y, si aplica, mismo origen |
| Rutas y contratos JSON | **Idénticos** (`api.php?accion=...`), para no tocar las 9 páginas |
| Backend PHP | Se queda como respaldo funcional hasta validar paridad |
| Autenticación | Misma tabla `usuarios`, mismos hashes, misma semántica de roles |

La regla de oro: **el frontend no se entera del cambio**. Si un endpoint devuelve
otra forma, es un bug de la conversión, no una decisión de diseño.

---

## 3. Compatibilidad verificada contra la base real

Medido hoy contra Supabase (`PostgreSQL 17.12`):

| Punto | Hallazgo | Impacto / solución |
|---|---|---|
| Hashes de clave | 8/8 son `$2y$` (bcrypt de PHP) | `bcryptjs` verifica `$2y$` sin migración; rehash a `$2b$` en el próximo login |
| Tipos ENUM | `tipo_activo`, `estado_herramienta`, `rol_usuario`, tipos de movimiento | Se envían como texto; no requieren cambios |
| `numeric` | El driver de Node devuelve string | **Mantener string** para paridad exacta con PHP (los `float` se castean donde PHP lo hace) |
| `timestamp` | Node lo convierte a `Date` y serializa ISO con `T`/`Z` | **Forzar parser a string** (`pg.types.setTypeParser(1114/1184)`), si no el frontend rompe fechas |
| IDs autoincrementales | PHP usaba `lastInsertId` con secuencia | `INSERT ... RETURNING id` (más seguro y 1 viaje menos) |
| `FOR UPDATE` | Usado en ajustes, activos, herramientas, entradas, dañados | Se conserva: es lo que evita sobreventa de stock |
| Transacciones | 8 bloques explícitos | `BEGIN/COMMIT` con cliente dedicado del pool |
| RLS | Activo, backend conecta como owner | Igual en Node; RLS no estorba al owner |
| `password_hash` futuro | PHP y Node pueden coexistir | Ambos leen/escriben bcrypt; convivencia segura |

Índices existentes: 33, cubriendo búsquedas por producto, fecha, cliente,
categoría, estado y las claves únicas de negocio. **No falta ningún índice**; el
problema de rendimiento es de aplicación, no de esquema.

---

## 4. Problemas reales encontrados (y que la conversión debe corregir)

### 4.1 N+1 confirmado en activos

`api_activos.php` ejecuta, **por cada material**, un `SELECT ... FOR UPDATE`, un
`UPDATE`, un `INSERT` de movimiento y un `INSERT` de relación:

```
crear activo con N materiales  →  1 + 4N consultas
actualizar activo con N materiales → 3 + 6N consultas
eliminar activo con N materiales → 2 + 3N consultas
```

Con 15 materiales son ~60–90 viajes a Supabase (pooler, ~30–60 ms cada uno):
2–5 s de espera y una transacción abierta reteniendo locks. En un almacén con
internet lento esto se siente como "se colgó".

**Corrección en Node:** una sola lectura bloqueante del lote
(`WHERE producto_id = ANY($1) ORDER BY producto_id FOR UPDATE`), actualizaciones
masivas con `UPDATE ... FROM (VALUES ...)` y un `INSERT` multi-fila de
movimientos/relaciones. De `1+4N` a **4 consultas fijas**, sin importar N.
La validación de stock insuficiente se hace en memoria sobre el lote bloqueado.

### 4.2 Idempotencia: cobertura correcta, implementación con carrera

Lo bueno: las 16 acciones de escritura pasan por `Http::json`, que cierra la
idempotencia, y el frontend ya envía `X-Idempotency-Key` en todo `POST`.

Lo malo: la toma de la clave es `SELECT` y luego `INSERT`. Dos clics simultáneos
(dos peticiones en paralelo, no secuenciales) hacen que la segunda choque con la
PK; el `catch (PDOException)` la interpreta como **"tabla no disponible"** y
ejecuta la operación **sin idempotencia**. Es decir, el caso exacto que la
funcionalidad debía evitar puede duplicar el consumo.

**Corrección en Node:** reclamo atómico
`INSERT ... ON CONFLICT (clave) DO NOTHING RETURNING ...`; si no inserta, se lee
la fila y se decide *replay* (misma huella) o *409* (huella distinta / en
proceso). Además se añade `Expires` corto y limpieza por TTL.

### 4.3 Idempotencia solo en el transporte, no en el botón

El `disabled` del botón se aplica después del `await` de validación previa en
algunas pantallas. Un doble clic rápido puede disparar dos `apiFetch` con **dos
claves distintas** (cada llamada genera la suya) y duplicar la operación aunque
el backend sea perfecto.

**Corrección:** guardia de un solo disparo por formulario en el cliente
(`data-enviando`, botón + submit handler) y clave de idempotencia **estable por
intento** (se genera al abrir el formulario y se reutiliza en reintentos), no por
llamada. Es un cambio de ~30 líneas en `api-client.js` que beneficia también a la
cola offline.

### 4.4 Detalles menores

- `registrar_toma_fisica` hace `UPDATE productos` de toda la tabla (854 filas):
  en Node se mantiene, pero dentro de transacción corta y con `RETURNING` para
  evitar el `SELECT` posterior.
- `exportar_excel.php` genera XLSX a mano (XML + ZIP): portable tal cual a Node
  usando `fflate` (40 KB) en vez de arrastrar `exceljs`.
- `exportar_pdf.php` devuelve HTML imprimible: se porta como plantilla, sin
  dependencias.
- `health.php` debe seguir sin exponer datos de negocio.

---

## 5. Arquitectura propuesta

```
server/
├─ package.json
├─ src/
│  ├─ app.js              # Express 5, middlewares, montaje de rutas
│  ├─ server.js           # listen local
│  ├─ api/index.js        # entrypoint serverless para Vercel
│  ├─ config.js           # env > .env > defaults (paridad con config.php)
│  ├─ db.js               # pg.Pool + parser de fechas + transacción helper
│  ├─ http.js             # json/error/cors/bodyLimit
│  ├─ auth.js             # cookie HMAC firmada, roles, login/logout/clave
│  ├─ audit.js            # historial_usuario
│  ├─ idempotency.js      # reclamo atómico + replay + TTL
│  ├─ routes/
│  │  ├─ productos.js  activos.js  herramientas.js
│  │  ├─ entradas.js   danados.js  historial.js
│  │  ├─ sesion.js     exports.js  health.js
│  └─ sql/                # consultas por caso de uso, sin SQL en las rutas
├─ test/
│  ├─ unit/               # validadores, huellas, constructores SQL
│  ├─ http/               # supertest + repositorio en memoria
│  ├─ parity/             # Node vs PHP contra Supabase (solo lectura)
│  └─ concurrency/        # 20 POST simultáneos con la misma clave
└─ scripts/               # migrate/verificar equivalentes
```

Stack: **Node 24 LTS, Express 5, pg, bcryptjs, zod, helmet, pino, fflate**.
Gestor: **pnpm** (no npm). Tests: `node:test` + `supertest` + `autocannon`.

Sin ORM a propósito: el SQL ya existe, está probado y es legible; un ORM añadiría
abstracción y riesgo de N+1 nuevo.

---

## 6. Plan de pruebas (lo que exige "que no haya ningún error")

| Nivel | Qué prueba | Herramienta |
|---|---|---|
| Unitario | Validadores (stock, fechas, estados), huella de idempotencia, constructor del lote `VALUES` | `node:test` |
| HTTP aislado | 200/400/401/403/404/405/409/422 por endpoint, sesión expirada, rol, idempotencia replay y conflicto | `supertest` + repo en memoria |
| Paridad | Los 12 GET reales comparados campo por campo contra PHP (mismos datos, mismo orden, mismos tipos) | script de diff JSON |
| Concurrencia | 20 peticiones simultáneas con la misma `X-Idempotency-Key` → **1 sola fila** y 1 sola auditoría | `Promise.all` |
| N+1 | Contador de consultas instrumentado: crear activo con 15 materiales debe usar ≤ 6 consultas | hook del pool |
| Carga | `autocannon` 50 conexiones sobre `listar` (854 productos) y sobre historial | `autocannon` |
| Regresión | Login, ajuste, entrada, dañado, préstamo y devolución contra Supabase con limpieza al final | suite `integration` |

Criterio de aceptación para apagar PHP:
1. Paridad GET en 12/12 endpoints, 0 diferencias.
2. Suite completa en verde.
3. Concurrencia: 1 sola aplicación por clave.
4. Activos: consultas constantes con 1, 5 y 15 materiales.
5. Una semana de uso real con ambos backends accesibles.

---

## 7. Riesgos y mitigación

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Diferencia sutil de tipos JSON (`numeric`, fechas) | Alta si no se controla | Parsers explícitos + test de paridad byte a byte |
| Sesiones serverless | Media | Cookie firmada stateless; sin estado en memoria |
| Pooler de Supabase agotando conexiones | Media | `max: 1–3`, `idleTimeoutMillis`, transaction mode |
| Cold start en exports grandes | Baja | Streaming y `fflate`; medir con autocannon |
| Drift entre PHP y Node durante la transición | Media | Un solo esquema, una sola tabla de idempotencia, paridad automatizada |
| Locks por transacciones largas | Baja tras batching | Transacción corta, lote bloqueado una sola vez |

---

## 8. Cronograma propuesto

| Fase | Entregable | Horas |
|---|---|---|
| 1 | Infra: config, DB, HTTP, auth, idempotencia atómica + tests | 5 |
| 2 | Productos + sesión + historial (paridad completa) | 4 |
| 3 | Activos con batching anti-N+1 + tests de conteo | 5 |
| 4 | Herramientas, entradas, dañados | 5 |
| 5 | Exports PDF/XLSX + health | 3 |
| 6 | Suite de paridad, concurrencia y carga | 5 |
| 7 | Despliegue Vercel serverless + documentación | 3 |
| | **Total** | **30 h** |

Se puede cortar en la fase 4 y ya tener el 80 % del valor.

---

## 9. Recomendación

1. **Sí a Node + Express**, como `server/` independiente.
2. **No borrar el PHP**: se conservó completo en `legacy/backend` y
   `legacy/app-php`, fuera del despliegue.
3. **Sí a corregir N+1 e idempotencia atómica** en la conversión; son los dos
   defectos reales que hoy existen, y se arreglan mejor de cero que parchando PHP.
4. **Sí a Vercel serverless** para el backend: elimina CORS, cookies cross-site y
   el hosting PHP separado.
5. El frontend no se toca salvo `config.js` y la guardia anti doble clic.
