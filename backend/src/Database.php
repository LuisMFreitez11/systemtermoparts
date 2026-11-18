<?php
declare(strict_types=1);

/**
 * Conexión PDO única (singleton) y utilidades comunes entre PostgreSQL y MariaDB.
 */
final class Database
{
    private static ?PDO $conexion = null;

    public static function conexion(): PDO
    {
        if (self::$conexion instanceof PDO) {
            return self::$conexion;
        }

        $driver = (string) Config::obtener('driver', 'pgsql');
        $config = Config::obtener('conexiones.' . $driver);

        if (!is_array($config)) {
            throw new RuntimeException('No existe configuración para el motor de base de datos "' . $driver . '".');
        }

        try {
            $pdo = new PDO(
                (string) $config['dsn'],
                (string) $config['usuario'],
                (string) $config['clave'],
                [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                    PDO::ATTR_STRINGIFY_FETCHES => false,
                ]
            );

            if (($config['zona_horaria'] ?? null) !== null && $driver === 'pgsql') {
                $pdo->exec('SET TIME ZONE ' . $pdo->quote((string) $config['zona_horaria']));
            }
        } catch (PDOException $e) {
            error_log('[WMS] Error de conexión (' . $driver . '): ' . $e->getMessage());

            $mensaje = $driver === 'mysql'
                ? 'Error de conexión a MariaDB. Verifica que el servidor MySQL esté iniciado.'
                : 'Error de conexión a la base de datos. Verifica la conexión a internet y las credenciales del backend.';

            if ($driver === 'mysql' && str_contains($e->getMessage(), 'Unknown database')) {
                $mensaje = 'La base de datos "termo_part_wms" no existe. Importa database/database.sql en phpMyAdmin.';
            }

            if (!headers_sent()) {
                http_response_code(500);
                header('Content-Type: application/json; charset=utf-8');
            }

            echo json_encode(['exito' => false, 'mensaje' => $mensaje], JSON_UNESCAPED_UNICODE);
            exit;
        }

        self::$conexion = $pdo;

        return self::$conexion;
    }

    public static function esPostgres(?PDO $pdo = null): bool
    {
        $pdo ??= self::conexion();

        return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql';
    }

    /**
     * ID generado por el último INSERT, tanto en MariaDB como en PostgreSQL.
     */
    public static function ultimoId(PDO $pdo, string $tabla, string $columna): int
    {
        if (!self::esPostgres($pdo)) {
            return (int) $pdo->lastInsertId();
        }

        $stmt = $pdo->prepare('SELECT currval(pg_get_serial_sequence(?, ?))');
        $stmt->execute([$tabla, $columna]);

        return (int) $stmt->fetchColumn();
    }

    /**
     * Detecta violaciones de unicidad o de clave foránea en ambos motores.
     */
    public static function esConflicto(PDOException $e): bool
    {
        return in_array((string) $e->getCode(), ['23000', '23503', '23505'], true);
    }

    public static function cerrar(): void
    {
        self::$conexion = null;
    }
}
