<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/bootstrap.php';

$usuarioActual = Auth::requiereSesion();

$accion = Http::parametro('accion');
$data = Http::cuerpo();

function responderDanados(array $payload, int $status = 200): never
{
    Http::json($payload, $status);
}

/**
 * Valida los datos de un material dañado.
 *
 * @return array{producto_id: int, cantidad: float, fecha_dano: string, motivo: string, observaciones: string}
 */
function validarDanado(array $data): array
{
    $errores = [];

    $productoId = filter_var($data['producto_id'] ?? null, FILTER_VALIDATE_INT);
    if ($productoId === false || $productoId === null || $productoId < 1) {
        $errores[] = 'Debes seleccionar un material del almacén.';
    }

    $cantidad = is_numeric($data['cantidad'] ?? null) ? (float) $data['cantidad'] : null;
    if ($cantidad === null || $cantidad < 0.001 || $cantidad > 999999999.999) {
        $errores[] = 'La cantidad debe ser un número mayor o igual a 0,001.';
    }

    $fecha = trim((string) ($data['fecha_dano'] ?? ''));
    if ($fecha === '') {
        $fecha = date('Y-m-d');
    }

    $objetoFecha = DateTimeImmutable::createFromFormat('Y-m-d', $fecha);
    if ($objetoFecha === false || $objetoFecha->format('Y-m-d') !== $fecha) {
        $errores[] = 'La fecha del daño no es válida (formato AAAA-MM-DD).';
    }

    $motivo = trim((string) ($data['motivo'] ?? ''));
    if ($motivo === '') {
        $errores[] = 'Indica el motivo o tipo de daño.';
    } elseif (mb_strlen($motivo) > 150) {
        $errores[] = 'El motivo no puede superar los 150 caracteres.';
    }

    $observaciones = trim((string) ($data['observaciones'] ?? ''));
    if (mb_strlen($observaciones) > 5000) {
        $errores[] = 'Las observaciones no pueden superar los 5000 caracteres.';
    }

    if ($errores !== []) {
        responderDanados(['exito' => false, 'mensaje' => implode(' ', $errores)], 422);
    }

    return [
        'producto_id' => (int) $productoId,
        'cantidad' => round((float) $cantidad, 3),
        'fecha_dano' => $fecha,
        'motivo' => $motivo,
        'observaciones' => $observaciones,
    ];
}

if (!in_array($accion, ['listar', 'crear', 'eliminar'], true)) {
    responderDanados(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ['crear', 'eliminar'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responderDanados(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'listar':
        $buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);

        $sql = "SELECT d.danado_id, d.producto_id, d.cantidad, d.fecha_dano, d.motivo, d.observaciones,
                       d.stock_anterior, d.stock_nuevo, d.creado_en,
                       p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.lote_condicion,
                       p.stock_actual, p.stock_danado
                FROM materiales_danados d
                JOIN productos p ON p.producto_id = d.producto_id";

        $parametros = [];
        if ($buscar !== '') {
            $sql .= ' WHERE (POSITION(LOWER(:b_codigo) IN LOWER(p.sku_codigo)) > 0
                        OR POSITION(LOWER(:b_descripcion) IN LOWER(p.nombre_descripcion)) > 0
                        OR POSITION(LOWER(:b_lote) IN LOWER(p.lote_condicion)) > 0
                        OR POSITION(LOWER(:b_motivo) IN LOWER(d.motivo)) > 0
                        OR POSITION(LOWER(:b_observaciones) IN LOWER(d.observaciones)) > 0)';

            foreach (['b_codigo', 'b_descripcion', 'b_lote', 'b_motivo', 'b_observaciones'] as $nombre) {
                $parametros[':' . $nombre] = $buscar;
            }
        }

        $sql .= ' ORDER BY d.fecha_dano DESC, d.danado_id DESC';

        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($parametros);
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar materiales dañados: ' . $e->getMessage());
            responderDanados(['exito' => false, 'mensaje' => 'No se pudieron obtener los materiales dañados.'], 500);
        }
        break;

    case 'crear':
        $danado = validarDanado($data);

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_danado FROM productos WHERE producto_id = ? FOR UPDATE");
            $stmt->execute([$danado['producto_id']]);
            $producto = $stmt->fetch();

            if ($producto === false) {
                $pdo->rollBack();
                responderDanados(['exito' => false, 'mensaje' => 'El material seleccionado ya no existe en el almacén.'], 404);
            }

            $stockAnterior = (float) $producto['stock_actual'];
            if ($danado['cantidad'] > $stockAnterior) {
                $pdo->rollBack();
                responderDanados([
                    'exito' => false,
                    'mensaje' => 'Stock insuficiente de ' . $producto['sku_codigo'] . ' - ' . $producto['nombre_descripcion']
                        . ': disponible ' . $stockAnterior . ', solicitado ' . $danado['cantidad'] . '.',
                ], 422);
            }

            $stockNuevo = round($stockAnterior - $danado['cantidad'], 3);
            $danadoNuevo = round((float) $producto['stock_danado'] + $danado['cantidad'], 3);

            $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_danado = ?, actualizado_en = NOW() WHERE producto_id = ?")
                ->execute([$stockNuevo, $danadoNuevo, $danado['producto_id']]);

            $motivoMovimiento = mb_substr('Material dañado · ' . $danado['motivo'], 0, 255);

            $pdo->prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, 'DANADO', ?, ?, ?, ?)")
                ->execute([
                    $danado['producto_id'],
                    $danado['cantidad'],
                    $stockAnterior,
                    $stockNuevo,
                    $motivoMovimiento,
                ]);

            $movimientoId = Database::ultimoId($pdo, 'movimientos_inventario', 'movimiento_id');

            $pdo->prepare("INSERT INTO materiales_danados (producto_id, cantidad, fecha_dano, motivo, observaciones, stock_anterior, stock_nuevo, movimiento_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([
                    $danado['producto_id'],
                    $danado['cantidad'],
                    $danado['fecha_dano'],
                    $danado['motivo'],
                    $danado['observaciones'] === '' ? null : $danado['observaciones'],
                    $stockAnterior,
                    $stockNuevo,
                    $movimientoId,
                ]);

            $danadoId = Database::ultimoId($pdo, 'materiales_danados', 'danado_id');

            $pdo->commit();

            Audit::registrar(
                $pdo,
                'DANADO',
                'Registró ' . $danado['cantidad'] . ' como dañado de ' . $producto['sku_codigo'] . ' - '
                    . $producto['nombre_descripcion'] . ' (' . $danado['motivo'] . ', stock '
                    . $stockAnterior . ' → ' . $stockNuevo . ').'
            );

            responderDanados([
                'exito' => true,
                'mensaje' => 'Material dañado registrado: el stock pasó de ' . $stockAnterior . ' a ' . $stockNuevo . '.',
                'danado_id' => $danadoId,
                'stock_anterior' => $stockAnterior,
                'stock_nuevo' => $stockNuevo,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al registrar material dañado: ' . $e->getMessage());
            responderDanados(['exito' => false, 'mensaje' => 'No se pudo registrar el material dañado.'], 500);
        }
        break;

    case 'eliminar':
        $danadoId = filter_var($data['danado_id'] ?? null, FILTER_VALIDATE_INT);

        if ($danadoId === false || $danadoId === null || $danadoId < 1) {
            responderDanados(['exito' => false, 'mensaje' => 'El ID del registro no es válido.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT danado_id, producto_id, cantidad, movimiento_id FROM materiales_danados WHERE danado_id = ? FOR UPDATE");
            $stmt->execute([$danadoId]);
            $danado = $stmt->fetch();

            if ($danado === false) {
                $pdo->rollBack();
                responderDanados(['exito' => false, 'mensaje' => 'El registro de material dañado no existe.'], 404);
            }

            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_danado FROM productos WHERE producto_id = ? FOR UPDATE");
            $stmt->execute([(int) $danado['producto_id']]);
            $producto = $stmt->fetch();

            if ($producto === false) {
                $pdo->rollBack();
                responderDanados(['exito' => false, 'mensaje' => 'El material de este registro ya no existe en el almacén.'], 404);
            }

            $cantidad = (float) $danado['cantidad'];
            $stockAnterior = (float) $producto['stock_actual'];
            $stockNuevo = round($stockAnterior + $cantidad, 3);
            $danadoNuevo = max(0.0, round((float) $producto['stock_danado'] - $cantidad, 3));

            $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_danado = ?, actualizado_en = NOW() WHERE producto_id = ?")
                ->execute([$stockNuevo, $danadoNuevo, (int) $danado['producto_id']]);

            if ($danado['movimiento_id'] !== null) {
                $pdo->prepare("DELETE FROM movimientos_inventario WHERE movimiento_id = ?")
                    ->execute([(int) $danado['movimiento_id']]);
            }

            $pdo->prepare("DELETE FROM materiales_danados WHERE danado_id = ?")->execute([$danadoId]);

            $pdo->commit();

            Audit::registrar(
                $pdo,
                'ANULAR_DANADO',
                'Anuló el registro de ' . $cantidad . ' dañado(s) de ' . $producto['sku_codigo'] . ' - '
                    . $producto['nombre_descripcion'] . ' (stock ' . $stockAnterior . ' → ' . $stockNuevo . ').'
            );

            responderDanados([
                'exito' => true,
                'mensaje' => 'Registro anulado. El material volvió al stock disponible: ' . $stockAnterior . ' → ' . $stockNuevo . '.',
                'stock_nuevo' => $stockNuevo,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al anular material dañado: ' . $e->getMessage());
            responderDanados(['exito' => false, 'mensaje' => 'No se pudo anular el registro de material dañado.'], 500);
        }
        break;
}
