/**
 * Endpoint `/api_herramientas.php`: inventario de herramientas y préstamos.
 */
import express from 'express';
import { db, query, withTransaction, esConflicto } from '../db.js';
import {
    json, error, lanzar, parametro, cuerpo, entero, texto, mbsub, esFecha, hoy,
} from '../http.js';
import { requireSession } from '../auth.js';
import { idempotencia } from '../idempotency.js';
import { registrar, ipCliente } from '../audit.js';

const router = express.Router();
const ESTADOS = ['DISPONIBLE', 'ASIGNADA', 'EN REPARACION', 'BAJA'];
const ACCIONES = new Set(['listar', 'movimientos', 'crear', 'actualizar', 'eliminar', 'registrar_movimiento']);
const ESCRITURA = new Set(['crear', 'actualizar', 'eliminar', 'registrar_movimiento']);

function validarHerramienta(data, requiereId = false) {
    const errores = [];
    let herramientaId = null;

    if (requiereId) {
        herramientaId = entero(data.herramienta_id);

        if (herramientaId === null || herramientaId < 1) {
            errores.push('El ID de la herramienta no es válido.');
        }
    }

    const codigo = texto(data.codigo);

    if (codigo === '') {
        errores.push('El código de la herramienta es obligatorio.');
    } else if (Array.from(codigo).length > 50) {
        errores.push('El código no puede superar los 50 caracteres.');
    }

    const nombre = texto(data.nombre);

    if (nombre === '') {
        errores.push('El nombre de la herramienta es obligatorio.');
    } else if (Array.from(nombre).length > 255) {
        errores.push('El nombre no puede superar los 255 caracteres.');
    }

    const marca = texto(data.marca);

    if (Array.from(marca).length > 100) {
        errores.push('La marca no puede superar los 100 caracteres.');
    }

    const modelo = texto(data.modelo);

    if (Array.from(modelo).length > 100) {
        errores.push('El modelo no puede superar los 100 caracteres.');
    }

    let unidad = texto(data.unidad_medida, 'UNIDAD').toUpperCase();

    if (unidad === '') {
        unidad = 'UNIDAD';
    }

    if (Array.from(unidad).length > 20) {
        errores.push('La unidad de medida no puede superar los 20 caracteres.');
    }

    const cantidad = entero(data.cantidad);

    if (cantidad === null || cantidad < 0 || cantidad > 999999) {
        errores.push('La cantidad debe ser un número entero entre cero y 999.999.');
    }

    const estado = texto(data.estado, 'DISPONIBLE').toUpperCase().replace(/_/g, ' ');

    if (!ESTADOS.includes(estado)) {
        errores.push('El estado no es válido.');
    }

    const ubicacion = texto(data.ubicacion);

    if (Array.from(ubicacion).length > 150) {
        errores.push('La ubicación no puede superar los 150 caracteres.');
    }

    const responsable = texto(data.responsable);

    if (Array.from(responsable).length > 150) {
        errores.push('El responsable no puede superar los 150 caracteres.');
    }

    const observaciones = texto(data.observaciones);

    if (Array.from(observaciones).length > 2000) {
        errores.push('Las observaciones no pueden superar los 2000 caracteres.');
    }

    if (errores.length > 0) {
        lanzar(422, errores.join(' '));
    }

    return {
        herramienta_id: herramientaId,
        codigo,
        nombre,
        marca,
        modelo,
        unidad_medida: unidad,
        cantidad,
        estado,
        ubicacion,
        responsable,
        observaciones,
    };
}

async function herramientaExiste(db, herramientaId) {
    const { rowCount } = await db.query('SELECT 1 FROM herramientas WHERE herramienta_id = $1', [herramientaId]);

    return rowCount > 0;
}

router.all('/', requireSession, idempotencia('api_herramientas.php'), async (req, res) => {
    const accion = parametro(req, 'accion');

    if (!ACCIONES.has(accion)) {
        error(res, 400, 'Acción no válida.');
        return;
    }

    if (ESCRITURA.has(accion) && req.method !== 'POST') {
        error(res, 405, 'Esta acción requiere el método POST.');
        return;
    }

    const data = cuerpo(req);

    switch (accion) {
        case 'listar': {
            const { rows } = await query(
                `SELECT *, (cantidad - cantidad_prestada) AS cantidad_disponible
                 FROM herramientas ORDER BY herramienta_id DESC`
            );
            json(res, 200, rows);
            return;
        }

        case 'movimientos': {
            const herramientaId = entero(req.query.herramienta_id ?? null);
            const buscar = mbsub(texto(req.query.buscar), 100);

            let sql = `SELECT hm.movimiento_id, hm.herramienta_id, hm.tipo, hm.cantidad, hm.fecha, hm.responsable,
                              hm.destino, hm.observaciones, hm.usuario_id, hm.creado_en,
                              h.codigo, h.nombre, h.unidad_medida,
                              u.nombre_completo AS usuario_nombre, u.usuario AS usuario
                       FROM herramientas_movimientos hm
                       JOIN herramientas h ON h.herramienta_id = hm.herramienta_id
                       LEFT JOIN usuarios u ON u.usuario_id = hm.usuario_id`;
            const condiciones = [];
            const parametros = [];

            if (herramientaId !== null && herramientaId > 0) {
                parametros.push(herramientaId);
                condiciones.push(`hm.herramienta_id = $${parametros.length}`);
            }

            if (buscar !== '') {
                parametros.push(buscar);
                const p = `$${parametros.length}`;

                condiciones.push(`(POSITION(LOWER(${p}) IN LOWER(h.codigo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(h.nombre)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(hm.responsable)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(hm.destino)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(hm.observaciones)) > 0)`);
            }

            if (condiciones.length > 0) {
                sql += ` WHERE ${condiciones.join(' AND ')}`;
            }

            sql += ' ORDER BY hm.fecha DESC, hm.movimiento_id DESC LIMIT 1000';

            const { rows } = await query(sql, parametros);
            json(res, 200, rows);
            return;
        }

        case 'crear': {
            const herramienta = validarHerramienta(data);

            try {
                await query(
                    `INSERT INTO herramientas
                     (codigo, nombre, marca, modelo, unidad_medida, cantidad, estado, ubicacion, responsable, observaciones)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        herramienta.codigo, herramienta.nombre, herramienta.marca, herramienta.modelo,
                        herramienta.unidad_medida, herramienta.cantidad, herramienta.estado,
                        herramienta.ubicacion, herramienta.responsable,
                        herramienta.observaciones === '' ? null : herramienta.observaciones,
                    ]
                );
            } catch (fallo) {
                if (esConflicto(fallo)) {
                    error(res, 409, 'Ya existe una herramienta con ese código.');
                    return;
                }

                throw fallo;
            }

            await registrar(db, {
                accion: 'CREAR_HERRAMIENTA',
                detalle: `Registró la herramienta ${herramienta.codigo} - ${herramienta.nombre} (cantidad ${herramienta.cantidad}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Herramienta registrada con éxito.' });
            return;
        }

        case 'actualizar': {
            const herramienta = validarHerramienta(data, true);

            try {
                const prestada = await query(
                    'SELECT cantidad_prestada FROM herramientas WHERE herramienta_id = $1',
                    [herramienta.herramienta_id]
                );

                if (prestada.rowCount === 0) {
                    error(res, 404, 'La herramienta que intentas actualizar no existe.');
                    return;
                }

                const prestadaActual = Number(prestada.rows[0].cantidad_prestada);

                if (herramienta.cantidad < prestadaActual) {
                    error(
                        res,
                        422,
                        `No puedes dejar la cantidad en ${herramienta.cantidad} porque hay ${prestadaActual} `
                        + 'unidad(es) prestada(s). Registra primero su entrada.'
                    );
                    return;
                }

                const { rowCount } = await query(
                    `UPDATE herramientas
                     SET codigo = $1, nombre = $2, marca = $3, modelo = $4, unidad_medida = $5, cantidad = $6,
                         estado = $7, ubicacion = $8, responsable = $9, observaciones = $10, actualizado_en = NOW()
                     WHERE herramienta_id = $11`,
                    [
                        herramienta.codigo, herramienta.nombre, herramienta.marca, herramienta.modelo,
                        herramienta.unidad_medida, herramienta.cantidad, herramienta.estado,
                        herramienta.ubicacion, herramienta.responsable,
                        herramienta.observaciones === '' ? null : herramienta.observaciones,
                        herramienta.herramienta_id,
                    ]
                );

                if (rowCount === 0 && !(await herramientaExiste(db, herramienta.herramienta_id))) {
                    error(res, 404, 'La herramienta que intentas actualizar no existe.');
                    return;
                }
            } catch (fallo) {
                if (esConflicto(fallo)) {
                    error(res, 409, 'Ya existe otra herramienta con ese código.');
                    return;
                }

                throw fallo;
            }

            await registrar(db, {
                accion: 'ACTUALIZAR_HERRAMIENTA',
                detalle: `Actualizó la herramienta ${herramienta.codigo} - ${herramienta.nombre}.`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Herramienta actualizada con éxito.' });
            return;
        }

        case 'eliminar': {
            const herramientaId = entero(data.herramienta_id);

            if (herramientaId === null || herramientaId < 1) {
                error(res, 422, 'El ID de la herramienta no es válido.');
                return;
            }

            const { rows } = await query(
                'SELECT codigo, nombre, cantidad_prestada FROM herramientas WHERE herramienta_id = $1',
                [herramientaId]
            );

            if (rows.length === 0) {
                error(res, 404, 'La herramienta que intentas eliminar no existe.');
                return;
            }

            const herramienta = rows[0];

            if (Number(herramienta.cantidad_prestada) > 0) {
                error(
                    res,
                    409,
                    'No puedes eliminar esta herramienta porque tiene '
                    + `${Number(herramienta.cantidad_prestada)} unidad(es) prestada(s). Registra primero su entrada.`
                );
                return;
            }

            await query('DELETE FROM herramientas WHERE herramienta_id = $1', [herramientaId]);

            await registrar(db, {
                accion: 'ELIMINAR_HERRAMIENTA',
                detalle: `Eliminó la herramienta ${herramienta.codigo} - ${herramienta.nombre}.`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Herramienta eliminada.' });
            return;
        }

        case 'registrar_movimiento': {
            const herramientaId = entero(data.herramienta_id);

            if (herramientaId === null || herramientaId < 1) {
                error(res, 422, 'El ID de la herramienta no es válido.');
                return;
            }

            const tipo = texto(data.tipo).toUpperCase();

            if (!['SALIDA', 'ENTRADA'].includes(tipo)) {
                error(res, 422, 'El tipo de movimiento debe ser SALIDA o ENTRADA.');
                return;
            }

            const cantidad = entero(data.cantidad);

            if (cantidad === null || cantidad < 1 || cantidad > 999999) {
                error(res, 422, 'La cantidad debe ser un número entero mayor que cero.');
                return;
            }

            const fecha = texto(data.fecha) === '' ? hoy() : texto(data.fecha);

            if (!esFecha(fecha)) {
                error(res, 422, 'La fecha del movimiento no es válida (formato AAAA-MM-DD).');
                return;
            }

            const responsable = texto(data.responsable);

            if (Array.from(responsable).length > 150) {
                error(res, 422, 'El responsable no puede superar los 150 caracteres.');
                return;
            }

            const destino = texto(data.destino);

            if (Array.from(destino).length > 150) {
                error(res, 422, 'El destino no puede superar los 150 caracteres.');
                return;
            }

            const observaciones = texto(data.observaciones);

            if (Array.from(observaciones).length > 2000) {
                error(res, 422, 'Las observaciones no pueden superar los 2000 caracteres.');
                return;
            }

            const { herramienta, movimientoId, prestadaNueva, disponible } = await withTransaction(async cliente => {
                const { rows } = await cliente.query(
                    `SELECT herramienta_id, codigo, nombre, cantidad, cantidad_prestada
                     FROM herramientas WHERE herramienta_id = $1 FOR UPDATE`,
                    [herramientaId]
                );

                if (rows.length === 0) {
                    lanzar(404, 'La herramienta seleccionada ya no existe.');
                }

                const fila = rows[0];
                const total = Number(fila.cantidad);
                const prestadaActual = Number(fila.cantidad_prestada);
                const disponibleActual = total - prestadaActual;

                if (tipo === 'SALIDA' && cantidad > disponibleActual) {
                    lanzar(
                        422,
                        `No hay suficientes unidades disponibles de ${fila.codigo}: `
                        + `disponible ${disponibleActual}, solicitado ${cantidad}.`
                    );
                }

                if (tipo === 'ENTRADA' && cantidad > prestadaActual) {
                    lanzar(
                        422,
                        `No puedes registrar la entrada de ${cantidad} unidad(es): solo hay `
                        + `${prestadaActual} prestada(s) de ${fila.codigo}.`
                    );
                }

                const nueva = tipo === 'SALIDA' ? prestadaActual + cantidad : prestadaActual - cantidad;

                await cliente.query(
                    'UPDATE herramientas SET cantidad_prestada = $1, actualizado_en = NOW() WHERE herramienta_id = $2',
                    [nueva, herramientaId]
                );

                const insertada = await cliente.query(
                    `INSERT INTO herramientas_movimientos
                     (herramienta_id, tipo, cantidad, fecha, responsable, destino, observaciones, usuario_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING movimiento_id`,
                    [
                        herramientaId, tipo, cantidad, fecha, responsable, destino,
                        observaciones === '' ? null : observaciones,
                        Number(req.usuario.usuario_id),
                    ]
                );

                return {
                    herramienta: fila,
                    movimientoId: Number(insertada.rows[0].movimiento_id),
                    prestadaNueva: nueva,
                    disponible: total - nueva,
                };
            });

            await registrar(db, {
                accion: tipo === 'SALIDA' ? 'SALIDA_HERRAMIENTA' : 'ENTRADA_HERRAMIENTA',
                detalle: `${tipo === 'SALIDA' ? 'Prestó' : 'Recibió'} ${cantidad} de `
                    + `${herramienta.codigo} - ${herramienta.nombre}`
                    + (responsable !== '' ? ` · Responsable: ${responsable}` : '')
                    + (destino !== '' ? ` · Destino: ${destino}` : '')
                    + ` (prestadas: ${Number(herramienta.cantidad_prestada)} → ${prestadaNueva}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: tipo === 'SALIDA'
                    ? `Salida registrada: ${cantidad} unidad(es) prestada(s).`
                    : `Entrada registrada: ${cantidad} unidad(es) devuelta(s).`,
                movimiento_id: movimientoId,
                cantidad_prestada: prestadaNueva,
                cantidad_disponible: disponible,
            });
            return;
        }

        default:
            error(res, 400, 'Acción no válida.');
    }
});

export default router;

export { validarHerramienta };
