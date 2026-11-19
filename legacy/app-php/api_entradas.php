<?php
declare(strict_types=1);

require_once 'conexion.php';
require_once 'sesion.php';

$usuarioActual = requiereSesion();

header('Content-Type: application/json; charset=utf-8');

$accion = $_GET['accion'] ?? '';
$raw = file_get_contents('php://input');
$data = [];

if ($raw !== false && trim($raw) !== '') {
    $decoded = json_decode($raw, true);

    if (!is_array($decoded)) {
        responderEntradas(['exito' => false, 'mensaje' => 'El cuerpo de la petición no es un JSON válido.'], 400);
    }

    $data = $decoded;
}

function responderEntradas(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Valida los datos de una entrada de material al almacén.
 *
 * @return array{producto_id: int, cantidad: float, fecha_entrada: string, referencia: string, proveedor: string, observaciones: string}
 */
function validarEntrada(array $data): array
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

    $fecha = trim((string) ($data['fecha_entrada'] ?? ''));
    if ($fecha === '') {
        $fecha = date('Y-m-d');
    }

    $objetoFecha = DateTimeImmutable::createFromFormat('Y-m-d', $fecha);
    if ($objetoFecha === false || $objetoFecha->format('Y-m-d') !== $fecha) {
        $errores[] = 'La fecha de entrada no es válida (formato AAAA-MM-DD).';
    }

    $referencia = trim((string) ($data['referencia'] ?? ''));
    if (mb_strlen($referencia) > 100) {
        $errores[] = 'La referencia no puede superar los 100 caracteres.';
    }

    $proveedor = trim((string) ($data['proveedor'] ?? ''));
    if (mb_strlen($proveedor) > 150) {
        $errores[] = 'El proveedor no puede superar los 150 caracteres.';
    }

    $observaciones = trim((string) ($data['observaciones'] ?? ''));
    if (mb_strlen($observaciones) > 5000) {
        $errores[] = 'Las observaciones no pueden superar los 5000 caracteres.';
    }

    if ($errores !== []) {
        responderEntradas(['exito' => false, 'mensaje' => implode(' ', $errores)], 422);
    }

    return [
        'producto_id' => (int) $productoId,
        'cantidad' => round((float) $cantidad, 3),
        'fecha_entrada' => $fecha,
        'referencia' => $referencia,
        'proveedor' => $proveedor,
        'observaciones' => $observaciones,
    ];
}

if (!in_array($accion, ['listar', 'crear', 'eliminar'], true)) {
    responderEntradas(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ['crear', 'eliminar'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responderEntradas(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'listar':
        $buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);

        $sql = "SELECT e.entrada_id, e.producto_id, e.cantidad, e.fecha_entrada, e.referencia, e.proveedor,
                       e.observaciones, e.stock_anterior, e.stock_nuevo, e.creado_en,
                       p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.lote_condicion, p.stock_actual
                FROM entradas_almacen e
                JOIN productos p ON p.producto_id = e.producto_id";

        $parametros = [];
        if ($buscar !== '') {
            $sql .= ' WHERE (LOCATE(:b_codigo, p.sku_codigo) > 0
                        OR LOCATE(:b_descripcion, p.nombre_descripcion) > 0
                        OR LOCATE(:b_referencia, e.referencia) > 0
                        OR LOCATE(:b_proveedor, e.proveedor) > 0
                        OR LOCATE(:b_observaciones, e.observaciones) > 0)';

            foreach (['b_codigo', 'b_descripcion', 'b_referencia', 'b_proveedor', 'b_observaciones'] as $nombre) {
                $parametros[':' . $nombre] = $buscar;
            }
        }

        $sql .= ' ORDER BY e.fecha_entrada DESC, e.entrada_id DESC';

        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($parametros);
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar entradas de almacén: ' . $e->getMessage());
            responderEntradas(['exito' => false, 'mensaje' => 'No se pudieron obtener las entradas de almacén.'], 500);
        }
        break;

    case 'crear':
        $entrada = validarEntrada($data);

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_incrementado FROM productos WHERE producto_id = ? FOR UPDATE");
            $stmt->execute([$entrada['producto_id']]);
            $producto = $stmt->fetch();

            if ($producto === false) {
                $pdo->rollBack();
                responderEntradas(['exito' => false, 'mensaje' => 'El material seleccionado ya no existe en el almacén.'], 404);
            }

            $stockAnterior = (float) $producto['stock_actual'];
            $stockNuevo = round($stockAnterior + $entrada['cantidad'], 3);
            $incrementadoNuevo = round((float) $producto['stock_incrementado'] + $entrada['cantidad'], 3);

            $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_incrementado = ?, actualizado_en = NOW() WHERE producto_id = ?")
                ->execute([$stockNuevo, $incrementadoNuevo, $entrada['producto_id']]);

            $detalle = 'Entrada de almacén';
            if ($entrada['referencia'] !== '') {
                $detalle .= ' · Ref. ' . $entrada['referencia'];
            }
            if ($entrada['proveedor'] !== '') {
                $detalle .= ' · ' . $entrada['proveedor'];
            }

            $pdo->prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, 'ENTRADA', ?, ?, ?, ?)")
                ->execute([
                    $entrada['producto_id'],
                    $entrada['cantidad'],
                    $stockAnterior,
                    $stockNuevo,
                    mb_substr($detalle, 0, 255),
                ]);

            $movimientoId = (int) $pdo->lastInsertId();

            $pdo->prepare("INSERT INTO entradas_almacen (producto_id, cantidad, fecha_entrada, referencia, proveedor, observaciones, stock_anterior, stock_nuevo, movimiento_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([
                    $entrada['producto_id'],
                    $entrada['cantidad'],
                    $entrada['fecha_entrada'],
                    $entrada['referencia'],
                    $entrada['proveedor'],
                    $entrada['observaciones'] === '' ? null : $entrada['observaciones'],
                    $stockAnterior,
                    $stockNuevo,
                    $movimientoId,
                ]);

            $entradaId = (int) $pdo->lastInsertId();

            $pdo->commit();

            registrarHistorial(
                $pdo,
                'ENTRADA_ALMACEN',
                'Registró entrada de ' . $entrada['cantidad'] . ' de ' . $producto['sku_codigo'] . ' - '
                    . $producto['nombre_descripcion'] . ' (stock ' . $stockAnterior . ' → ' . $stockNuevo . ').'
                    . ($entrada['referencia'] !== '' ? ' Ref. ' . $entrada['referencia'] : '')
                    . ($entrada['proveedor'] !== '' ? ' · ' . $entrada['proveedor'] : '')
            );

            responderEntradas([
                'exito' => true,
                'mensaje' => 'Entrada registrada: el stock pasó de ' . $stockAnterior . ' a ' . $stockNuevo . '.',
                'entrada_id' => $entradaId,
                'stock_anterior' => $stockAnterior,
                'stock_nuevo' => $stockNuevo,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al crear entrada de almacén: ' . $e->getMessage());
            responderEntradas(['exito' => false, 'mensaje' => 'No se pudo registrar la entrada de almacén.'], 500);
        }
        break;

    case 'eliminar':
        $entradaId = filter_var($data['entrada_id'] ?? null, FILTER_VALIDATE_INT);

        if ($entradaId === false || $entradaId === null || $entradaId < 1) {
            responderEntradas(['exito' => false, 'mensaje' => 'El ID de la entrada no es válido.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT entrada_id, producto_id, cantidad, movimiento_id FROM entradas_almacen WHERE entrada_id = ? FOR UPDATE");
            $stmt->execute([$entradaId]);
            $entrada = $stmt->fetch();

            if ($entrada === false) {
                $pdo->rollBack();
                responderEntradas(['exito' => false, 'mensaje' => 'La entrada que intentas anular no existe.'], 404);
            }

            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_incrementado FROM productos WHERE producto_id = ? FOR UPDATE");
            $stmt->execute([(int) $entrada['producto_id']]);
            $producto = $stmt->fetch();

            if ($producto === false) {
                $pdo->rollBack();
                responderEntradas(['exito' => false, 'mensaje' => 'El material de esta entrada ya no existe en el almacén.'], 404);
            }

            $cantidad = (float) $entrada['cantidad'];
            $stockAnterior = (float) $producto['stock_actual'];

            if ($cantidad > $stockAnterior) {
                $pdo->rollBack();
                responderEntradas([
                    'exito' => false,
                    'mensaje' => 'No se puede anular la entrada: el stock actual de ' . $producto['sku_codigo']
                        . ' es ' . $stockAnterior . ' y la entrada fue de ' . $cantidad . '. Ajusta el inventario primero.',
                ], 422);
            }

            $stockNuevo = round($stockAnterior - $cantidad, 3);
            $incrementadoNuevo = max(0.0, round((float) $producto['stock_incrementado'] - $cantidad, 3));

            $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_incrementado = ?, actualizado_en = NOW() WHERE producto_id = ?")
                ->execute([$stockNuevo, $incrementadoNuevo, (int) $entrada['producto_id']]);

            if ($entrada['movimiento_id'] !== null) {
                $pdo->prepare("DELETE FROM movimientos_inventario WHERE movimiento_id = ?")
                    ->execute([(int) $entrada['movimiento_id']]);
            }

            $pdo->prepare("DELETE FROM entradas_almacen WHERE entrada_id = ?")->execute([$entradaId]);

            $pdo->commit();

            registrarHistorial(
                $pdo,
                'ANULAR_ENTRADA',
                'Anuló la entrada de ' . $cantidad . ' de ' . $producto['sku_codigo'] . ' - '
                    . $producto['nombre_descripcion'] . ' (stock ' . $stockAnterior . ' → ' . $stockNuevo . ').'
            );

            responderEntradas([
                'exito' => true,
                'mensaje' => 'Entrada anulada. El stock pasó de ' . $stockAnterior . ' a ' . $stockNuevo . '.',
                'stock_nuevo' => $stockNuevo,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al eliminar entrada de almacén: ' . $e->getMessage());
            responderEntradas(['exito' => false, 'mensaje' => 'No se pudo anular la entrada de almacén.'], 500);
        }
        break;
}
