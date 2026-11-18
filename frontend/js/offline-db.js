/**
 * Almacenamiento local del WMS: respuestas cacheadas y cola de escrituras.
 *
 * Usa IndexedDB cuando está disponible y cae a localStorage en navegadores
 * antiguos o en modo privado restringido. Todo el API es asíncrono.
 */
(function () {
    'use strict';

    var NOMBRE = 'termopart-wms';
    var VERSION = 1;
    var ALMACENES = { respuestas: 'respuestas', cola: 'cola', meta: 'meta' };
    var prefijoLocal = 'wms:';
    var disponible = typeof indexedDB !== 'undefined';
    var promesaBd = null;

    function abrir() {
        if (!disponible) {
            return Promise.reject(new Error('IndexedDB no disponible'));
        }

        if (promesaBd) {
            return promesaBd;
        }

        promesaBd = new Promise(function (resolver, rechazar) {
            var solicitud = indexedDB.open(NOMBRE, VERSION);

            solicitud.onupgradeneeded = function (evento) {
                var bd = evento.target.result;

                if (!bd.objectStoreNames.contains(ALMACENES.respuestas)) {
                    bd.createObjectStore(ALMACENES.respuestas, { keyPath: 'url' });
                }

                if (!bd.objectStoreNames.contains(ALMACENES.cola)) {
                    var cola = bd.createObjectStore(ALMACENES.cola, { keyPath: 'id', autoIncrement: true });
                    cola.createIndex('estado', 'estado', { unique: false });
                }

                if (!bd.objectStoreNames.contains(ALMACENES.meta)) {
                    bd.createObjectStore(ALMACENES.meta, { keyPath: 'clave' });
                }
            };

            solicitud.onsuccess = function () {
                var bd = solicitud.result;

                bd.onversionchange = function () {
                    bd.close();
                    promesaBd = null;
                };

                resolver(bd);
            };

            solicitud.onerror = function () {
                disponible = false;
                rechazar(solicitud.error);
            };
        });

        return promesaBd;
    }

    function transaccion(almacen, modo, accion) {
        return abrir().then(function (bd) {
            return new Promise(function (resolver, rechazar) {
                var tx = bd.transaction(almacen, modo);
                var peticion = accion(tx.objectStore(almacen));

                tx.oncomplete = function () {
                    resolver(peticion && 'result' in peticion ? peticion.result : undefined);
                };
                tx.onerror = function () {
                    rechazar(tx.error);
                };
                tx.onabort = function () {
                    rechazar(tx.error || new Error('Transacción cancelada'));
                };
            });
        });
    }

    function local(clave, valor) {
        try {
            if (valor === undefined) {
                var bruto = localStorage.getItem(prefijoLocal + clave);
                return bruto === null ? null : JSON.parse(bruto);
            }

            if (valor === null) {
                localStorage.removeItem(prefijoLocal + clave);
            } else {
                localStorage.setItem(prefijoLocal + clave, JSON.stringify(valor));
            }
        } catch (error) {
            // Sin almacenamiento disponible: se ignora.
        }

        return null;
    }

    var DB = {
        disponible: function () {
            return disponible;
        },

        guardarRespuesta: function (url, registro) {
            registro.url = url;
            registro.guardadoEn = Date.now();

            return transaccion(ALMACENES.respuestas, 'readwrite', function (store) {
                return store.put(registro);
            }).catch(function () {
                local('respuesta:' + url, registro);
            });
        },

        leerRespuesta: function (url) {
            return transaccion(ALMACENES.respuestas, 'readonly', function (store) {
                return store.get(url);
            }).then(function (registro) {
                return registro || local('respuesta:' + url);
            }).catch(function () {
                return local('respuesta:' + url);
            });
        },

        limpiarRespuestas: function () {
            return transaccion(ALMACENES.respuestas, 'readwrite', function (store) {
                return store.clear();
            }).catch(function () {
                try {
                    Object.keys(localStorage)
                        .filter(function (k) { return k.indexOf(prefijoLocal + 'respuesta:') === 0; })
                        .forEach(function (k) { localStorage.removeItem(k); });
                } catch (error) { /* ignorar */ }
            });
        },

        encolar: function (operacion) {
            return transaccion(ALMACENES.cola, 'readwrite', function (store) {
                return store.add(operacion);
            }).catch(function () {
                var cola = local('cola') || [];
                operacion.id = (cola.length ? cola[cola.length - 1].id : 0) + 1;
                cola.push(operacion);
                local('cola', cola);
                return operacion.id;
            });
        },

        pendientes: function () {
            return transaccion(ALMACENES.cola, 'readonly', function (store) {
                return store.getAll();
            }).then(function (filas) {
                return (filas || []).sort(function (a, b) { return a.id - b.id; });
            }).catch(function () {
                return (local('cola') || []).sort(function (a, b) { return a.id - b.id; });
            });
        },

        contarPendientes: function () {
            return DB.pendientes().then(function (filas) {
                return filas.filter(function (f) { return f.estado !== 'error'; }).length;
            });
        },

        actualizar: function (id, cambios) {
            function aplicar(fila) {
                return Object.assign({}, fila, cambios);
            }

            return transaccion(ALMACENES.cola, 'readwrite', function (store) {
                var solicitud = store.get(id);

                solicitud.onsuccess = function () {
                    if (solicitud.result) {
                        store.put(aplicar(solicitud.result));
                    }
                };

                return solicitud;
            }).catch(function () {
                var cola = local('cola') || [];
                local('cola', cola.map(function (fila) {
                    return fila.id === id ? aplicar(fila) : fila;
                }));
            });
        },

        quitarDeCola: function (id) {
            return transaccion(ALMACENES.cola, 'readwrite', function (store) {
                return store.delete(id);
            }).catch(function () {
                local('cola', (local('cola') || []).filter(function (fila) { return fila.id !== id; }));
            });
        },

        guardarMeta: function (clave, valor) {
            return transaccion(ALMACENES.meta, 'readwrite', function (store) {
                return store.put({ clave: clave, valor: valor });
            }).catch(function () {
                local('meta:' + clave, valor);
            });
        },

        leerMeta: function (clave) {
            return transaccion(ALMACENES.meta, 'readonly', function (store) {
                return store.get(clave);
            }).then(function (fila) {
                return fila ? fila.valor : local('meta:' + clave);
            }).catch(function () {
                return local('meta:' + clave);
            });
        }
    };

    window.WmsDB = DB;
})();
