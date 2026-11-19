# Despliegue en Vercel

## Resumen

| Componente | Dónde se despliega | Notas |
|---|---|---|
| Frontend (HTML/CSS/JS/PWA) | **Vercel** | Estático. `vercel.json` sirve `frontend/`. |
| Backend Node + Express | **Vercel** (funciones de `api/`) | Backend activo. Mismas rutas y JSON. |
| Backend PHP + sesiones | Hosting PHP con HTTPS | **Archivado** en `legacy/backend`. Solo si se vuelve a PHP/MariaDB. |

Hay dos caminos válidos:

- **A. Todo en Vercel (el actual):** frontend estático + backend Node
  serverless. No hace falta otro hosting y el frontend queda en el mismo
  dominio (`apiBase = ''`).
- **B. Frontend en Vercel + backend PHP archivado:** solo si algún día se
  retoma PHP o se necesita MariaDB. Ver el Paso 2.

---

## Opción A — Backend Node en Vercel

`vercel.json` ya incluye los `rewrites` (`/api.php` → `/api/productos`, …), la
región `yul1`, `maxDuration: 30`, y las funciones de `api/` importan
`server/src/app.js`. No hay build: el `outputDirectory` es `frontend` y
`.vercelignore` excluye `legacy/`, `docs/`, `database/` y las pruebas.

### Paso 1 — Importar el repositorio

1. En Vercel: **Add New → Project → Import** del repositorio
   `https://github.com/LuisMFreitez11/systemtermoparts.git`.
2. Framework Preset: **Other**.
3. Build Command: *(vacío; Vercel instala con pnpm)*.
4. Output Directory: `frontend`.
5. Antes de desplegar, define las variables del Paso 2.

Si el proyecto ya está conectado al repositorio, **cada push a `main`
redespliega**: no hace falta subir nada a mano.

### Paso 2 — Variables de entorno

| Variable | Valor |
|---|---|
| `DB_DRIVER` | `pgsql` |
| `DB_PGSQL_DSN` | `pgsql:host=...pooler.supabase.com;port=6543;dbname=postgres;sslmode=require` |
| `DB_PGSQL_USER` | `postgres.TU-PROYECTO` |
| `DB_PGSQL_PASSWORD` | tu clave |
| `SESSION_SECRET` | cadena larga y aleatoria (**obligatoria**) |
| `SESSION_SAMESITE` | `Lax` (mismo dominio) o `None` (dominios distintos) |
| `SESSION_SECURE` | `0` con `Lax`; `1` con `None` (HTTPS) |
| `CORS_ALLOWED_ORIGINS` | `https://tu-proyecto.vercel.app` |
| `FRONTEND_URL` | `https://tu-proyecto.vercel.app` |
| `IDEMPOTENCY_WAIT` | `5` |
| `DB_POOL_MAX` | `3` |

Sin `SESSION_SECRET`, el backend falla al arrancar en producción. En local se
deriva uno de desarrollo, por eso el error no aparece hasta desplegar.

Si falta alguna de estas variables, la API **no cae con un 500 opaco**: responde
`503` con `{"exito":false,"faltantes":["SESSION_SECRET", ...]}`, así se ve en
`/health.php` y en los logs qué falta exactamente.

En Vercel usa preferentemente el pooler de Supabase en el puerto **6543**
(transacción) en `DB_PGSQL_DSN`; el puerto `5432` es modo sesión y consume una
conexión por instancia.

### Paso 3 — Verificar

1. `https://TU-APP/health.php` → `{"exito":true,...}`.
2. Login real desde `https://TU-APP/login.html`.
3. Inventario con los 859 productos.
4. `/exportar_excel.php` descarga un `.xlsx` y `/exportar_pdf.php` abre el HTML.
5. Dos clics seguidos en un botón → **una sola** fila en el historial.

Detalles técnicos y pruebas: [`BACKEND_NODE.md`](BACKEND_NODE.md).

---

## Opción B — Backend PHP archivado

El backend PHP ya **no forma parte del despliegue**: vive en `legacy/backend` y
`.vercelignore` lo excluye. Vercel no ejecuta PHP. Esta opción solo tiene sentido
si se decide volver a ese motor (por ejemplo, para usar MariaDB).

### Paso 1 — Publicar el frontend en Vercel

1. Sube el repositorio a GitHub/GitLab.
2. En Vercel: **Add New → Project → Import**.
3. Framework Preset: **Other**.
4. Build Command: *(vacío)*.
5. Output Directory: `frontend`.
6. Deploy.

`vercel.json` ya declara `"outputDirectory": "frontend"` y las cabeceras de
`sw.js` y `manifest.json`.

También se puede desde la CLI:

```powershell
pnpm dlx vercel --prod
# o, si ya está instalada:
vercel --prod
```

> Si se instala tooling, el proyecto usa **pnpm**, no npm.

---

### Paso 2 — Publicar el backend PHP (solo si se retoma)

Requisitos del hosting:

- PHP **8.1+** con `pdo_pgsql` (o `pdo_mysql`).
- Apache con `.htaccess` y `mod_authz_core` (para bloquear `config/`, `src/`...).
- Carpeta escribible para las sesiones de PHP (`session.save_path`).
- HTTPS (obligatorio: cookies `SameSite=None` y service worker).

Opciones habituales:

- **cPanel / hosting compartido:** sube el contenido de `legacy/backend` y apunta
  el dominio o subdominio a su carpeta `public/`.
- **Railway / Render / VPS:** contenedor PHP-Apache con `legacy/backend` montado.
- **Túnel para una demo:** `cloudflared tunnel --url http://localhost` o
  `ngrok http 80` sobre el XAMPP local. Sirve para probar, pero no para
  producción.

Configura `legacy/backend/.env` **en el servidor**:

```env
APP_DEBUG=0
DB_DRIVER=pgsql
DB_PGSQL_DSN="pgsql:host=...;port=5432;dbname=postgres;sslmode=require"
DB_PGSQL_USER=postgres.TU-PROYECTO
DB_PGSQL_PASSWORD=TU-CLAVE
SESSION_SAMESITE=None
SESSION_SECURE=1
CORS_ALLOWED_ORIGINS=https://TU-FRONTEND.vercel.app
FRONTEND_URL=https://TU-FRONTEND.vercel.app
IDEMPOTENCY_ENABLED=1
```

Aplica las migraciones en el servidor:

```bash
php legacy/backend/scripts/migrate.php todo
php legacy/backend/scripts/verificar.php
```

Comprueba:

```
https://TU-BACKEND/health.php
```

Debe responder `{"exito":true,"servicio":"wms-termo-part",...}`.

---

### Paso 3 — Conectar el frontend con la API

Por defecto el frontend usa **el mismo origen** (`apiBase = ''`), que es lo que
necesita la Opción A. No hay que editar nada.

Solo si la API está en otro dominio, define `window.WMS_API_BASE` antes de
`frontend/js/config.js` en cada HTML (o con la metaetiqueta `wms-api-base`):

```html
<script>window.WMS_API_BASE = 'https://TU-BACKEND.com';</script>
```

Con dominios distintos, el backend debe permitir el origen del frontend en
`CORS_ALLOWED_ORIGINS` y usar `SESSION_SAMESITE=None` + `SESSION_SECURE=1`.

Al cambiar `config.js`, sube un nuevo deployment (`vercel --prod` o push a la
rama conectada).

---

## Verificación en producción

1. `https://TU-FRONTEND.vercel.app/login.html` carga el logo y el formulario.
2. Login con un usuario válido.
3. En DevTools → Application:
   - `Manifest` sin errores.
   - `Service Workers` con `sw.js` activo (requiere HTTPS).
   - `IndexedDB → termopart-wms` creado.
4. Inventario muestra los 859 productos.
5. DevTools → Network → **Offline**:
   - Recargar: la app abre (app shell).
   - Navegar entre páginas: funciona con datos cacheados.
   - Registrar un ajuste: aparece “Guardado en el dispositivo”.
6. Volver a **Online**: la barra muestra “Sincronizando…” y luego los cambios
   aplicados. La operación debe existir **una sola vez** en el historial.

---

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| Login responde 200 pero no “entra” | `SESSION_SECRET` ausente o cookie bloqueada | Definir `SESSION_SECRET`; con dominios distintos `SESSION_SAMESITE=None` y `SESSION_SECURE=1` |
| `health.php` 503 con `faltantes` | Faltan variables de entorno en Vercel | Crear las que lista el JSON y redesplegar |
| `CORS` bloqueado | Origen no autorizado | Agregar el dominio de Vercel a `CORS_ALLOWED_ORIGINS` |
| Service worker no registra | Se accedió por HTTP o IP LAN | Usar HTTPS o `localhost` |
| `health.php` 500 | Credenciales o conexión a Supabase | Revisar `DB_PGSQL_*` y `SESSION_SECRET` en Vercel; ver log de la función |
| `FUNCTION_INVOCATION_TIMEOUT` | `maxDuration` o espera de idempotencia | `IDEMPOTENCY_WAIT=5`, `DB_POOL_MAX=3`, puerto 6543 |
| Datos viejos tras sincronizar | Caché de la pestaña | La app limpia IndexedDB y recarga; si no, recarga manual |
| `health.php` 404 | Rewrite mal aplicado | Revisar `vercel.json` y que `api/health.js` exista |

---

## Nota importante sobre Vercel

Con la **Opción A** (la actual), Vercel aloja el frontend y el backend Node en el
mismo proyecto: las funciones de `api/` mantienen las rutas PHP mediante
`rewrites`, así que `config.js` deja `apiBase = ''` y no hay CORS entre sitios.
El PHP archivado en `legacy/backend` no se publica.

Con la **Opción B**, Vercel solo aloja el frontend estático y la PWA: no ejecuta
PHP ni mantiene sesiones PHP. Para un despliegue totalmente funcional se
necesita el hosting PHP del Paso 2. Si el backend se publica en un subdominio
(por ejemplo `api.termopart.com`), conviene mantener ese dominio estable para no
reconfigurar el frontend.
