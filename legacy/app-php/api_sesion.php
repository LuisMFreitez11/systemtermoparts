<?php
declare(strict_types=1);

require_once 'conexion.php';
require_once 'sesion.php';

header('Content-Type: application/json; charset=utf-8');

$accion = $_GET['accion'] ?? '';
$raw = file_get_contents('php://input');
$data = [];

if ($raw !== false && trim($raw) !== '') {
    $decoded = json_decode($raw, true);

    if (!is_array($decoded)) {
        responderSesion(['exito' => false, 'mensaje' => 'El cuerpo de la petición no es un JSON válido.'], 400);
    }

    $data = $decoded;
}

function responderSesion(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

if (!in_array($accion, ['estado', 'login', 'logout', 'cambiar_clave'], true)) {
    responderSesion(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ['login', 'logout', 'cambiar_clave'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responderSesion(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'estado':
        $usuario = usuarioSesion();

        responderSesion([
            'autenticado' => $usuario !== null,
            'usuario' => $usuario,
        ]);
        break;

    case 'login':
        $nombreUsuario = trim((string) ($data['usuario'] ?? ''));
        $clave = (string) ($data['clave'] ?? '');

        if ($nombreUsuario === '' || $clave === '') {
            responderSesion(['exito' => false, 'mensaje' => 'Escribe tu usuario y tu clave.'], 422);
        }

        try {
            $stmt = $pdo->prepare("SELECT usuario_id, usuario, nombre_completo, clave_hash, rol, activo FROM usuarios WHERE usuario = ? LIMIT 1");
            $stmt->execute([$nombreUsuario]);
            $fila = $stmt->fetch();

            if ($fila === false || (int) $fila['activo'] !== 1 || !password_verify($clave, $fila['clave_hash'])) {
                usleep(250000);
                responderSesion(['exito' => false, 'mensaje' => 'Usuario o clave incorrectos.'], 401);
            }

            session_regenerate_id(true);

            $_SESSION['usuario'] = [
                'usuario_id' => (int) $fila['usuario_id'],
                'usuario' => $fila['usuario'],
                'nombre_completo' => $fila['nombre_completo'],
                'rol' => $fila['rol'],
            ];

            $pdo->prepare("UPDATE usuarios SET ultimo_acceso = NOW() WHERE usuario_id = ?")
                ->execute([(int) $fila['usuario_id']]);

            registrarHistorial($pdo, 'INICIO_SESION', 'Ingresó al sistema');

            responderSesion([
                'exito' => true,
                'mensaje' => 'Bienvenido, ' . ($fila['nombre_completo'] !== '' ? $fila['nombre_completo'] : $fila['usuario']) . '.',
                'usuario' => $_SESSION['usuario'],
            ]);
        } catch (PDOException $e) {
            error_log('Error al iniciar sesión: ' . $e->getMessage());
            responderSesion(['exito' => false, 'mensaje' => 'No se pudo iniciar sesión.'], 500);
        }
        break;

    case 'logout':
        $usuario = usuarioSesion();

        if ($usuario !== null) {
            registrarHistorial($pdo, 'CIERRE_SESION', 'Salió del sistema');
        }

        $_SESSION = [];

        if (ini_get('session.use_cookies')) {
            $parametros = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => time() - 42000,
                'path' => $parametros['path'] ?: '/',
                'domain' => $parametros['domain'] ?? '',
                'secure' => (bool) ($parametros['secure'] ?? false),
                'httponly' => (bool) ($parametros['httponly'] ?? true),
                'samesite' => $parametros['samesite'] ?? 'Lax',
            ]);
        }

        session_destroy();

        responderSesion(['exito' => true, 'mensaje' => 'Sesión cerrada.']);
        break;

    case 'cambiar_clave':
        $usuario = requiereSesion();

        $claveActual = (string) ($data['clave_actual'] ?? '');
        $claveNueva = (string) ($data['clave_nueva'] ?? '');

        if ($claveActual === '' || $claveNueva === '') {
            responderSesion(['exito' => false, 'mensaje' => 'Completa la clave actual y la nueva clave.'], 422);
        }

        if (mb_strlen($claveNueva) < 6) {
            responderSesion(['exito' => false, 'mensaje' => 'La nueva clave debe tener al menos 6 caracteres.'], 422);
        }

        try {
            $stmt = $pdo->prepare("SELECT clave_hash FROM usuarios WHERE usuario_id = ?");
            $stmt->execute([(int) $usuario['usuario_id']]);
            $hash = $stmt->fetchColumn();

            if ($hash === false || !password_verify($claveActual, (string) $hash)) {
                responderSesion(['exito' => false, 'mensaje' => 'La clave actual no es correcta.'], 422);
            }

            $pdo->prepare("UPDATE usuarios SET clave_hash = ? WHERE usuario_id = ?")
                ->execute([password_hash($claveNueva, PASSWORD_DEFAULT), (int) $usuario['usuario_id']]);

            registrarHistorial($pdo, 'CAMBIO_CLAVE', 'Cambió su clave de acceso');

            responderSesion(['exito' => true, 'mensaje' => 'Clave actualizada correctamente.']);
        } catch (PDOException $e) {
            error_log('Error al cambiar la clave: ' . $e->getMessage());
            responderSesion(['exito' => false, 'mensaje' => 'No se pudo cambiar la clave.'], 500);
        }
        break;
}
