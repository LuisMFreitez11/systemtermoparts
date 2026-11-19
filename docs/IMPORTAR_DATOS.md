# Importar datos de MariaDB a Supabase

El backend activo (Node) trabaja contra **PostgreSQL/Supabase**. Los datos se
pueden cargar de dos formas:

| Vía | Cuándo usarla |
|---|---|
| `tools/importar_dump_mariadb.mjs` | Tienes un **volcado de phpMyAdmin** (`.sql`) de MariaDB. Es la vía actual. |
| `database/migracion_supabase.php` | Solo si el backend PHP archivado (`legacy/backend`) está operativo y hay una MariaDB viva. |

## 1. Uso del importador

```powershell
# 1) Validar sin escribir nada (modo simulación)
node tools/importar_dump_mariadb.mjs "C:\ruta\volcado.sql"

# 2) Aplicar en Supabase
node tools/importar_dump_mariadb.mjs "C:\ruta\volcado.sql" --aplicar

# 3) Estado tras la importación
node tools/estado-supabase.mjs
```

Con `pnpm`:

```powershell
pnpm db:estado
pnpm db:importar -- "C:\ruta\volcado.sql" --aplicar
```

### Qué hace `--aplicar` (todo en una transacción)

1. Copia las 12 tablas actuales al esquema `respaldo_AAAAMMDD`.
2. Vacía las tablas con `TRUNCATE ... RESTART IDENTITY CASCADE`.
3. Inserta el volcado con los **IDs originales**, en orden de claves foráneas
   (usuarios → productos → herramientas → activos → movimientos → …).
4. Ajusta cada secuencia `IDENTITY` al máximo ID.
5. Verifica conteos e integridad referencial **antes del `COMMIT`**: si algo no
   cuadra, se revierte todo y la base queda como estaba.

No toca `operaciones_idempotencia`, ni las políticas RLS, ni el esquema.

### Detalles que resuelve

- **Codificación mixta:** el volcado de phpMyAdmin mezcla texto UTF-8 correcto
  (`generación`, `°C`) con tramos doblemente codificados (`PAÃ‘01`, `75Âº`). El
  importador repara solo esos tramos (CP1252 → UTF-8) y conserva el resto.
  Si el archivo viniera entero en UTF-8, no lo toca.
- **Escapes de MySQL:** `\'`, `\\`, `\n`, `\r`, `\t`, `\0`, `\Z` y `NULL`.
- **Claves foráneas huérfanas:** `entradas_almacen.movimiento_id` y
  `materiales_danados.movimiento_id` que apuntan a movimientos borrados se
  guardan como `NULL` (igual que `ON DELETE SET NULL`), en vez de romper la carga.
- **Volumen:** inserta por lotes de 400 filas (sin N+1 y sin superar el límite
  de parámetros de PostgreSQL).

## 2. Respaldo y rollback

Antes de escribir, el importador crea el esquema `respaldo_AAAAMMDD` con una
copia de las 12 tablas. Para volver al estado anterior:

```sql
BEGIN;
TRUNCATE public.toma_fisica_detalle, public.tomas_fisicas,
         public.materiales_danados, public.entradas_almacen,
         public.historial_usuario, public.herramientas_movimientos,
         public.activo_materiales, public.movimientos_inventario,
         public.activos, public.herramientas, public.productos, public.usuarios
  RESTART IDENTITY CASCADE;

INSERT INTO public.productos SELECT * FROM respaldo_AAAAMMDD.productos;
-- … repetir para cada tabla, respetando el orden de claves foráneas
COMMIT;
```

Cuando el respaldo ya no haga falta:

```sql
DROP SCHEMA respaldo_AAAAMMDD CASCADE;
```

## 3. Importación del 18/11/2026

Volcado: `termo_part_wms (18-11-2026).sql` (phpMyAdmin, MariaDB 10.11.16).
Respaldo previo: esquema `respaldo_20261119` (fecha UTC del servidor).

| Tabla | Filas |
|---|---:|
| `usuarios` | 8 |
| `productos` | 859 |
| `herramientas` | 149 |
| `activos` | 22 |
| `movimientos_inventario` | 8 |
| `activo_materiales` | 3 |
| `herramientas_movimientos` | 2 |
| `historial_usuario` | 100 |
| `entradas_almacen` | 1 |
| `materiales_danados` | 1 |
| `tomas_fisicas` | 2 |
| `toma_fisica_detalle` | 1.708 |

Stock total: **1.363,044**; dañado acumulado: **1,000**.

Verificado después de importar:

- Login, `listar` (859), historial, activos, herramientas, entradas y dañados.
- Exportar PDF y Excel.
- Pruebas de integración de escritura (con limpieza) y paridad Node vs PHP.
- RLS sigue activo en las 13 tablas.

## 4. Notas

- El importador **reemplaza** el contenido de las 12 tablas: es para cargar una
  foto completa, no para fusionar. Para fusionar, importa primero en una base
  temporal y compara.
- Si el volcado trae una tabla o columna que no existe en Supabase, el modo
  simulación lo reporta y no se escribe nada.
- Las contraseñas viajan como hashes bcrypt; no se re-hashean.
