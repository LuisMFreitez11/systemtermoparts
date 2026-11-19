# Backend Node.js + Express (`server/`)

Segundo backend del WMS, con **el mismo contrato JSON y las mismas rutas** que
el backend PHP archivado (`legacy/backend/public`). El frontend no distingue
cuál responde: en local se puede usar cualquiera de los dos y en Vercel corre
este.

| | PHP (`legacy/backend/`) | Node (`server/`) |
|---|---|---|
| Motor de base | PostgreSQL **y** MariaDB | Solo PostgreSQL/Supabase |
| Sesión | Archivos de PHP | Cookie firmada (HMAC) |
| Despliegue | Hosting con PHP | Vercel Serverless |
| Estado | Archivado | Backend activo |

> El backend PHP **no se elimina**: sigue en `legacy/backend` como respaldo para
> MariaDB y referencia de comportamiento, pero **no se despliega**.

---

## 1. Estructura

```
server/
├─ package.json          # scripts; las dependencias viven en la raíz
├─ .env.example          # plantilla (server/.env no se versiona)
├─ src/
│  ├─ app.js             # Express: CORS, cuerpo crudo, montaje de routers
│  ├─ server.js          # arranque local (node src/server.js)
│  ├─ config.js          # env > server/.env > legacy/backend/.env > defaults
│  ├─ db.js              # pool pg, zona horaria, transacciones, db inyectable
│  ├─ http.js            # helpers con paridad PHP (entero, numero, cantidad…)
│  ├─ auth.js            # login bcrypt + cookie HMAC, roles
│  ├─ audit.js           # historial_usuario
│  ├─ idempotency.js     # reclamo atómico + replay de respuestas
│  ├─ sql.js             # VALUES en lote, arreglos PostgreSQL
│  └─ routes/
│     ├─ productos.js    ├─ activos.js       ├─ herramientas.js
│     ├─ entradas.js     ├─ danados.js       ├─ historial.js
│     ├─ sesion.js       ├─ exports.js       └─ health.js
└─ test/
   ├─ unit/              # helpers y validadores (sin base)
   ├─ http/              # rutas, errores y concurrencia (sin base)
   ├─ parity/            # Node vs PHP real (requiere RUN_INTEGRATION=1)
   └─ integration/       # escrituras reales + anti-N+1 (RUN_INTEGRATION=1)
```

`api/` contiene una función serverless por recurso (`api/productos.js`,
`api/activos.js`, …). Todas importan la misma app de `server/src/app.js`.

---

## 2. Arranque local

Requisitos: **Node 22+** (probado con 24) y **pnpm**. No se usa `npm`.

```powershell
# Dependencias en la raíz (Vercel las resuelve desde api/)
pnpm install

# Servidor en http://localhost:3000
pnpm start
# o con recarga automática
pnpm dev
```

Configuración: copia `server/.env.example` como `server/.env` o reutiliza
`legacy/backend/.env`. La prioridad es
`variables de entorno > server/.env > legacy/backend/.env > valores por defecto`.

`pnpm start` sirve también `frontend/` en el mismo origen, así que
<http://localhost:3000> abre la app completa. `pnpm dev` añade recarga
automática.

Comprobación rápida:

```powershell
curl http://localhost:3000/health.php
# {"exito":true,"servicio":"wms-termo-part","hora":"...","motor":"pgsql"}

curl "http://localhost:3000/api_sesion.php?accion=estado"
# {"autenticado":false,"usuario":null}
```

La app también acepta los alias limpios (`/api/productos`, `/api/activos`, …)
que usan los `rewrites` de Vercel.

---

## 3. Variables de entorno

| Variable | Por defecto | Notas |
|---|---|---|
| `DB_DRIVER` | `pgsql` | Solo `pgsql`; con otro valor el proceso no arranca |
| `DB_PGSQL_DSN` | — | `pgsql:host=...;port=5432;dbname=postgres;sslmode=require` |
| `DB_PGSQL_USER` / `DB_PGSQL_PASSWORD` | — | Usuario del pooler de Supabase |
| `DB_POOL_MAX` | `3` | Conexiones por instancia; en serverless no subir || `SESSION_SECRET` | derivado en desarrollo | **Obligatorio en producción** |
| `SESSION_NAME` | `TERMOPART_SESS` | Igual que PHP |
| `SESSION_LIFETIME` | `43200` | Segundos (12 h) |
| `SESSION_SAMESITE` / `SESSION_SECURE` | `Lax` / `0` | `None` + `1` si el frontend está en otro dominio |
| `CORS_ALLOWED_ORIGINS` | vacío | Lista separada por comas |
| `IDEMPOTENCY_ENABLED` | `1` | — |
| `IDEMPOTENCY_TTL` | `604800` | Retención de respuestas (7 días) |
| `IDEMPOTENCY_IN_PROGRESS` | `120` | Segundos antes de considerar muerto un reclamo |
| `IDEMPOTENCY_WAIT` | `8` | Espera máxima de un reintento antes de 409 |
| `APP_TIMEZONE` | `America/Caracas` | Se fija por conexión con `SET TIME ZONE` |
| `APP_DEBUG` | `0` | Con `1`, los 500 muestran el mensaje real |
| `PORT` | `3000` | Solo local |

---

## 4. Idempotencia (un botón = una ejecución)

Todos los POST pasan por `idempotency.js` **excepto** `api_sesion.php` (el
replay de un login perdería el `Set-Cookie`).

1. El frontend envía `X-Idempotency-Key` (UUID por operación).
2. La huella es `sha256(endpoint|accion|cuerpoCrudo)`, **idéntica a PHP**, para
   que una operación pueda reintentarse contra cualquiera de los dos backends.
3. El reclamo es atómico: `INSERT ... ON CONFLICT (clave) DO NOTHING`. Dos
   clics simultáneos solo pueden insertar una fila.
4. Si la clave ya está **COMPLETADA**, se replica la respuesta guardada con
   `X-Idempotent-Replay: true` y no se ejecuta nada.
5. Si sigue **EN_PROCESO**, el reintento espera hasta `IDEMPOTENCY_WAIT`
   segundos, sondeando cada 120 ms, y devuelve la misma respuesta.
6. Clave reutilizada con **otro cuerpo** → `409` con
   `idempotencia_conflicto: true`.
7. Proceso caído: pasado `IDEMPOTENCY_IN_PROGRESS` el reclamo se libera y la
   operación se puede reintentar.
8. Un error (`4xx`/`5xx`) **no** se cachea: libera la clave para corregir y
   reintentar.

En el cliente, `frontend/js/api-client.js` además comparte la misma promesa y la
misma clave cuando dos envíos idénticos coinciden mientras el primero sigue en
curso (doble clic o doble `submit`), de modo que solo sale **una** petición.

---

## 5. Sin N+1

Crear o actualizar un activo con N materiales **no** hace 2N+1 consultas:

1. `SELECT ... WHERE producto_id = ANY($1) ORDER BY producto_id FOR UPDATE`
   (una sola consulta, bloqueo ordenado para evitar interbloqueos).
2. `UPDATE productos ... FROM (VALUES ...)` (un solo `UPDATE` en lote).
3. `INSERT INTO movimientos_inventario ... VALUES (...), (...)` (multi-fila).
4. `INSERT INTO activo_materiales ...` multi-fila.

El test `server/test/integration/escrituras.test.js` mide las consultas reales y
exige que 2 y 15 materiales usen **el mismo número** (≤ 3).

---

## 6. Pruebas

```powershell
# 60 pruebas rápidas: helpers, validadores, rutas, errores, CORS,
# cookies, JSON inválido, 401/400/405/404/409, idempotencia concurrente
# y la guardia anti doble clic del cliente.
pnpm test

# Añade paridad e integración (escriben en Supabase; se limpian solas).
$env:RUN_INTEGRATION = '1'
pnpm test:all
```

| Suite | Qué cubre | ¿Base real? |
|---|---|---|
| `test/unit` | Helpers con paridad PHP, validadores, `VALUES` en lote | No |
| `test/http` | Routing, 401/405/404, CORS, cookies, 20 POST concurrentes | No |
| `test/parity` | Diff Node vs PHP con el mismo login y datos | Solo lectura |
| `test/integration` | Ciclo CRUD completo + conteo anti-N+1 | Sí (se limpia) |

Las suites con `RUN_INTEGRATION=1` requieren `legacy/backend/.env` (o
`server/.env`) y, para paridad, PHP CLI en `C:\xampp\php\php.exe` (o `PHP_BIN`).
No se ejecutan en CI sin secretos: quedan `skip` por defecto.

Limpieza de las suites de escritura: prefijos `ZZTEST…` / `zztest-…` y borrado
del historial por encima del `MAX(historial_id)` tomado **antes** del login.

---

## 7. Despliegue en Vercel

1. Importa el repositorio en **vercel.com/new** con preset **Other**.
2. Build Command: vacío. Output Directory: `frontend` (ya está en `vercel.json`).
3. Variables de entorno (Production y Preview):
   - `DB_DRIVER=pgsql`
   - `DB_PGSQL_DSN`, `DB_PGSQL_USER`, `DB_PGSQL_PASSWORD`
   - `SESSION_SECRET` (largo y aleatorio; sin él las sesiones se invalidan en
     cada instancia)
   - `SESSION_SAMESITE=None`, `SESSION_SECURE=1` si el frontend y la API no
     comparten dominio (con el mismo dominio, `Lax` y `0` funcionan)
   - `CORS_ALLOWED_ORIGINS=https://tu-proyecto.vercel.app`
   - `FRONTEND_URL=https://tu-proyecto.vercel.app`
   - `IDEMPOTENCY_WAIT=5` (margen dentro del límite de la función)
   - `DB_POOL_MAX=3`

> **Pooler**: en Vercel conviene el pooler de Supabase en el puerto **6543**
> (modo transacción), pensado para serverless. Con el puerto `5432` (modo
> sesión) cada instancia retiene conexiones mientras está congelada y se puede
> agotar el límite del proyecto. Ambos puertos se probaron con este backend.
4. Deploy. `vercel.json` reescribe `/api.php`, `/api_activos.php`, … a
   `/api/productos`, `/api/activos`, … y da 30 s de `maxDuration` a las
   funciones. La región es `yul1` (Montreal), junto a Supabase `ca-central-1`.
   `.vercelignore` deja fuera `legacy/`, `docs/`, `database/` y las pruebas.
5. Comprueba:
   - `https://TU-APP/health.php`
   - login real
   - `/exportar_excel.php` (MIME xlsx) y `/exportar_pdf.php` (HTML)
   - dos clics seguidos en un botón → una sola fila en el historial

Si el frontend y la API comparten dominio (caso Vercel), `config.js` deja
`apiBase = ''` automáticamente y las peticiones van al mismo origen.

---

## 8. Seguridad y límites

- **Cookie firmada**: `base64url(JSON).HMAC-SHA256`, `HttpOnly`, `Secure` y
  `SameSite=None` automáticos si el `Origin` es cruzado. No hay estado en el
  servidor: **logout borra la cookie en el cliente**, pero un token copiado
  sigue siendo válido hasta expirar. Cambiar la clave tampoco revoca tokens
  emitidos; para invalidar todo, rota `SESSION_SECRET`.
- Contraseñas con `bcryptjs` (compatible con los hashes `$2y$` de PHP).
- Consultas preparadas en todas las operaciones; nunca se interpola entrada.
- RLS de Supabase se mantiene activo: el backend conecta con el rol propietario,
  igual que PHP (ver `legacy/backend/database/rls_supabase.sql`).
- Credenciales solo por entorno; `server/.env` está en `.gitignore`.
- El backend Node **no** implementa MariaDB. Para ese motor, usa PHP.
