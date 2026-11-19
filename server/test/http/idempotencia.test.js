import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

import { idempotencia, huellaDe, PATRON_CLAVE } from '../../src/idempotency.js';

/**
 * Almacén de idempotencia en memoria con la MISMA semántica que el SQL:
 * insertar es atómico y solo devuelve true la primera vez.
 */
function crearAlmacen() {
    const filas = new Map();

    const almacen = {
        filas,
        inserciones: 0,
        async insertar(clave, huella, endpoint, usuarioId) {
            if (filas.has(clave)) {
                return false;
            }

            almacen.inserciones += 1;
            filas.set(clave, {
                huella,
                endpoint,
                usuario_id: usuarioId,
                estado: 'EN_PROCESO',
                codigo_http: null,
                respuesta: null,
                desde: Date.now(),
            });

            return true;
        },
        async leer(clave) {
            const fila = filas.get(clave);

            if (!fila) {
                return null;
            }

            return {
                estado: fila.estado,
                huella: fila.huella,
                codigo_http: fila.codigo_http,
                respuesta: fila.respuesta,
                edad: Math.floor((Date.now() - fila.desde) / 1000),
            };
        },
        async liberar(clave) {
            filas.delete(clave);
        },
        async completar(clave, status, payload) {
            const fila = filas.get(clave);

            if (!fila) {
                return;
            }

            if (status >= 200 && status < 300) {
                fila.estado = 'COMPLETADA';
                fila.codigo_http = status;
                fila.respuesta = JSON.stringify(payload);
                fila.desde = Date.now();

                return;
            }

            filas.delete(clave);
        },
        async limpiar() {
            // No-op: los tests controlan el TTL manualmente.
        },
    };

    return almacen;
}

function crearApp(almacen, handler) {
    const app = express();

    app.use(express.json({
        verify: (req, _res, buffer) => {
            req.rawBody = buffer.toString('utf8');
        },
    }));
    app.post('/operacion', idempotencia('api.php', almacen), handler);
    // eslint-disable-next-line no-unused-vars
    app.use((fallo, _req, res, _next) => {
        res.status(fallo.status ?? 500).json({ exito: false, mensaje: fallo.message });
    });

    return app;
}

const ESPERA = milisegundos => new Promise(resolver => setTimeout(resolver, milisegundos));

test('el patrón de clave acepta UUID y rechaza claves débiles', () => {
    assert.equal(PATRON_CLAVE.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), true);
    assert.equal(PATRON_CLAVE.test('clave:con.puntos_guiones-bien'), true);
    assert.equal(PATRON_CLAVE.test('corta'), false);
    assert.equal(PATRON_CLAVE.test('con espacios y mas de ocho'), false);
    assert.equal(PATRON_CLAVE.test('a'.repeat(121)), false);
});

test('la huella es sha256 de endpoint|accion|cuerpo crudo (igual que PHP)', () => {
    const req = {
        query: { accion: 'crear' },
        rawBody: '{"producto_id":1}',
        usuario: { usuario_id: 7 },
    };
    const esperado = crypto
        .createHash('sha256')
        .update('api.php|crear|{"producto_id":1}')
        .digest('hex');

    assert.equal(huellaDe('api.php', req), esperado);
});

test('20 peticiones simultáneas con la misma clave ejecutan la operación UNA vez', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    const app = crearApp(almacen, async (req, res) => {
        ejecuciones += 1;
        const numero = ejecuciones;

        await ESPERA(60);
        res.json({ exito: true, numero, cuerpo: req.body });
    });

    const respuestas = await Promise.all(
        Array.from({ length: 20 }, () => request(app)
            .post('/operacion?accion=crear')
            .set('X-Idempotency-Key', 'clave-concurrente-0001')
            .send({ producto_id: 1, cantidad: 2 }))
    );

    for (const respuesta of respuestas) {
        assert.equal(respuesta.status, 200);
        assert.deepEqual(respuesta.body, { exito: true, numero: 1, cuerpo: { producto_id: 1, cantidad: 2 } });
    }

    assert.equal(ejecuciones, 1, 'la operación debe ejecutarse exactamente una vez');
    assert.equal(almacen.inserciones, 1);
    assert.equal(almacen.filas.size, 1);
    assert.equal(almacen.filas.get('clave-concurrente-0001').estado, 'COMPLETADA');

    // Las respuestas replicadas se marcan explícitamente.
    const replicas = respuestas.filter(respuesta => respuesta.headers['x-idempotent-replay'] === 'true');
    assert.equal(replicas.length, 19);
});

test('un reintento secuencial devuelve la respuesta guardada sin reejecutar', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    const app = crearApp(almacen, (_req, res) => {
        ejecuciones += 1;
        res.json({ exito: true, mensaje: `Ejecución ${ejecuciones}` });
    });

    const primera = await request(app)
        .post('/operacion?accion=ajustar')
        .set('X-Idempotency-Key', 'reintento-secuencial-1')
        .send({ cantidad: 1 });

    const segunda = await request(app)
        .post('/operacion?accion=ajustar')
        .set('X-Idempotency-Key', 'reintento-secuencial-1')
        .send({ cantidad: 1 });

    assert.equal(primera.status, 200);
    assert.equal(segunda.status, 200);
    assert.deepEqual(segunda.body, primera.body);
    assert.equal(segunda.headers['x-idempotent-replay'], 'true');
    assert.equal(ejecuciones, 1);
});

test('la misma clave con otro cuerpo devuelve 409 y no ejecuta', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    const app = crearApp(almacen, (_req, res) => {
        ejecuciones += 1;
        res.json({ exito: true });
    });

    await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-reutilizada-01')
        .send({ cantidad: 1 });

    const conflicto = await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-reutilizada-01')
        .send({ cantidad: 2 });

    assert.equal(conflicto.status, 409);
    assert.equal(conflicto.body.idempotencia_conflicto, true);
    assert.equal(ejecuciones, 1);
});

test('claves distintas ejecutan operaciones distintas', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    const app = crearApp(almacen, (_req, res) => {
        ejecuciones += 1;
        res.json({ exito: true, numero: ejecuciones });
    });

    const a = await request(app).post('/operacion?accion=crear').set('X-Idempotency-Key', 'clave-distinta-001').send({ a: 1 });
    const b = await request(app).post('/operacion?accion=crear').set('X-Idempotency-Key', 'clave-distinta-002').send({ a: 1 });

    assert.equal(a.body.numero, 1);
    assert.equal(b.body.numero, 2);
    assert.equal(ejecuciones, 2);
});

test('sin clave válida la operación se ejecuta siempre (compatibilidad PHP)', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    const app = crearApp(almacen, (_req, res) => {
        ejecuciones += 1;
        res.json({ exito: true });
    });

    await request(app).post('/operacion?accion=crear').send({ a: 1 });
    await request(app).post('/operacion?accion=crear').set('X-Idempotency-Key', 'corta').send({ a: 1 });

    assert.equal(ejecuciones, 2);
    assert.equal(almacen.inserciones, 0);
});

test('un error libera la clave para poder corregir y reintentar', async () => {
    const almacen = crearAlmacen();
    let intentos = 0;

    const app = crearApp(almacen, (req, res) => {
        intentos += 1;

        if (req.body.forzarError) {
            const fallo = new Error('Datos inválidos');
            fallo.status = 422;
            throw fallo;
        }

        res.json({ exito: true, intentos });
    });

    const fallo = await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-error-000001')
        .send({ forzarError: true });

    assert.equal(fallo.status, 422);
    assert.equal(almacen.filas.size, 0, 'un error no debe cachearse');

    const exito = await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-error-000001')
        .send({ forzarError: false });

    assert.equal(exito.status, 200);
    assert.equal(exito.body.intentos, 2);
});

test('una clave colgada de un proceso caído se puede reclamar', async () => {
    const almacen = crearAlmacen();
    let ejecuciones = 0;

    // Simula una operación que quedó EN_PROCESO hace 10 minutos.
    const huella = crypto
        .createHash('sha256')
        .update('api.php|crear|{"a":1}')
        .digest('hex');

    almacen.filas.set('clave-abandonada-01', {
        huella,
        endpoint: 'api.php',
        usuario_id: null,
        estado: 'EN_PROCESO',
        codigo_http: null,
        respuesta: null,
        desde: Date.now() - 600000,
    });

    const app = crearApp(almacen, (_req, res) => {
        ejecuciones += 1;
        res.json({ exito: true });
    });

    const respuesta = await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-abandonada-01')
        .send({ a: 1 });

    assert.equal(respuesta.status, 200);
    assert.equal(ejecuciones, 1);
    assert.equal(almacen.filas.get('clave-abandonada-01').estado, 'COMPLETADA');
});

test('una operación en proceso sin caducar responde 409 con la marca', async () => {
    const almacen = crearAlmacen();
    const app = crearApp(almacen, (_req, res) => {
        res.json({ exito: true });
    });

    // Se genera la huella real de la petición para que no sea un conflicto.
    const huella = crypto
        .createHash('sha256')
        .update('api.php|crear|{"a":1}')
        .digest('hex');

    almacen.filas.set('clave-en-curso-0001', {
        huella,
        endpoint: 'api.php',
        usuario_id: null,
        estado: 'EN_PROCESO',
        codigo_http: null,
        respuesta: null,
        desde: Date.now(),
    });

    const respuesta = await request(app)
        .post('/operacion?accion=crear')
        .set('X-Idempotency-Key', 'clave-en-curso-0001')
        .send({ a: 1 });

    assert.equal(respuesta.status, 409);
    assert.equal(respuesta.body.idempotencia_en_proceso, true);
});

test('las peticiones GET no pasan por idempotencia', async () => {
    const almacen = crearAlmacen();
    const app = express();

    app.get('/operacion', idempotencia('api.php', almacen), (_req, res) => res.json({ exito: true }));

    await request(app).get('/operacion?accion=listar');
    await request(app).get('/operacion?accion=listar');

    assert.equal(almacen.inserciones, 0);
});
