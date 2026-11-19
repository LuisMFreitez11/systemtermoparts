/**
 * Pruebas del cliente HTTP: la guardia anti doble clic debe compartir la misma
 * petición (y la misma X-Idempotency-Key) mientras la primera sigue en curso.
 *
 * El archivo es un IIFE de navegador; se evalúa con un `window` mínimo para
 * poder probarlo con node:test sin DOM real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FUENTE = path.resolve(AQUI, '..', '..', '..', 'frontend', 'js', 'api-client.js');

function crearNavegador() {
    const peticiones = [];

    const window = {
        WMS_CONFIG: { apiBase: '', tiempoEspera: 1000, intervaloCola: 999999 },
        crypto: { randomUUID: () => `clave-${peticiones.length + 1}-${Math.random().toString(36).slice(2)}` },
        setTimeout,
        clearTimeout,
        addEventListener() {},
        fetch(url, opciones) {
            peticiones.push({ url, opciones });

            return new Promise(resolver => {
                setTimeout(() => resolver({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ exito: true, orden: peticiones.length }),
                }), 25);
            });
        },
    };

    const document = { dispatchEvent() {} };
    const navigator = { onLine: true };

    const codigo = fs.readFileSync(FUENTE, 'utf8');

    // AbortController = undefined: evita señales en la prueba.
    const ejecutar = new Function('window', 'document', 'navigator', 'AbortController', codigo);

    ejecutar(window, document, navigator, undefined);

    return { window, peticiones };
}

test('dos envíos idénticos simultáneos comparten petición y clave', async () => {
    const { window, peticiones } = crearNavegador();

    const primera = window.apiFetch('/api.php?accion=crear', {
        method: 'POST',
        body: '{"sku":"A-1"}',
    });
    const segunda = window.apiFetch('/api.php?accion=crear', {
        method: 'POST',
        body: '{"sku":"A-1"}',
    });

    const [a, b] = await Promise.all([primera, segunda]);

    assert.equal(peticiones.length, 1, 'el doble clic debe producir UNA sola petición');
    assert.equal(a.status, 200);
    assert.deepEqual(a.datos, b.datos);

    const enviada = peticiones[0];
    assert.match(enviada.opciones.method, /POST/i);
    assert.match(enviada.opciones.headers['X-Idempotency-Key'], /^[\w.:-]{8,120}$/);
});

test('un envío posterior al primero sí se ejecuta (no es un doble clic)', async () => {
    const { window, peticiones } = crearNavegador();

    await window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"sku":"A-1"}' });
    await window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"sku":"A-1"}' });

    assert.equal(peticiones.length, 2, 'dos operaciones intencionales deben enviarse');
});

test('cuerpos distintos no se deduplican aunque sean simultáneos', async () => {
    const { window, peticiones } = crearNavegador();

    await Promise.all([
        window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"sku":"A-1"}' }),
        window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"sku":"B-2"}' }),
    ]);

    assert.equal(peticiones.length, 2);
});

test('las lecturas GET nunca se deduplican', async () => {
    const { window, peticiones } = crearNavegador();

    await Promise.all([
        window.apiFetch('/api.php?accion=listar'),
        window.apiFetch('/api.php?accion=listar'),
    ]);

    assert.equal(peticiones.length, 2);
});

test('una clave explícita (cola offline) no pasa por la guardia local', async () => {
    const { window, peticiones } = crearNavegador();

    await Promise.all([
        window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"x":1}', idempotencyKey: 'clave-explicita-01' }),
        window.apiFetch('/api.php?accion=crear', { method: 'POST', body: '{"x":1}', idempotencyKey: 'clave-explicita-01' }),
    ]);

    assert.equal(peticiones.length, 2);
    assert.equal(peticiones[0].opciones.headers['X-Idempotency-Key'], 'clave-explicita-01');
    assert.equal(peticiones[1].opciones.headers['X-Idempotency-Key'], 'clave-explicita-01');
});
