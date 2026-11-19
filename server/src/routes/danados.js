/**
 * Endpoint `/api_danados.php`: materiales dañados.
 */
import express from 'express';
import { db, query, withTransaction } from '../db.js';
import {
    json, error, lanzar, parametro, cuerpo, numero, entero, texto,
    mbsub, redondear, esFecha, hoy,
} from '../http.js';
import { requireSession } from '../auth.js';
import { idempotencia } from '../idempotency.js';
import { registrar, ipCliente } from '../audit.js';

const router = express.Router();
const ACCIONES = new Set(['listar', 'crear', 'eliminar']);
const ESCRITURA = new Set(['crear', 'eliminar']);
const MAXIMO = 999999999.999;

function validarDanado(data) {
    const errores = [];

    const productoId = entero(data.producto_id);

    if (productoId === null || productoId < 1) {
        errores.push('Debes seleccionar un material del almacén.');
    }

    const cantidad = numero(data.cantidad);

    if (cantidad === null || cantidad < 0.001 || cantidad > MAXIMO) {
        errores.push('La cantidad debe ser un número mayor o igual a 0,001.');
    }

    const fecha = texto(data.fecha_dano) === '' ? hoy() : texto(data.fecha_dano);

    if (!esFecha(fecha)) {
        errores.push('La fecha del daño no es válida (formato AAAA-MM-DD).');
    }

    const motivo = texto(data.motivo);

    if (motivo === '') {
        errores.push('Indica el motivo o tipo de daño.');
    } else if (Array.from(motivo).length > 150) {
        errores.push('El motivo no puede superar los 150 caracteres.');
    }

    const observaciones = texto(data.observaciones);

    if (Array.from(observaciones).length > 5000) {
        errores.push('Las observaciones no pueden superar los 5000 caracteres.');
    }

    if (errores.length > 0) {
        lanzar(422, errores.join(' '));
    }

    return {
        producto_id: productoId,
        cantidad: redondear(cantidad, 3),
        fecha_dano: fecha,
        motivo,
        observaciones,
    };
}

router.all('/', requireSession, idempotencia('api_danados.php'), async (req, res) => {
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
            const buscar = mbsub(texto(req.query.buscar), 100);

            let sql = `SELECT d.danado_id, d.producto_id, d.cantidad, d.fecha_dano, d.motivo, d.observaciones,
                              d.stock_anterior, d.stock_nuevo, d.creado_en,
                              p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.lote_condicion,
                              p.stock_actual, p.stock_danado
                       FROM materiales_danados d
                       JOIN productos p ON p.producto_id = d.producto_id`;
            const parametros = [];

            if (buscar !== '') {
                parametros.push(buscar);
                const p = `$${parametros.length}`;

                sql += ` WHERE (POSITION(LOWER(${p}) IN LOWER(p.sku_codigo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(p.nombre_descripcion)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(p.lote_condicion)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(d.motivo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(d.observaciones)) > 0)`;
            }

            sql += ' ORDER BY d.fecha_dano DESC, d.danado_id DESC';

            const { rows } = await query(sql, parametros);
            json(res, 200, rows);
            return;
        }

        case 'crear': {
            const danado = validarDanado(data);

            const resultado = await withTransaction(async cliente => {
                const { rows } = await cliente.query(
                    `SELECT sku_codigo, nombre_descripcion, stock_actual, stock_danado
                     FROM productos WHERE producto_id = $1 FOR UPDATE`,
                    [danado.producto_id]
                );

                if (rows.length === 0) {
                    lanzar(404, 'El material seleccionado ya no existe en el almacén.');
                }

                const producto = rows[0];
                const stockAnterior = Number(producto.stock_actual);

                if (danado.cantidad > stockAnterior) {
                    lanzar(
                        422,
                        `Stock insuficiente de ${producto.sku_codigo} - ${producto.nombre_descripcion}: `
                        + `disponible ${stockAnterior}, solicitado ${danado.cantidad}.`
                    );
                }

                const stockNuevo = redondear(stockAnterior - danado.cantidad, 3);
                const danadoNuevo = redondear(Number(producto.stock_danado) + danado.cantidad, 3);

                await cliente.query(
                    `UPDATE productos SET stock_actual = $1, stock_danado = $2, actualizado_en = NOW()
                     WHERE producto_id = $3`,
                    [stockNuevo, danadoNuevo, danado.producto_id]
                );

                const movimiento = await cliente.query(
                    `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo)
                     VALUES ($1, 'DANADO', $2, $3, $4, $5)
                     RETURNING movimiento_id`,
                    [danado.producto_id, danado.cantidad, stockAnterior, stockNuevo, mbsub(`Material dañado · ${danado.motivo}`, 255)]
                );

                const insertado = await cliente.query(
                    `INSERT INTO materiales_danados
                     (producto_id, cantidad, fecha_dano, motivo, observaciones, stock_anterior, stock_nuevo, movimiento_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING danado_id`,
                    [
                        danado.producto_id, danado.cantidad, danado.fecha_dano, danado.motivo,
                        danado.observaciones === '' ? null : danado.observaciones,
                        stockAnterior, stockNuevo, movimiento.rows[0].movimiento_id,
                    ]
                );

                return {
                    producto,
                    danadoId: Number(insertado.rows[0].danado_id),
                    stockAnterior,
                    stockNuevo,
                };
            });

            await registrar(db, {
                accion: 'DANADO',
                detalle: `Registró ${danado.cantidad} como dañado de ${resultado.producto.sku_codigo} - `
                    + `${resultado.producto.nombre_descripcion} (${danado.motivo}, stock `
                    + `${resultado.stockAnterior} → ${resultado.stockNuevo}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: `Material dañado registrado: el stock pasó de ${resultado.stockAnterior} a ${resultado.stockNuevo}.`,
                danado_id: resultado.danadoId,
                stock_anterior: resultado.stockAnterior,
                stock_nuevo: resultado.stockNuevo,
            });
            return;
        }

        case 'eliminar': {
            const danadoId = entero(data.danado_id);

            if (danadoId === null || danadoId < 1) {
                error(res, 422, 'El ID del registro no es válido.');
                return;
            }

            const resultado = await withTransaction(async cliente => {
                const danado = await cliente.query(
                    'SELECT danado_id, producto_id, cantidad, movimiento_id FROM materiales_danados WHERE danado_id = $1 FOR UPDATE',
                    [danadoId]
                );

                if (danado.rowCount === 0) {
                    lanzar(404, 'El registro de material dañado no existe.');
                }

                const fila = danado.rows[0];

                const producto = await cliente.query(
                    `SELECT sku_codigo, nombre_descripcion, stock_actual, stock_danado
                     FROM productos WHERE producto_id = $1 FOR UPDATE`,
                    [Number(fila.producto_id)]
                );

                if (producto.rowCount === 0) {
                    lanzar(404, 'El material de este registro ya no existe en el almacén.');
                }

                const datos = producto.rows[0];
                const cantidad = Number(fila.cantidad);
                const stockAnterior = Number(datos.stock_actual);
                const stockNuevo = redondear(stockAnterior + cantidad, 3);
                const danadoNuevo = Math.max(0, redondear(Number(datos.stock_danado) - cantidad, 3));

                await cliente.query(
                    `UPDATE productos SET stock_actual = $1, stock_danado = $2, actualizado_en = NOW()
                     WHERE producto_id = $3`,
                    [stockNuevo, danadoNuevo, Number(fila.producto_id)]
                );

                if (fila.movimiento_id !== null) {
                    await cliente.query('DELETE FROM movimientos_inventario WHERE movimiento_id = $1', [Number(fila.movimiento_id)]);
                }

                await cliente.query('DELETE FROM materiales_danados WHERE danado_id = $1', [danadoId]);

                return { datos, cantidad, stockAnterior, stockNuevo };
            });

            await registrar(db, {
                accion: 'ANULAR_DANADO',
                detalle: `Anuló el registro de ${resultado.cantidad} dañado(s) de ${resultado.datos.sku_codigo} - `
                    + `${resultado.datos.nombre_descripcion} (stock ${resultado.stockAnterior} → ${resultado.stockNuevo}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: `Registro anulado. El material volvió al stock disponible: ${resultado.stockAnterior} → ${resultado.stockNuevo}.`,
                stock_nuevo: resultado.stockNuevo,
            });
            return;
        }

        default:
            error(res, 400, 'Acción no válida.');
    }
});

export default router;

export { validarDanado };
