/**
 * Endpoint `/api_activos.php`: activos de calle y taller con sus materiales.
 *
 * Corrección del N+1: consumir o devolver 15 materiales usa un número FIJO de
 * consultas (una lectura bloqueante del lote + updates/inserts multi-fila),
 * en lugar de 4 consultas por material como hacía la versión PHP.
 */
import express from 'express';
import { db, query, withTransaction } from '../db.js';
import {
    json, error, lanzar, parametro, cuerpo, numero, entero, texto,
    mbsub, redondear, esFecha,
} from '../http.js';
import { requireSession } from '../auth.js';
import { idempotencia } from '../idempotency.js';
import { registrar, ipCliente } from '../audit.js';
import { valoresLote, arregloInt } from '../sql.js';

const router = express.Router();
const ACCIONES = new Set(['listar', 'crear', 'actualizar', 'eliminar']);
const ESCRITURA = new Set(['crear', 'actualizar', 'eliminar']);
const MAXIMO = 999999999.999;

function validarActivo(data, requiereId = false) {
    const errores = [];
    let activoId = null;

    if (requiereId) {
        activoId = entero(data.activo_id);

        if (activoId === null || activoId < 1) {
            errores.push('El ID del activo no es válido.');
        }
    }

    const fechaRuta = texto(data.fecha_ruta);

    if (fechaRuta !== '' && !esFecha(fechaRuta)) {
        errores.push('La fecha de ruta no es válida (formato AAAA-MM-DD).');
    }

    const activo = texto(data.activo);

    if (activo === '') {
        errores.push('El número de activo es obligatorio.');
    } else if (Array.from(activo).length > 50) {
        errores.push('El activo no puede superar los 50 caracteres.');
    }

    const modelo = texto(data.modelo);

    if (Array.from(modelo).length > 120) {
        errores.push('El modelo no puede superar los 120 caracteres.');
    }

    const nroOrden = texto(data.nro_orden);

    if (Array.from(nroOrden).length > 50) {
        errores.push('El número de orden no puede superar los 50 caracteres.');
    }

    const reporte = texto(data.numero_reporte);

    if (Array.from(reporte).length > 50) {
        errores.push('El número de reporte no puede superar los 50 caracteres.');
    }

    const cliente = texto(data.nombre_cliente);

    if (Array.from(cliente).length > 255) {
        errores.push('El nombre del cliente no puede superar los 255 caracteres.');
    }

    const reparacion = texto(data.reparacion);

    if (Array.from(reparacion).length > 5000) {
        errores.push('La reparación no puede superar los 5000 caracteres.');
    }

    if (errores.length > 0) {
        lanzar(422, errores.join(' '));
    }

    return {
        activo_id: activoId,
        fecha_ruta: fechaRuta === '' ? null : fechaRuta,
        activo,
        modelo,
        nro_orden: nroOrden,
        numero_reporte: reporte,
        nombre_cliente: cliente,
        reparacion,
    };
}

function normalizarMateriales(materiales) {
    if (materiales === null || materiales === undefined || materiales === '') {
        return new Map();
    }

    if (!Array.isArray(materiales)) {
        lanzar(422, 'La lista de materiales no es válida.');
    }

    const resultado = new Map();

    for (const item of materiales) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            lanzar(422, 'Uno de los materiales no es válido.');
        }

        const productoId = entero(item.producto_id);

        if (productoId === null || productoId < 1) {
            lanzar(422, 'El producto de uno de los materiales no es válido.');
        }

        const cantidad = numero(item.cantidad);

        if (cantidad === null || cantidad < 0.001 || cantidad > MAXIMO) {
            lanzar(422, 'La cantidad de cada material debe ser mayor o igual a 0,001.');
        }

        resultado.set(productoId, redondear((resultado.get(productoId) ?? 0) + cantidad, 3));
    }

    return resultado;
}

function normalizarTipoActivo(valor, defecto = 'CALLE') {
    const tipo = texto(valor).toUpperCase();

    if (tipo === '') {
        return defecto;
    }

    if (!['CALLE', 'TALLER'].includes(tipo)) {
        lanzar(422, 'El tipo de activo debe ser CALLE o TALLER.');
    }

    return tipo;
}

function motivoActivo(activo) {
    return `Activo ${activo.activo}`
        + (activo.numero_reporte !== '' ? ` · Reporte ${activo.numero_reporte}` : '');
}

/**
 * Bloquea y devuelve los productos involucrados en UNA sola consulta.
 * El orden por producto_id evita interbloqueos con otras transacciones.
 */
async function bloquearProductos(cliente, ids) {
    if (ids.length === 0) {
        return new Map();
    }

    const { rows } = await cliente.query(
        `SELECT producto_id, sku_codigo, nombre_descripcion, stock_actual, stock_consumido
         FROM productos
         WHERE producto_id = ANY($1::int[])
         ORDER BY producto_id
         FOR UPDATE`,
        [arregloInt(ids)]
    );

    return new Map(rows.map(fila => [Number(fila.producto_id), fila]));
}

/**
 * Aplica el estado final de cada producto y registra sus movimientos.
 * `movimientos`: [{ productoId, tipo, cantidad, stockAnterior, stockNuevo,
 *                   consumidoNuevo, motivo }]
 */
async function aplicarMovimientos(cliente, movimientos) {
    if (movimientos.length === 0) {
        return;
    }

    const actualizaciones = movimientos.map(movimiento => ({
        producto_id: movimiento.productoId,
        stock_actual: movimiento.stockNuevo,
        stock_consumido: movimiento.consumidoNuevo,
    }));
    const update = valoresLote(actualizaciones, ['producto_id', 'stock_actual', 'stock_consumido']);

    await cliente.query(
        `UPDATE productos p
         SET stock_actual = v.stock_actual::numeric, stock_consumido = v.stock_consumido::numeric, actualizado_en = NOW()
         FROM (VALUES ${update.sql}) AS v(producto_id, stock_actual, stock_consumido)
         WHERE p.producto_id = v.producto_id::int`,
        update.parametros
    );

    const filas = movimientos.map(movimiento => ({
        producto_id: movimiento.productoId,
        tipo: movimiento.tipo,
        cantidad: movimiento.cantidad,
        stock_anterior: movimiento.stockAnterior,
        stock_nuevo: movimiento.stockNuevo,
        motivo: movimiento.motivo,
    }));
    const insert = valoresLote(filas, ['producto_id', 'tipo', 'cantidad', 'stock_anterior', 'stock_nuevo', 'motivo']);

    await cliente.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo)
         VALUES ${insert.sql}`,
        insert.parametros
    );
}

router.all('/', requireSession, idempotencia('api_activos.php'), async (req, res) => {
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
            const tipoFiltro = texto(req.query.tipo).toUpperCase();

            if (tipoFiltro !== '' && !['CALLE', 'TALLER'].includes(tipoFiltro)) {
                error(res, 422, 'El tipo de activo debe ser CALLE o TALLER.');
                return;
            }

            let sql = `SELECT a.activo_id, a.tipo, a.fecha_ruta, a.activo, a.modelo, a.nro_orden,
                              a.numero_reporte, a.nombre_cliente, a.reparacion, a.creado_en,
                              m.id AS material_id, m.producto_id, m.cantidad, m.cantidad_descontada,
                              p.sku_codigo, p.nombre_descripcion, p.unidad_medida, p.stock_actual
                       FROM activos a
                       LEFT JOIN activo_materiales m ON m.activo_id = a.activo_id
                       LEFT JOIN productos p ON p.producto_id = m.producto_id`;
            const condiciones = [];
            const parametros = [];

            if (tipoFiltro !== '') {
                parametros.push(tipoFiltro);
                condiciones.push(`a.tipo = $${parametros.length}`);
            }

            if (buscar !== '') {
                parametros.push(buscar);
                const p = `$${parametros.length}`;

                condiciones.push(`(POSITION(LOWER(${p}) IN LOWER(a.activo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(a.nombre_cliente)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(a.modelo)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(a.nro_orden)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(a.numero_reporte)) > 0
                            OR POSITION(LOWER(${p}) IN LOWER(a.reparacion)) > 0
                            OR EXISTS (
                                SELECT 1 FROM activo_materiales x
                                JOIN productos px ON px.producto_id = x.producto_id
                                WHERE x.activo_id = a.activo_id
                                  AND (POSITION(LOWER(${p}) IN LOWER(px.sku_codigo)) > 0
                                       OR POSITION(LOWER(${p}) IN LOWER(px.nombre_descripcion)) > 0)
                            ))`);
            }

            if (condiciones.length > 0) {
                sql += ` WHERE ${condiciones.join(' AND ')}`;
            }

            sql += ' ORDER BY a.fecha_ruta DESC, a.activo ASC, m.id ASC';

            const { rows } = await query(sql, parametros);
            const activos = new Map();

            for (const fila of rows) {
                const id = Number(fila.activo_id);

                if (!activos.has(id)) {
                    activos.set(id, {
                        activo_id: id,
                        tipo: fila.tipo,
                        fecha_ruta: fila.fecha_ruta,
                        activo: fila.activo,
                        modelo: fila.modelo,
                        nro_orden: fila.nro_orden,
                        numero_reporte: fila.numero_reporte,
                        nombre_cliente: fila.nombre_cliente,
                        reparacion: fila.reparacion,
                        creado_en: fila.creado_en,
                        materiales: [],
                    });
                }

                if (fila.producto_id !== null) {
                    activos.get(id).materiales.push({
                        producto_id: Number(fila.producto_id),
                        sku_codigo: fila.sku_codigo,
                        nombre_descripcion: fila.nombre_descripcion,
                        unidad_medida: fila.unidad_medida,
                        stock_actual: Number(fila.stock_actual),
                        cantidad: Number(fila.cantidad),
                        cantidad_descontada: Number(fila.cantidad_descontada),
                    });
                }
            }

            json(res, 200, Array.from(activos.values()));
            return;
        }

        case 'crear': {
            const activo = validarActivo(data);
            const tipoActivo = normalizarTipoActivo(data.tipo);
            const materiales = normalizarMateriales(data.materiales);
            const motivo = motivoActivo(activo);

            const activoId = await withTransaction(async cliente => {
                const insertado = await cliente.query(
                    `INSERT INTO activos (tipo, fecha_ruta, activo, modelo, nro_orden, numero_reporte, nombre_cliente, reparacion)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING activo_id`,
                    [
                        tipoActivo, activo.fecha_ruta, activo.activo, activo.modelo, activo.nro_orden,
                        activo.numero_reporte, activo.nombre_cliente,
                        activo.reparacion === '' ? null : activo.reparacion,
                    ]
                );
                const id = Number(insertado.rows[0].activo_id);

                if (materiales.size === 0) {
                    return id;
                }

                const productos = await bloquearProductos(cliente, Array.from(materiales.keys()));

                if (productos.size !== materiales.size) {
                    lanzar(422, 'Uno de los materiales ya no existe en el almacén.');
                }

                const movimientos = [];

                for (const [productoId, cantidad] of materiales) {
                    const producto = productos.get(productoId);
                    const stockAnterior = Number(producto.stock_actual);

                    if (cantidad > stockAnterior) {
                        lanzar(422, `Stock insuficiente de ${producto.sku_codigo} - ${producto.nombre_descripcion}: `
                            + `disponible ${stockAnterior}, solicitado ${cantidad}.`);
                    }

                    movimientos.push({
                        productoId,
                        tipo: 'CONSUMO',
                        cantidad,
                        stockAnterior,
                        stockNuevo: redondear(stockAnterior - cantidad, 3),
                        consumidoNuevo: redondear(Number(producto.stock_consumido) + cantidad, 3),
                        motivo,
                    });
                }

                await aplicarMovimientos(cliente, movimientos);

                const relaciones = Array.from(materiales, ([productoId, cantidad]) => ({
                    activo_id: id,
                    producto_id: productoId,
                    cantidad,
                    cantidad_descontada: cantidad,
                }));
                const insert = valoresLote(relaciones, ['activo_id', 'producto_id', 'cantidad', 'cantidad_descontada']);

                await cliente.query(
                    `INSERT INTO activo_materiales (activo_id, producto_id, cantidad, cantidad_descontada)
                     VALUES ${insert.sql}`,
                    insert.parametros
                );

                return id;
            });

            await registrar(db, {
                accion: tipoActivo === 'TALLER' ? 'CREAR_ACTIVO_TALLER' : 'CREAR_ACTIVO',
                detalle: `Registró el activo ${tipoActivo} ${activo.activo}`
                    + (activo.nombre_cliente !== '' ? ` · Cliente: ${activo.nombre_cliente}` : '')
                    + ` con ${materiales.size} material(es).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Activo registrado con éxito.', activo_id: activoId });
            return;
        }

        case 'actualizar': {
            const activo = validarActivo(data, true);
            const materiales = normalizarMateriales(data.materiales);
            const tipoSolicitado = texto(data.tipo).toUpperCase();

            if (tipoSolicitado !== '' && !['CALLE', 'TALLER'].includes(tipoSolicitado)) {
                error(res, 422, 'El tipo de activo debe ser CALLE o TALLER.');
                return;
            }

            const motivoConsumo = motivoActivo(activo);
            const motivoDevolucion = `Devolución activo ${activo.activo}`;
            const activoId = activo.activo_id;

            const tipoFinal = await withTransaction(async cliente => {
                const existente = await cliente.query('SELECT tipo FROM activos WHERE activo_id = $1 FOR UPDATE', [activoId]);

                if (existente.rowCount === 0) {
                    lanzar(404, 'El activo que intentas actualizar no existe.');
                }

                const tipoActivo = tipoSolicitado !== '' ? tipoSolicitado : existente.rows[0].tipo;

                await cliente.query(
                    `UPDATE activos
                     SET tipo = $1, fecha_ruta = $2, activo = $3, modelo = $4, nro_orden = $5,
                         numero_reporte = $6, nombre_cliente = $7, reparacion = $8, actualizado_en = NOW()
                     WHERE activo_id = $9`,
                    [
                        tipoActivo, activo.fecha_ruta, activo.activo, activo.modelo, activo.nro_orden,
                        activo.numero_reporte, activo.nombre_cliente,
                        activo.reparacion === '' ? null : activo.reparacion, activoId,
                    ]
                );

                const relaciones = await cliente.query(
                    `SELECT producto_id, cantidad, cantidad_descontada
                     FROM activo_materiales WHERE activo_id = $1 ORDER BY producto_id FOR UPDATE`,
                    [activoId]
                );

                const actuales = new Map(relaciones.rows.map(fila => [Number(fila.producto_id), {
                    cantidad: Number(fila.cantidad),
                    descontada: Number(fila.cantidad_descontada),
                }]));

                const devoluciones = [];
                const consumos = [];
                const nuevasRelaciones = [];
                const relacionesActualizadas = [];
                const eliminadas = [];

                for (const [productoId, fila] of actuales) {
                    if (materiales.has(productoId)) {
                        continue;
                    }

                    eliminadas.push(productoId);

                    if (fila.descontada > 0) {
                        devoluciones.push({ productoId, cantidad: fila.descontada });
                    }
                }

                for (const [productoId, cantidad] of materiales) {
                    const actual = actuales.get(productoId);

                    if (!actual) {
                        consumos.push({ productoId, cantidad });
                        nuevasRelaciones.push({
                            activo_id: activoId,
                            producto_id: productoId,
                            cantidad,
                            cantidad_descontada: cantidad,
                        });
                        continue;
                    }

                    const diferencia = redondear(cantidad - actual.cantidad, 3);
                    let descontada = actual.descontada;

                    if (diferencia > 0) {
                        consumos.push({ productoId, cantidad: diferencia });
                        descontada = redondear(descontada + diferencia, 3);
                    } else if (diferencia < 0) {
                        const devolver = Math.min(redondear(-diferencia, 3), descontada);

                        if (devolver > 0) {
                            devoluciones.push({ productoId, cantidad: devolver });
                        }

                        descontada = redondear(descontada - devolver, 3);
                    }

                    relacionesActualizadas.push({
                        activo_id: activoId,
                        producto_id: productoId,
                        cantidad,
                        cantidad_descontada: descontada,
                    });
                }

                // Un producto solo puede consumirse o devolverse una vez por operación.
                const ids = Array.from(new Set([
                    ...consumos.map(item => item.productoId),
                    ...devoluciones.map(item => item.productoId),
                ]));
                const productos = await bloquearProductos(cliente, ids);
                const movimientos = [];

                for (const consumo of consumos) {
                    const producto = productos.get(consumo.productoId);

                    if (!producto) {
                        lanzar(422, 'Uno de los materiales ya no existe en el almacén.');
                    }

                    const stockAnterior = Number(producto.stock_actual);

                    if (consumo.cantidad > stockAnterior) {
                        lanzar(422, `Stock insuficiente de ${producto.sku_codigo} - ${producto.nombre_descripcion}: `
                            + `disponible ${stockAnterior}, solicitado ${consumo.cantidad}.`);
                    }

                    movimientos.push({
                        productoId: consumo.productoId,
                        tipo: 'CONSUMO',
                        cantidad: consumo.cantidad,
                        stockAnterior,
                        stockNuevo: redondear(stockAnterior - consumo.cantidad, 3),
                        consumidoNuevo: redondear(Number(producto.stock_consumido) + consumo.cantidad, 3),
                        motivo: motivoConsumo,
                    });
                }

                for (const devolucion of devoluciones) {
                    const producto = productos.get(devolucion.productoId);

                    // Igual que devolverMaterial(): si el producto ya no existe, se ignora.
                    if (!producto) {
                        continue;
                    }

                    const stockAnterior = Number(producto.stock_actual);

                    movimientos.push({
                        productoId: devolucion.productoId,
                        tipo: 'DEVOLUCION',
                        cantidad: devolucion.cantidad,
                        stockAnterior,
                        stockNuevo: redondear(stockAnterior + devolucion.cantidad, 3),
                        consumidoNuevo: Math.max(
                            0,
                            redondear(Number(producto.stock_consumido) - devolucion.cantidad, 3)
                        ),
                        motivo: motivoDevolucion,
                    });
                }

                if (movimientos.length > 0) {
                    // El UPDATE de stock va consolidado por producto (una fila por
                    // producto); los movimientos se insertan todos juntos.
                    const estadoFinal = new Map();

                    for (const movimiento of movimientos) {
                        const estado = estadoFinal.get(movimiento.productoId) ?? {
                            producto_id: movimiento.productoId,
                            stock_actual: movimiento.stockAnterior,
                            stock_consumido: null,
                        };

                        estado.stock_actual = movimiento.stockNuevo;
                        estado.stock_consumido = movimiento.consumidoNuevo;
                        estadoFinal.set(movimiento.productoId, estado);
                    }

                    const update = valoresLote(
                        Array.from(estadoFinal.values()),
                        ['producto_id', 'stock_actual', 'stock_consumido']
                    );

                    await cliente.query(
                        `UPDATE productos p
                         SET stock_actual = v.stock_actual::numeric, stock_consumido = v.stock_consumido::numeric, actualizado_en = NOW()
                         FROM (VALUES ${update.sql}) AS v(producto_id, stock_actual, stock_consumido)
                         WHERE p.producto_id = v.producto_id::int`,
                        update.parametros
                    );

                    const filas = movimientos.map(movimiento => ({
                        producto_id: movimiento.productoId,
                        tipo: movimiento.tipo,
                        cantidad: movimiento.cantidad,
                        stock_anterior: movimiento.stockAnterior,
                        stock_nuevo: movimiento.stockNuevo,
                        motivo: movimiento.motivo,
                    }));
                    const insert = valoresLote(
                        filas,
                        ['producto_id', 'tipo', 'cantidad', 'stock_anterior', 'stock_nuevo', 'motivo']
                    );

                    await cliente.query(
                        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo)
                         VALUES ${insert.sql}`,
                        insert.parametros
                    );
                }

                if (eliminadas.length > 0) {
                    await cliente.query(
                        'DELETE FROM activo_materiales WHERE activo_id = $1 AND producto_id = ANY($2::int[])',
                        [activoId, arregloInt(eliminadas)]
                    );
                }

                if (relacionesActualizadas.length > 0) {
                    const update = valoresLote(
                        relacionesActualizadas,
                        ['activo_id', 'producto_id', 'cantidad', 'cantidad_descontada']
                    );

                    await cliente.query(
                        `UPDATE activo_materiales am
                         SET cantidad = v.cantidad::numeric, cantidad_descontada = v.cantidad_descontada::numeric
                         FROM (VALUES ${update.sql}) AS v(activo_id, producto_id, cantidad, cantidad_descontada)
                         WHERE am.activo_id = v.activo_id::int AND am.producto_id = v.producto_id::int`,
                        update.parametros
                    );
                }

                if (nuevasRelaciones.length > 0) {
                    const insert = valoresLote(
                        nuevasRelaciones,
                        ['activo_id', 'producto_id', 'cantidad', 'cantidad_descontada']
                    );

                    await cliente.query(
                        `INSERT INTO activo_materiales (activo_id, producto_id, cantidad, cantidad_descontada)
                         VALUES ${insert.sql}`,
                        insert.parametros
                    );
                }

                return tipoActivo;
            });

            await registrar(db, {
                accion: tipoFinal === 'TALLER' ? 'ACTUALIZAR_ACTIVO_TALLER' : 'ACTUALIZAR_ACTIVO',
                detalle: `Actualizó el activo ${tipoFinal} ${activo.activo}`
                    + (activo.nombre_cliente !== '' ? ` · Cliente: ${activo.nombre_cliente}` : '')
                    + ` con ${materiales.size} material(es).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Activo actualizado con éxito.' });
            return;
        }

        case 'eliminar': {
            const activoId = entero(data.activo_id);

            if (activoId === null || activoId < 1) {
                error(res, 422, 'El ID del activo no es válido.');
                return;
            }

            const resultado = await withTransaction(async cliente => {
                const activo = await cliente.query('SELECT activo, tipo FROM activos WHERE activo_id = $1 FOR UPDATE', [activoId]);

                if (activo.rowCount === 0) {
                    lanzar(404, 'El activo que intentas eliminar no existe.');
                }

                const nombreActivo = activo.rows[0].activo;
                const tipoActivo = activo.rows[0].tipo;
                const motivo = `Devolución activo ${nombreActivo}`;

                const materiales = await cliente.query(
                    `SELECT am.producto_id, am.cantidad_descontada, p.stock_actual, p.stock_consumido
                     FROM activo_materiales am
                     JOIN productos p ON p.producto_id = am.producto_id
                     WHERE am.activo_id = $1
                     ORDER BY am.producto_id
                     FOR UPDATE OF p`,
                    [activoId]
                );

                const movimientos = [];

                for (const fila of materiales.rows) {
                    const devolver = Number(fila.cantidad_descontada);

                    if (devolver <= 0) {
                        continue;
                    }

                    const stockAnterior = Number(fila.stock_actual);

                    movimientos.push({
                        productoId: Number(fila.producto_id),
                        tipo: 'DEVOLUCION',
                        cantidad: devolver,
                        stockAnterior,
                        stockNuevo: redondear(stockAnterior + devolver, 3),
                        consumidoNuevo: Math.max(0, redondear(Number(fila.stock_consumido) - devolver, 3)),
                        motivo,
                    });
                }

                await aplicarMovimientos(cliente, movimientos);
                await cliente.query('DELETE FROM activos WHERE activo_id = $1', [activoId]);

                return { nombreActivo, tipoActivo, materiales: materiales.rowCount };
            });

            await registrar(db, {
                accion: resultado.tipoActivo === 'TALLER' ? 'ELIMINAR_ACTIVO_TALLER' : 'ELIMINAR_ACTIVO',
                detalle: `Eliminó el activo ${resultado.tipoActivo} ${resultado.nombreActivo} y devolvió ${resultado.materiales} material(es) al almacén.`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Activo eliminado y materiales devueltos al almacén.' });
            return;
        }

        default:
            error(res, 400, 'Acción no válida.');
    }
});

export default router;

export { validarActivo, normalizarMateriales, normalizarTipoActivo, bloquearProductos, aplicarMovimientos };
