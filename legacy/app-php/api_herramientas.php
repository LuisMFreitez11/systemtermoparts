<?php
declare(strict_types=1);

require_once 'conexion.php';
require_once 'sesion.php';

$usuarioActual = requiereSesion();

header('Content-Type: application/json; charset=utf-8');

const ESTADOS_HERRAMIENTA = ['DISPONIBLE', 'ASIGNADA', 'EN REPARACION', 'BAJA'];
const ACCIONES_ESCRITURA = ['crear', 'actualizar', 'eliminar', 'registrar_movimiento'];

$accion = $_GET['accion'] ?? '';
$raw = file_get_contents('php://input');
$data = [];

if ($raw !== false && trim($raw) !== '') {
    $decoded = json_decode($raw, true);

    if (!is_array($decoded)) {
        responderHerramientas(['exito' => false, 'mensaje' => 'El cuerpo de la petición no es un JSON válido.'], 400);
    }

    $data = $decoded;
}

function responderHerramientas(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Valida y normaliza los datos de una herramienta.
 *
 * @return array<string, mixed>
 */
function validarHerramienta(array $data, bool $requiereId = false): array
{
    $errores = [];

    $herramientaId = null;
    if ($requiereId) {
        $herramientaId = filter_var($data['herramienta_id'] ?? null, FILTER_VALIDATE_INT);

        if ($herramientaId === false || $herramientaId === null || $herramientaId < 1) {
            $errores[] = 'El ID de la herramienta no es válido.';
        }
    }

    $codigo = trim((string) ($data['codigo'] ?? ''));
    if ($codigo === '') {
        $errores[] = 'El código de la herramienta es obligatorio.';
    } elseif (mb_strlen($codigo) > 50) {
        $errores[] = 'El código no puede superar los 50 caracteres.';
    }

    $nombre = trim((string) ($data['nombre'] ?? ''));
    if ($nombre === '') {
        $errores[] = 'El nombre de la herramienta es obligatorio.';
    } elseif (mb_strlen($nombre) > 255) {
        $errores[] = 'El nombre no puede superar los 255 caracteres.';
    }

    $marca = trim((string) ($data['marca'] ?? ''));
    if (mb_strlen($marca) > 100) {
        $errores[] = 'La marca no puede superar los 100 caracteres.';
    }

    $modelo = trim((string) ($data['modelo'] ?? ''));
    if (mb_strlen($modelo) > 100) {
        $errores[] = 'El modelo no puede superar los 100 caracteres.';
    }

    $unidad = mb_strtoupper(trim((string) ($data['unidad_medida'] ?? 'UNIDAD')));
    if ($unidad === '') {
        $unidad = 'UNIDAD';
    }
    if (mb_strlen($unidad) > 20) {
        $errores[] = 'La unidad de medida no puede superar los 20 caracteres.';
    }

    $cantidad = filter_var($data['cantidad'] ?? null, FILTER_VALIDATE_INT);
    if ($cantidad === false || $cantidad === null || $cantidad < 0 || $cantidad > 999999) {
        $errores[] = 'La cantidad debe ser un número entero entre cero y 999.999.';
    }

    $estado = strtoupper(trim((string) ($data['estado'] ?? 'DISPONIBLE')));
    $estado = str_replace('_', ' ', $estado);
    if (!in_array($estado, ESTADOS_HERRAMIENTA, true)) {
        $errores[] = 'El estado no es válido.';
    }

    $ubicacion = trim((string) ($data['ubicacion'] ?? ''));
    if (mb_strlen($ubicacion) > 150) {
        $errores[] = 'La ubicación no puede superar los 150 caracteres.';
    }

    $responsable = trim((string) ($data['responsable'] ?? ''));
    if (mb_strlen($responsable) > 150) {
        $errores[] = 'El responsable no puede superar los 150 caracteres.';
    }

    $observaciones = trim((string) ($data['observaciones'] ?? ''));
    if (mb_strlen($observaciones) > 2000) {
        $errores[] = 'Las observaciones no pueden superar los 2000 caracteres.';
    }

    if ($errores !== []) {
        responderHerramientas(['exito' => false, 'mensaje' => implode(' ', $errores)], 422);
    }

    return [
        'herramienta_id' => $herramientaId,
        'codigo' => $codigo,
        'nombre' => $nombre,
        'marca' => $marca,
        'modelo' => $modelo,
        'unidad_medida' => $unidad,
        'cantidad' => $cantidad,
        'estado' => $estado,
        'ubicacion' => $ubicacion,
        'responsable' => $responsable,
        'observaciones' => $observaciones,
    ];
}

if (!in_array($accion, ['listar', 'movimientos', 'crear', 'actualizar', 'eliminar', 'registrar_movimiento'], true)) {
    responderHerramientas(['exito' => false, 'mensaje' => 'Acción no válida.'], 400);
}

if (in_array($accion, ACCIONES_ESCRITURA, true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    responderHerramientas(['exito' => false, 'mensaje' => 'Esta acción requiere el método POST.'], 405);
}

switch ($accion) {
    case 'listar':
        try {
            $stmt = $pdo->query("SELECT *, (cantidad - cantidad_prestada) AS cantidad_disponible FROM herramientas ORDER BY herramienta_id DESC");
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar herramientas: ' . $e->getMessage());
            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudieron obtener las herramientas.'], 500);
        }
        break;

    case 'movimientos':
        $herramientaId = filter_var($_GET['herramienta_id'] ?? null, FILTER_VALIDATE_INT);
        $buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);

        $sql = "SELECT hm.movimiento_id, hm.herramienta_id, hm.tipo, hm.cantidad, hm.fecha, hm.responsable,
                       hm.destino, hm.observaciones, hm.usuario_id, hm.creado_en,
                       h.codigo, h.nombre, h.unidad_medida,
                       u.nombre_completo AS usuario_nombre, u.usuario AS usuario
                FROM herramientas_movimientos hm
                JOIN herramientas h ON h.herramienta_id = hm.herramienta_id
                LEFT JOIN usuarios u ON u.usuario_id = hm.usuario_id";

        $condiciones = [];
        $parametros = [];

        if ($herramientaId !== false && $herramientaId !== null && $herramientaId > 0) {
            $condiciones[] = 'hm.herramienta_id = :herramienta_id';
            $parametros[':herramienta_id'] = $herramientaId;
        }

        if ($buscar !== '') {
            $condiciones[] = '(LOCATE(:b_codigo, h.codigo) > 0
                        OR LOCATE(:b_nombre, h.nombre) > 0
                        OR LOCATE(:b_responsable, hm.responsable) > 0
                        OR LOCATE(:b_destino, hm.destino) > 0
                        OR LOCATE(:b_observaciones, hm.observaciones) > 0)';
            foreach (['b_codigo', 'b_nombre', 'b_responsable', 'b_destino', 'b_observaciones'] as $nombre) {
                $parametros[':' . $nombre] = $buscar;
            }
        }

        if ($condiciones !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $condiciones);
        }

        $sql .= ' ORDER BY hm.fecha DESC, hm.movimiento_id DESC LIMIT 1000';

        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($parametros);
            echo json_encode($stmt->fetchAll(), JSON_UNESCAPED_UNICODE);
        } catch (PDOException $e) {
            error_log('Error al listar movimientos de herramientas: ' . $e->getMessage());
            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudo obtener el historial de movimientos.'], 500);
        }
        break;

    case 'crear':
        $herramienta = validarHerramienta($data);

        try {
            $stmt = $pdo->prepare("INSERT INTO herramientas (codigo, nombre, marca, modelo, unidad_medida, cantidad, estado, ubicacion, responsable, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $herramienta['codigo'],
                $herramienta['nombre'],
                $herramienta['marca'],
                $herramienta['modelo'],
                $herramienta['unidad_medida'],
                $herramienta['cantidad'],
                $herramienta['estado'],
                $herramienta['ubicacion'],
                $herramienta['responsable'],
                $herramienta['observaciones'] === '' ? null : $herramienta['observaciones'],
            ]);

            registrarHistorial(
                $pdo,
                'CREAR_HERRAMIENTA',
                'Registró la herramienta ' . $herramienta['codigo'] . ' - ' . $herramienta['nombre']
                    . ' (cantidad ' . $herramienta['cantidad'] . ').'
            );

            responderHerramientas(['exito' => true, 'mensaje' => 'Herramienta registrada con éxito.']);
        } catch (PDOException $e) {
            error_log('Error al crear herramienta: ' . $e->getMessage());

            if ($e->getCode() === '23000') {
                responderHerramientas(['exito' => false, 'mensaje' => 'Ya existe una herramienta con ese código.'], 409);
            }

            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudo registrar la herramienta.'], 500);
        }
        break;

    case 'actualizar':
        $herramienta = validarHerramienta($data, true);

        try {
            $stmt = $pdo->prepare("SELECT cantidad_prestada FROM herramientas WHERE herramienta_id = ?");
            $stmt->execute([$herramienta['herramienta_id']]);
            $prestadaActual = $stmt->fetchColumn();

            if ($prestadaActual === false) {
                responderHerramientas(['exito' => false, 'mensaje' => 'La herramienta que intentas actualizar no existe.'], 404);
            }

            if ($herramienta['cantidad'] < (int) $prestadaActual) {
                responderHerramientas([
                    'exito' => false,
                    'mensaje' => 'No puedes dejar la cantidad en ' . $herramienta['cantidad']
                        . ' porque hay ' . (int) $prestadaActual . ' unidad(es) prestada(s). Registra primero su entrada.',
                ], 422);
            }

            $stmt = $pdo->prepare("UPDATE herramientas SET codigo = ?, nombre = ?, marca = ?, modelo = ?, unidad_medida = ?, cantidad = ?, estado = ?, ubicacion = ?, responsable = ?, observaciones = ?, actualizado_en = NOW() WHERE herramienta_id = ?");
            $stmt->execute([
                $herramienta['codigo'],
                $herramienta['nombre'],
                $herramienta['marca'],
                $herramienta['modelo'],
                $herramienta['unidad_medida'],
                $herramienta['cantidad'],
                $herramienta['estado'],
                $herramienta['ubicacion'],
                $herramienta['responsable'],
                $herramienta['observaciones'] === '' ? null : $herramienta['observaciones'],
                $herramienta['herramienta_id'],
            ]);

            if ($stmt->rowCount() === 0 && !herramientaExiste($pdo, $herramienta['herramienta_id'])) {
                responderHerramientas(['exito' => false, 'mensaje' => 'La herramienta que intentas actualizar no existe.'], 404);
            }

            registrarHistorial(
                $pdo,
                'ACTUALIZAR_HERRAMIENTA',
                'Actualizó la herramienta ' . $herramienta['codigo'] . ' - ' . $herramienta['nombre'] . '.'
            );

            responderHerramientas(['exito' => true, 'mensaje' => 'Herramienta actualizada con éxito.']);
        } catch (PDOException $e) {
            error_log('Error al actualizar herramienta: ' . $e->getMessage());

            if ($e->getCode() === '23000') {
                responderHerramientas(['exito' => false, 'mensaje' => 'Ya existe otra herramienta con ese código.'], 409);
            }

            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudo actualizar la herramienta.'], 500);
        }
        break;

    case 'eliminar':
        $herramientaId = filter_var($data['herramienta_id'] ?? null, FILTER_VALIDATE_INT);

        if ($herramientaId === false || $herramientaId === null || $herramientaId < 1) {
            responderHerramientas(['exito' => false, 'mensaje' => 'El ID de la herramienta no es válido.'], 422);
        }

        try {
            $stmt = $pdo->prepare("SELECT codigo, nombre, cantidad_prestada FROM herramientas WHERE herramienta_id = ?");
            $stmt->execute([$herramientaId]);
            $herramientaEliminar = $stmt->fetch();

            if ($herramientaEliminar === false) {
                responderHerramientas(['exito' => false, 'mensaje' => 'La herramienta que intentas eliminar no existe.'], 404);
            }

            if ((int) $herramientaEliminar['cantidad_prestada'] > 0) {
                responderHerramientas([
                    'exito' => false,
                    'mensaje' => 'No puedes eliminar esta herramienta porque tiene '
                        . (int) $herramientaEliminar['cantidad_prestada'] . ' unidad(es) prestada(s). Registra primero su entrada.',
                ], 409);
            }

            $stmt = $pdo->prepare("DELETE FROM herramientas WHERE herramienta_id = ?");
            $stmt->execute([$herramientaId]);

            registrarHistorial(
                $pdo,
                'ELIMINAR_HERRAMIENTA',
                'Eliminó la herramienta ' . $herramientaEliminar['codigo'] . ' - ' . $herramientaEliminar['nombre'] . '.'
            );

            responderHerramientas(['exito' => true, 'mensaje' => 'Herramienta eliminada.']);
        } catch (PDOException $e) {
            error_log('Error al eliminar herramienta: ' . $e->getMessage());
            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudo eliminar la herramienta.'], 500);
        }
        break;

    case 'registrar_movimiento':
        $herramientaId = filter_var($data['herramienta_id'] ?? null, FILTER_VALIDATE_INT);
        if ($herramientaId === false || $herramientaId === null || $herramientaId < 1) {
            responderHerramientas(['exito' => false, 'mensaje' => 'El ID de la herramienta no es válido.'], 422);
        }

        $tipoMovimiento = mb_strtoupper(trim((string) ($data['tipo'] ?? '')));
        if (!in_array($tipoMovimiento, ['SALIDA', 'ENTRADA'], true)) {
            responderHerramientas(['exito' => false, 'mensaje' => 'El tipo de movimiento debe ser SALIDA o ENTRADA.'], 422);
        }

        $cantidadMovimiento = filter_var($data['cantidad'] ?? null, FILTER_VALIDATE_INT);
        if ($cantidadMovimiento === false || $cantidadMovimiento === null || $cantidadMovimiento < 1 || $cantidadMovimiento > 999999) {
            responderHerramientas(['exito' => false, 'mensaje' => 'La cantidad debe ser un número entero mayor que cero.'], 422);
        }

        $fechaMovimiento = trim((string) ($data['fecha'] ?? ''));
        if ($fechaMovimiento === '') {
            $fechaMovimiento = date('Y-m-d');
        }

        $objetoFecha = DateTimeImmutable::createFromFormat('Y-m-d', $fechaMovimiento);
        if ($objetoFecha === false || $objetoFecha->format('Y-m-d') !== $fechaMovimiento) {
            responderHerramientas(['exito' => false, 'mensaje' => 'La fecha del movimiento no es válida (formato AAAA-MM-DD).'], 422);
        }

        $responsableMovimiento = trim((string) ($data['responsable'] ?? ''));
        if (mb_strlen($responsableMovimiento) > 150) {
            responderHerramientas(['exito' => false, 'mensaje' => 'El responsable no puede superar los 150 caracteres.'], 422);
        }

        $destinoMovimiento = trim((string) ($data['destino'] ?? ''));
        if (mb_strlen($destinoMovimiento) > 150) {
            responderHerramientas(['exito' => false, 'mensaje' => 'El destino no puede superar los 150 caracteres.'], 422);
        }

        $observacionesMovimiento = trim((string) ($data['observaciones'] ?? ''));
        if (mb_strlen($observacionesMovimiento) > 2000) {
            responderHerramientas(['exito' => false, 'mensaje' => 'Las observaciones no pueden superar los 2000 caracteres.'], 422);
        }

        try {
            $pdo->beginTransaction();

            $stmt = $pdo->prepare("SELECT herramienta_id, codigo, nombre, cantidad, cantidad_prestada FROM herramientas WHERE herramienta_id = ? FOR UPDATE");
            $stmt->execute([$herramientaId]);
            $herramienta = $stmt->fetch();

            if ($herramienta === false) {
                $pdo->rollBack();
                responderHerramientas(['exito' => false, 'mensaje' => 'La herramienta seleccionada ya no existe.'], 404);
            }

            $cantidadTotal = (int) $herramienta['cantidad'];
            $prestadaActual = (int) $herramienta['cantidad_prestada'];
            $disponible = $cantidadTotal - $prestadaActual;

            if ($tipoMovimiento === 'SALIDA') {
                if ($cantidadMovimiento > $disponible) {
                    $pdo->rollBack();
                    responderHerramientas([
                        'exito' => false,
                        'mensaje' => 'No hay suficientes unidades disponibles de ' . $herramienta['codigo']
                            . ': disponible ' . $disponible . ', solicitado ' . $cantidadMovimiento . '.',
                    ], 422);
                }

                $prestadaNueva = $prestadaActual + $cantidadMovimiento;
            } else {
                if ($cantidadMovimiento > $prestadaActual) {
                    $pdo->rollBack();
                    responderHerramientas([
                        'exito' => false,
                        'mensaje' => 'No puedes registrar la entrada de ' . $cantidadMovimiento
                            . ' unidad(es): solo hay ' . $prestadaActual . ' prestada(s) de ' . $herramienta['codigo'] . '.',
                    ], 422);
                }

                $prestadaNueva = $prestadaActual - $cantidadMovimiento;
            }

            $pdo->prepare("UPDATE herramientas SET cantidad_prestada = ?, actualizado_en = NOW() WHERE herramienta_id = ?")
                ->execute([$prestadaNueva, $herramientaId]);

            $pdo->prepare("INSERT INTO herramientas_movimientos (herramienta_id, tipo, cantidad, fecha, responsable, destino, observaciones, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([
                    $herramientaId,
                    $tipoMovimiento,
                    $cantidadMovimiento,
                    $fechaMovimiento,
                    $responsableMovimiento,
                    $destinoMovimiento,
                    $observacionesMovimiento === '' ? null : $observacionesMovimiento,
                    (int) $usuarioActual['usuario_id'],
                ]);

            $movimientoId = (int) $pdo->lastInsertId();
            $pdo->commit();

            registrarHistorial(
                $pdo,
                $tipoMovimiento === 'SALIDA' ? 'SALIDA_HERRAMIENTA' : 'ENTRADA_HERRAMIENTA',
                ($tipoMovimiento === 'SALIDA' ? 'Prestó ' : 'Recibió ') . $cantidadMovimiento . ' de '
                    . $herramienta['codigo'] . ' - ' . $herramienta['nombre']
                    . ($responsableMovimiento !== '' ? ' · Responsable: ' . $responsableMovimiento : '')
                    . ($destinoMovimiento !== '' ? ' · Destino: ' . $destinoMovimiento : '')
                    . ' (prestadas: ' . $prestadaActual . ' → ' . $prestadaNueva . ').'
            );

            responderHerramientas([
                'exito' => true,
                'mensaje' => $tipoMovimiento === 'SALIDA'
                    ? 'Salida registrada: ' . $cantidadMovimiento . ' unidad(es) prestada(s).'
                    : 'Entrada registrada: ' . $cantidadMovimiento . ' unidad(es) devuelta(s).',
                'movimiento_id' => $movimientoId,
                'cantidad_prestada' => $prestadaNueva,
                'cantidad_disponible' => $cantidadTotal - $prestadaNueva,
            ]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            error_log('Error al registrar movimiento de herramienta: ' . $e->getMessage());
            responderHerramientas(['exito' => false, 'mensaje' => 'No se pudo registrar el movimiento de la herramienta.'], 500);
        }
        break;
}

function herramientaExiste(PDO $pdo, int $herramientaId): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM herramientas WHERE herramienta_id = ?");
    $stmt->execute([$herramientaId]);

    return $stmt->fetchColumn() !== false;
}
