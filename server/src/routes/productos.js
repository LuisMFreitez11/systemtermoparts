/**
 * Endpoint `/api.php`: productos, ajustes de stock, tomas físicas e historial.
 * Réplica exacta de backend/public/api.php (mismos mensajes y mismo JSON).
 */
import express from 'express';
import { db, query, withTransaction, esConflicto } from '../db.js';
import {
    json, error, lanzar, parametro, cuerpo, numero, entero, texto,
    redondear,
} from '../http.js';
import { requireSession } from '../auth.js';
import { idempotencia } from '../idempotency.js';
import { registrar, ipCliente } from '../audit.js';

const router = express.Router();

const ACCIONES = new Set([
    'listar', 'historial', 'crear', 'actualizar', 'eliminar', 'ajustar',
    'ultima_toma', 'registrar_toma_fisica',
]);
const ESCRITURA = new Set(['crear', 'actualizar', 'eliminar', 'ajustar', 'registrar_toma_fisica']);
const MAXIMO_STOCK = 999999999.999;

function categoriaDesdeDescripcion(nombre) {
    const primera = String(nombre).trim().split(/\s+/u)[0] ?? '';
    const limpia = primera.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/gu, '').toUpperCase();

    if (limpia === '') {
        return 'OTROS';
    }

    return Array.from(limpia).slice(0, 50).join('');
}

function validarProducto(data, requiereId = false) {
    const errores = [];
    let productoId = null;

    if (requiereId) {
        productoId = entero(data.producto_id);

        if (productoId === null || productoId < 1) {
            errores.push('El ID del producto no es válido.');
        }
    }

    const sku = texto(data.sku_codigo);

    if (sku === '') {
        errores.push('El código es obligatorio.');
    } else if (Array.from(sku).length > 50) {
        errores.push('El código no puede superar los 50 caracteres.');
    }

    const nombre = texto(data.nombre_descripcion);

    if (nombre === '') {
        errores.push('La descripción del producto es obligatoria.');
    } else if (Array.from(nombre).length > 255) {
        errores.push('La descripción no puede superar los 255 caracteres.');
    }

    let lote = texto(data.lote_condicion).replace(/\s+/gu, ' ').toUpperCase();

    if (lote === '' || lote === 'NUEVO' || lote === 'STOK') {
        lote = 'STOCK';
    } else if (lote === 'RECUP') {
        lote = 'RECUPERADO';
    }

    if (Array.from(lote).length > 50) {
        errores.push('El lote o condición no puede superar los 50 caracteres.');
    }

    const unidad = texto(data.unidad_medida);

    if (unidad === '') {
        errores.push('La unidad de medida es obligatoria.');
    } else if (Array.from(unidad).length > 20) {
        errores.push('La unidad de medida no puede superar los 20 caracteres.');
    }

    let stockActual = numero(data.stock_actual);

    if (stockActual === null || stockActual < 0 || stockActual > MAXIMO_STOCK) {
        errores.push('El stock actual debe ser un número entre cero y 999.999.999,999.');
        stockActual = null;
    }

    let stockMinimo = numero(data.stock_minimo);

    if (stockMinimo === null || stockMinimo < 0 || stockMinimo > MAXIMO_STOCK) {
        errores.push('El stock mínimo debe ser un número entre cero y 999.999.999,999.');
        stockMinimo = null;
    }

    if (errores.length > 0) {
        lanzar(422, errores.join(' '));
    }

    return {
        producto_id: productoId,
        sku_codigo: sku,
        nombre_descripcion: nombre,
        categoria: categoriaDesdeDescripcion(nombre),
        lote_condicion: lote,
        unidad_medida: unidad,
        stock_actual: stockActual,
        stock_minimo: stockMinimo,
    };
}

async function productoExiste(db, productoId) {
    const { rowCount } = await db.query('SELECT 1 FROM productos WHERE producto_id = $1', [productoId]);

    return rowCount > 0;
}

router.all('/', requireSession, idempotencia('api.php'), async (req, res) => {
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
            const { rows } = await query('SELECT * FROM productos ORDER BY producto_id DESC');
            json(res, 200, rows);
            return;
        }

        case 'historial': {
            const productoId = entero(req.query.producto_id ?? null);

            if (productoId === null || productoId < 1) {
                error(res, 422, 'El ID del producto no es válido.');
                return;
            }

            const { rows } = await query(
                `SELECT movimiento_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo, creado_en
                 FROM movimientos_inventario WHERE producto_id = $1 ORDER BY movimiento_id DESC`,
                [productoId]
            );
            json(res, 200, rows);
            return;
        }

        case 'ultima_toma': {
            const { rows } = await query(
                `SELECT toma_id, registrada_en, total_productos, total_unidades
                 FROM tomas_fisicas ORDER BY toma_id DESC LIMIT 1`
            );
            json(res, 200, rows[0] ?? null);
            return;
        }

        case 'registrar_toma_fisica': {
            const { totales, toma } = await withTransaction(async cliente => {
                const { rows } = await cliente.query(
                    `SELECT COUNT(*) AS total_productos, COALESCE(SUM(stock_actual), 0) AS total_unidades
                     FROM productos`
                );
                const totalesToma = rows[0];

                await cliente.query('UPDATE productos SET toma_fisica_anterior = stock_actual');

                const insertada = await cliente.query(
                    `INSERT INTO tomas_fisicas (total_productos, total_unidades)
                     VALUES ($1, $2)
                     RETURNING toma_id, registrada_en, total_productos, total_unidades`,
                    [Number(totalesToma.total_productos), totalesToma.total_unidades]
                );

                await cliente.query(
                    `INSERT INTO toma_fisica_detalle (toma_id, producto_id, cantidad)
                     SELECT $1, producto_id, stock_actual FROM productos`,
                    [insertada.rows[0].toma_id]
                );

                return { totales: totalesToma, toma: insertada.rows[0] };
            });

            await registrar(db, {
                accion: 'TOMA_FISICA',
                detalle: `Registró la toma física de ${Number(totales.total_productos)} materiales (${totales.total_unidades} unidades).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: `Toma física registrada con el stock actual de ${Number(totales.total_productos)} materiales.`,
                toma,
            });
            return;
        }

        case 'crear': {
            const producto = validarProducto(data);

            try {
                await query(
                    `INSERT INTO productos
                     (sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, stock_minimo, toma_fisica_anterior)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        producto.sku_codigo, producto.nombre_descripcion, producto.categoria,
                        producto.lote_condicion, producto.unidad_medida,
                        producto.stock_actual, producto.stock_minimo, producto.stock_actual,
                    ]
                );
            } catch (fallo) {
                if (esConflicto(fallo)) {
                    error(res, 409, 'Ya existe un producto con ese código, lote y descripción.');
                    return;
                }

                throw fallo;
            }

            await registrar(db, {
                accion: 'CREAR_PRODUCTO',
                detalle: `Creó el producto ${producto.sku_codigo} - ${producto.nombre_descripcion} (stock inicial ${producto.stock_actual}).`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Producto creado con éxito.' });
            return;
        }

        case 'actualizar': {
            const producto = validarProducto(data, true);

            try {
                const { rowCount } = await query(
                    `UPDATE productos
                     SET sku_codigo = $1, nombre_descripcion = $2, categoria = $3, lote_condicion = $4,
                         unidad_medida = $5, stock_actual = $6, stock_minimo = $7, actualizado_en = NOW()
                     WHERE producto_id = $8`,
                    [
                        producto.sku_codigo, producto.nombre_descripcion, producto.categoria,
                        producto.lote_condicion, producto.unidad_medida,
                        producto.stock_actual, producto.stock_minimo, producto.producto_id,
                    ]
                );

                if (rowCount === 0 && !(await productoExiste(db, producto.producto_id))) {
                    error(res, 404, 'El producto que intentas actualizar no existe.');
                    return;
                }
            } catch (fallo) {
                if (esConflicto(fallo)) {
                    error(res, 409, 'Ya existe otro producto con ese código, lote y descripción.');
                    return;
                }

                throw fallo;
            }

            await registrar(db, {
                accion: 'ACTUALIZAR_PRODUCTO',
                detalle: `Actualizó el producto ${producto.sku_codigo} - ${producto.nombre_descripcion}.`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Producto actualizado con éxito.' });
            return;
        }

        case 'ajustar': {
            const productoId = entero(data.producto_id);

            if (productoId === null || productoId < 1) {
                error(res, 422, 'El ID del producto no es válido.');
                return;
            }

            const tipo = texto(data.tipo).toLowerCase();

            if (!['restar', 'sumar'].includes(tipo)) {
                error(res, 422, 'El tipo de ajuste debe ser "restar" o "sumar".');
                return;
            }

            const cantidadSolicitada = numero(data.cantidad);

            if (cantidadSolicitada === null || cantidadSolicitada < 0.001 || cantidadSolicitada > MAXIMO_STOCK) {
                error(res, 422, 'La cantidad debe ser un número mayor o igual a 0,001.');
                return;
            }

            const cantidad = redondear(cantidadSolicitada, 3);
            const motivo = texto(data.motivo);

            if (Array.from(motivo).length > 255) {
                error(res, 422, 'El motivo no puede superar los 255 caracteres.');
                return;
            }

            const resultado = await withTransaction(async cliente => {
                const { rows } = await cliente.query(
                    `SELECT sku_codigo, nombre_descripcion, stock_actual, stock_consumido, stock_incrementado
                     FROM productos WHERE producto_id = $1 FOR UPDATE`,
                    [productoId]
                );
                const producto = rows[0];

                if (!producto) {
                    lanzar(404, 'El producto que intentas ajustar no existe.');
                }

                const stockAnterior = Number(producto.stock_actual);
                const consumidoAnterior = Number(producto.stock_consumido);
                const incrementadoAnterior = Number(producto.stock_incrementado);

                let stockNuevo;
                let consumidoNuevo;
                let incrementadoNuevo;
                let tipoMovimiento;

                if (tipo === 'restar') {
                    if (cantidad > stockAnterior) {
                        lanzar(422, `No puedes restar ${cantidad} porque el stock actual es ${stockAnterior}.`);
                    }

                    stockNuevo = redondear(stockAnterior - cantidad, 3);
                    consumidoNuevo = redondear(consumidoAnterior + cantidad, 3);
                    incrementadoNuevo = incrementadoAnterior;
                    tipoMovimiento = 'CONSUMO';
                } else {
                    stockNuevo = redondear(stockAnterior + cantidad, 3);
                    consumidoNuevo = consumidoAnterior;
                    incrementadoNuevo = redondear(incrementadoAnterior + cantidad, 3);
                    tipoMovimiento = 'INCREMENTO';
                }

                await cliente.query(
                    `UPDATE productos SET stock_actual = $1, stock_consumido = $2, stock_incrementado = $3, actualizado_en = NOW()
                     WHERE producto_id = $4`,
                    [stockNuevo, consumidoNuevo, incrementadoNuevo, productoId]
                );

                await cliente.query(
                    `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [productoId, tipoMovimiento, cantidad, stockAnterior, stockNuevo, motivo === '' ? null : motivo]
                );

                return {
                    producto, stockAnterior, stockNuevo, consumidoNuevo, incrementadoNuevo,
                };
            });

            await registrar(db, {
                accion: 'AJUSTAR_STOCK',
                detalle: `${tipo === 'restar' ? 'Restó' : 'Incrementó'} ${cantidad} al producto `
                    + `${resultado.producto.sku_codigo} - ${resultado.producto.nombre_descripcion}`
                    + ` (stock ${resultado.stockAnterior} → ${resultado.stockNuevo}).`
                    + (motivo !== '' ? ` Motivo: ${motivo}` : ''),
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, {
                exito: true,
                mensaje: tipo === 'restar'
                    ? `Se restaron ${cantidad} unidades del stock.`
                    : `Se incrementaron ${cantidad} unidades al stock.`,
                stock_actual: resultado.stockNuevo,
                stock_consumido: resultado.consumidoNuevo,
                stock_incrementado: resultado.incrementadoNuevo,
            });
            return;
        }

        case 'eliminar': {
            const productoId = entero(data.producto_id);

            if (productoId === null || productoId < 1) {
                error(res, 422, 'El ID del producto no es válido.');
                return;
            }

            const { rows } = await query(
                'SELECT sku_codigo, nombre_descripcion FROM productos WHERE producto_id = $1',
                [productoId]
            );
            const eliminado = rows[0];

            let borrados = 0;

            try {
                const resultado = await query('DELETE FROM productos WHERE producto_id = $1', [productoId]);
                borrados = resultado.rowCount;
            } catch (fallo) {
                if (esConflicto(fallo)) {
                    error(res, 409, 'No se puede eliminar porque tiene movimientos, activos o entradas de almacén asociados.');
                    return;
                }

                throw fallo;
            }

            if (borrados === 0) {
                error(res, 404, 'El producto que intentas eliminar no existe.');
                return;
            }

            await registrar(db, {
                accion: 'ELIMINAR_PRODUCTO',
                detalle: `Eliminó el producto ${eliminado?.sku_codigo ?? `ID ${productoId}`} - ${eliminado?.nombre_descripcion ?? ''}.`,
                usuario: req.usuario,
                ip: ipCliente(req),
            });

            json(res, 200, { exito: true, mensaje: 'Producto eliminado.' });
            return;
        }

        default:
            error(res, 400, 'Acción no válida.');
    }
});

export default router;

export { validarProducto, categoriaDesdeDescripcion };
