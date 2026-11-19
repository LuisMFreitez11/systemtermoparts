import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import { guardiaConfiguracion } from '../../src/config-guard.js';

function aplicacion(faltantes) {
    const app = express();
    app.use(guardiaConfiguracion(faltantes));
    app.get('/health.php', (_req, res) => res.json({ exito: true }));

    return app;
}

test('sin faltantes la guardia deja pasar la petición', async () => {
    const app = aplicacion([]);

    const salud = await request(app).get('/health.php');
    assert.equal(salud.status, 200);
    assert.deepEqual(salud.body, { exito: true });

    const desconocida = await request(app).get('/api.php?accion=listar');
    assert.equal(desconocida.status, 404);
});

test('con faltantes responde 503 y nombra las variables, nunca sus valores', async () => {
    const app = aplicacion(['SESSION_SECRET', 'DB_PGSQL_PASSWORD']);
    const respuesta = await request(app).get('/api.php?accion=listar');

    assert.equal(respuesta.status, 503);
    assert.equal(respuesta.type, 'application/json');
    assert.equal(respuesta.body.exito, false);
    assert.deepEqual(respuesta.body.faltantes, ['SESSION_SECRET', 'DB_PGSQL_PASSWORD']);
    assert.match(respuesta.body.mensaje, /SESSION_SECRET, DB_PGSQL_PASSWORD/);
    assert.equal(respuesta.body.documentacion, 'docs/DESPLIEGUE_VERCEL.md');
});

test('la guardia también bloquea health para que el monitoreo lo detecte', async () => {
    const app = aplicacion(['SESSION_SECRET']);
    const respuesta = await request(app).get('/health.php');

    assert.equal(respuesta.status, 503);
    assert.deepEqual(respuesta.body.faltantes, ['SESSION_SECRET']);
});

test('ignora entradas vacías en la lista de faltantes', async () => {
    const app = aplicacion([null, '', 'SESSION_SECRET']);
    const respuesta = await request(app).get('/health.php');

    assert.equal(respuesta.status, 503);
    assert.deepEqual(respuesta.body.faltantes, ['SESSION_SECRET']);
});
