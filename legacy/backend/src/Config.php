<?php
declare(strict_types=1);

/**
 * Acceso tipado a la configuración del backend.
 */
final class Config
{
    /** @var array<string, mixed>|null */
    private static ?array $datos = null;

    /**
     * Carga la configuración una sola vez por petición.
     *
     * @return array<string, mixed>
     */
    public static function todo(): array
    {
        if (self::$datos === null) {
            /** @var array<string, mixed> $datos */
            $datos = require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'config.php';
            self::$datos = $datos;
        }

        return self::$datos;
    }

    /**
     * Obtiene un valor usando notación de punto: "app.zona_horaria".
     */
    public static function obtener(string $ruta, mixed $defecto = null): mixed
    {
        $valor = self::todo();

        foreach (explode('.', $ruta) as $parte) {
            if (!is_array($valor) || !array_key_exists($parte, $valor)) {
                return $defecto;
            }

            $valor = $valor[$parte];
        }

        return $valor;
    }

    /**
     * Configura zona horaria, errores y manejo global de excepciones.
     */
    public static function inicializar(): void
    {
        date_default_timezone_set((string) self::obtener('app.zona_horaria', 'America/Caracas'));

        $depurar = (bool) self::obtener('app.depuracion', false);

        ini_set('display_errors', $depurar ? '1' : '0');
        ini_set('log_errors', '1');
        error_reporting(E_ALL);

        set_exception_handler(static function (Throwable $e): void {
            error_log('[WMS] Excepción no controlada: ' . $e->getMessage() . ' en ' . $e->getFile() . ':' . $e->getLine());

            if (!headers_sent()) {
                http_response_code(500);

                if (PHP_SAPI !== 'cli') {
                    header('Content-Type: application/json; charset=utf-8');
                }
            }

            if (PHP_SAPI !== 'cli') {
                echo json_encode([
                    'exito' => false,
                    'mensaje' => 'Ocurrió un error interno. Intenta de nuevo en unos segundos.',
                ], JSON_UNESCAPED_UNICODE);
            }

            exit(1);
        });
    }
}
