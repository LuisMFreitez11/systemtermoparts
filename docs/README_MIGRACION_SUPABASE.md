# Migración del WMS a Supabase (PostgreSQL)

Fecha de migración: 17/11/2026 (hora de Venezuela).

La aplicación quedó configurada para trabajar contra Supabase. MariaDB se conserva
con todos los datos y con el esquema alineado para poder volver atrás si hace falta.

## 1. Reinicio obligatorio de Apache

Se habilitaron las extensiones `pdo_pgsql` y `pgsql` en `C:\xampp\php\php.ini`.
Apache solo las carga al iniciarse, por lo que hay que reiniciarlo:

1. Abrir **XAMPP Control Panel**.
2. En la fila **Apache**, pulsar **Stop** y luego **Start** (o **Restart**).
3. Recargar la aplicación en el navegador.

Mientras no se reinicie Apache, las páginas que consultan la base mostrarán un
error de conexión, porque el proceso actual de Apache todavía no tiene `pdo_pgsql`.

Comprobación rápida: `http://localhost/xampp/TERMOPARTALMACEN/api_sesion.php?accion=estado`
debe responder JSON con `"autenticado":false` o `true`, y el login debe funcionar.

## 2. Archivos nuevos y modificados

| Archivo | Uso |
| --- | --- |
| `config_bd.php` | Credenciales y selector de motor (`pgsql` o `mysql`). |
| `conexion.php` | Conexión PDO unificada, zona horaria y funciones auxiliares. |
| `database_supabase.sql` | Esquema PostgreSQL completo para Supabase. |
| `migracion_supabase.php` | Crea el esquema y copia los datos desde MariaDB. |
| `api*.php`, `exportar_*.php` | SQL adaptado para funcionar en PostgreSQL y MariaDB. |

### Cambios de compatibilidad aplicados

- `LOCATE(...)` se reemplazó por `POSITION(LOWER(...) IN LOWER(...))`, que funciona
  en ambos motores y mantiene la búsqueda sin distinguir mayúsculas.
- `lastInsertId()` se reemplazó por `ultimoIdInsertado()`, que en PostgreSQL usa
  `currval(pg_get_serial_sequence(...))` y en MariaDB usa `lastInsertId()`.
- Los errores de unicidad/clave foránea ahora aceptan los códigos `23000`, `23503`
  y `23505` (MySQL y PostgreSQL).
- La zona horaria de la sesión PostgreSQL se fija en `America/Caracas`, igual que
  la hora que mostraba MariaDB.

## 3. Datos migrados

Se conservaron IDs, secuencias, fechas y relaciones:

| Tabla | Filas |
| --- | ---: |
| `usuarios` | 8 |
| `productos` | 854 |
| `herramientas` | 149 |
| `activos` | 22 |
| `movimientos_inventario` | 6 |
| `activo_materiales` | 3 |
| `herramientas_movimientos` | 2 |
| `historial_usuario` | 60 |
| `entradas_almacen` | 1 |
| `materiales_danados` | 2 |
| `tomas_fisicas` | 0 |
| `toma_fisica_detalle` | 0 |

Stock total migrado: **1.391,044**; dañado acumulado: **2,000**; activos de calle: **22**.

Nota: la entrada `entrada_id=5` y los dos registros de `materiales_danados`
apuntaban a movimientos de inventario que ya no existen en MariaDB. Como en
Supabase esas columnas tienen clave foránea, se migraron con `movimiento_id = NULL`
para no perder los registros. Los conteos y los stocks no cambian.

## 4. Respaldo y rollback

Respaldo completo previo a cualquier cambio:

```
C:\xampp\respaldos_termopart\termo_part_wms_pre_supabase_20261117.sql
```

También existe una copia en
`C:\Users\LuisM_Freitez11\AppData\Local\Temp\opencode\respaldos\`.

Para volver a MariaDB:

1. Editar `config_bd.php` y cambiar `const DB_DRIVER = 'pgsql';` por `'mysql'`.
2. Reiniciar Apache.

MariaDB quedó con el esquema que espera el código: se agregaron
`productos.stock_danado`, `productos.toma_fisica_anterior`,
`herramientas.cantidad_prestada`, `activos.tipo`,
AUTO_INCREMENT en las tomas físicas y los valores `ENTRADA`/`DANADO` en
`movimientos_inventario.tipo`. Los datos nuevos se calcularon antes de la copia
(dañado por producto, toma física anterior y herramientas prestadas).

Importante: MariaDB es una foto del momento de la migración. Los movimientos que
se registren de ahora en adelante se guardan en Supabase. Si se vuelve a MariaDB
después de seguir operando, hay que migrar primero esos datos nuevos.

## 5. Volver a ejecutar la migración

Con MariaDB actualizado y Supabase accesible:

```powershell
cd C:\xampp\htdocs\xampp\TERMOPARTALMACEN
C:\xampp\php\php.exe migracion_supabase.php datos --reemplazar
```

`--reemplazar` vacía las tablas de Supabase y vuelve a copiar todo. Sin ese
parámetro, el script se detiene si encuentra datos para evitar duplicados.

Para crear solo el esquema:

```powershell
C:\xampp\php\php.exe migracion_supabase.php esquema
```

## 6. Pruebas realizadas

Contra Supabase, con el servidor embebido de PHP y la misma sesión/API que usa la web:

- Login con `admin`, actualización de último acceso e historial.
- Listado de 854 productos, 149 herramientas y 22 activos.
- Búsqueda de activos (`T423067`) y filtro por tipo `CALLE`/`TALLER`.
- Listados de historial, materiales dañados y entradas de almacén.
- Exportación PDF/HTML y Excel (1.020.682 bytes).
- Crear, actualizar y eliminar producto (incluida la detección de duplicado 409).
- Crear, actualizar y eliminar activo de taller/calle.
- Crear y eliminar herramienta.
- En una transacción revertida: toma física con 854 detalles, entrada de almacén,
  material dañado y salida de herramienta, verificando las secuencias identity.

## 7. Seguridad

Las credenciales están en `config_bd.php` (archivo PHP, no se muestra como texto
al pedirlo por HTTP). Si el proyecto se publica fuera de la red local, conviene
mover las credenciales a variables de entorno y restringir el acceso al servidor.
