<?php
declare(strict_types=1);

/**
 * Idempotencia de escrituras.
 *
 * El cliente envía la cabecera X-Idempotency-Key. Si la operación ya se
 * completó, se devuelve la misma respuesta sin volver a aplicarla. Es la pieza
 * que permite reintentar la cola offline sin duplicar consumos ni entradas.
 */
final class Idempotency
{
    private static bool $activa = false;
    private static bool $disponible = true;
    private static ?string $clave = null;
    private static ?string $huella = null;
    private static ?PDO $pdo = null;

    public static function iniciar(PDO $pdo, string $endpoint): void
    {
        if (!Config::obtener('idempotencia.activa', true) || !Http::esPost() || !self::$disponible) {
            return;
        }

        $clave = trim((string) ($_SERVER['HTTP_X_IDEMPOTENCY_KEY'] ?? ''));

        if ($clave === '' || !preg_match('/^[A-Za-z0-9._:-]{8,120}$/', $clave)) {
            return;
        }

        $raw = (string) file_get_contents('php://input');
        $accion = Http::parametro('accion');
        $huella = hash('sha256', $endpoint . '|' . $accion . '|' . $raw);
        $usuario = Auth::usuario();

        try {
            $stmt = $pdo->prepare(
                'SELECT estado, huella, codigo_http, respuesta, actualizado_en
                 FROM operaciones_idempotencia WHERE clave = ?'
            );
            $stmt->execute([$clave]);
            $fila = $stmt->fetch();

            if ($fila !== false) {
                if (!hash_equals((string) $fila['huella'], $huella)) {
                    Http::error(
                        'La clave de idempotencia ya fue usada con otra operación.',
                        409,
                        ['idempotencia_conflicto' => true]
                    );
                }

                if ((string) $fila['estado'] === 'COMPLETADA') {
                    http_response_code((int) $fila['codigo_http']);

                    if (!headers_sent()) {
                        header('Content-Type: application/json; charset=utf-8');
                        header('Cache-Control: no-store');
                        header('X-Idempotent-Replay: true');
                    }

                    echo (string) $fila['respuesta'];
                    exit;
                }

                $antiguedad = time() - strtotime((string) $fila['actualizado_en']);

                if ($antiguedad < 120) {
                    Http::error(
                        'La operación está en proceso. Espera unos segundos antes de reintentar.',
                        409,
                        ['idempotencia_en_proceso' => true]
                    );
                }

                $pdo->prepare('DELETE FROM operaciones_idempotencia WHERE clave = ?')->execute([$clave]);
            }

            $stmt = $pdo->prepare(
                'INSERT INTO operaciones_idempotencia (clave, huella, endpoint, usuario_id, estado)
                 VALUES (?, ?, ?, ?, \'EN_PROCESO\')'
            );
            $stmt->execute([
                $clave,
                $huella,
                mb_substr($endpoint, 0, 120),
                $usuario !== null ? (int) $usuario['usuario_id'] : null,
            ]);

            self::$activa = true;
            self::$clave = $clave;
            self::$huella = $huella;
            self::$pdo = $pdo;
        } catch (PDOException $e) {
            // La tabla es opcional: si aún no existe, la aplicación sigue igual.
            self::$disponible = false;
            error_log('[WMS] Idempotencia deshabilitada: ' . $e->getMessage());
        }
    }

    /**
     * Guarda la respuesta definitiva o libera la clave si la operación falló.
     *
     * @param array<mixed> $payload
     */
    public static function completar(int $status, array $payload): void
    {
        if (!self::$activa || self::$clave === null || self::$pdo === null) {
            return;
        }

        $pdo = self::$pdo;
        $clave = self::$clave;

        self::$activa = false;

        try {
            if ($status >= 200 && $status < 300) {
                $pdo->prepare(
                    'UPDATE operaciones_idempotencia
                     SET estado = \'COMPLETADA\', codigo_http = ?, respuesta = ?, actualizado_en = NOW()
                     WHERE clave = ?'
                )->execute([
                    $status,
                    json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                    $clave,
                ]);
            } else {
                // La operación no se aplicó: permitir el reintento con la misma clave.
                $pdo->prepare('DELETE FROM operaciones_idempotencia WHERE clave = ?')->execute([$clave]);
            }

            if (random_int(1, 50) === 1) {
                self::limpiar($pdo);
            }
        } catch (Throwable $e) {
            error_log('[WMS] No se pudo cerrar la idempotencia: ' . $e->getMessage());
        }
    }

    private static function limpiar(PDO $pdo): void
    {
        $dias = max(1, (int) (Config::obtener('idempotencia.vigencia_segundos', 604800) / 86400));
        $limite = date('Y-m-d H:i:s', time() - ($dias * 86400));

        $pdo->prepare('DELETE FROM operaciones_idempotencia WHERE actualizado_en < ?')->execute([$limite]);
    }
}
