/**
 * Endpoint `/api_entradas.php`: entradas de material al almacén.
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

function validarEntrada(data) {
    const errores = [];

    const productoId = entero(data.producto_id);

    if (productoId === null || productoId < 1) {
        errores.push('Debes seleccionar un material del almacén.');
    }

    const cantidad = numero(data.cantidad);

    if (cantidad === null || cantidad < 0.001 || cantidad > MAXIMO) {
        errores.push('La cantidad debe ser un número mayor o igual a 0,001.');
    }

    const fecha = texto(data.fecha_entrada) === '' ? hoy() : texto(data.fecha_entrada);

    if (!esFecha(fecha)) {
        errores.push('La fecha de entrada no es válida (formato AAAA-MM-DD).');
    }

    const referencia = texto(data.referencia);

    if (Array.from(referencia).length > 100) {
        errores.push('La referencia no puede superar los 100 caracteres.');
    }

    const proveedor = texto(data.proveedor);

    if (Array.from(proveedor).length > 150) {
        errores.push('El proveedor no puede superar los 150 caracteres.');
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
        fecha_entrada: fecha,
        referencia,
        proveedor,
        observaciones,
    };
}

router.all('/', requireSession, idempotencia('api_entradas.php'), async (req, res) => {
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

            let sql = `SELECT e.entrada_id, e.producto_id, e.cantidad, e.fecha_entrada, e.referencia, e.proveedor,
                              e.observaciones, e.stock_anterior, e.stock_nuevo, e.creado_en,
                              p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.lote_condicion, p.stock_actual
                       FROM entradas_almacen e
                       JOIN productos p ON p.producto_id = e.producto_id`;
            const parametros = [];

            if (buscar !== '') {
                parametros.push(buscar);
                const p = `$${parametros.length}`;

                sql += ` WHERE (POSITION(LOWER(${p}) IN LOWER(p.sku_codigo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(p.nombre_descripcion)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(e.referencia)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(e.proveedor)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(e.observaciones)) > 0)`;
            }

            sql += ' ORDER BY e.fecha_entrada DESC, e.entrada_id DESC';

            const { rows } = await query(sql, parametros);
            json(res, 200, rows);
            return;
        }

        case 'crear': {
            const entrada = validarEntrada(data);

            const resultado = await withTransaction(async cliente => {
                const { rows } = await cliente.query(
                    `SELECT sku_codigo, nombre_descripcion, stock_actual, stock_incrementado
                     FROM productos WHERE producto_id = $1 FOR UPDATE`,
                    [entrada.producto_id]
                );

                if (rows.length === 0) {
                    lanzar(404, 'El material seleccionado ya no existe en el almacén.');
                }

                const producto = rows[0];
                const stockAnterior = Number(producto.stock_actual);
                const stockNuevo = redondear(stockAnterior + entrada.cantidad, 3);
                const incrementadoNuevo = redondear(Number(producto.stock_incrementado) + entrada.cantidad, 3);

                await cliente.query(
                    `UPDATE productos SET stock_actual = $1, stock_incrementado = $2, actualizado_en = NOW()
                     WHERE producto_id = $3`,
                    [stockNuevo, incrementadoNuevo, entrada.producto_id]
                );

                let detalle = 'Entrada de almacén';

                if (entrada.referencia !== '') {
                    detalle += ` · Ref. ${entrada.referencia}`;
                }

                if (entrada.proveedor !== '') {
                    detalle += ` · ${entrada.proveedor}`;
                }

                const movimiento = await cliente.query(
                    `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo)
                     VALUES ($1, 'ENTRADA', $2, $3, $4, $5)
                     RETURNING movimiento_id`,
                    [entrada.producto_id, entrada.cantidad, stockAnterior, stockNuevo, mbsub(detalle, 255)]
                );

                const insertada = await cliente.query(
                    `INSERT INTO entradas_almacen
                     (producto_id, cantidad, fecha_entrada, referencia, proveedor, observaciones, stock_anterior, stock_nuevo, movimiento_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING entrada_id`,
                    [
                        entrada.producto_id, entrada.cantidad, entrada.fecha_entrada, entrada.referencia,
                        entrada.proveedor, entrada.observaciones === '' ? null : entrada.observaciones,
                        stockAnterior, stockNuevo, movimiento.rows[0].movimiento_id,
                    ]
                );

                return {
                    producto,
                    entradaId: Number(insertada.rows[0].entrada_id),
                    stockAnterior,
                    stockNuevo,
                };
            });

            await registrar(db, {
                accion: 'ENTRADA_ALMACEN',
                detalle: `Registró entrada de ${entrada.cantidad} de ${resultado.producto.sku_codigo} - `
                    + `${resultado.producto.nombre_descripcion} (stock ${resultado.stockAnterior} → ${resultado.stockNuevo}).`
                    + (entrada.referencia !== '' ? ` Ref. ${entrada.referencia}` : '')
                    + (entrada.proveedor !== '' ? ` · ${entrada.proveedor}` : ''),
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: `Entrada registrada: el stock pasó de ${resultado.stockAnterior} a ${resultado.stockNuevo}.`,
                entrada_id: resultado.entradaId,
                stock_anterior: resultado.stockAnterior,
                stock_nuevo: resultado.stockNuevo,
            });
            return;
        }

        case 'eliminar': {
            const entradaId = entero(data.entrada_id);

            if (entradaId === null || entradaId < 1) {
                error(res, 422, 'El ID de la entrada no es válido.');
                return;
            }

            const resultado = await withTransaction(async cliente => {
                const entrada = await cliente.query(
                    `SELECT entrada_id, producto_id, cantidad, movimiento_id
                     FROM entradas_almacen WHERE entrada_id = $1 FOR UPDATE`,
                    [entradaId]
                );

                if (entrada.rowCount === 0) {
                    lanzar(404, 'La entrada que intentas anular no existe.');
                }

                const fila = entrada.rows[0];

                const producto = await cliente.query(
                    `SELECT sku_codigo, nombre_descripcion, stock_actual, stock_incrementado
                     FROM productos WHERE producto_id = $1 FOR UPDATE`,
                    [Number(fila.producto_id)]
                );

                if (producto.rowCount === 0) {
                    lanzar(404, 'El material de esta entrada ya no existe en el almacén.');
                }

                const datos = producto.rows[0];
                const cantidad = Number(fila.cantidad);
                const stockAnterior = Number(datos.stock_actual);

                if (cantidad > stockAnterior) {
                    lanzar(
                        422,
                        `No se puede anular la entrada: el stock actual de ${datos.sku_codigo} `
                        + `es ${stockAnterior} y la entrada fue de ${cantidad}. Ajusta el inventario primero.`
                    );
                }

                const stockNuevo = redondear(stockAnterior - cantidad, 3);
                const incrementadoNuevo = Math.max(0, redondear(Number(datos.stock_incrementado) - cantidad, 3));

                await cliente.query(
                    `UPDATE productos SET stock_actual = $1, stock_incrementado = $2, actualizado_en = NOW()
                     WHERE producto_id = $3`,
                    [stockNuevo, incrementadoNuevo, Number(fila.producto_id)]
                );

                if (fila.movimiento_id !== null) {
                    await cliente.query('DELETE FROM movimientos_inventario WHERE movimiento_id = $1', [Number(fila.movimiento_id)]);
                }

                await cliente.query('DELETE FROM entradas_almacen WHERE entrada_id = $1', [entradaId]);

                return { datos, cantidad, stockAnterior, stockNuevo };
            });

            await registrar(db, {
                accion: 'ANULAR_ENTRADA',
                detalle: `Anuló la entrada de ${resultado.cantidad} de ${resultado.datos.sku_codigo} - `
                    + `${resultado.datos.nombre_descripcion} (stock ${resultado.stockAnterior} → ${resultado.stockNuevo}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: `Entrada anulada. El stock pasó de ${resultado.stockAnterior} a ${resultado.stockNuevo}.`,
                stock_nuevo: resultado.stockNuevo,
            });
            return;
        }

        default:
            error(res, 400, 'Acción no válida.');
    }
});

export default router;

export { validarEntrada };
