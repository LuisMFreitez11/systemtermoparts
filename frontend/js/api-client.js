/**
 * Cliente HTTP del WMS.
 *
 * - GET: red primero, con tiempo máximo; si falla usa la copia guardada.
 * - POST: si no hay red (o la red falla) se guarda en una cola FIFO.
 * - Cada escritura lleva X-Idempotency-Key para que el reintento no duplique.
 *
 * Expone window.apiFetch(ruta, opciones) y window.WmsApi.
 */
(function () {
    'use strict';

    var cfg = window.WMS_CONFIG || {};
    var base = String(cfg.apiBase || '').replace(/\/+$/, '');
    var sincronizando = false;
    var temporizador = null;

    function url(ruta) {
        ruta = String(ruta || '');

        if (/^https?:\/\//i.test(ruta)) {
            return ruta;
        }

        return (base ? base + '/' : '') + ruta.replace(/^\/+/, '');
    }

    function generarClave() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        var partes = [];
        partes.push(Date.now().toString(36));

        for (var i = 0; i < 4; i += 1) {
            partes.push(Math.random().toString(36).slice(2, 8));
        }

        return partes.join('-');
    }

    function RespuestaApi(status, datos, extra) {
        extra = extra || {};
        this.status = status;
        this.ok = status >= 200 && status < 300;
        this.datos = datos;
        this.desdeCache = Boolean(extra.desdeCache);
        this.pendiente = Boolean(extra.pendiente);
        this.offline = Boolean(extra.offline);
        this.encoladaId = extra.encoladaId || null;
    }

    RespuestaApi.prototype.json = function () {
        return Promise.resolve(this.datos);
    };

    RespuestaApi.prototype.text = function () {
        return Promise.resolve(typeof this.datos === 'string' ? this.datos : JSON.stringify(this.datos));
    };

    function leerJson(respuesta) {
        return respuesta.json().catch(function () {
            return null;
        });
    }

    function pedir(urlFinal, opciones) {
        var limite = Number(cfg.tiempoEspera || 6000);
        var controlador = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var config = Object.assign({}, opciones);

        if (controlador) {
            config.signal = controlador.signal;
        }

        var temporizadorRed = controlador
            ? window.setTimeout(function () { controlador.abort(); }, limite)
            : null;

        return window.fetch(urlFinal, config).finally(function () {
            if (temporizadorRed) {
                window.clearTimeout(temporizadorRed);
            }
        });
    }

    function accionDe(ruta) {
        var coincidencia = /[?&]accion=([^&]+)/.exec(ruta);
        return coincidencia ? decodeURIComponent(coincidencia[1]) : '';
    }

    function describir(ruta) {
        var archivo = String(ruta).split('?')[0].replace(/^.*\//, '');
        var accion = accionDe(ruta);
        return accion ? archivo + ' · ' + accion : archivo;
    }

    function avisarCola() {
        if (!window.WmsDB) {
            return;
        }

        window.WmsDB.contarPendientes().then(function (total) {
            document.dispatchEvent(new CustomEvent('wms:cola', { detail: { pendientes: total } }));
        });
    }

    function encolar(urlFinal, ruta, metodo, cuerpo, cabeceras, clave) {
        var operacion = {
            url: urlFinal,
            ruta: ruta,
            metodo: metodo,
            cuerpo: cuerpo === undefined ? null : cuerpo,
            cabeceras: cabeceras,
            clave: clave,
            estado: 'pendiente',
            intentos: 0,
            descripcion: describir(ruta),
            creadoEn: Date.now()
        };

        return window.WmsDB.encolar(operacion).then(function (id) {
            avisarCola();

            return new RespuestaApi(202, {
                exito: true,
                pendiente: true,
                mensaje: 'Guardado en el dispositivo. Se enviará automáticamente al volver la conexión.'
            }, { pendiente: true, offline: true, encoladaId: id });
        });
    }

    function apiFetch(ruta, opciones) {
        opciones = Object.assign({}, opciones || {});

        var metodo = String(opciones.method || 'GET').toUpperCase();
        var esLectura = metodo === 'GET';
        var permiteCola = opciones.queue !== false && !esLectura;
        var urlFinal = url(ruta);
        var cabeceras = {};

        Object.keys(opciones.headers || {}).forEach(function (nombre) {
            cabeceras[nombre] = opciones.headers[nombre];
        });

        if (!Object.keys(cabeceras).some(function (n) { return n.toLowerCase() === 'accept'; })) {
            cabeceras.Accept = 'application/json';
        }

        var clave = null;

        if (permiteCola) {
            clave = opciones.idempotencyKey || generarClave();
            cabeceras['X-Idempotency-Key'] = clave;
        }

        var config = {
            method: metodo,
            headers: cabeceras,
            credentials: 'include',
            cache: opciones.cache || 'no-store',
            body: opciones.body
        };

        var sinRed = typeof navigator !== 'undefined' && navigator.onLine === false;

        if (sinRed) {
            if (esLectura) {
                return desdeCache(urlFinal).then(function (respuesta) {
                    return respuesta || sinCopia();
                });
            }

            if (permiteCola) {
                return encolar(urlFinal, ruta, metodo, config.body, cabeceras, clave);
            }

            return Promise.resolve(new RespuestaApi(503, {
                exito: false,
                mensaje: 'No hay conexión a internet. Intenta de nuevo cuando vuelva la señal.',
                offline: true
            }, { offline: true }));
        }

        return pedir(urlFinal, config).then(function (respuesta) {
            return leerJson(respuesta).then(function (datos) {
                if (esLectura && respuesta.ok && window.WmsDB) {
                    window.WmsDB.guardarRespuesta(urlFinal, { datos: datos, status: respuesta.status });
                }

                if (respuesta.status === 401 && datos && datos.no_autenticado) {
                    document.dispatchEvent(new CustomEvent('wms:sesion-expirada'));
                }

                if (permiteCola && ruta.indexOf('accion=logout') !== -1 && respuesta.ok) {
                    window.WmsDB.limpiarRespuestas();
                }

                if (esLectura && respuesta.status >= 500) {
                    // El servidor está caído o saturado: mejor mostrar la última copia.
                    return desdeCache(urlFinal).then(function (guardada) {
                        return guardada || new RespuestaApi(respuesta.status, datos);
                    });
                }

                return new RespuestaApi(respuesta.status, datos);
            });
        }).catch(function (error) {
            if (error && error.name === 'AbortError') {
                // Tiempo de espera agotado: se trata como red caída.
            }

            if (esLectura) {
                return desdeCache(urlFinal).then(function (respuesta) {
                    if (respuesta) {
                        return respuesta;
                    }

                    return new RespuestaApi(503, {
                        exito: false,
                        mensaje: 'Sin conexión y sin copia guardada de estos datos. Vuelve a intentar cuando haya señal.',
                        offline: true
                    }, { offline: true });
                });
            }

            if (permiteCola) {
                return encolar(urlFinal, ruta, metodo, config.body, cabeceras, clave);
            }

            return new RespuestaApi(503, {
                exito: false,
                mensaje: 'No se pudo conectar con el servidor. Revisa tu conexión.',
                offline: true
            }, { offline: true });
        });
    }

    function sinCopia() {
        return new RespuestaApi(503, {
            exito: false,
            mensaje: 'Sin conexión y sin copia guardada de estos datos. Vuelve a intentar cuando haya señal.',
            offline: true
        }, { offline: true });
    }

    function desdeCache(urlFinal) {        if (!window.WmsDB) {
            return Promise.resolve(new RespuestaApi(503, {
                exito: false,
                mensaje: 'Sin conexión y sin almacenamiento local disponible.',
                offline: true
            }, { offline: true }));
        }

        return window.WmsDB.leerRespuesta(urlFinal).then(function (registro) {
            if (!registro || registro.datos === undefined) {
                return null;
            }

            return new RespuestaApi(registro.status || 200, registro.datos, { desdeCache: true });
        });
    }

    /**
     * Envía la cola en orden. Se detiene ante fallos de red para no perder el
     * orden ni martillar el servidor; marca como "error" lo que el servidor
     * rechaza de forma definitiva (4xx).
     */
    function sincronizar() {
        if (sincronizando || !window.WmsDB || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
            return Promise.resolve({ aplicadas: 0, pendientes: 0 });
        }

        sincronizando = true;
        document.dispatchEvent(new CustomEvent('wms:sync-inicio'));

        var aplicadas = 0;

        return window.WmsDB.pendientes().then(function (filas) {
            var pendientes = filas.filter(function (fila) { return fila.estado !== 'error'; });

            function siguiente(indice) {
                if (indice >= pendientes.length) {
                    return Promise.resolve();
                }

                var operacion = pendientes[indice];

                return pedir(operacion.url, {
                    method: operacion.metodo,
                    headers: Object.assign({}, operacion.cabeceras, { 'X-Idempotency-Key': operacion.clave }),
                    credentials: 'include',
                    body: operacion.cuerpo
                }).then(function (respuesta) {
                    return leerJson(respuesta).then(function (datos) {
                        var rechazoDefinitivo = respuesta.status >= 400
                            && respuesta.status < 500
                            && respuesta.status !== 401
                            && respuesta.status !== 408
                            && respuesta.status !== 429;

                        if (respuesta.ok && (!datos || datos.exito !== false)) {
                            aplicadas += 1;

                            return window.WmsDB.quitarDeCola(operacion.id).then(function () {
                                return siguiente(indice + 1);
                            });
                        }

                        if (respuesta.status === 401) {
                            return Promise.reject(new Error('sesion'));
                        }

                        if (rechazoDefinitivo) {
                            return window.WmsDB.actualizar(operacion.id, {
                                estado: 'error',
                                intentos: (operacion.intentos || 0) + 1,
                                error: (datos && datos.mensaje) || ('HTTP ' + respuesta.status)
                            }).then(function () {
                                return siguiente(indice + 1);
                            });
                        }

                        return Promise.reject(new Error('reintentar'));
                    });
                });
            }

            return siguiente(0);
        }).catch(function (error) {
            if (error && error.message === 'sesion') {
                document.dispatchEvent(new CustomEvent('wms:sesion-expirada'));
            }
        }).then(function () {
            sincronizando = false;

            if (aplicadas > 0 && window.WmsDB) {
                return window.WmsDB.limpiarRespuestas().then(function () {
                    return window.WmsDB.contarPendientes();
                }).then(function (pendientes) {
                    document.dispatchEvent(new CustomEvent('wms:sync-fin', {
                        detail: { aplicadas: aplicadas, pendientes: pendientes }
                    }));
                    avisarCola();

                    return { aplicadas: aplicadas, pendientes: pendientes };
                });
            }

            return window.WmsDB.contarPendientes().then(function (pendientes) {
                document.dispatchEvent(new CustomEvent('wms:sync-fin', {
                    detail: { aplicadas: 0, pendientes: pendientes }
                }));
                avisarCola();

                return { aplicadas: 0, pendientes: pendientes };
            });
        });
    }

    function programarSincronizacion() {
        if (temporizador) {
            window.clearInterval(temporizador);
        }

        temporizador = window.setInterval(function () {
            if (navigator.onLine) {
                sincronizar();
            }
        }, Number(cfg.intervaloCola || 30000));
    }

    window.addEventListener('online', function () {
        sincronizar();
    });

    window.addEventListener('load', function () {
        programarSincronizacion();
        window.setTimeout(function () { sincronizar(); }, 1500);
    });

    window.apiFetch = apiFetch;
    window.WmsApi = {
        url: url,
        apiFetch: apiFetch,
        sincronizar: sincronizar,
        generarClave: generarClave,
        pendientes: function () {
            return window.WmsDB ? window.WmsDB.contarPendientes() : Promise.resolve(0);
        },
        RespuestaApi: RespuestaApi
    };
})();
