/**
 * Prueba de PARIDAD real: Node vs PHP, mismos datos de Supabase.
 *
 * Solo hace lecturas (y logins) para no ensuciar la base. Se activa a mano:
 *
 *   $env:RUN_INTEGRATION = '1'
 *   node --test server/test/parity/
 *
 * Requiere PHP CLI en C:\xampp\php\php.exe (o PHP_BIN) y las credenciales en
 * legacy/backend/.env (o server/.env).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';

import app from '../../src/app.js';
import { RAIZ_PROYECTO } from '../../src/config.js';

const HABILITADO = process.env.RUN_INTEGRATION === '1';
const PHP = process.env.PHP_BIN ?? 'C:/xampp/php/php.exe';
const PUERTO = Number(process.env.PHP_PORT ?? 8099);
const DOCROOT = path.join(RAIZ_PROYECTO, 'legacy', 'backend', 'public');

const USUARIO = process.env.ADMIN_USER ?? 'admin';
const CLAVE = process.env.ADMIN_PASS ?? 'admin123';

/** Cliente mínimo con manejo manual de cookies para hablar con PHP. */
function clientePhp(base) {
    let cookie = '';

    return async (ruta, opciones = {}) => {
        const respuesta = await fetch(`${base}${ruta}`, {
            ...opciones,
            headers: {
                Accept: 'application/json',
                ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(opciones.headers ?? {}),
            },
        });

        const nuevas = respuesta.headers.getSetCookie?.() ?? [];

        if (nuevas.length > 0) {
            cookie = nuevas.map(valor => valor.split(';')[0]).join('; ');
        }

        const texto = await respuesta.text();
        let cuerpo = null;

        try {
            cuerpo = texto === '' ? null : JSON.parse(texto);
        } catch {
            cuerpo = texto;
        }

        return { status: respuesta.status, body: cuerpo, texto };
    };
}

/** Cliente equivalente sobre la app Express, sin abrir puerto. */
function clienteNode() {
    let cookie = '';

    return async (ruta, opciones = {}) => {
        const [camino, consulta = ''] = ruta.split('?');
        const destino = consulta ? `${camino}?${consulta}` : camino;
        const peticion = (opciones.method ?? 'GET') === 'POST'
            ? request(app).post(destino)
            : request(app).get(destino);

        if (cookie) {
            peticion.set('Cookie', cookie);
        }

        if (opciones.body) {
            peticion.set('Content-Type', 'application/json').send(opciones.body);
        }

        const respuesta = await peticion;
        const cookies = respuesta.headers['set-cookie'] ?? [];

        if (cookies.length > 0) {
            cookie = cookies.map(valor => valor.split(';')[0]).join('; ');
        }

        return { status: respuesta.status, body: respuesta.body, texto: respuesta.text };
    };
}

async function esperarPhp(veces = 60) {
    for (let intento = 0; intento < veces; intento += 1) {
        try {
            const respuesta = await fetch(`http://127.0.0.1:${PUERTO}/health.php`);

            if (respuesta.ok) {
                return;
            }
        } catch {
            // Aún no escucha.
        }

        await new Promise(resolver => setTimeout(resolver, 200));
    }

    throw new Error('El servidor PHP de pruebas no arrancó.');
}

test('paridad Node vs PHP en lecturas y validaciones', { skip: !HABILITADO, timeout: 180000 }, async () => {
    assert.ok(fs.existsSync(PHP), `No se encontró PHP en ${PHP}`);
    assert.ok(fs.existsSync(DOCROOT), `No se encontró el docroot ${DOCROOT}`);

    const php = spawn(PHP, ['-S', `127.0.0.1:${PUERTO}`, '-t', DOCROOT], {
        cwd: DOCROOT,
        stdio: 'ignore',
    });

    try {
        await esperarPhp();

        const base = `http://127.0.0.1:${PUERTO}`;
        const enPhp = clientePhp(base);
        const enNode = clienteNode();

        // --- Login real en ambos backends -------------------------------
        const loginPhp = await enPhp('/api_sesion.php?accion=login', {
            method: 'POST',
            body: JSON.stringify({ usuario: USUARIO, clave: CLAVE }),
        });
        const loginNode = await enNode('/api_sesion.php?accion=login', {
            method: 'POST',
            body: { usuario: USUARIO, clave: CLAVE },
        });

        assert.equal(loginPhp.status, 200, `PHP login: ${loginPhp.texto}`);
        assert.equal(loginNode.status, 200, `Node login: ${loginNode.texto}`);
        assert.equal(loginNode.body.exito, true);
        assert.equal(loginNode.body.usuario.usuario, loginPhp.body.usuario.usuario);
        assert.equal(loginNode.body.usuario.rol, loginPhp.body.usuario.rol);
        assert.equal(loginNode.body.usuario.usuario_id, loginPhp.body.usuario.usuario_id);

        // --- Login fallido: mismo código y mismo mensaje ----------------
        const maloPhp = await clientePhp(base)('/api_sesion.php?accion=login', {
            method: 'POST',
            body: JSON.stringify({ usuario: USUARIO, clave: 'clave-incorrecta' }),
        });
        const maloNode = await clienteNode()('/api_sesion.php?accion=login', {
            method: 'POST',
            body: { usuario: USUARIO, clave: 'clave-incorrecta' },
        });

        assert.equal(maloPhp.status, 401);
        assert.equal(maloNode.status, 401);
        assert.equal(maloNode.body.mensaje, maloPhp.body.mensaje);

        // --- Lecturas ----------------------------------------------------
        const lecturas = [
            '/health.php',
            '/api.php?accion=listar',
            '/api.php?accion=ultima_toma',
            '/api_activos.php?accion=listar',
            '/api_activos.php?accion=listar&tipo=CALLE',
            '/api_activos.php?accion=listar&tipo=TALLER',
            '/api_herramientas.php?accion=listar',
            '/api_herramientas.php?accion=movimientos',
            '/api_entradas.php?accion=listar',
            '/api_danados.php?accion=listar',
            '/api_historial.php?accion=usuarios',
            '/api_historial.php?accion=listar&limite=50',
            '/api_sesion.php?accion=estado',
        ];

        for (const ruta of lecturas) {
            const dePhp = ruta === '/health.php' ? null : await enPhp(ruta);
            const deNode = await enNode(ruta);

            assert.equal(deNode.status, 200, `Node ${ruta}: ${deNode.texto}`);

            if (ruta === '/health.php') {
                const dePhpHealth = await (await fetch(`${base}${ruta}`)).json();

                assert.equal(deNode.body.exito, dePhpHealth.exito);
                assert.equal(deNode.body.servicio, dePhpHealth.servicio);
                assert.equal(deNode.body.motor, dePhpHealth.motor);
                continue;
            }

            assert.equal(deNode.status, dePhp.status, `estado de ${ruta}`);
            assert.deepEqual(deNode.body, dePhp.body, `contenido de ${ruta}`);
        }

        // --- Validaciones de escritura (no tocan la base) ----------------
        const validaciones = [
            ['/api.php?accion=crear', {}],
            ['/api.php?accion=ajustar', { producto_id: 1, tipo: 'restar', cantidad: 0 }],
            ['/api_activos.php?accion=crear', { activo: '' }],
            ['/api_herramientas.php?accion=crear', { codigo: '', nombre: '' }],
            ['/api_entradas.php?accion=crear', { producto_id: 0, cantidad: 0 }],
            ['/api_danados.php?accion=crear', { producto_id: 0, cantidad: 0 }],
        ];

        for (const [ruta, cuerpo] of validaciones) {
            const dePhp = await enPhp(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });
            const deNode = await enNode(ruta, { method: 'POST', body: cuerpo });

            assert.equal(deNode.status, dePhp.status, `estado de ${ruta}`);
            assert.equal(deNode.body.exito, dePhp.body.exito, `exito de ${ruta}`);
            assert.equal(deNode.body.mensaje, dePhp.body.mensaje, `mensaje de ${ruta}`);
        }
    } finally {
        php.kill();
    }
});
