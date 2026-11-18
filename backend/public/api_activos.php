<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/bootstrap.php';

$usuarioActual = Auth::requiereSesion();

$accion = Http::parametro('accion');
$data = Http::cuerpo();

function responderActivos(array $payload, int $status = 200): never
{
    Http::json($payload, $status);
}

/**
 * Valida y normaliza los datos de un activo.
 *
 * @return array<string, mixed>
 */
function validarActivo(array $data, bool $requiereId = false): array
{
    $errores = [];

    $activoId = null;
    if ($requiereId) {
        $activoId = filter_var($data['activo_id'] ?? null, FILTER_VALIDATE_INT);

        if ($activoId === false || $activoId === null || $activoId < 1) {
            $errores[] = 'El ID del activo no es válido.';
        }
    }

    $fecha = trim((string) ($data['fecha_ruta'] ?? ''));
    $fechaNormalizada = null;
    if ($fecha !== '') {
        $objeto = DateTimeImmutable::createFromFormat('Y-m-d', $fecha);
        if ($objeto === false || $objeto->format('Y-m-d') !== $fecha) {
            $errores[] = 'La fecha de ruta no es válida (formato AAAA-MM-DD).';
        } else {
            $fechaNormalizada = $fecha;
        }
    }

    $activo = trim((string) ($data['activo'] ?? ''));
    if ($activo === '') {
        $errores[] = 'El número de activo es obligatorio.';
    } elseif (mb_strlen($activo) > 50) {
        $errores[] = 'El activo no puede superar los 50 caracteres.';
    }

    $modelo = trim((string) ($data['modelo'] ?? ''));
    if (mb_strlen($modelo) > 120) {
        $errores[] = 'El modelo no puede superar los 120 caracteres.';
    }

    $nroOrden = trim((string) ($data['nro_orden'] ?? ''));
    if (mb_strlen($nroOrden) > 50) {
        $errores[] = 'El número de orden no puede superar los 50 caracteres.';
    }

    $reporte = trim((string) ($data['numero_reporte'] ?? ''));
    if (mb_strlen($reporte) > 50) {
        $errores[] = 'El número de reporte no puede superar los 50 caracteres.';
    }

    $cliente = trim((string) ($data['nombre_cliente'] ?? ''));
    if (mb_strlen($cliente) > 255) {
        $errores[] = 'El nombre del cliente no puede superar los 255 caracteres.';
    }

    $reparacion = trim((string) ($data['reparacion'] ?? ''));
    if (mb_strlen($reparacion) > 5000) {
        $errores[] = 'La reparación no puede superar los 5000 caracteres.';
    }

    if ($errores !== []) {
        responderActivos(['exito' => false, 'mensaje' => implode(' ', $errores)], 422);
    }

    return [
        'activo_id' => $activoId,
        'fecha_ruta' => $fechaNormalizada,
        'activo' => $activo,
        'modelo' => $modelo,
        'nro_orden' => $nroOrden,
        'numero_reporte' => $reporte,
        'nombre_cliente' => $cliente,
        'reparacion' => $reparacion,
    ];
}

/**
 * Normaliza la lista de materiales enviada por la interfaz.
 *
 * @return array<int, float> producto_id => cantidad
 */
function normalizarMateriales(mixed $materiales): array
{
    if ($materiales === null || $materiales === '') {
        return [];
    }

    if (!is_array($materiales)) {
        responderActivos(['exito' => false, 'mensaje' => 'La lista de materiales no es válida.'], 422);
    }

    $resultado = [];

    foreach ($materiales as $item) {
        if (!is_array($item)) {
            responderActivos(['exito' => false, 'mensaje' => 'Uno de los materiales no es válido.'], 422);
        }

        $productoId = filter_var($item['producto_id'] ?? null, FILTER_VALIDATE_INT);
        if ($productoId === false || $productoId === null || $productoId < 1) {
            responderActivos(['exito' => false, 'mensaje' => 'El producto de uno de los materiales no es válido.'], 422);
        }

        $cantidad = is_numeric($item['cantidad'] ?? null) ? (float) $item['cantidad'] : 0.0;
        if ($cantidad < 0.001 || $cantidad > 999999999.999) {
            responderActivos(['exito' => false, 'mensaje' => 'La cantidad de cada material debe ser mayor o igual a 0,001.'], 422);
        }

        $resultado[$productoId] = round(($resultado[$productoId] ?? 0.0) + $cantidad, 3);
    }

    return $resultado;
}

/**
 * Descuenta stock del producto y registra el movimiento de consumo.
 */
function consumirMaterial(PDO $pdo, int $productoId, float $cantidad, string $motivo): void
{
    $stmt = $pdo->prepare("SELECT sku_codigo, nombre_descripcion, stock_actual, stock_consumido FROM productos WHERE producto_id = ? FOR UPDATE");
    $stmt->execute([$productoId]);
    $producto = $stmt->fetch();

    if ($producto === false) {
        throw new RuntimeException('Uno de los materiales ya no existe en el almacén.');
    }

    $stockAnterior = (float) $producto['stock_actual'];
    if ($cantidad > $stockAnterior) {
        throw new RuntimeException(
            'Stock insuficiente de ' . $producto['sku_codigo'] . ' - ' . $producto['nombre_descripcion']
            . ': disponible ' . $stockAnterior . ', solicitado ' . $cantidad . '.'
        );
    }

    $stockNuevo = round($stockAnterior - $cantidad, 3);
    $consumidoNuevo = round((float) $producto['stock_consumido'] + $cantidad, 3);

    $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_consumido = ?, actualizado_en = NOW() WHERE producto_id = ?")
        ->execute([$stockNuevo, $consumidoNuevo, $productoId]);

    $pdo->prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, 'CONSUMO', ?, ?, ?, ?)")
        ->execute([$productoId, $cantidad, $stockAnterior, $stockNuevo, $motivo]);
}

/**
 * Devuelve stock del producto y registra el movimiento de devolución.
 */
function devolverMaterial(PDO $pdo, int $productoId, float $cantidad, string $motivo): void
{
    if ($cantidad <= 0) {
        return;
    }

    $stmt = $pdo->prepare("SELECT stock_actual, stock_consumido FROM productos WHERE producto_id = ? FOR UPDATE");
    $stmt->execute([$productoId]);
    $producto = $stmt->fetch();

    if ($producto === false) {
        return;
    }

    $stockAnterior = (float) $producto['stock_actual'];
    $stockNuevo = round($stockAnterior + $cantidad, 3);
    $consumidoNuevo = max(0.0, round((float) $producto['stock_consumido'] - $cantidad, 3));

    $pdo->prepare("UPDATE productos SET stock_actual = ?, stock_consumido = ?, actualizado_en = NOW() WHERE producto_id = ?")
        ->execute([$stockNuevo, $consumidoNuevo, $productoId]);

    $pdo->prepare("INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo) VALUES (?, 'DEVOLUCION', ?, ?, ?, ?)")
        ->execute([$productoId, $cantidad, $stockAnterior, $stockNuevo, $motivo]);
}

/**
 * Carga los materiales de un activo.
 *
 * @return array<int, array{cantidad: float, descontada: float}>
 */
function materialesActuales(PDO $pdo, int $activoId): array
{
    $stmt = $pdo->prepare("SELECT producto_id, cantidad, cantidad_descontada FROM activo_materiales WHERE activo_id = ? FOR UPDATE");
    $stmt->execute([$activoId]);

    $resultado = [];
    foreach ($stmt->fetchAll() as $fila) {
        $resultado[(int) $fila['producto_id']] = [
            'cantidad' => (float) $fila['cantidad'],
            'descontada' => (float) $fila['cantidad_descontada'],
        ];
    }

    return $resultado;
}

/**
 * Normaliza el tipo de activo: CALLE (equipos en ruta) o TALLER.
 */
function normalizarTipoActivo(mixed $valor, string $defecto = 'CALLE'): string
{
    $tipo = mb_strtoupper(trim((string) ($valor ?? '')));

    if ($tipo === '') {
        return $defecto;
    }

    if (!in_array($tipo, ['CALLE', 'TALLER'], true)) {
        responderActivos(['exito' => false, 'mensaje' => 'El tipo de activo debe ser CALLE o TALLER.'], 422);
    }

    return $tipo;
}

if (!in_array($accion, ['listar', 'crear', 'actualizar', 'eliminar'], true)) {
    responderActivos(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ['crear', 'actualizar', 'eliminar'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responderActivos(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'listar':
        $buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);
        $tipoFiltro = mb_strtoupper(trim((string) ($_GET['tipo'] ?? '')));

        if ($tipoFiltro !== '' && !in_array($tipoFiltro, ['CALLE', 'TALLER'], true)) {
            responderActivos(['exito' => false, 'mensaje' => 'El tipo de activo debe ser CALLE o TALLER.'], 422);
        }

        $sql = "SELECT a.activo_id, a.tipo, a.fecha_ruta, a.activo, a.modelo, a.nro_orden, a.numero_reporte, a.nombre_cliente, a.reparacion, a.creado_en,
                       m.id AS material_id, m.producto_id, m.cantidad, m.cantidad_descontada,
                       p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.stock_actual
                FROM activos a
                LEFT JOIN activo_materiales m ON m.activo_id = a.activo_id
                LEFT JOIN productos p ON p.producto_id = m.producto_id";

        $condiciones = [];
        $parametros = [];

        if ($tipoFiltro !== '') {
            $condiciones[] = 'a.tipo = :tipo';
            $parametros[':tipo'] = $tipoFiltro;
        }

        if ($buscar !== '') {
            $condiciones[] = "(POSITION(LOWER(:b_activo) IN LOWER(a.activo)) > 0
                        OR POSITION(LOWER(:b_cliente) IN LOWER(a.nombre_cliente)) > 0
                        OR POSITION(LOWER(:b_modelo) IN LOWER(a.modelo)) > 0
                        OR POSITION(LOWER(:b_orden) IN LOWER(a.nro_orden)) > 0
                        OR POSITION(LOWER(:b_reporte) IN LOWER(a.numero_reporte)) > 0
                        OR POSITION(LOWER(:b_reparacion) IN LOWER(a.reparacion)) > 0
                        OR EXISTS (
                            SELECT 1 FROM activo_materiales x
                            JOIN productos px ON px.producto_id = x.producto_id
                            WHERE x.activo_id = a.activo_id
                              AND (POSITION(LOWER(:b_codigo) IN LOWER(px.sku_codigo)) > 0
                                   OR POSITION(LOWER(:b_descripcion) IN LOWER(px.nombre_descripcion)) > 0)
                        ))";
            foreach (['b_activo', 'b_cliente', 'b_modelo', 'b_orden', 'b_reporte', 'b_reparacion', 'b_codigo', 'b_descripcion'] as $nombre) {
                $parametros[':' . $nombre] = $buscar;
            }
        }

        if ($condiciones !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $condiciones);
        }

        $sql .= ' ORDER BY a.fecha_ruta DESC, a.activo ASC, m.id ASC';

        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($parametros);

            $activos = [];
            foreach ($stmt->fetchAll() as $fila) {
                $id = (int) $fila['activo_id'];

                if (!isset($activos[$id])) {
                    $activos[$id] = [
                        'activo_id' => $id,
                        'tipo' => $fila['tipo'],
                        'fecha_ruta' => $fila['fecha_ruta'],
                        'activo' => $fila['activo'],
                        'modelo' => $fila['modelo'],
                        'nro_orden' => $fila['nro_orden'],
                        'numero_reporte' => $fila['numero_reporte'],
                        'nombre_cliente' => $fila['nombre_cliente'],
                        'reparacion' => $fila['reparacion'],
                        'creado_en' => $fila['creado_en'],
                        'materiales' => [],
                    ];
                }

                if ($fila['producto_id'] !== null) {
                    $activos[$id]['materiales'][] = [
                        'producto_id' => (int) $fila['producto_id'],
                        'sku_codigo' => $fila['sku_codigo'],
                        'nombre_descripcion' => $fila['nombre_descripcion'],
                        'unidad_medida' => $fila['unidad_medida'],
                        'stock_actual' => (float) $fila['stock_actual'],
                        'cantidad' => (float) $fila['cantidad'],
                        'cantidad_descontada' => (float) $fila['cantidad_descontada'],
                    ];
                }
            }

            echo json_encode(array_values($activos), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar activos: ' . $e->getMessage());
            responderActivos(['exito' => false, 'mensaje' => 'No se pudieron obtener los activos.'], 500);
        }
        break;

    case 'crear':
        $activo = validarActivo($data);
        $tipoActivo = normalizarTipoActivo($data['tipo'] ?? null);
        $materiales = normalizarMateriales($data['materiales'] ?? []);

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("INSERT INTO activos (tipo, fecha_ruta, activo, modelo, nro_orden, numero_reporte, nombre_cliente, reparacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $tipoActivo,
                $activo['fecha_ruta'],
                $activo['activo'],
                $activo['modelo'],
                $activo['nro_orden'],
                $activo['numero_reporte'],
                $activo['nombre_cliente'],
                $activo['reparacion'] === '' ? null : $activo['reparacion'],
            ]);

            $activoId = Database::ultimoId($pdo, 'activos', 'activo_id');
            $motivo = 'Activo ' . $activo['activo'] . ($activo['numero_reporte'] !== '' ? ' · Reporte ' . $activo['numero_reporte'] : '');

            foreach ($materiales as $productoId => $cantidad) {
                consumirMaterial($pdo, $productoId, $cantidad, $motivo);
                $pdo->prepare("INSERT INTO activo_materiales (activo_id, producto_id, cantidad, cantidad_descontada) VALUES (?, ?, ?, ?)")
                    ->execute([$activoId, $productoId, $cantidad, $cantidad]);
            }

            $pdo->commit();

            Audit::registrar(
                $pdo,
                $tipoActivo === 'TALLER' ? 'CREAR_ACTIVO_TALLER' : 'CREAR_ACTIVO',
                'Registró el activo ' . $tipoActivo . ' ' . $activo['activo']
                    . ($activo['nombre_cliente'] !== '' ? ' · Cliente: ' . $activo['nombre_cliente'] : '')
                    . ' con ' . count($materiales) . ' material(es).'
            );

            responderActivos(['exito' => true, 'mensaje' => 'Activo registrado con éxito.', 'activo_id' => $activoId]);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            responderActivos(['exito' => false, 'mensaje' => $e->getMessage()], 422);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Error al crear activo: ' . $e->getMessage());

            if (Database::esConflicto($e)) {
                responderActivos(['exito' => false, 'mensaje' => 'Ya existe un activo con ese número de orden.'], 409);
            }

            responderActivos(['exito' => false, 'mensaje' => 'No se pudo registrar el activo.'], 500);
        }
        break;

    case 'actualizar':
        $activo = validarActivo($data, true);
        $materiales = normalizarMateriales($data['materiales'] ?? []);
        $tipoSolicitado = mb_strtoupper(trim((string) ($data['tipo'] ?? '')));

        if ($tipoSolicitado !== '' && !in_array($tipoSolicitado, ['CALLE', 'TALLER'], true)) {
            responderActivos(['exito' => false, 'mensaje' => 'El tipo de activo debe ser CALLE o TALLER.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT tipo FROM activos WHERE activo_id = ? FOR UPDATE");
            $stmt->execute([$activo['activo_id']]);
            $existente = $stmt->fetch();
            if ($existente === false) {
                $pdo->rollBack();
                responderActivos(['exito' => false, 'mensaje' => 'El activo que intentas actualizar no existe.'], 404);
            }

            $tipoActivo = $tipoSolicitado !== '' ? $tipoSolicitado : $existente['tipo'];

            $stmt = $pdo->prepare("UPDATE activos SET tipo = ?, fecha_ruta = ?, activo = ?, modelo = ?, nro_orden = ?, numero_reporte = ?, nombre_cliente = ?, reparacion = ?, actualizado_en = NOW() WHERE activo_id = ?");
            $stmt->execute([
                $tipoActivo,
                $activo['fecha_ruta'],
                $activo['activo'],
                $activo['modelo'],
                $activo['nro_orden'],
                $activo['numero_reporte'],
                $activo['nombre_cliente'],
                $activo['reparacion'] === '' ? null : $activo['reparacion'],
                $activo['activo_id'],
            ]);

            $actuales = materialesActuales($pdo, (int) $activo['activo_id']);
            $motivoConsumo = 'Activo ' . $activo['activo'] . ($activo['numero_reporte'] !== '' ? ' · Reporte ' . $activo['numero_reporte'] : '');
            $motivoDevolucion = 'Devolución activo ' . $activo['activo'];

            foreach ($actuales as $productoId => $fila) {
                if (isset($materiales[$productoId])) {
                    continue;
                }

                devolverMaterial($pdo, $productoId, $fila['descontada'], $motivoDevolucion);
                $pdo->prepare("DELETE FROM activo_materiales WHERE activo_id = ? AND producto_id = ?")
                    ->execute([$activo['activo_id'], $productoId]);
            }

            foreach ($materiales as $productoId => $cantidad) {
                if (!isset($actuales[$productoId])) {
                    consumirMaterial($pdo, $productoId, $cantidad, $motivoConsumo);
                    $pdo->prepare("INSERT INTO activo_materiales (activo_id, producto_id, cantidad, cantidad_descontada) VALUES (?, ?, ?, ?)")
                        ->execute([$activo['activo_id'], $productoId, $cantidad, $cantidad]);
                    continue;
                }

                $descontada = $actuales[$productoId]['descontada'];
                $diferencia = round($cantidad - $actuales[$productoId]['cantidad'], 3);

                if ($diferencia > 0) {
                    consumirMaterial($pdo, $productoId, $diferencia, $motivoConsumo);
                    $descontada = round($descontada + $diferencia, 3);
                } elseif ($diferencia < 0) {
                    $devolver = min(round(-$diferencia, 3), $descontada);
                    devolverMaterial($pdo, $productoId, $devolver, $motivoDevolucion);
                    $descontada = round($descontada - $devolver, 3);
                }

                $pdo->prepare("UPDATE activo_materiales SET cantidad = ?, cantidad_descontada = ? WHERE activo_id = ? AND producto_id = ?")
                    ->execute([$cantidad, $descontada, $activo['activo_id'], $productoId]);
            }

            $pdo->commit();

            Audit::registrar(
                $pdo,
                $tipoActivo === 'TALLER' ? 'ACTUALIZAR_ACTIVO_TALLER' : 'ACTUALIZAR_ACTIVO',
                'Actualizó el activo ' . $tipoActivo . ' ' . $activo['activo']
                    . ($activo['nombre_cliente'] !== '' ? ' · Cliente: ' . $activo['nombre_cliente'] : '')
                    . ' con ' . count($materiales) . ' material(es).'
            );

            responderActivos(['exito' => true, 'mensaje' => 'Activo actualizado con éxito.']);
        } catch (RuntimeException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            responderActivos(['exito' => false, 'mensaje' => $e->getMessage()], 422);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Error al actualizar activo: ' . $e->getMessage());

            if (Database::esConflicto($e)) {
                responderActivos(['exito' => false, 'mensaje' => 'Ya existe otro activo con ese número de orden.'], 409);
            }

            responderActivos(['exito' => false, 'mensaje' => 'No se pudo actualizar el activo.'], 500);
        }
        break;

    case 'eliminar':
        $activoId = filter_var($data['activo_id'] ?? null, FILTER_VALIDATE_INT);

        if ($activoId === false || $activoId === null || $activoId < 1) {
            responderActivos(['exito' => false, 'mensaje' => 'El ID del activo no es válido.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT activo, tipo FROM activos WHERE activo_id = ? FOR UPDATE");
            $stmt->execute([$activoId]);
            $filaActivo = $stmt->fetch();

            if ($filaActivo === false) {
                $pdo->rollBack();
                responderActivos(['exito' => false, 'mensaje' => 'El activo que intentas eliminar no existe.'], 404);
            }

            $nombreActivo = $filaActivo['activo'];
            $tipoActivo = $filaActivo['tipo'];

            $materiales = materialesActuales($pdo, $activoId);
            foreach ($materiales as $productoId => $fila) {
                devolverMaterial($pdo, $productoId, $fila['descontada'], 'Devolución activo ' . $nombreActivo);
            }

            $pdo->prepare("DELETE FROM activos WHERE activo_id = ?")->execute([$activoId]);
            $pdo->commit();

            Audit::registrar(
                $pdo,
                $tipoActivo === 'TALLER' ? 'ELIMINAR_ACTIVO_TALLER' : 'ELIMINAR_ACTIVO',
                'Eliminó el activo ' . $tipoActivo . ' ' . $nombreActivo . ' y devolvió ' . count($materiales) . ' material(es) al almacén.'
            );

            responderActivos(['exito' => true, 'mensaje' => 'Activo eliminado y materiales devueltos al almacén.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('Error al eliminar activo: ' . $e->getMessage());
            responderActivos(['exito' => false, 'mensaje' => 'No se pudo eliminar el activo.'], 500);
        }
        break;
}
