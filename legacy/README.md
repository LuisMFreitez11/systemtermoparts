# Legado PHP (archivado, no desplegado)

Esta carpeta conserva la versión PHP del WMS **solo como respaldo histórico**.
El backend activo del proyecto es **Node.js + Express** (`server/`), desplegado
en Vercel mediante `api/`.

| Carpeta | Qué contiene |
|---|---|
| `legacy/backend/` | Backend PHP refactorizado (`backend/public`, `backend/src`, …) |
| `legacy/app-php/` | Aplicación plana original (HTML + PHP + JS en la raíz) |

## Importante

- **Nada de esta carpeta se despliega.** `vercel.json` publica `frontend/` y las
  funciones de `api/`; `.vercelignore` excluye `legacy/`.
- El frontend actual (`frontend/`) funciona con Node y también con PHP; no se
  movió porque es el que se usa en producción.
- Si algún día se vuelve a PHP, copia el contenido de `legacy/backend/` a un
  hosting con PHP 8.1+, `pdo_pgsql` y Apache, y configura su `.env`. El
  `legacy/backend/.env` local no se versiona (credenciales).
- `legacy/app-php/` es una copia autocontenida (incluye `conexion.php`, los
  endpoints `api*.php`, el HTML y los assets). No mezclarla con `frontend/`.

## Datos y esquema

Los esquemas vigentes están en `database/` y en
`legacy/backend/database/` (idempotencia y RLS de Supabase). El backend Node usa
las mismas tablas.

## Referencias

- Backend Node: [`docs/BACKEND_NODE.md`](../docs/BACKEND_NODE.md)
- Despliegue: [`docs/DESPLIEGUE_VERCEL.md`](../docs/DESPLIEGUE_VERCEL.md)
