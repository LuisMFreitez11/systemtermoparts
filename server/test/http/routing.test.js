import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import app from '../../src/app.js';
import { config } from '../../src/config.js';
import { crearToken } from '../../src/auth.js';
import { db } from '../../src/db.js';

const ADMIN = {
    usuario_id: 1,
    usuario: 'admin',
    nombre_completo: 'Administrador',
    rol: 'ADMIN',
};

function cookieDe(usuario = ADMIN) {
    const { token } = crearToken(usuario);

    return `${config.sesion.nombre}=${token}`;
}

/** Sustituye la base por un doble vacío y devuelve la función para restaurar. */
function baseFalsa() {
    const original = db.query;

    db.query = async () => ({ rows: [], rowCount: 0 });

    return () => {
        db.query = original;
    };
}

test('health.php responde sin sesión y sin datos de negocio', async () => {
    const respuesta = await request(app).get('/health.php');

    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.body.exito, true);
    assert.equal(respuesta.body.servicio, 'wms-termo-part');
    assert.equal(respuesta.body.motor, 'pgsql');
    assert.match(respuesta.body.hora, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(respuesta.body.productos, undefined);

    const alias = await request(app).get('/api/health');
    assert.equal(alias.status, 200);
});

test('una acción desconocida devuelve 400 con el mensaje de PHP', async () => {
    for (const ruta of ['/api.php', '/api_activos.php', '/api_herramientas.php', '/api_entradas.php', '/api_danados.php', '/api_sesion.php']) {
        const respuesta = await request(app)
            .get(`${ruta}?accion=inventada`)
            .set('Cookie', cookieDe());

        assert.equal(respuesta.status, 400, ruta);
        assert.equal(respuesta.body.exito, false, ruta);
        assert.equal(respuesta.body.mensaje, 'Acción no válida.', ruta);
    }
});

test('historial solo admite listar y usuarios', async () => {
    const respuesta = await request(app)
        .get('/api_historial.php?accion=borrar')
        .set('Cookie', cookieDe());

    assert.equal(respuesta.status, 400);
    assert.equal(respuesta.body.mensaje, 'Acción no válida.');
});

test('sin cookie todos los endpoints protegidos devuelven 401 no_autenticado', async () => {
    const rutas = [
        '/api.php?accion=listar',
        '/api_activos.php?accion=listar',
        '/api_herramientas.php?accion=listar',
        '/api_entradas.php?accion=listar',
        '/api_danados.php?accion=listar',
        '/api_historial.php?accion=listar',
    ];

    for (const ruta of rutas) {
        const respuesta = await request(app).get(ruta);

        assert.equal(respuesta.status, 401, ruta);
        assert.equal(respuesta.body.no_autenticado, true, ruta);
        assert.match(respuesta.body.mensaje, /sesión expiró/i, ruta);
    }
});

test('una cookie manipulada no autentica', async () => {
    const respuesta = await request(app)
        .get('/api_sesion.php?accion=estado')
        .set('Cookie', `${config.sesion.nombre}=eyJ1IjoxfQ.firma-falsa`);

    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.body.autenticado, false);
    assert.equal(respuesta.body.usuario, null);
});

test('estado refleja la sesión firmada', async () => {
    const respuesta = await request(app)
        .get('/api_sesion.php?accion=estado')
        .set('Cookie', cookieDe());

    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.body.autenticado, true);
    assert.equal(respuesta.body.usuario.usuario, 'admin');
    assert.equal(respuesta.body.usuario.rol, 'ADMIN');
    assert.equal(respuesta.body.usuario.clave_hash, undefined);
});

test('las acciones de escritura exigen POST (405) antes de tocar la base', async () => {
    const casos = [
        ['/api.php?accion=crear', 'Esta acción requiere el método POST.'],
        ['/api_activos.php?accion=eliminar', 'Esta acción requiere el método POST.'],
        ['/api_herramientas.php?accion=registrar_movimiento', 'Esta acción requiere el método POST.'],
        ['/api_entradas.php?accion=crear', 'Esta acción requiere el método POST.'],
        ['/api_danados.php?accion=eliminar', 'Esta acción requiere el método POST.'],
        ['/api_sesion.php?accion=login', 'Esta acción requiere el método POST.'],
    ];

    for (const [ruta, mensaje] of casos) {
        const respuesta = await request(app).get(ruta).set('Cookie', cookieDe());

        assert.equal(respuesta.status, 405, ruta);
        assert.equal(respuesta.body.mensaje, mensaje, ruta);
    }
});

test('un JSON inválido devuelve 400 sin romper el proceso', async () => {
    const respuesta = await request(app)
        .post('/api_sesion.php?accion=login')
        .set('Content-Type', 'application/json')
        .send('{"usuario": ');

    assert.equal(respuesta.status, 400);
    assert.equal(respuesta.body.exito, false);
    assert.match(respuesta.body.mensaje, /no es un JSON válido/);
});

test('login sin usuario ni clave responde 422', async () => {
    const respuesta = await request(app)
        .post('/api_sesion.php?accion=login')
        .send({});

    assert.equal(respuesta.status, 422);
    assert.equal(respuesta.body.mensaje, 'Escribe tu usuario y tu clave.');
});

test('cambiar_clave sin sesión responde 401', async () => {
    const respuesta = await request(app)
        .post('/api_sesion.php?accion=cambiar_clave')
        .send({ clave_actual: 'a', clave_nueva: 'bbbbbb' });

    assert.equal(respuesta.status, 401);
    assert.equal(respuesta.body.exito, false);
});

test('logout limpia la cookie y registra la salida', async () => {
    const restaurar = baseFalsa();

    try {
        const respuesta = await request(app)
            .post('/api_sesion.php?accion=logout')
            .set('Cookie', cookieDe());

        assert.equal(respuesta.status, 200);
        assert.equal(respuesta.body.exito, true);
        assert.equal(respuesta.body.mensaje, 'Sesión cerrada.');

        const cookies = respuesta.headers['set-cookie'] ?? [];
        assert.ok(cookies.some(valor => valor.startsWith(`${config.sesion.nombre}=;`)));
        assert.ok(cookies.some(valor => /Expires=Thu, 01 Jan 1970/.test(valor)));
    } finally {
        restaurar();
    }
});

test('CORS refleja el mismo origen y rechaza orígenes ajenos', async () => {
    const propio = await request(app)
        .options('/api.php?accion=listar')
        .set('Host', 'localhost:3311')
        .set('Origin', 'http://localhost:3311');

    assert.equal(propio.status, 204);
    assert.equal(propio.headers['access-control-allow-origin'], 'http://localhost:3311');
    assert.equal(propio.headers['access-control-allow-credentials'], 'true');
    assert.match(propio.headers['access-control-allow-headers'], /X-Idempotency-Key/i);

    const ajeno = await request(app)
        .options('/api.php?accion=listar')
        .set('Origin', 'https://sitio-malicioso.example');

    assert.equal(ajeno.status, 204);
    assert.equal(ajeno.headers['access-control-allow-origin'], undefined);
});

test('una ruta inexistente devuelve JSON 404', async () => {
    const respuesta = await request(app).get('/no-existe');

    assert.equal(respuesta.status, 404);
    assert.equal(respuesta.body.exito, false);
    assert.equal(respuesta.body.mensaje, 'Recurso no encontrado.');
});
