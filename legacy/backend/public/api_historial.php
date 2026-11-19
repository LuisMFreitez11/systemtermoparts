<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/bootstrap.php';

$accion = Http::parametro('accion', 'listar');
$usuario = Auth::requiereSesion();
$esAdmin = ($usuario['rol'] ?? '') === 'ADMIN';

if (!in_array($accion, ['listar', 'usuarios'], true)) {
    Http::error('Acción no válida.', 400);
}

try {
    if ($accion === 'usuarios') {
        if ($esAdmin) {
            $stmt = $pdo->query("SELECT usuario FROM usuarios ORDER BY usuario ASC");
            echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN), JSON_UNESCAPED_UNICODE);
        } else {
            echo json_encode([$usuario['usuario']], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    $buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);
    $usuarioFiltro = mb_substr(trim((string) ($_GET['usuario'] ?? '')), 0, 50);
    $desde = trim((string) ($_GET['desde'] ?? ''));
    $hasta = trim((string) ($_GET['hasta'] ?? ''));
    $limite = filter_var($_GET['limite'] ?? 300, FILTER_VALIDATE_INT);
    $limite = ($limite === false || $limite === null) ? 300 : max(1, min($limite, 1000));

    $sql = "SELECT historial_id, usuario_id, usuario, accion, detalle, ip, creado_en
            FROM historial_usuario
            WHERE 1 = 1";
    $parametros = [];

    if (!$esAdmin) {
        $sql .= ' AND usuario_id = :usuario_id';
        $parametros[':usuario_id'] = (int) $usuario['usuario_id'];
    } elseif ($usuarioFiltro !== '') {
        $sql .= ' AND usuario = :usuario';
        $parametros[':usuario'] = $usuarioFiltro;
    }

    if ($buscar !== '') {
        $sql .= ' AND (POSITION(LOWER(:b_accion) IN LOWER(accion)) > 0
                    OR POSITION(LOWER(:b_detalle) IN LOWER(detalle)) > 0
                    OR POSITION(LOWER(:b_usuario) IN LOWER(usuario)) > 0
                    OR POSITION(LOWER(:b_ip) IN LOWER(ip)) > 0)';
        foreach (['b_accion', 'b_detalle', 'b_usuario', 'b_ip'] as $nombre) {
            $parametros[':' . $nombre] = $buscar;
        }
    }

    if ($desde !== '') {
        $fecha = DateTimeImmutable::createFromFormat('Y-m-d', $desde);
        if ($fecha === false || $fecha->format('Y-m-d') !== $desde) {
            Http::error('La fecha "desde" no es válida.', 422);
        }

        $sql .= ' AND creado_en >= :desde';
        $parametros[':desde'] = $desde . ' 00:00:00';
    }

    if ($hasta !== '') {
        $fecha = DateTimeImmutable::createFromFormat('Y-m-d', $hasta);
        if ($fecha === false || $fecha->format('Y-m-d') !== $hasta) {
            Http::error('La fecha "hasta" no es válida.', 422);
        }

        $sql .= ' AND creado_en <= :hasta';
        $parametros[':hasta'] = $hasta . ' 23:59:59';
    }

    $sql .= ' ORDER BY creado_en DESC, historial_id DESC LIMIT ' . $limite;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($parametros);

    echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    error_log('[WMS] Error al consultar el historial: ' . $e->getMessage());
    Http::error('No se pudo consultar el historial de movimientos.', 500);
}
