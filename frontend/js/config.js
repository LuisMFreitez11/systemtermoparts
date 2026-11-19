/**
 * Configuración del cliente.
 *
 * Por defecto la API vive en el MISMO origen:
 *   - local: `pnpm start` sirve `frontend/` y la API en http://localhost:3000
 *   - Vercel: la plataforma sirve `frontend/` y las funciones `/api/*`
 *
 * Si la API está en otro dominio (por ejemplo el backend PHP archivado), define
 * `window.WMS_API_BASE` antes de cargar este archivo, o usa la metaetiqueta
 * `<meta name="wms-api-base" content="https://api.ejemplo.com/backend/public">`.
 */
(function () {
    'use strict';

    var meta = document.querySelector('meta[name="wms-api-base"]');
    var base = (meta && meta.getAttribute('content')) || window.WMS_API_BASE || '';

    window.WMS_CONFIG = Object.assign({
        // Sin barra final: las rutas se concatenan con `/`.
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
