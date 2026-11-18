/* eslint-env serviceworker */
'use strict';

var VERSION = 'wms-2.0.0';
var CACHE = 'termopart-' + VERSION;

var RECURSOS = [
    './',
    './index.html',
    './login.html',
    './activos.html',
    './activos_taller.html',
    './entradas.html',
    './danados.html',
    './herramientas.html',
    './historial.html',
    './offline.html',
    './manifest.json',
    './css/estilos_cabecera.css',
    './css/estilos_movil.css',
    './js/config.js',
    './js/offline-db.js',
    './js/api-client.js',
    './js/app-shell.js',
    './js/auth.js',
    './js/movil.js',
    './assets/logo_termo_parts.jpg',
    './icons/icon.svg',
    './icons/icon-maskable.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (evento) {
    evento.waitUntil(
        caches.open(CACHE).then(function (cache) {
            return Promise.all(RECURSOS.map(function (recurso) {
                return cache.add(new Request(recurso, { cache: 'reload' })).catch(function () {
                    // Un recurso opcional puede faltar: no se rompe la instalación.
                });
            }));
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

self.addEventListener('activate', function (evento) {
    evento.waitUntil(
        caches.keys().then(function (claves) {
            return Promise.all(claves.map(function (clave) {
                if (clave !== CACHE && clave.indexOf('termopart-') === 0) {
                    return caches.delete(clave);
                }

                return null;
            }));
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener('message', function (evento) {
    if (evento.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

function conLimite(peticion, milisegundos) {
    return new Promise(function (resolver, rechazar) {
        var controlador = new AbortController();
        var temporizador = setTimeout(function () {
            controlador.abort();
            rechazar(new Error('Tiempo de espera agotado'));
        }, milisegundos);

        fetch(peticion, { signal: controlador.signal }).then(function (respuesta) {
            clearTimeout(temporizador);
            resolver(respuesta);
        }).catch(function (error) {
            clearTimeout(temporizador);
            rechazar(error);
        });
    });
}

async function responderNavegacion(evento) {
    var cache = await caches.open(CACHE);

    try {
        var respuesta = await conLimite(evento.request, 4500);

        if (respuesta && respuesta.ok) {
            cache.put(evento.request, respuesta.clone());
            return respuesta;
        }

        throw new Error('Respuesta no válida');
    } catch (error) {
        var guardada = await cache.match(evento.request, { ignoreSearch: true });

        if (guardada) {
            return guardada;
        }

        var inicio = await cache.match('./index.html');

        if (inicio) {
            return inicio;
        }

        return (await cache.match('./offline.html')) || new Response(
            '<!doctype html><meta charset="utf-8"><h1>Sin conexión</h1>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    }
}

async function responderRecurso(evento) {
    var cache = await caches.open(CACHE);
    var guardada = await cache.match(evento.request);

    if (guardada) {
        // Actualiza en segundo plano para la próxima visita.
        fetch(evento.request).then(function (respuesta) {
            if (respuesta && respuesta.ok) {
                cache.put(evento.request, respuesta.clone());
            }
        }).catch(function () { /* sin red */ });

        return guardada;
    }

    try {
        var respuesta = await fetch(evento.request);

        if (respuesta && respuesta.ok) {
            cache.put(evento.request, respuesta.clone());
        }

        return respuesta;
    } catch (error) {
        return new Response('', { status: 504, statusText: 'Sin conexión' });
    }
}

self.addEventListener('fetch', function (evento) {
    var peticion = evento.request;

    if (peticion.method !== 'GET') {
        return;
    }

    var destino = new URL(peticion.url);

    if (destino.origin !== self.location.origin) {
        return;
    }

    // La API se maneja en api-client.js (IndexedDB + cola). No se cachea aquí.
    if (destino.pathname.indexOf('/backend/public/') !== -1 || destino.pathname.indexOf('/api/') !== -1) {
        return;
    }

    if (peticion.mode === 'navigate') {
        evento.respondWith(responderNavegacion(evento));
        return;
    }

    evento.respondWith(responderRecurso(evento));
});
