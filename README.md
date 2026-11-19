# TERMO PART WMS

Sistema de gestión de almacén (WMS) para **Termo Parts FW, C.A.** Inventario de
repuestos, activos de calle y taller, herramientas, entradas de almacén,
materiales dañados, tomas físicas, auditoría y reportes.

El proyecto usa **Node.js + Express** como backend (`server/`), con un
**frontend** en HTML/CSS/JS sin build tools, y funciona como **PWA offline-first**
pensada para internet lento o inestable y cortes de luz.

El backend PHP anterior **no se despliega**: se conserva completo en `legacy/`
(`legacy/backend` y `legacy/app-php`) por si algún día se vuelve a ese motor. El
backend activo se publica como funciones serverless en Vercel. Ver
[`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md).

---

## 1. Estructura

```
TERMOPARTALMACEN/
├─ server/                 # backend activo: Node.js + Express
│  ├─ src/
│  │  ├─ app.js            # CORS, cuerpo crudo, montaje de rutas, estáticos
│  │  ├─ server.js         # arranque local
│  │  ├─ config.js         # env > server/.env > legacy/backend/.env
│  │  ├─ db.js             # pool pg, zona horaria y transacciones
│  │  ├─ auth.js           # login bcrypt + cookie HMAC
│  │  ├─ idempotency.js    # reclamo atómico + replay de respuestas
│  │  └─ routes/           # productos, activos, herramientas, …
│  ├─ test/                # unit, http, parity e integration
│  └─ .env.example
├─ api/                    # funciones serverless de Vercel (importan server/)
├─ frontend/
│  ├─ index.html           # inventario
│  ├─ login.html
│  ├─ activos.html
│  ├─ activos_taller.html
│  ├─ entradas.html
│  ├─ danados.html
│  ├─ herramientas.html
│  ├─ historial.html
│  ├─ offline.html
│  ├─ manifest.json
│  ├─ sw.js                # service worker (app shell)
│  ├─ css/
│  ├─ js/
│  │  ├─ config.js         # mismo origen por defecto + parámetros offline
│  │  ├─ offline-db.js     # IndexedDB: caché + cola
│  │  ├─ api-client.js     # apiFetch, sincronización FIFO, idempotencia
│  │  ├─ app-shell.js      # barra de estado + registro del service worker
│  │  ├─ auth.js
│  │  └─ movil.js
│  ├─ assets/
│  └─ icons/
├─ legacy/                 # PHP archivado (NO se despliega)
│  ├─ backend/             # backend PHP refactorizado + scripts de migración
│  └─ app-php/             # app plana original (HTML + PHP + JS)
├─ database/               # esquemas y respaldos SQL históricos
├─ docs/
├─ tools/generar_iconos.ps1
├─ index.html              # redirección local a frontend/
├─ vercel.json             # frontend estático + funciones api/
└─ README.md
```

---

## 2. Requisitos

- **Node.js 22+** (probado con 24) y **pnpm**. No se usa `npm`.
- PostgreSQL 15+ / Supabase (el backend Node solo soporta `pgsql`).
- Navegador moderno con IndexedDB y Service Worker (Chrome, Edge, Firefox, Safari).
- HTTPS o `localhost` para el service worker.
- Opcional: PHP 8.1+ y Apache solo para revivir `legacy/`.

El frontend es JS nativo sin build. Las dependencias del backend se instalan en
la raíz del proyecto para que Vercel las resuelva desde `api/`.

---

## 3. Puesta en marcha local

```powershell
# 1. Dependencias (raíz)
pnpm install

# 2. Credenciales: server/.env o, en su defecto, legacy/backend/.env
Copy-Item server\.env.example server\.env

# 3. App completa (frontend + API) en http://localhost:3000
pnpm start
```

`pnpm start` sirve `frontend/` y la API en el **mismo origen**, así que no hay
CORS ni cookies entre sitios. `pnpm dev` hace lo mismo con recarga automática.

Usuarios iniciales de prueba (cámbialos al primer ingreso):

| Usuario | Clave |
|---|---|
| `admin` | `admin123` |
| `almacen` | `almacen123` |

Comprobaciones:

```powershell
curl http://localhost:3000/health.php
curl "http://localhost:3000/api_sesion.php?accion=estado"
```

> **Modo PHP (legacy):** si necesitas el backend anterior, usa
> `legacy/backend` con su propio `.env` y los scripts
> `php legacy\backend\scripts\verificar.php` / `migrate.php todo`. El frontend
> puede apuntar allí con `window.WMS_API_BASE`.

---

## 4. Cómo funciona el modo offline

1. **Lecturas (GET)** — `apiFetch` intenta la red con un límite de 6 s. Si falla,
   devuelve la última copia guardada en IndexedDB. También se cachea el estado de
   sesión, por lo que se puede abrir la app sin señal si ya se inició sesión antes.
2. **Escrituras (POST)** — si no hay red, la operación se guarda en una cola FIFO
   en IndexedDB y la interfaz responde como “guardado en el dispositivo”.
3. **Sincronización** — al volver la conexión (o cada 30 s) la cola se envía en
   orden. Cada operación lleva una cabecera `X-Idempotency-Key`; el backend
   guarda la respuesta y, si el envío se repite, la reproduce sin volver a
   aplicar el cambio.
4. **Rechazos definitivos** — un 4xx se marca como error visible en la barra de
   estado. Los fallos de red o 5xx se reintentan sin perder el orden.
5. **Cortes de luz / recargas** — la cola y la caché viven en IndexedDB (disco),
   no en memoria; sobreviven a cerrar el navegador o apagar el equipo.
6. **App shell** — el service worker guarda HTML, CSS, JS, iconos y `offline.html`
   para que la aplicación abra aun sin red.

La barra inferior derecha muestra: conectado, sin conexión, cambios por enviar,
sincronizando o errores.

---

## 5. Endpoints

Todos los endpoints se implementan en `server/src/routes/` y conservan las rutas
del backend PHP (`/api.php`, `/api_activos.php`, …) más alias limpios
(`/api/productos`, `/api/activos`, …). Requieren sesión salvo
`api_sesion.php?accion=estado|login` y `health.php`.

| Endpoint | Acciones |
|---|---|
| `api.php` | `listar`, `historial`, `ultima_toma`, `crear`, `actualizar`, `ajustar`, `eliminar`, `registrar_toma_fisica` |
| `api_activos.php` | `listar` (`tipo=CALLE\|TALLER`), `crear`, `actualizar`, `eliminar` |
| `api_herramientas.php` | `listar`, `movimientos`, `crear`, `actualizar`, `eliminar`, `registrar_movimiento` |
| `api_entradas.php` | `listar`, `crear`, `eliminar` |
| `api_danados.php` | `listar`, `crear`, `eliminar` |
| `api_historial.php` | `listar`, `usuarios` |
| `api_sesion.php` | `estado`, `login`, `logout`, `cambiar_clave` |
| `exportar_pdf.php` / `exportar_excel.php` | reportes del inventario con filtros |
| `health.php` | estado del servicio |

Convenciones:

- Respuestas de error: `{ "exito": false, "mensaje": "..." }` con código HTTP.
- Escrituras: método `POST` y cuerpo JSON.
- Idempotencia: cabecera `X-Idempotency-Key` (obligatoria para la cola offline).
- Autenticación: cookie de sesión `TERMOPART_SESS` (`HttpOnly`, `SameSite=Lax`).

---

## 6. Seguridad

- **RLS deny-by-default** en Supabase: RLS activo en todas las tablas, sin
  políticas para `anon`/`authenticated` y permisos revocados. El backend conecta
  con el rol propietario, que no queda afectado por RLS.
  Ver `legacy/backend/database/rls_supabase.sql`.
- **Credenciales fuera del repositorio** (`server/.env` y
  `legacy/backend/.env`, excluidos por Git).
- **Cookie de sesión firmada** con HMAC-SHA256 (`HttpOnly`; `Secure` y
  `SameSite=None` automáticos si el origen es cruzado).
- **Idempotencia atómica** con huella SHA-256 para detectar reutilización de
  claves.
- Contraseñas con `bcryptjs` (compatible con los hashes de PHP).
- Consultas preparadas en todas las operaciones.
- `.vercelignore` evita publicar `legacy/`, `docs/`, `database/` y las pruebas.

---

## 7. Despliegue

- **Frontend + backend en Vercel:** `vercel.json` publica `frontend/` y las
  funciones de `api/` ejecutan el backend Node. Los `rewrites` mantienen las
  rutas PHP. Ver [`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md) y
  [`docs/DESPLIEGUE_VERCEL.md`](docs/DESPLIEGUE_VERCEL.md).
- **Backend PHP (legacy):** Vercel no ejecuta PHP. Si algún día se retoma, hay
  que alojar `legacy/backend` en un hosting PHP (cPanel, Railway, Render, VPS)
  con HTTPS y apuntar el frontend con `window.WMS_API_BASE`.

---

## 8. Verificación ejecutada

| Prueba | Resultado |
|---|---|
| Conexión Supabase (PostgreSQL 17) | OK |
| RLS activo en 13 tablas | OK |
| Login / estado / logout | OK |
| Productos (`listar`) | 854 |
| Activos CALLE / TALLER | 22 / 0 |
| Herramientas | 149 |
| Movimientos de herramientas | 2 |
| Entradas de almacén | 1 |
| Materiales dañados | 2 |
| Historial | 67 |
| Exportar PDF | 200, `text/html` |
| Exportar Excel | 200, `application/vnd.openxmlformats...` |
| Pruebas unitarias + HTTP (Node) | 56/56 |
| Paridad Node vs PHP | 13 lecturas + 6 validaciones idénticas |
| Integración de escrituras (Supabase) | ciclo completo con limpieza |
| Anti-N+1 | 2 y 15 materiales → las mismas 3 consultas |
| Idempotencia (misma clave 2 veces) | 1 sola fila creada, segunda respuesta reproducida |
| Reutilización de clave con otro cuerpo | 409 |
| Doble clic en el cliente | 1 sola petición y 1 sola clave |

---

## 9. Scripts útiles

```powershell
# Pruebas rápidas (sin base de datos)
pnpm test

# Paridad + escrituras reales (se limpian solas)
$env:RUN_INTEGRATION = '1'
pnpm test:all

# Estado de conexión, conteos y RLS (backend PHP archivado)
C:\xampp\php\php.exe legacy\backend\scripts\verificar.php

# Aplicar idempotencia + RLS en Supabase (scripts del backend archivado)
C:\xampp\php\php.exe legacy\backend\scripts\migrate.php todo

# Regenerar iconos PWA
powershell -ExecutionPolicy Bypass -File tools\generar_iconos.ps1
```

---

## 10. Backend Node.js

- Mismas rutas y respuestas que PHP (`/api.php`, `/api_activos.php`, …) y alias
  limpios (`/api/productos`, `/api/activos`, …).
- Idempotencia atómica en todos los POST (replay de la respuesta original) y
  guardia anti doble clic en `frontend/js/api-client.js`.
- Lote anti-N+1 al crear/actualizar activos con muchos materiales.
- Sesión stateless con cookie HMAC, apta para serverless.
- En local sirve el frontend y la API en el mismo origen.

Detalles, variables de entorno y despliegue:
[`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md).
