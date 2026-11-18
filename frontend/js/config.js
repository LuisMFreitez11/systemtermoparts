/**
 * Configuración del cliente.
 *
 * En local (XAMPP) la API vive en ../backend/public.
 * En producción (por ejemplo Vercel) define window.WMS_API_BASE antes de cargar
 * este archivo, o edita el valor por defecto de abajo.
 */
(function () {
    'use strict';

    var host = window.location.hostname;
    var esLocal = host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || /^192\.168\./.test(host)
        || /^10\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host);

    var meta = document.querySelector('meta[name="wms-api-base"]');
    var base = (meta && meta.getAttribute('content')) || window.WMS_API_BASE || '';

    if (!base) {
        base = esLocal ? '../backend/public' : '';
    }

    window.WMS_CONFIG = Object.assign({
        apiBase: String(base).replace(/\/+$/, ''),
        version: '2.0.0',
        // Tiempo máximo de espera antes de considerar la red caída (ms).
        tiempoEspera: 6000,
        // Tiempo máximo para navegaciones en el service worker.
        tiempoEsperaNavegacion: 4500,
        // Sincronización periódica de la cola (ms).
        intervaloCola: 30000
    }, window.WMS_CONFIG || {});
})();
