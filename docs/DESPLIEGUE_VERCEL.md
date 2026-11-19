# Despliegue en Vercel

## Resumen

| Componente | Dónde se despliega | Notas |
|---|---|---|
| Frontend (HTML/CSS/JS/PWA) | **Vercel** | Estático. `vercel.json` sirve `frontend/`. |
| Backend Node + Express | **Vercel** (funciones de `api/`) | Mismas rutas y JSON. Recomendado. |
| Backend PHP + sesiones | Hosting PHP con HTTPS | Alternativa con MariaDB. |

Hay dos caminos válidos:

- **A. Todo en Vercel (recomendado):** frontend estático + backend Node
  serverless. No hace falta otro hosting y el frontend queda en el mismo
  dominio (`apiBase = ''`).
- **B. Frontend en Vercel + backend PHP:** obligatorio si la base es MariaDB.
  Ver el Paso 2.

---

## Opción A — Backend Node en Vercel

`vercel.json` ya incluye los `rewrites` (`/api.php` → `/api/productos`, …) y las
funciones de `api/` importan `server/src/app.js`. No hay build: el
`outputDirectory` es `frontend`.

### Paso 1 — Importar el repositorio

1. En Vercel: **Add New → Project → Import** del repositorio.
2. Framework Preset: **Other**.
3. Build Command: *(vacío)*.
4. Output Directory: `frontend`.
5. Antes de desplegar, define las variables del Paso 2.

### Paso 2 — Variables de entorno

| Variable | Valor |
|---|---|
| `DB_DRIVER` | `pgsql` |
| `DB_PGSQL_DSN` | `pgsql:host=...pooler.supabase.com;port=5432;dbname=postgres;sslmode=require` |
| `DB_PGSQL_USER` | `postgres.TU-PROYECTO` |
| `DB_PGSQL_PASSWORD` | tu clave |
| `SESSION_SECRET` | cadena larga y aleatoria (**obligatoria**) |
| `SESSION_SAMESITE` | `Lax` (mismo dominio) o `None` (dominios distintos) |
| `SESSION_SECURE` | `0` con `Lax`; `1` con `None` (HTTPS) |
| `CORS_ALLOWED_ORIGINS` | `https://tu-proyecto.vercel.app` |
| `FRONTEND_URL` | `https://tu-proyecto.vercel.app` |
| `IDEMPOTENCY_WAIT` | `5` |
| `DB_POOL_MAX` | `3` |

Sin `SESSION_SECRET`, cada instancia firma las cookies con una clave distinta y
las sesiones se pierden de forma intermitente.

### Paso 3 — Verificar

1. `https://TU-APP/health.php` → `{"exito":true,...}`.
2. Login real desde `https://TU-APP/login.html`.
3. Inventario con los 854 productos.
4. `/exportar_excel.php` descarga un `.xlsx` y `/exportar_pdf.php` abre el HTML.
5. Dos clics seguidos en un botón → **una sola** fila en el historial.

Detalles técnicos y pruebas: [`BACKEND_NODE.md`](BACKEND_NODE.md).

---

## Opción B — Backend PHP

### Paso 1 — Publicar el frontend en Vercel

### Opción A: desde la web

1. Sube el repositorio a GitHub/GitLab.
2. En Vercel: **Add New → Project → Import**.
3. Framework Preset: **Other**.
4. Build Command: *(vacío)*.
5. Output Directory: `frontend`.
6. Deploy.

`vercel.json` ya declara `"outputDirectory": "frontend"` y las cabeceras de
`sw.js` y `manifest.json`.

### Opción B: con la CLI

```powershell
pnpm dlx vercel --prod
# o, si ya está instalada:
vercel --prod
```

> Si se instala tooling, el proyecto usa **pnpm**, no npm.

URL de ejemplo: `https://termo-part-wms.vercel.app`.

---

## Paso 2 — Publicar el backend PHP

Requisitos del hosting:

- PHP **8.1+** con `pdo_pgsql` (o `pdo_mysql`).
- Apache con `.htaccess` y `mod_authz_core` (para bloquear `config/`, `src/`...).
- Carpeta escribible para las sesiones de PHP (`session.save_path`).
- HTTPS (obligatorio: cookies `SameSite=None` y service worker).

Opciones habituales:

- **cPanel / hosting compartido:** sube el proyecto completo y apunta el dominio
  o subdominio a la carpeta del proyecto.
- **Railway / Render / VPS:** contenedor PHP-Apache con el repositorio montado.
- **Túnel para una demo:** `cloudflared tunnel --url http://localhost` o
  `ngrok http 80` sobre el XAMPP local. Sirve para probar desde Vercel, pero no
  para producción.

Configura `backend/.env` **en el servidor**:

```env
APP_DEBUG=0
DB_DRIVER=pgsql
DB_PGSQL_DSN="pgsql:host=...;port=5432;dbname=postgres;sslmode=require"
DB_PGSQL_USER=postgres.TU-PROYECTO
DB_PGSQL_PASSWORD=TU-CLAVE
SESSION_SAMESITE=None
SESSION_SECURE=1
CORS_ALLOWED_ORIGINS=https://termo-part-wms.vercel.app
FRONTEND_URL=https://termo-part-wms.vercel.app
IDEMPOTENCY_ENABLED=1
```

Aplica las migraciones en el servidor:

```bash
php backend/scripts/migrate.php todo
php backend/scripts/verificar.php
```

Comprueba:

```
https://TU-BACKEND/backend/public/health.php
```

Debe responder `{"exito":true,"servicio":"wms-termo-part",...}`.

---

## Paso 3 — Conectar el frontend con la API

Edita `frontend/js/config.js` y define la URL pública del backend:

```js
// Producción
base = 'https://TU-BACKEND.com/backend/public';
```

O, sin tocar el archivo, agrega antes de `config.js` en cada HTML:

```html
<script>window.WMS_API_BASE = 'https://TU-BACKEND.com/backend/public';</script>
```

La detección automática funciona así:

- `localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x` → usa
  `../backend/public` (XAMPP).
- Cualquier otro dominio → usa `window.WMS_API_BASE` (o `''` si no se define).

Al cambiar `config.js`, sube un nuevo deployment (`vercel --prod` o push a la
rama conectada).

---

## Paso 4 — Verificación en producción

1. `https://TU-FRONTEND.vercel.app/login.html` carga el logo y el formulario.
2. Login con un usuario válido.
3. En DevTools → Application:
   - `Manifest` sin errores.
   - `Service Workers` con `sw.js` activo (requiere HTTPS).
   - `IndexedDB → termopart-wms` creado.
4. Inventario muestra los 854 productos.
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
| Login responde 401 correcto pero no “entra” | Cookie bloqueada entre sitios | `SESSION_SAMESITE=None`, `SESSION_SECURE=1` y backend en HTTPS |
| `CORS` bloqueado | Origen no autorizado | Agregar el dominio de Vercel a `CORS_ALLOWED_ORIGINS` |
| Service worker no registra | Se accedió por HTTP o IP LAN | Usar HTTPS o `localhost` |
| `health.php` 500 | Credenciales o `pdo_pgsql` | Revisar `backend/.env` y `php -m` |
| Datos viejos tras sincronizar | Caché de la pestaña | La app limpia IndexedDB y recarga; si no, recarga manual |
| 403 al abrir `config/` | Protección `.htaccess` | Es el comportamiento esperado |

---

## Nota importante sobre Vercel

Con la **Opción A**, Vercel aloja el frontend y el backend Node en el mismo
proyecto: las funciones de `api/` mantienen las rutas PHP mediante `rewrites`,
así que `config.js` deja `apiBase = ''` y no hay CORS entre sitios.

Con la **Opción B**, Vercel solo aloja el frontend estático y la PWA: no ejecuta
PHP ni mantiene sesiones PHP. Para un despliegue totalmente funcional se
necesita el hosting PHP del Paso 2. Si el backend se publica en un subdominio
(por ejemplo `api.termopart.com`), conviene mantener ese dominio estable para no
reconfigurar el frontend.
