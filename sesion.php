<?php
declare(strict_types=1);

/**
 * Manejo de sesión y funciones compartidas de autenticación.
 */

if (session_status() === PHP_SESSION_NONE) {
    ini_set('session.use_strict_mode', '1');
    session_name('TERMOPART_SESS');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/**
 * Devuelve los datos del usuario autenticado o null.
 *
 * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}|null
 */
function usuarioSesion(): ?array
{
    $usuario = $_SESSION['usuario'] ?? null;

    return is_array($usuario) ? $usuario : null;
}

/**
 * Exige una sesión iniciada. Si $json es true responde JSON 401; si no, redirige al login.
 *
 * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}
 */
function requiereSesion(bool $json = true): array
{
    $usuario = usuarioSesion();

    if ($usuario !== null) {
        return $usuario;
    }

    if ($json) {
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'exito' => false,
            'mensaje' => 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.',
            'no_autenticado' => true,
        ], JSON_UNESCAPED_UNICODE);
    } else {
        header('Location: login.html');
    }

    exit;
}

/**
 * Exige que el usuario autenticado tenga rol ADMIN.
 *
 * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}
 */
function requiereAdmin(): array
{
    $usuario = requiereSesion();

    if (($usuario['rol'] ?? '') !== 'ADMIN') {
        http_response_code(403);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'exito' => false,
            'mensaje' => 'No tienes permiso para realizar esta acción.',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    return $usuario;
}

/**
 * Registra una acción del usuario en el historial global.
 */
function registrarHistorial(PDO $pdo, string $accion, string $detalle = ''): void
{
    $usuario = usuarioSesion();

    if ($usuario === null) {
        return;
    }

    try {
        $stmt = $pdo->prepare("INSERT INTO historial_usuario (usuario_id, usuario, accion, detalle, ip) VALUES (?, ?, ?, ?, ?)");
        $stmt->execute([
            (int) $usuario['usuario_id'],
            $usuario['usuario'],
            mb_substr($accion, 0, 80),
            mb_substr($detalle, 0, 500),
            mb_substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45),
        ]);
    } catch (Throwable $e) {
        error_log('No se pudo guardar el historial del usuario: ' . $e->getMessage());
    }
}
