<?php
declare(strict_types=1);

require_once 'conexion.php';
require_once 'sesion.php';

$usuarioActual = requiereSesion();

header('Content-Type: application/json; charset=utf-8');

const ACCIONES_ESCRITURA = ['crear', 'actualizar', 'eliminar', 'ajustar', 'registrar_toma_fisica'];

$accion = $_GET['accion'] ?? '';
$raw = file_get_contents('php://input');
$data = [];

if ($raw !== false && trim($raw) !== '') {
    $decoded = json_decode($raw, true);

    if (!is_array($decoded)) {
        responder(['exito' => false, 'mensaje' => 'El cuerpo de la petición no es un JSON válido.'], 400);
    }

    $data = $decoded;
}

function responder(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Deriva la categoría a partir de la primera palabra de la descripción.
 */
function categoriaDesdeDescripcion(string $nombre): string
{
    $partes = preg_split('/\s+/u', trim($nombre)) ?: [];
    $primera = $partes[0] ?? '';
    $limpia = preg_replace('/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/u', '', $primera) ?? '';
    $limpia = mb_strtoupper($limpia);

    return $limpia === '' ? 'OTROS' : mb_substr($limpia, 0, 50);
}

/**
 * Valida y normaliza los datos de un producto.
 *
 * @return array{producto_id: int|null, sku_codigo: string, nombre_descripcion: string, categoria: string, lote_condicion: string, unidad_medida: string, stock_actual: float, stock_minimo: float}
 */
function validarProducto(array $data, bool $requiereId = false): array
{
    $errores = [];

    $productoId = null;
    if ($requiereId) {
        $productoId = filter_var($data['producto_id'] ?? null, FILTER_VALIDATE_INT);

        if ($productoId === false || $productoId === null || $productoId < 1) {
            $errores[] = 'El ID del producto no es válido.';
        }
    }

    $sku = trim((string) ($data['sku_codigo'] ?? ''));
    if ($sku === '') {
        $errores[] = 'El código es obligatorio.';
    } elseif (mb_strlen($sku) > 50) {
        $errores[] = 'El código no puede superar los 50 caracteres.';
    }

    $nombre = trim((string) ($data['nombre_descripcion'] ?? ''));
    if ($nombre === '') {
        $errores[] = 'La descripción del producto es obligatoria.';
    } elseif (mb_strlen($nombre) > 255) {
        $errores[] = 'La descripción no puede superar los 255 caracteres.';
    }

    $lote = trim((string) ($data['lote_condicion'] ?? ''));
    $lote = preg_replace('/\s+/u', ' ', $lote) ?? '';
    $lote = strtoupper($lote);

    if ($lote === '' || $lote === 'NUEVO' || $lote === 'STOK') {
        $lote = 'STOCK';
    } elseif ($lote === 'RECUP') {
        $lote = 'RECUPERADO';
    }

    if (mb_strlen($lote) > 50) {
        $errores[] = 'El lote o condición no puede superar los 50 caracteres.';
    }

    $unidad = trim((string) ($data['unidad_medida'] ?? ''));
    if ($unidad === '') {
        $errores[] = 'La unidad de medida es obligatoria.';
    } elseif (mb_strlen($unidad) > 20) {
        $errores[] = 'La unidad de medida no puede superar los 20 caracteres.';
    }

    $stockActual = is_numeric($data['stock_actual'] ?? null) ? (float) $data['stock_actual'] : null;
    if ($stockActual === null || $stockActual < 0 || $stockActual > 999999999.999) {
        $errores[] = 'El stock actual debe ser un número entre cero y 999.999.999,999.';
    }

    $stockMinimo = is_numeric($data['stock_minimo'] ?? null) ? (float) $data['stock_minimo'] : null;
    if ($stockMinimo === null || $stockMinimo < 0 || $stockMinimo > 999999999.999) {
        $errores[] = 'El stock mínimo debe ser un número entre cero y 999.999.999,999.';
    }

    if ($errores !== []) {
        responder(['exito' => false, 'mensaje' => implode(' ', $errores)], 422);
    }

    return [
        'producto_id' => $productoId,
        'sku_codigo' => $sku,
        'nombre_descripcion' => $nombre,
        'categoria' => categoriaDesdeDescripcion($nombre),
        'lote_condicion' => $lote,
        'unidad_medida' => $unidad,
        'stock_actual' => $stockActual,
        'stock_minimo' => $stockMinimo,
    ];
}

if (!in_array($accion, ['listar', 'historial', 'crear', 'actualizar', 'eliminar', 'ajustar', 'ultima_toma', 'registrar_toma_fisica'], true)) {
    responder(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ACCIONES_ESCRITURA, true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responder(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'listar':
        try {
            $stmt = $pdo->query("SELECT * FROM productos ORDER BY producto_id DESC");
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar productos: ' . $e->getMessage());
            responder(['exito' => false, 'mensaje' => 'No se pudieron obtener los productos.'], 500);
        }
        break;

    case 'historial':
        $productoId = filter_var($_GET['producto_id'] ?? null, FILTER_VALIDATE_INT);

        if ($productoId === false || $productoId === null || $productoId < 1) {
            responder(['exito' => false, 'mensaje' => 'El ID del producto no es válido.'], 422);
        }

        try {
            $stmt = $pdo->prepare("SELECT movimiento_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo, creado_en FROM movimientos_inventario WHERE producto_id = ? ORDER BY movimiento_id DESC");
            $stmt->execute([$productoId]);
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al obtener historial: ' . $e->getMessage());
            responder(['exito' => false, 'mensaje' => 'No se pudo obtener el historial del producto.'], 500);
        }
        break;

    case 'ultima_toma':
        try {
            $stmt = $pdo->query("SELECT toma_id, registrada_en, total_productos, total_unidades FROM tomas_fisicas ORDER BY toma_id DESC LIMIT 1");
            $toma = $stmt->fetch();
            echo json_encode($toma === false ? null : $toma, JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al obtener la última toma física: ' . $e->getMessage());
            responder(['exito' => false, 'mensaje' => 'No se pudo obtener la última toma física.'], 500);
        }
        break;

    case 'registrar_toma_fisica':
        try {
            $pdo->beginTransaction();

            $stmt = $pdo->query("SELECT COUNT(*) AS total_productos, COALESCE(SUM(stock_actual), 0) AS total_unidades FROM productos");
            $totales = $stmt->fetch();

            $pdo->exec("UPDATE productos SET toma_fisica_anterior = stock_actual");

            $stmt = $pdo->prepare("INSERT INTO tomas_fisicas (total_productos, total_unidades) VALUES (?, ?)");
            $stmt->execute([(int) $totales['total_productos'], (float) $totales['total_unidades']]);
            $tomaId = (int) $pdo->lastInsertId();

            $stmt = $pdo->prepare("INSERT INTO toma_fisica_detalle (toma_id, producto_id, cantidad) SELECT ?, producto_id, stock_actual FROM productos");
            $stmt->execute([$tomaId]);

            $pdo->commit();

            registrarHistorial(
                $pdo,
                'TOMA_FISICA',
                'Registró la toma física de ' . (int) $totales['total_productos'] . ' materiales (' . (float) $totales['total_unidades'] . ' unidades).'
            );

            $stmt = $pdo->prepare("SELECT toma_id, registrada_en, total_productos, total_unidades FROM tomas_fisicas WHERE toma_id = ?");
            $stmt->execute([$tomaId]);
            $toma = $stmt->fetch();

            responder([
                'exito' => true,
                'mensaje' => 'Toma física registrada con el stock actual de ' . (int) $totales['total_productos'] . ' materiales.',
                'toma' => $toma,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al registrar la toma física: ' . $e->getMessage());
            responder(['exito' => false, 'mensaje' => 'No se pudo registrar la toma física.'], 500);
        }
        break;

    case 'crear':
        $producto = validarProducto($data);

        try {
            $stmt = $pdo->prepare("INSERT INTO productos (sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, stock_minimo, toma_fisica_anterior) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $producto['sku_codigo'],
                $producto['nombre_descripcion'],
                $producto['categoria'],
                $producto['lote_condicion'],
                $producto['unidad_medida'],
                $producto['stock_actual'],
                $producto['stock_minimo'],
                $producto['stock_actual'],
            ]);

            registrarHistorial(
                $pdo,
                'CREAR_PRODUCTO',
                'Creó el producto ' . $producto['sku_codigo'] . ' - ' . $producto['nombre_descripcion'] . ' (stock inicial ' . $producto['stock_actual'] . ').'
            );

            responder(['exito' => true, 'mensaje' => 'Producto creado con éxito.']);
        } catch (PDOException $e) {
            error_log('Error al crear producto: ' . $e->getMessage());

            if ($e->getCode() === '23000') {
                responder(['exito' => false, 'mensaje' => 'Ya existe un producto con ese código, lote y descripción.'], 409);
            }

            responder(['exito' => false, 'mensaje' => 'No se pudo crear el producto.'], 500);
        }
        break;

    case 'actualizar':
        $producto = validarProducto($data, true);

        try {
            $stmt = $pdo->prepare("UPDATE productos SET sku_codigo = ?, nombre_descripcion = ?, categoria = ?, lote_condicion = ?, unidad_medida = ?, stock_actual = ?, stock_minimo = ?, actualizado_en = NOW() WHERE producto_id = ?");
            $stmt->execute([
                $producto['sku_codigo'],
                $producto['nombre_descripcion'],
                $producto['categoria'],
                $producto['lote_condicion'],
                $producto['unidad_medida'],
                $producto['stock_actual'],
                $producto['stock_minimo'],
                $producto['producto_id'],
            ]);

            if ($stmt->rowCount() === 0 && !productoExiste($pdo, $producto['producto_id'])) {
                responder(['exito' => false, 'mensaje' => 'El producto que intentas actualizar no existe.'], 404);
            }

            registrarHistorial(
                $pdo,
                'ACTUALIZAR_PRODUCTO',
                'Actualizó el producto ' . $producto['sku_codigo'] . ' - ' . $producto['nombre_descripcion'] . '.'
            );

            responder(['exito' => true, 'mensaje' => 'Producto actualizado con éxito.']);
        } catch (PDOException $e) {
            error_log('Error al actualizar producto: ' . $e->getMessage());

            if ($e->getCode() === '23000') {
                responder(['exito' => false, 'mensaje' => 'Ya existe otro producto con ese código, lote y descripción.'], 409);
            }

            responder(['exito' => false, 'mensaje' => 'No se pudo actualizar el producto.'], 500);
        }
        break;

    case 'ajustar':
        $productoId = filter_var($data['producto_id'] ?? null, FILTER_VALIDATE_INT);

        if ($productoId === false || $productoId === null || $productoId < 1) {
            responder(['exito' => false, 'mensaje' => 'El ID del producto no es válido.'], 422);
        }

        $tipo = strtolower(trim((string) ($data['tipo'] ?? '')));
        if (!in_array($tipo, ['restar', 'sumar'], true)) {
            responder(['exito' => false, 'mensaje' => 'El tipo de ajuste debe ser "restar" o "sumar".'], 422);
        }

        $cantidad = is_numeric($data['cantidad'] ?? null) ? (float) $data['cantidad'] : null;
        if ($cantidad === null || $cantidad < 0.001 || $cantidad > 999999999.999) {
            responder(['exito' => false, 'mensaje' => 'La cantidad debe ser un número mayor o igual a 0,001.'], 422);
        }

        $cantidad = round($cantidad, 3);

        $motivo = trim((string) ($data['motivo'] ?? ''));
        if (mb_strlen($motivo) > 255) {
            responder(['exito' => false, 'mensaje' => 'El motivo no puede superar los 255 caracteres.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_consumido, stock_incrementado FROM productos WHERE producto_id = ? FOR UPDATE");
            $stmt->execute([$productoId]);
            $producto = $stmt->fetch();

            if ($producto === false) {
                $pdo->rollBack();
                responder(['exito' => false, 'mensaje' => 'El producto que intentas ajustar no existe.'], 404);
            }

            $stockAnterior = (float) $producto['stock_actual'];
            $consumidoAnterior = (float) $producto['stock_consumido'];
            $incrementadoAnterior = (float) $producto['stock_incrementado'];

            if ($tipo === 'restar') {
                if ($cantidad > $stockAnterior) {
                    $pdo->rollBack();
                    responder([
                        'exito' => false,
                        'mensaje' => 'No puedes restar ' . $cantidad . ' porque el stock actual es ' . $stockAnterior . '.',
                    ], 422);
                }

                $stockNuevo = round($stockAnterior - $cantidad, 3);
                $consumidoNuevo = round($consumidoAnterior + $cantidad, 3);
                $incrementadoNuevo = $incrementadoAnterior;
                $tipoMovimiento = 'CONSUMO';
            } else {
                $stockNuevo = round($stockAnterior + $cantidad, 3);
                $consumidoNuevo = $consumidoAnterior;
                $incrementadoNuevo = round($incrementadoAnterior + $cantidad, 3);
                $tipoMovimiento = 'INCREMENTO';
            }

            $stmt = $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_consumido = ?, stock_incrementado = ?, actualizado_en = NOW() WHERE producto_id = ?");
            $stmt->execute([$stockNuevo, $consumidoNuevo, $incrementadoNuevo, $productoId]);

            $stmt = $pdo->prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $productoId,
                $tipoMovimiento,
                $cantidad,
                $stockAnterior,
                $stockNuevo,
                $motivo === '' ? null : $motivo,
            ]);

            $pdo->commit();

            registrarHistorial(
                $pdo,
                'AJUSTAR_STOCK',
                ($tipo === 'restar' ? 'Restó ' : 'Incrementó ') . $cantidad . ' al producto '
                    . $producto['sku_codigo'] . ' - ' . $producto['nombre_descripcion']
                    . ' (stock ' . $stockAnterior . ' → ' . $stockNuevo . ').'
                    . ($motivo !== '' ? ' Motivo: ' . $motivo : '')
            );

            responder([
                'exito' => true,
                'mensaje' => $tipo === 'restar'
                    ? 'Se restaron ' . $cantidad . ' unidades del stock.'
                    : 'Se incrementaron ' . $cantidad . ' unidades al stock.',
                'stock_actual' => $stockNuevo,
                'stock_consumido' => $consumidoNuevo,
                'stock_incrementado' => $incrementadoNuevo,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al ajustar inventario: ' . $e->getMessage());
            responder(['exito' => false, 'mensaje' => 'No se pudo ajustar el inventario.'], 500);
        }
        break;

    case 'eliminar':
        $productoId = filter_var($data['producto_id'] ?? null, FILTER_VALIDATE_INT);

        if ($productoId === false || $productoId === null || $productoId < 1) {
            responder(['exito' => false, 'mensaje' => 'El ID del producto no es válido.'], 422);
        }

        try {
            $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion FROM productos WHERE producto_id = ?");
            $stmt->execute([$productoId]);
            $productoEliminado = $stmt->fetch();

            $stmt = $pdo->prepare("DELETE FROM productos WHERE producto_id = ?");
            $stmt->execute([$productoId]);

            if ($stmt->rowCount() === 0) {
                responder(['exito' => false, 'mensaje' => 'El producto que intentas eliminar no existe.'], 404);
            }

            registrarHistorial(
                $pdo,
                'ELIMINAR_PRODUCTO',
                'Eliminó el producto ' . ($productoEliminado['sku_codigo'] ?? ('ID ' . $productoId))
                    . ' - ' . ($productoEliminado['nombre_descripcion'] ?? '') . '.'
            );

            responder(['exito' => true, 'mensaje' => 'Producto eliminado.']);
        } catch (PDOException $e) {
            error_log('Error al eliminar producto: ' . $e->getMessage());

            if ($e->getCode() === '23000') {
                responder(['exito' => false, 'mensaje' => 'No se puede eliminar porque tiene movimientos, activos o entradas de almacén asociados.'], 409);
            }

            responder(['exito' => false, 'mensaje' => 'No se pudo eliminar el producto.'], 500);
        }
        break;
}

function productoExiste(PDO $pdo, int $productoId): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM productos WHERE producto_id = ?");
    $stmt->execute([$productoId]);

    return $stmt->fetchColumn() !== false;
}
