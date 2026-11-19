# TERMO PART WMS

Sistema de gestión de almacén (WMS) para **Termo Parts FW, C.A.** Inventario de
repuestos, activos de calle y taller, herramientas, entradas de almacén,
materiales dañados, tomas físicas, auditoría y reportes.

El proyecto está separado en **backend** (PHP + PostgreSQL/Supabase, con respaldo
MariaDB) y **frontend** (HTML/CSS/JS sin build tools), y funciona como **PWA
offline-first** pensada para internet lento o inestable y cortes de luz.

Incluye además un **segundo backend en Node.js + Express** (`server/`) con el
mismo contrato JSON, pensado para desplegarse como funciones serverless en
Vercel. Ver [`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md).

---

## 1. Estructura

```
TERMOPARTALMACEN/
├─ backend/
│  ├─ .env                 # credenciales reales (NO se versiona)
│  ├─ .env.example         # plantilla de configuración
│  ├─ config/config.php    # configuración central (env > .env > defaults)
│  ├─ src/
│  │  ├─ bootstrap.php     # arranque único de todos los endpoints
│  │  ├─ Config.php        # configuración tipada + manejo de errores
│  │  ├─ Database.php      # PDO singleton y utilidades SQL
│  │  ├─ Http.php          # respuestas JSON, cuerpo, CORS
│  │  ├─ Auth.php          # sesión, login, roles, cambio de clave
│  │  ├─ Audit.php         # historial de auditoría
│  │  └─ Idempotency.php   # reintentos seguros de escrituras
│  ├─ public/              # únicos archivos PHP accesibles por HTTP
│  │  ├─ api.php           # productos, ajustes, tomas físicas
│  │  ├─ api_activos.php   # activos CALLE / TALLER y materiales
│  │  ├─ api_herramientas.php
│  │  ├─ api_entradas.php
│  │  ├─ api_danados.php
│  │  ├─ api_historial.php
│  │  ├─ api_sesion.php
│  │  ├─ exportar_pdf.php
│  │  ├─ exportar_excel.php
│  │  └─ health.php        # monitoreo (sin sesión, sin datos de negocio)
│  ├─ database/            # DDL de idempotencia y RLS
│  └─ scripts/             # migrate.php, verificar.php (CLI)
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
│  │  ├─ config.js         # URL de la API y parámetros offline
│  │  ├─ offline-db.js     # IndexedDB: caché + cola
│  │  ├─ api-client.js     # apiFetch, sincronización FIFO, idempotencia
│  │  ├─ app-shell.js      # barra de estado + registro del service worker
│  │  ├─ auth.js
│  │  └─ movil.js
│  ├─ assets/
│  └─ icons/
├─ database/               # esquemas y respaldos SQL históricos
├─ server/                 # backend Node.js + Express (mismas rutas JSON)
│  ├─ src/                 # app, db, auth, idempotencia, rutas y helpers
│  ├─ test/                # unit, http, parity e integration
│  └─ .env.example
├─ api/                    # funciones serverless de Vercel (importan server/)
├─ docs/
├─ tools/generar_iconos.ps1
├─ index.html              # redirección local a frontend/
├─ vercel.json             # despliegue estático del frontend
└─ README.md
```

---

## 2. Requisitos

- PHP **8.1+** con `pdo_pgsql` (o `pdo_mysql`) y Apache.
- PostgreSQL 15+ / Supabase, o MariaDB 10.4+ como respaldo.
- Navegador moderno con IndexedDB y Service Worker (Chrome, Edge, Firefox, Safari).
- HTTPS o `localhost` para el service worker.
- Opcional (backend Node): **Node 22+** y **pnpm**.

El frontend es JS nativo sin build y **no usa npm**. El backend Node usa
**pnpm** (nunca `npm`).

---

## 3. Puesta en marcha local (XAMPP)

1. Copia el proyecto en `C:\xampp\htdocs\xampp\TERMOPARTALMACEN`.
2. Crea `backend/.env` a partir de `backend/.env.example` y coloca las
   credenciales reales.
3. Verifica la conexión y el estado de la base:

   ```powershell
   C:\xampp\php\php.exe backend\scripts\verificar.php
   ```

4. Aplica las migraciones pendientes (idempotencia y, en Supabase, RLS):

   ```powershell
   C:\xampp\php\php.exe backend\scripts\migrate.php todo
   ```

5. Abre <http://localhost/xampp/TERMOPARTALMACEN/>.
   El `index.html` raíz redirige a `frontend/`.

Usuarios iniciales de prueba (cámbialos al primer ingreso):

| Usuario | Clave |
|---|---|
| `admin` | `admin123` |
| `almacen` | `almacen123` |

> Para volver a MariaDB: `DB_DRIVER=mysql` en `.env` y aplica
> `backend/database/idempotencia_mariadb.sql`.

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

Todos los endpoints viven en `backend/public/` y requieren sesión salvo
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
  Ver `backend/database/rls_supabase.sql`.
- **Credenciales fuera del repositorio** (`backend/.env`, excluido por Git).
- **Archivos sensibles bloqueados** por `.htaccess` (`config/`, `src/`,
  `database/`, `scripts/`, `.env`, `.sql`, `.md`).
- **Idempotencia** con huella SHA-256 para detectar reutilización de claves.
- Contraseñas con `password_hash`/`password_verify`.
- Consultas preparadas en todas las operaciones.

---

## 7. Despliegue

- **Frontend en Vercel:** `vercel.json` sirve `frontend/`. Ver
  [`docs/DESPLIEGUE_VERCEL.md`](docs/DESPLIEGUE_VERCEL.md).
- **Backend en Vercel (recomendado):** las funciones de `api/` ejecutan el
  backend Node en el mismo dominio; los `rewrites` mantienen las rutas PHP.
  Ver [`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md).
- **Backend PHP:** Vercel no ejecuta PHP. Debe alojarse en un hosting PHP
  (cPanel, Railway, Render, VPS) con HTTPS. El frontend apunta a esa URL desde
  `frontend/js/config.js`.

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
| Historial | 60 |
| Exportar PDF | 200, `text/html` |
| Exportar Excel | 200, `application/vnd.openxmlformats...` |
| Idempotencia (misma clave 2 veces) | 1 sola fila creada, segunda respuesta reproducida |
| Reutilización de clave con otro cuerpo | 409 |
| Archivos sensibles (`.env`, `config`, SQL) | 403 |

---

## 9. Scripts útiles

```powershell
# Estado de conexión, conteos y RLS
C:\xampp\php\php.exe backend\scripts\verificar.php

# Aplicar idempotencia + RLS (Supabase)
C:\xampp\php\php.exe backend\scripts\migrate.php todo

# Regenerar iconos PWA
powershell -ExecutionPolicy Bypass -File tools\generar_iconos.ps1
```

---

## 10. Backend Node.js (opcional)

```powershell
pnpm install          # dependencias en la raíz
pnpm start            # http://localhost:3000
pnpm test             # 51 pruebas rápidas, sin base de datos
```

- Mismas rutas y respuestas que PHP (`/api.php`, `/api_activos.php`, …) y alias
  limpios (`/api/productos`, `/api/activos`, …).
- Idempotencia atómica en todos los POST (replay de la respuesta original).
- Lote anti-N+1 al crear/actualizar activos con muchos materiales.
- Pruebas de paridad y de escritura real: `$env:RUN_INTEGRATION = '1'; pnpm test:all`.

Detalles, variables de entorno y despliegue:
[`docs/BACKEND_NODE.md`](docs/BACKEND_NODE.md).
