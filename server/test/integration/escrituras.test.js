/**
 * Pruebas de escritura contra Supabase real, con limpieza total al final.
 *
 * Se activan a mano (escriben en la base, aunque dejan todo como estaba):
 *
 *   $env:RUN_INTEGRATION = '1'
 *   node --test server/test/integration/
 *
 * Lo que comprueban:
 *  - que TODO el SQL de escritura (compras, consumos, devoluciones, dañados,
 *    préstamos) se ejecuta sin errores de sintaxis ni de tipos;
 *  - que las operaciones dejan el stock exacto que deben dejar;
 *  - que la idempotencia evita ejecutar dos veces el mismo botón;
 *  - que el lote de activos usa un número CONSTANTE de consultas (sin N+1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import app from '../../src/app.js';
import { db, query } from '../../src/db.js';
import { bloquearProductos, aplicarMovimientos } from '../../src/routes/activos.js';
import { valoresLote, arregloInt } from '../../src/sql.js';
import { hoy } from '../../src/http.js';

const HABILITADO = process.env.RUN_INTEGRATION === '1';
const USUARIO = process.env.ADMIN_USER ?? 'admin';
const CLAVE = process.env.ADMIN_PASS ?? 'admin123';

const PREFIJO = `ZZTEST${Date.now().toString(36).toUpperCase()}`;

function idUnico(sufijo) {
    return `${PREFIJO}-${sufijo}`.slice(0, 45);
}

async function sesionAdmin() {
    const agente = request.agent(app);
    const respuesta = await agente
        .post('/api_sesion.php?accion=login')
        .send({ usuario: USUARIO, clave: CLAVE });

    assert.equal(respuesta.status, 200, `login: ${respuesta.text}`);
    assert.equal(respuesta.body.exito, true);

    return agente;
}

async function stockDe(productoId) {
    const { rows } = await query(
        `SELECT stock_actual, stock_consumido, stock_incrementado, stock_danado
         FROM productos WHERE producto_id = $1`,
        [productoId]
    );

    return rows[0];
}

async function crearProducto(agente, sku, nombre, stock) {
    const respuesta = await agente.post('/api.php?accion=crear').send({
        sku_codigo: sku,
        nombre_descripcion: nombre,
        lote_condicion: 'STOCK',
        unidad_medida: 'UND',
        stock_actual: stock,
        stock_minimo: 1,
    });

    assert.equal(respuesta.status, 200, `crear producto ${sku}: ${respuesta.text}`);

    const { rows } = await query('SELECT producto_id FROM productos WHERE sku_codigo = $1', [sku]);

    assert.equal(rows.length, 1);

    return Number(rows[0].producto_id);
}

/** Borra todo lo que pudo quedar del test, aunque haya fallado a mitad. */
async function limpiar(ids = {}) {
    const productoIds = ids.productos ?? [];

    try {
        if (ids.activos?.length > 0) {
            await query('DELETE FROM activos WHERE activo_id = ANY($1::int[])', [`{${ids.activos.join(',')}}`]);
        }

        if (ids.herramientas?.length > 0) {
            await query('DELETE FROM herramientas_movimientos WHERE herramienta_id = ANY($1::int[])', [`{${ids.herramientas.join(',')}}`]);
            await query('DELETE FROM herramientas WHERE herramienta_id = ANY($1::int[])', [`{${ids.herramientas.join(',')}}`]);
        }

        if (ids.danados?.length > 0) {
            await query('DELETE FROM materiales_danados WHERE danado_id = ANY($1::int[])', [`{${ids.danados.join(',')}}`]);
        }

        if (ids.entradas?.length > 0) {
            await query('DELETE FROM entradas_almacen WHERE entrada_id = ANY($1::int[])', [`{${ids.entradas.join(',')}}`]);
        }

        if (productoIds.length > 0) {
            await query('DELETE FROM movimientos_inventario WHERE producto_id = ANY($1::int[])', [`{${productoIds.join(',')}}`]);
            await query('DELETE FROM productos WHERE producto_id = ANY($1::int[])', [`{${productoIds.join(',')}}`]);
        }

        // Restos por si el test murió antes de conocer los IDs.
        await query("DELETE FROM activos WHERE activo LIKE $1", [`${PREFIJO}%`]);
        await query("DELETE FROM herramientas WHERE codigo LIKE $1", [`${PREFIJO}%`]);
        await query("DELETE FROM productos WHERE sku_codigo LIKE $1", [`${PREFIJO}%`]);

        if (ids.historialMax !== undefined) {
            await query('DELETE FROM historial_usuario WHERE historial_id > $1', [ids.historialMax]);
        }

        await query("DELETE FROM operaciones_idempotencia WHERE clave LIKE $1", [`zztest-${PREFIJO.toLowerCase()}%`]);
    } catch (error) {
        console.error('[test] No se pudo limpiar del todo:', error.message);
    }
}

test('ciclo completo de escritura: activo, stock, entradas, dañados y herramientas', { skip: !HABILITADO, timeout: 180000 }, async () => {
    // El máximo se toma ANTES del login para que la limpieza también borre
    // la fila de "INICIO_SESION" que genera este test.
    const { rows: maximo } = await query('SELECT COALESCE(MAX(historial_id), 0) AS maximo FROM historial_usuario');
    const agente = await sesionAdmin();
    const ids = { productos: [], activos: [], herramientas: [], entradas: [], danados: [], historialMax: Number(maximo[0].maximo) };

    try {
        // --- Productos ---------------------------------------------------
        const productoA = await crearProducto(agente, idUnico('A'), 'Filtro de prueba A', 100);
        const productoB = await crearProducto(agente, idUnico('B'), 'Aceite de prueba B', 50);
        ids.productos.push(productoA, productoB);

        assert.deepEqual(await stockDe(productoA), {
            stock_actual: '100.000',
            stock_consumido: '0.000',
            stock_incrementado: '0.000',
            stock_danado: '0.000',
        });

        // --- Crear activo con materiales (consumo en lote) ----------------
        const crearActivo = await agente.post('/api_activos.php?accion=crear').send({
            tipo: 'CALLE',
            fecha_ruta: hoy(),
            activo: idUnico('ACT'),
            modelo: 'Modelo de prueba',
            nombre_cliente: 'Cliente de prueba',
            materiales: [
                { producto_id: productoA, cantidad: 2 },
                { producto_id: productoB, cantidad: 1 },
            ],
        });

        assert.equal(crearActivo.status, 200, crearActivo.text);
        ids.activos.push(crearActivo.body.activo_id);

        assert.equal((await stockDe(productoA)).stock_actual, '98.000');
        assert.equal((await stockDe(productoA)).stock_consumido, '2.000');
        assert.equal((await stockDe(productoB)).stock_actual, '49.000');

        // --- Idempotencia: el mismo botón dos veces ----------------------
        const claveIdem = `zztest-${PREFIJO.toLowerCase()}-ajuste`;
        const primerAjuste = await agente
            .post('/api.php?accion=ajustar')
            .set('X-Idempotency-Key', claveIdem)
            .send({ producto_id: productoA, tipo: 'sumar', cantidad: 5, motivo: 'Prueba' });

        assert.equal(primerAjuste.status, 200, primerAjuste.text);
        assert.equal((await stockDe(productoA)).stock_actual, '103.000');

        const segundoAjuste = await agente
            .post('/api.php?accion=ajustar')
            .set('X-Idempotency-Key', claveIdem)
            .send({ producto_id: productoA, tipo: 'sumar', cantidad: 5, motivo: 'Prueba' });

        assert.equal(segundoAjuste.status, 200);
        assert.deepEqual(segundoAjuste.body, primerAjuste.body);
        assert.equal(segundoAjuste.headers['x-idempotent-replay'], 'true');
        assert.equal((await stockDe(productoA)).stock_actual, '103.000', 'el reintento no debe sumar otra vez');

        const { rows: filasIdem } = await query(
            'SELECT COUNT(*)::int AS total FROM operaciones_idempotencia WHERE clave = $1',
            [claveIdem]
        );
        assert.equal(filasIdem[0].total, 1);

        // --- Actualizar activo: cambiar cantidades y quitar un material ---
        const actualizar = await agente.post('/api_activos.php?accion=actualizar').send({
            activo_id: ids.activos[0],
            tipo: 'TALLER',
            fecha_ruta: hoy(),
            activo: idUnico('ACT'),
            modelo: 'Modelo actualizado',
            nombre_cliente: 'Cliente de prueba',
            materiales: [{ producto_id: productoA, cantidad: 4 }],
        });

        assert.equal(actualizar.status, 200, actualizar.text);
        // A estaba en 2 descontadas y pasa a 4 (2 más); B devuelve su 1.
        assert.equal((await stockDe(productoA)).stock_actual, '101.000');
        assert.equal((await stockDe(productoA)).stock_consumido, '4.000');
        assert.equal((await stockDe(productoB)).stock_actual, '50.000');
        assert.equal((await stockDe(productoB)).stock_consumido, '0.000');

        // --- Entrada de almacén -----------------------------------------
        const entrada = await agente.post('/api_entradas.php?accion=crear').send({
            producto_id: productoA,
            cantidad: 10,
            fecha_entrada: hoy(),
            referencia: idUnico('REF'),
            proveedor: 'Proveedor de prueba',
        });

        assert.equal(entrada.status, 200, entrada.text);
        ids.entradas.push(entrada.body.entrada_id);
        assert.equal(entrada.body.stock_anterior, 101);
        assert.equal(entrada.body.stock_nuevo, 111);
        assert.equal((await stockDe(productoA)).stock_incrementado, '15.000'); // 5 del ajuste + 10 de la entrada

        // --- Material dañado: alta y anulación ---------------------------
        const danado = await agente.post('/api_danados.php?accion=crear').send({
            producto_id: productoA,
            cantidad: 3,
            fecha_dano: hoy(),
            motivo: 'Golpe en el empaque',
        });

        assert.equal(danado.status, 200, danado.text);
        ids.danados.push(danado.body.danado_id);
        assert.equal(danado.body.stock_nuevo, 108);
        assert.equal((await stockDe(productoA)).stock_danado, '3.000');

        const anularDanado = await agente.post('/api_danados.php?accion=eliminar').send({ danado_id: danado.body.danado_id });
        assert.equal(anularDanado.status, 200, anularDanado.text);
        assert.equal(anularDanado.body.stock_nuevo, 111);
        assert.equal((await stockDe(productoA)).stock_danado, '0.000');
        ids.danados = [];

        // --- Anular entrada ---------------------------------------------
        const anularEntrada = await agente.post('/api_entradas.php?accion=eliminar').send({ entrada_id: entrada.body.entrada_id });
        assert.equal(anularEntrada.status, 200, anularEntrada.text);
        assert.equal((await stockDe(productoA)).stock_actual, '101.000');
        assert.equal((await stockDe(productoA)).stock_incrementado, '5.000'); // el ajuste manual no se anula
        ids.entradas = [];

        // --- Herramientas: alta, salida, entrada y baja ------------------
        const herramienta = await agente.post('/api_herramientas.php?accion=crear').send({
            codigo: idUnico('HERR'),
            nombre: 'Herramienta de prueba',
            cantidad: 5,
            estado: 'DISPONIBLE',
        });

        assert.equal(herramienta.status, 200, herramienta.text);
        const { rows: filaHerramienta } = await query('SELECT herramienta_id FROM herramientas WHERE codigo = $1', [idUnico('HERR')]);
        const herramientaId = Number(filaHerramienta[0].herramienta_id);
        ids.herramientas.push(herramientaId);

        const salida = await agente.post('/api_herramientas.php?accion=registrar_movimiento').send({
            herramienta_id: herramientaId,
            tipo: 'SALIDA',
            cantidad: 2,
            fecha: hoy(),
            responsable: 'Técnico de prueba',
        });

        assert.equal(salida.status, 200, salida.text);
        assert.equal(salida.body.cantidad_prestada, 2);
        assert.equal(salida.body.cantidad_disponible, 3);

        const devolucion = await agente.post('/api_herramientas.php?accion=registrar_movimiento').send({
            herramienta_id: herramientaId,
            tipo: 'ENTRADA',
            cantidad: 1,
            fecha: hoy(),
        });

        assert.equal(devolucion.status, 200, devolucion.text);
        assert.equal(devolucion.body.cantidad_prestada, 1);

        // Con una unidad prestada no se puede eliminar (409, como en PHP).
        const bajaConPrestamo = await agente.post('/api_herramientas.php?accion=eliminar').send({ herramienta_id: herramientaId });
        assert.equal(bajaConPrestamo.status, 409);
        assert.match(bajaConPrestamo.body.mensaje, /unidad\(es\) prestada/);

        const devolverResto = await agente.post('/api_herramientas.php?accion=registrar_movimiento').send({
            herramienta_id: herramientaId,
            tipo: 'ENTRADA',
            cantidad: 1,
            fecha: hoy(),
        });
        assert.equal(devolverResto.status, 200, devolverResto.text);

        const baja = await agente.post('/api_herramientas.php?accion=eliminar').send({ herramienta_id: herramientaId });
        assert.equal(baja.status, 200, baja.text);
        ids.herramientas = [];

        // --- Eliminar activo: devuelve los materiales --------------------
        const eliminarActivo = await agente.post('/api_activos.php?accion=eliminar').send({ activo_id: ids.activos[0] });
        assert.equal(eliminarActivo.status, 200, eliminarActivo.text);
        assert.equal((await stockDe(productoA)).stock_actual, '105.000');
        assert.equal((await stockDe(productoA)).stock_consumido, '0.000');
        ids.activos = [];

        // --- Eliminar productos -----------------------------------------
        for (const productoId of ids.productos) {
            const borrado = await agente.post('/api.php?accion=eliminar').send({ producto_id: productoId });
            assert.equal(borrado.status, 200, borrado.text);
        }
        ids.productos = [];

        // --- Auditoría registrada ---------------------------------------
        const { rows: auditoria } = await query(
            'SELECT accion FROM historial_usuario WHERE historial_id > $1 ORDER BY historial_id',
            [ids.historialMax]
        );
        const acciones = auditoria.map(fila => fila.accion);

        for (const esperada of ['CREAR_PRODUCTO', 'CREAR_ACTIVO', 'AJUSTAR_STOCK', 'ACTUALIZAR_ACTIVO_TALLER', 'ENTRADA_ALMACEN', 'DANADO', 'ANULAR_DANADO', 'ANULAR_ENTRADA', 'CREAR_HERRAMIENTA', 'SALIDA_HERRAMIENTA', 'ENTRADA_HERRAMIENTA', 'ELIMINAR_HERRAMIENTA', 'ELIMINAR_ACTIVO_TALLER', 'ELIMINAR_PRODUCTO']) {
            assert.ok(acciones.includes(esperada), `falta la auditoría ${esperada}`);
        }
    } finally {
        await limpiar(ids);
    }
});

test('el lote de activos usa un número CONSTANTE de consultas (sin N+1)', { skip: !HABILITADO, timeout: 120000 }, async () => {
    // Se ejecuta dentro de una transacción que SIEMPRE se revierte.
    const ROLLBACK = 'ROLLBACK_DE_PRUEBA';

    try {
        await db.withTransaction(async cliente => {
            const productos = [];

            for (let indice = 0; indice < 17; indice += 1) {
                const { rows } = await cliente.query(
                    `INSERT INTO productos (sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, stock_minimo)
                     VALUES ($1, $2, 'ZZTEST', 'STOCK', 'UND', 100, 1)
                     RETURNING producto_id`,
                    [`${idUnico(`L${indice}`)}`, `Producto lote ${indice}`]
                );

                productos.push(Number(rows[0].producto_id));
            }

            const contar = async ids => {
                let consultas = 0;
                const original = cliente.query.bind(cliente);

                cliente.query = (...args) => {
                    consultas += 1;

                    return original(...args);
                };

                try {
                    const bloqueados = await bloquearProductos(cliente, ids);
                    const movimientos = ids.map(productoId => {
                        const producto = bloqueados.get(productoId);
                        const stockAnterior = Number(producto.stock_actual);

                        return {
                            productoId,
                            tipo: 'CONSUMO',
                            cantidad: 1,
                            stockAnterior,
                            stockNuevo: stockAnterior - 1,
                            consumidoNuevo: Number(producto.stock_consumido) + 1,
                            motivo: 'Prueba N+1',
                        };
                    });

                    await aplicarMovimientos(cliente, movimientos);

                    const relaciones = ids.map(productoId => ({
                        activo_id: -1,
                        producto_id: productoId,
                        cantidad: 1,
                        cantidad_descontada: 1,
                    }));
                    const insert = valoresLote(relaciones, ['activo_id', 'producto_id', 'cantidad', 'cantidad_descontada']);
                    const { rows } = await original(
                        `WITH filas AS (SELECT * FROM (VALUES ${insert.sql}) AS v(activo_id, producto_id, cantidad, cantidad_descontada))
                         SELECT COUNT(*)::int AS total FROM filas`,
                        insert.parametros
                    );

                    return { consultas, total: rows[0].total };
                } finally {
                    cliente.query = original;
                }
            };

            const conDos = await contar(productos.slice(0, 2));
            const granLote = productos.slice(2, 17);
            const conQuince = await contar(granLote);

            assert.equal(conDos.consultas, conQuince.consultas,
                `el número de consultas no puede crecer con los materiales (2 → ${conDos.consultas}, 15 → ${conQuince.consultas})`);
            assert.ok(conQuince.consultas <= 3, `se esperaban como máximo 3 consultas para 15 materiales, hubo ${conQuince.consultas}`);
            assert.equal(conQuince.total, 15);

            // Verifica que el UPDATE en lote dejó los 15 productos en 99.
            const { rows: stocks } = await cliente.query(
                'SELECT DISTINCT stock_actual::numeric(12,3)::text AS stock FROM productos WHERE producto_id = ANY($1::int[])',
                [arregloInt(granLote)]
            );
            assert.deepEqual(stocks.map(fila => fila.stock), ['99.000']);

            throw new Error(ROLLBACK);
        });
    } catch (error) {
        assert.equal(error.message, ROLLBACK, `la transacción de prueba falló: ${error.message}`);
    }
});
