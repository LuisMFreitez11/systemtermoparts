<?php
declare(strict_types=1);

/**
 * Autenticación por sesión PHP con roles ADMIN / USUARIO.
 */
final class Auth
{
    public static function iniciarSesion(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $nombre = (string) Config::obtener('sesion.nombre', 'TERMOPART_SESS');
        $sameSite = (string) Config::obtener('sesion.samesite', 'Lax');
        $segura = (bool) Config::obtener('sesion.segura', false);
        $dominio = (string) Config::obtener('sesion.dominio', '');
        $vigencia = (int) Config::obtener('sesion.vigencia', 0);

        // Si el frontend se sirve desde otro dominio (por ejemplo Vercel),
        // la cookie debe viajar entre sitios: SameSite=None; Secure.
        $origen = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');

        if ($origen !== '') {
            $hostOrigen = parse_url($origen, PHP_URL_HOST);
            $hostActual = preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? ''));

            if (is_string($hostOrigen) && $hostOrigen !== '' && strcasecmp($hostOrigen, $hostActual) !== 0) {
                $sameSite = 'None';
                $segura = true;
            }
        }

        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        session_name($nombre);

        $parametros = [
            'lifetime' => max(0, $vigencia),
            'path' => '/',
            'httponly' => true,
            'samesite' => in_array($sameSite, ['Lax', 'Strict', 'None'], true) ? $sameSite : 'Lax',
            'secure' => $segura,
        ];

        if ($dominio !== '') {
            $parametros['domain'] = $dominio;
        }

        session_set_cookie_params($parametros);
        session_start();
    }

    /**
     * Construye la URL pública de una página del frontend, tanto en XAMPP
     * (subcarpeta) como en un dominio propio.
     */
    public static function urlFrontend(string $pagina): string
    {
        $configurada = trim((string) Config::obtener('app.url_frontend', ''));

        if ($configurada !== '') {
            return rtrim($configurada, '/') . '/' . ltrim($pagina, '/');
        }

        $script = (string) ($_SERVER['SCRIPT_NAME'] ?? '');
        $base = preg_replace('#/backend/public/[^/]+$#', '', $script);

        if (is_string($base) && $base !== $script) {
            return $base . '/frontend/' . ltrim($pagina, '/');
        }

        return '../frontend/' . ltrim($pagina, '/');
    }

    /**
     * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}|null
     */
    public static function usuario(): ?array
    {
        $usuario = $_SESSION['usuario'] ?? null;

        return is_array($usuario) ? $usuario : null;
    }

    /**
     * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}
     */
    public static function requiereSesion(bool $json = true): array
    {
        $usuario = self::usuario();

        if ($usuario !== null) {
            return $usuario;
        }

        if ($json) {
            Http::json([
                'exito' => false,
                'mensaje' => 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.',
                'no_autenticado' => true,
            ], 401);
        }

        header('Location: ' . self::urlFrontend('login.html'));
        exit;
    }

    /**
     * @return array{usuario_id: int, usuario: string, nombre_completo: string, rol: string}
     */
    public static function requiereAdmin(): array
    {
        $usuario = self::requiereSesion();

        if (($usuario['rol'] ?? '') !== 'ADMIN') {
            Http::error('No tienes permiso para realizar esta acción.', 403);
        }

        return $usuario;
    }

    /**
     * @return array{ok: bool, status: int, mensaje: string, usuario?: array<string, mixed>}
     */
    public static function login(PDO $pdo, string $nombreUsuario, string $clave): array
    {
        $nombreUsuario = trim($nombreUsuario);

        if ($nombreUsuario === '' || $clave === '') {
            return ['ok' => false, 'status' => 422, 'mensaje' => 'Escribe tu usuario y tu clave.'];
        }

        try {
            $stmt = $pdo->prepare(
                'SELECT usuario_id, usuario, nombre_completo, clave_hash, rol, activo
                 FROM usuarios WHERE usuario = ? LIMIT 1'
            );
            $stmt->execute([$nombreUsuario]);
            $fila = $stmt->fetch();

            if ($fila === false || (int) $fila['activo'] !== 1 || !password_verify($clave, (string) $fila['clave_hash'])) {
                usleep(250000);

                return ['ok' => false, 'status' => 401, 'mensaje' => 'Usuario o clave incorrectos.'];
            }

            session_regenerate_id(true);

            $_SESSION['usuario'] = [
                'usuario_id' => (int) $fila['usuario_id'],
                'usuario' => $fila['usuario'],
                'nombre_completo' => $fila['nombre_completo'],
                'rol' => $fila['rol'],
            ];

            $pdo->prepare('UPDATE usuarios SET ultimo_acceso = NOW() WHERE usuario_id = ?')
                ->execute([(int) $fila['usuario_id']]);

            Audit::registrar($pdo, 'INICIO_SESION', 'Ingresó al sistema');

            $nombreMostrar = $fila['nombre_completo'] !== '' ? $fila['nombre_completo'] : $fila['usuario'];

            return [
                'ok' => true,
                'status' => 200,
                'mensaje' => 'Bienvenido, ' . $nombreMostrar . '.',
                'usuario' => $_SESSION['usuario'],
            ];
        } catch (PDOException $e) {
            error_log('[WMS] Error al iniciar sesión: ' . $e->getMessage());

            return ['ok' => false, 'status' => 500, 'mensaje' => 'No se pudo iniciar sesión.'];
        }
    }

    public static function logout(PDO $pdo): void
    {
        if (self::usuario() !== null) {
            Audit::registrar($pdo, 'CIERRE_SESION', 'Salió del sistema');
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
    }

    /**
     * @return array{ok: bool, status: int, mensaje: string}
     */
    public static function cambiarClave(PDO $pdo, string $claveActual, string $claveNueva): array
    {
        $usuario = self::requiereSesion();

        if ($claveActual === '' || $claveNueva === '') {
            return ['ok' => false, 'status' => 422, 'mensaje' => 'Completa la clave actual y la nueva clave.'];
        }

        if (mb_strlen($claveNueva) < 6) {
            return ['ok' => false, 'status' => 422, 'mensaje' => 'La nueva clave debe tener al menos 6 caracteres.'];
        }

        try {
            $stmt = $pdo->prepare('SELECT clave_hash FROM usuarios WHERE usuario_id = ?');
            $stmt->execute([(int) $usuario['usuario_id']]);
            $hash = $stmt->fetchColumn();

            if ($hash === false || !password_verify($claveActual, (string) $hash)) {
                return ['ok' => false, 'status' => 422, 'mensaje' => 'La clave actual no es correcta.'];
            }

            $pdo->prepare('UPDATE usuarios SET clave_hash = ? WHERE usuario_id = ?')
                ->execute([password_hash($claveNueva, PASSWORD_DEFAULT), (int) $usuario['usuario_id']]);

            Audit::registrar($pdo, 'CAMBIO_CLAVE', 'Cambió su clave de acceso');

            return ['ok' => true, 'status' => 200, 'mensaje' => 'Clave actualizada correctamente.'];
        } catch (PDOException $e) {
            error_log('[WMS] Error al cambiar la clave: ' . $e->getMessage());

            return ['ok' => false, 'status' => 500, 'mensaje' => 'No se pudo cambiar la clave.'];
        }
    }
}
