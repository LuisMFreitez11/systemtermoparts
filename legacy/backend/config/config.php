<?php
declare(strict_types=1);

/**
 * Configuración central del backend WMS Termo Part.
 *
 * Prioridad de valores:
 *   1. Variables de entorno del proceso (recomendado en producción).
 *   2. Archivo backend/.env (desarrollo local, nunca se versiona).
 *   3. Valores por defecto de este archivo.
 */

$env = static function (string $clave, string $defecto = ''): string {
    static $archivo = null;

    if ($archivo === null) {
        $archivo = [];
        $ruta = dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env';

        if (is_file($ruta)) {
            $lineas = file($ruta, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];

            foreach ($lineas as $linea) {
                $linea = trim($linea);

                if ($linea === '' || $linea[0] === '#' || !str_contains($linea, '=')) {
                    continue;
                }

                [$nombre, $valor] = explode('=', $linea, 2);
                $nombre = trim($nombre);
                $valor = trim($valor);

                if (strlen($valor) >= 2
                    && ($valor[0] === '"' || $valor[0] === "'")
                    && $valor[strlen($valor) - 1] === $valor[0]
                ) {
                    $valor = substr($valor, 1, -1);
                }

                $archivo[$nombre] = $valor;
            }
        }
    }

    $valor = getenv($clave);

    if ($valor !== false && $valor !== '') {
        return $valor;
    }

    return $archivo[$clave] ?? $defecto;
};

$flag = static fn (string $clave, string $defecto = '0'): bool
    => filter_var($env($clave, $defecto), FILTER_VALIDATE_BOOL);

$origenes = array_values(array_filter(array_map(
    'trim',
    explode(',', $env('CORS_ALLOWED_ORIGINS', ''))
)));

return [
    'app' => [
        'nombre' => $env('APP_NAME', 'WMS Termo Part'),
        'zona_horaria' => $env('APP_TIMEZONE', 'America/Caracas'),
        'depuracion' => $flag('APP_DEBUG', '0'),
        'origenes_permitidos' => $origenes,
        'url_frontend' => $env('FRONTEND_URL', ''),
    ],

    'sesion' => [
        'nombre' => $env('SESSION_NAME', 'TERMOPART_SESS'),
        'samesite' => $env('SESSION_SAMESITE', 'Lax'),
        'segura' => $flag('SESSION_SECURE', '0'),
        'dominio' => $env('SESSION_DOMAIN', ''),
        'vigencia' => (int) $env('SESSION_LIFETIME', '0'),
    ],

    'driver' => $env('DB_DRIVER', 'pgsql'),

    'conexiones' => [
        'pgsql' => [
            'dsn' => $env(
                'DB_PGSQL_DSN',
                'pgsql:host=aws-0-ca-central-1.pooler.supabase.com;port=5432;dbname=postgres;sslmode=require'
            ),
            'usuario' => $env('DB_PGSQL_USER', 'postgres.TU-PROYECTO'),
            'clave' => $env('DB_PGSQL_PASSWORD', ''),
            'zona_horaria' => $env('DB_PGSQL_TIMEZONE', 'America/Caracas'),
        ],
        'mysql' => [
            'dsn' => $env('DB_MYSQL_DSN', 'mysql:host=localhost;dbname=termo_part_wms;charset=utf8mb4'),
            'usuario' => $env('DB_MYSQL_USER', 'root'),
            'clave' => $env('DB_MYSQL_PASSWORD', ''),
            'zona_horaria' => null,
        ],
    ],

    'idempotencia' => [
        'activa' => $flag('IDEMPOTENCY_ENABLED', '1'),
        'vigencia_segundos' => (int) $env('IDEMPOTENCY_TTL', '604800'),
    ],
];
