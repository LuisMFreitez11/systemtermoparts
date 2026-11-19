<?php
declare(strict_types=1);

/**
 * Verificación rápida del backend desde la línea de comandos.
 *
 *   php backend/scripts/verificar.php
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Este script solo se ejecuta desde la línea de comandos.');
}

require_once __DIR__ . '/../src/Config.php';
require_once __DIR__ . '/../src/Http.php';
require_once __DIR__ . '/../src/Database.php';
require_once __DIR__ . '/../src/Idempotency.php';
require_once __DIR__ . '/../src/Audit.php';
require_once __DIR__ . '/../src/Auth.php';

Config::inicializar();

$pdo = Database::conexion();
$driver = (string) Config::obtener('driver', 'pgsql');

echo 'Motor: ' . $driver . PHP_EOL;
echo 'Versión: ' . $pdo->getAttribute(PDO::ATTR_SERVER_VERSION) . PHP_EOL;
echo str_repeat('-', 46) . PHP_EOL;

$tablas = [
    'usuarios',
    'productos',
    'movimientos_inventario',
    'herramientas',
    'herramientas_movimientos',
    'activos',
    'activo_materiales',
    'entradas_almacen',
    'materiales_danados',
    'tomas_fisicas',
    'toma_fisica_detalle',
    'historial_usuario',
    'operaciones_idempotencia',
];

foreach ($tablas as $tabla) {
    try {
        $total = (int) $pdo->query('SELECT COUNT(*) FROM ' . $tabla)->fetchColumn();
        printf("%-28s %6d filas" . PHP_EOL, $tabla, $total);
    } catch (Throwable $e) {
        printf("%-28s %s" . PHP_EOL, $tabla, 'NO DISPONIBLE');
    }
}

if ($driver === 'pgsql') {
    echo str_repeat('-', 46) . PHP_EOL;
    echo 'Row Level Security:' . PHP_EOL;

    $stmt = $pdo->query(
        "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );

    foreach ($stmt->fetchAll() as $fila) {
        printf("%-28s %s" . PHP_EOL, $fila['tablename'], $fila['rowsecurity'] === true || $fila['rowsecurity'] === 't' ? 'RLS activo' : 'sin RLS');
    }
}
