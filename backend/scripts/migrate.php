<?php
declare(strict_types=1);

/**
 * Migraciones del backend.
 *
 * Uso:
 *   php backend/scripts/migrate.php idempotencia
 *   php backend/scripts/migrate.php rls
 *   php backend/scripts/migrate.php todo
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

$objetivo = strtolower(trim((string) ($argv[1] ?? 'todo')));
$driver = (string) Config::obtener('driver', 'pgsql');
$pdo = Database::conexion();

/**
 * Ejecuta un archivo SQL completo.
 */
function ejecutarSql(PDO $pdo, string $archivo): void
{
    if (!is_file($archivo)) {
        throw new RuntimeException('No existe el archivo SQL: ' . $archivo);
    }

    $sql = (string) file_get_contents($archivo);
    $pdo->exec($sql);

    echo '  OK  ' . basename($archivo) . PHP_EOL;
}

$base = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'database' . DIRECTORY_SEPARATOR;

try {
    echo 'Motor activo: ' . $driver . PHP_EOL;

    if ($objetivo === 'todo' || $objetivo === 'idempotencia') {
        echo 'Aplicando idempotencia...' . PHP_EOL;
        ejecutarSql(
            $pdo,
            $base . ($driver === 'pgsql' ? 'idempotencia_supabase.sql' : 'idempotencia_mariadb.sql')
        );
    }

    if ($objetivo === 'todo' || $objetivo === 'rls') {
        if ($driver !== 'pgsql') {
            throw new RuntimeException('RLS solo aplica al motor PostgreSQL/Supabase.');
        }

        echo 'Aplicando Row Level Security...' . PHP_EOL;
        ejecutarSql($pdo, $base . 'rls_supabase.sql');
    }

    echo 'Migración completada.' . PHP_EOL;
} catch (Throwable $e) {
    fwrite(STDERR, 'ERROR: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
