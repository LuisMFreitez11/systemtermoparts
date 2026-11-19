<?php
declare(strict_types=1);

/**
 * Registro de auditoría en historial_usuario.
 */
final class Audit
{
    public static function registrar(PDO $pdo, string $accion, string $detalle = ''): void
    {
        $usuario = Auth::usuario();

        if ($usuario === null) {
            return;
        }

        try {
            $stmt = $pdo->prepare(
                'INSERT INTO historial_usuario (usuario_id, usuario, accion, detalle, ip)
                 VALUES (?, ?, ?, ?, ?)'
            );

            $stmt->execute([
                (int) $usuario['usuario_id'],
                $usuario['usuario'],
                mb_substr($accion, 0, 80),
                mb_substr($detalle, 0, 500),
                mb_substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45),
            ]);
        } catch (Throwable $e) {
            error_log('[WMS] No se pudo guardar el historial: ' . $e->getMessage());
        }
    }
}
