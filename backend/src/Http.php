<?php
declare(strict_types=1);

/**
 * Utilidades HTTP compartidas por todos los endpoints.
 */
final class Http
{
    /**
     * Envía una respuesta JSON y termina la petición.
     *
     * @param array<mixed> $payload
     */
    public static function json(array $payload, int $status = 200): never
    {
        Idempotency::completar($status, $payload);

        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
        }

        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /**
     * Respuesta estándar de error.
     *
     * @param array<string, mixed> $extra
     */
    public static function error(string $mensaje, int $status = 400, array $extra = []): never
    {
        self::json(array_merge(['exito' => false, 'mensaje' => $mensaje], $extra), $status);
    }

    /**
     * Cuerpo JSON de la petición. Responde 400 si el JSON es inválido.
     *
     * @return array<mixed>
     */
    public static function cuerpo(): array
    {
        $raw = file_get_contents('php://input');

        if ($raw === false || trim($raw) === '') {
            return [];
        }

        $datos = json_decode($raw, true);

        if (!is_array($datos)) {
            self::error('El cuerpo de la petición no es un JSON válido.', 400);
        }

        return $datos;
    }

    public static function parametro(string $clave, string $defecto = ''): string
    {
        $valor = $_GET[$clave] ?? $defecto;

        return is_scalar($valor) ? (string) $valor : $defecto;
    }

    public static function metodo(): string
    {
        return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    }

    public static function esPost(): bool
    {
        return self::metodo() === 'POST';
    }

    public static function requierePost(): void
    {
        if (!self::esPost()) {
            self::error('Esta acción requiere el método POST.', 405);
        }
    }

    /**
     * Cabeceras CORS. Se permite el mismo origen siempre y, si se configuran,
     * los orígenes explícitos de CORS_ALLOWED_ORIGINS.
     */
    public static function cors(): void
    {
        $origen = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');

        if ($origen !== '') {
            $permitidos = (array) Config::obtener('app.origenes_permitidos', []);
            $mismoHost = self::mismoHost($origen);

            if ($mismoHost || in_array($origen, $permitidos, true)) {
                header('Access-Control-Allow-Origin: ' . $origen);
                header('Vary: Origin');
                header('Access-Control-Allow-Credentials: true');
                header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
                header('Access-Control-Allow-Headers: Content-Type, Accept, X-Idempotency-Key, X-Requested-With');
                header('Access-Control-Max-Age: 86400');
            }
        }

        if (self::metodo() === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    private static function mismoHost(string $origen): bool
    {
        $hostOrigen = parse_url($origen, PHP_URL_HOST);

        if (!is_string($hostOrigen) || $hostOrigen === '') {
            return false;
        }

        $hostActual = preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? ''));

        return $hostActual !== '' && strcasecmp($hostOrigen, $hostActual) === 0;
    }
}
