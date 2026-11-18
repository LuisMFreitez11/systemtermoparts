<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/bootstrap.php';

$accion = Http::parametro('accion');

if (!in_array($accion, ['estado', 'login', 'logout', 'cambiar_clave'], true)) {
    Http::error('Acción no válida.', 400);
}

if (in_array($accion, ['login', 'logout', 'cambiar_clave'], true) && !Http::esPost()) {
    Http::error('Esta acción requiere el método POST.', 405);
}

switch ($accion) {
    case 'estado':
        $usuario = Auth::usuario();

        Http::json([
            'autenticado' => $usuario !== null,
            'usuario' => $usuario,
        ]);
        break;

    case 'login':
        $data = Http::cuerpo();
        $resultado = Auth::login(
            $pdo,
            (string) ($data['usuario'] ?? ''),
            (string) ($data['clave'] ?? '')
        );

        if (!$resultado['ok']) {
            Http::json(['exito' => false, 'mensaje' => $resultado['mensaje']], $resultado['status']);
        }

        Http::json([
            'exito' => true,
            'mensaje' => $resultado['mensaje'],
            'usuario' => $resultado['usuario'] ?? null,
        ]);
        break;

    case 'logout':
        Auth::logout($pdo);

        Http::json(['exito' => true, 'mensaje' => 'Sesión cerrada.']);
        break;

    case 'cambiar_clave':
        $data = Http::cuerpo();
        $resultado = Auth::cambiarClave(
            $pdo,
            (string) ($data['clave_actual'] ?? ''),
            (string) ($data['clave_nueva'] ?? '')
        );

        Http::json(
            ['exito' => $resultado['ok'], 'mensaje' => $resultado['mensaje']],
            $resultado['status']
        );
        break;
}
