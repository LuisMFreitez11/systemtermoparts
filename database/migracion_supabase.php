<?php
declare(strict_types=1);

/**
 * Migración MariaDB -> PostgreSQL (Supabase) del WMS TERMO PART.
 *
 * Uso (desde la carpeta del proyecto):
 *   php migracion_supabase.php              # crea el esquema y copia los datos
 *   php migracion_supabase.php esquema      # solo crea/actualiza el esquema
 *   php migracion_supabase.php datos        # solo copia los datos
 *   php migracion_supabase.php todo --reemplazar  # borra lo que haya en Supabase y vuelve a copiar
 *
 * El script es de uso exclusivo por consola.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde la línea de comandos.');
}

require_once __DIR__ . '/../backend/src/Config.php';
require_once __DIR__ . '/../backend/src/Http.php';
require_once __DIR__ . '/../backend/src/Database.php';
require_once __DIR__ . '/../backend/src/Idempotency.php';
require_once __DIR__ . '/../backend/src/Audit.php';
require_once __DIR__ . '/../backend/src/Auth.php';

Config::inicializar();

$configMysql = Config::obtener('conexiones.mysql');
$configPg = Config::obtener('conexiones.pgsql');

const TABLAS_MIGRACION = [
    // [tabla, clave primaria]
    ['usuarios', 'usuario_id'],
    ['productos', 'producto_id'],
    ['herramientas', 'herramienta_id'],
    ['activos', 'activo_id'],
    ['movimientos_inventario', 'movimiento_id'],
    ['activo_materiales', 'id'],
    ['herramientas_movimientos', 'movimiento_id'],
    ['historial_usuario', 'historial_id'],
    ['entradas_almacen', 'entrada_id'],
    ['materiales_danados', 'danado_id'],
    ['tomas_fisicas', 'toma_id'],
    ['toma_fisica_detalle', 'detalle_id'],
];

$argumentos = array_slice($argv, 1);
$modo = 'todo';

foreach ($argumentos as $argumento) {
    if (in_array($argumento, ['esquema', 'datos', 'todo'], true)) {
        $modo = $argumento;
    }
}

$reemplazar = in_array('--reemplazar', $argumentos, true);

try {
    $mysql = new PDO($configMysql['dsn'], $configMysql['usuario'], $configMysql['clave'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    $pg = new PDO($configPg['dsn'], $configPg['usuario'], $configPg['clave'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);

    if (($configPg['zona_horaria'] ?? null) !== null) {
        $pg->exec('SET TIME ZONE ' . $pg->quote((string) $configPg['zona_horaria']));
    }
} catch (PDOException $e) {
    fwrite(STDERR, 'ERROR de conexión: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}

/**
 * Devuelve las columnas de una tabla en MariaDB.
 *
 * @return string[]
 */
function columnasMysql(PDO $mysql, string $tabla): array
{
    $stmt = $mysql->prepare(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION'
    );
    $stmt->execute([$tabla]);

    return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

/**
 * Devuelve las columnas de una tabla en PostgreSQL (esquema public).
 *
 * @return string[]
 */
function columnasPostgres(PDO $pg, string $tabla): array
{
    $stmt = $pg->prepare(
        'SELECT column_name FROM information_schema.columns
         WHERE table_schema = \'public\' AND table_name = ?
         ORDER BY ordinal_position'
    );
    $stmt->execute([$tabla]);

    return $stmt->fetchAll(PDO::FETCH_COLUMN);
}

/**
 * Cuenta filas de una tabla PostgreSQL, o devuelve null si no existe.
 */
function contarPostgres(PDO $pg, string $tabla): ?int
{
    try {
        return (int) $pg->query('SELECT COUNT(*) FROM public.' . $tabla)->fetchColumn();
    } catch (PDOException $e) {
        return null;
    }
}

if ($modo === 'todo' || $modo === 'esquema') {
    $archivoEsquema = __DIR__ . '/database_supabase.sql';

    if (!is_file($archivoEsquema)) {
        fwrite(STDERR, 'No se encontró database_supabase.sql' . PHP_EOL);
        exit(1);
    }

    $sql = (string) file_get_contents($archivoEsquema);

    try {
        $pg->exec($sql);
        echo 'Esquema PostgreSQL creado/verificado correctamente.' . PHP_EOL;
    } catch (PDOException $e) {
        try {
            $pg->exec('ROLLBACK');
        } catch (PDOException $ignorada) {
            // Sin transacción abierta.
        }

        fwrite(STDERR, 'ERROR al crear el esquema: ' . $e->getMessage() . PHP_EOL);
        exit(1);
    }
}

if ($modo === 'todo' || $modo === 'datos') {
    if (!$reemplazar) {
        foreach (TABLAS_MIGRACION as [$tabla, $pk]) {
            $filas = contarPostgres($pg, $tabla);

            if ($filas !== null && $filas > 0) {
                fwrite(
                    STDERR,
                    'La tabla ' . $tabla . ' ya tiene ' . $filas . ' fila(s) en Supabase.' . PHP_EOL
                    . 'Usa "--reemplazar" si deseas vaciar y volver a copiar, o "datos" tras vaciarlas manualmente.' . PHP_EOL
                );
                exit(1);
            }
        }
    }

    try {
        $pg->beginTransaction();

        if ($reemplazar) {
            $pg->exec(
                'TRUNCATE TABLE public.toma_fisica_detalle, public.tomas_fisicas,
                 public.materiales_danados, public.entradas_almacen,
                 public.historial_usuario, public.herramientas_movimientos,
                 public.activo_materiales, public.movimientos_inventario,
                 public.activos, public.herramientas, public.productos, public.usuarios
                 RESTART IDENTITY CASCADE'
            );
            echo 'Tablas de Supabase vaciadas (--reemplazar).' . PHP_EOL;
        }

        $totales = [];
        $movimientosValidos = null;

        foreach (TABLAS_MIGRACION as [$tabla, $pk]) {
            $columnasMysql = columnasMysql($mysql, $tabla);

            if ($columnasMysql === []) {
                throw new RuntimeException('La tabla ' . $tabla . ' no existe en MariaDB.');
            }

            $columnasPg = columnasPostgres($pg, $tabla);

            if ($columnasPg === []) {
                throw new RuntimeException('La tabla ' . $tabla . ' no existe en Supabase.');
            }

            $columnas = array_values(array_intersect($columnasMysql, $columnasPg));

            if ($columnas === []) {
                throw new RuntimeException('No hay columnas en común para ' . $tabla . '.');
            }

            $listaColumnasMysql = implode(', ', array_map(static fn (string $c): string => '`' . $c . '`', $columnas));
            $listaColumnasPg = implode(', ', array_map(static fn (string $c): string => '"' . $c . '"', $columnas));

            $filas = $mysql->query('SELECT ' . $listaColumnasMysql . ' FROM `' . $tabla . '`')->fetchAll();

            $marcadores = implode(', ', array_fill(0, count($columnas), '?'));
            $insert = $pg->prepare(
                'INSERT INTO public.' . $tabla . ' (' . $listaColumnasPg . ') VALUES (' . $marcadores . ')'
            );

            foreach ($filas as $fila) {
                $valores = [];

                foreach ($columnas as $columna) {
                    $valor = $fila[$columna];

                    // En MariaDB estas dos tablas no tienen FK real a movimientos_inventario.
                    // Si el movimiento fue eliminado, se conserva el registro con movimiento_id NULL.
                    if ($columna === 'movimiento_id' && in_array($tabla, ['entradas_almacen', 'materiales_danados'], true)) {
                        if ($movimientosValidos === null) {
                            $movimientosValidos = array_flip(array_map(
                                'intval',
                                $pg->query('SELECT movimiento_id FROM public.movimientos_inventario')->fetchAll(PDO::FETCH_COLUMN)
                            ));
                        }

                        if ($valor !== null && !isset($movimientosValidos[(int) $valor])) {
                            $valor = null;
                        }
                    }

                    $valores[] = $valor;
                }

                $insert->execute($valores);
            }

            $totales[$tabla] = count($filas);
            echo '  ' . str_pad($tabla, 26, ' ') . count($filas) . ' fila(s)' . PHP_EOL;
        }

        $pg->commit();
    } catch (Throwable $e) {
        if ($pg->inTransaction()) {
            $pg->rollBack();
        }

        fwrite(STDERR, 'ERROR al copiar los datos: ' . $e->getMessage() . PHP_EOL);
        exit(1);
    }

    // Ajustar las secuencias (identity) al máximo ID copiado.
    echo PHP_EOL . 'Ajustando secuencias...' . PHP_EOL;

    foreach (TABLAS_MIGRACION as [$tabla, $pk]) {
        try {
            $secuencia = $pg->query(
                'SELECT pg_get_serial_sequence(' . $pg->quote('public.' . $tabla) . ', ' . $pg->quote($pk) . ')'
            )->fetchColumn();

            if ($secuencia === false || $secuencia === null) {
                continue;
            }

            $maximo = (int) $pg->query('SELECT COALESCE(MAX("' . $pk . '"), 0) FROM public.' . $tabla)->fetchColumn();

            if ($maximo > 0) {
                $pg->exec('SELECT setval(' . $pg->quote($secuencia) . ', ' . $maximo . ', true)');

                $siguiente = (int) $pg->query(
                    'SELECT last_value FROM ' . $secuencia
                )->fetchColumn();

                echo '  ' . str_pad($tabla, 26, ' ') . 'secuencia en ' . $siguiente . PHP_EOL;
            }
        } catch (PDOException $e) {
            fwrite(STDERR, '  Aviso: no se pudo ajustar la secuencia de ' . $tabla . ': ' . $e->getMessage() . PHP_EOL);
        }
    }

    // Verificación de conteos contra MariaDB.
    echo PHP_EOL . 'Verificación de conteos:' . PHP_EOL;
    $diferencias = 0;

    foreach (TABLAS_MIGRACION as [$tabla, $pk]) {
        $origen = (int) $mysql->query('SELECT COUNT(*) FROM `' . $tabla . '`')->fetchColumn();
        $destino = (int) $pg->query('SELECT COUNT(*) FROM public.' . $tabla)->fetchColumn();

        if ($origen !== $destino) {
            $diferencias++;
            echo '  MISMATCH ' . $tabla . ': MariaDB=' . $origen . ' Supabase=' . $destino . PHP_EOL;
        }
    }

    echo $diferencias === 0
        ? '  Todas las tablas coinciden en cantidad de filas.' . PHP_EOL
        : '  Se encontraron ' . $diferencias . ' diferencia(s).' . PHP_EOL;

    $resumenProductos = $pg->query(
        'SELECT COUNT(*) AS productos,
                COALESCE(SUM(stock_actual), 0) AS stock,
                COALESCE(SUM(stock_danado), 0) AS danado
         FROM public.productos'
    )->fetch();

    $resumenActivos = $pg->query(
        'SELECT tipo, COUNT(*) AS cantidad FROM public.activos GROUP BY tipo ORDER BY tipo'
    )->fetchAll();

    echo PHP_EOL . 'Resumen Supabase:' . PHP_EOL;
    echo '  Productos: ' . $resumenProductos['productos']
        . ' | stock total: ' . $resumenProductos['stock']
        . ' | dañado: ' . $resumenProductos['danado'] . PHP_EOL;

    foreach ($resumenActivos as $fila) {
        echo '  Activos ' . $fila['tipo'] . ': ' . $fila['cantidad'] . PHP_EOL;
    }

    echo PHP_EOL . 'Migración finalizada.' . PHP_EOL;
}
