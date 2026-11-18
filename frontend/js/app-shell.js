/**
 * Indicador de estado de conexión y sincronización + registro del service worker.
 */
(function () {
    'use strict';

    var estado = {
        online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        pendientes: 0,
        errores: 0,
        sincronizando: false,
        aplicadas: 0
    };

    var barra = null;
    var texto = null;
    var boton = null;
    var estiloInyectado = false;

    function inyectarEstilo() {
        if (estiloInyectado) {
            return;
        }

        var estilo = document.createElement('style');
        estilo.id = 'wmsBarraEstilos';
        estilo.textContent = [
            '.wms-barra{position:fixed;right:14px;bottom:14px;z-index:2147483000;',
            'display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:999px;',
            'font:600 12.5px/1.2 "Segoe UI",Tahoma,sans-serif;box-shadow:0 6px 18px rgba(15,23,42,.22);',
            'background:#0f172a;color:#e2e8f0;max-width:calc(100vw - 28px);}',
            '.wms-barra[data-estado="online"]{background:#065f46;color:#d1fae5;}',
            '.wms-barra[data-estado="offline"]{background:#7f1d1d;color:#fee2e2;}',
            '.wms-barra[data-estado="pendiente"]{background:#78350f;color:#fef3c7;}',
            '.wms-barra[data-estado="error"]{background:#7f1d1d;color:#fee2e2;}',
            '.wms-barra button{border:0;border-radius:999px;padding:5px 10px;font:inherit;cursor:pointer;',
            'background:rgba(255,255,255,.18);color:inherit;}',
            '.wms-barra button:hover{background:rgba(255,255,255,.3);}',
            '.wms-barra .wms-punto{width:8px;height:8px;border-radius:50%;background:currentColor;',
            'box-shadow:0 0 0 3px rgba(255,255,255,.15);}',
            '@media print{.wms-barra{display:none;}}'
        ].join('');
        document.head.appendChild(estilo);
        estiloInyectado = true;
    }

    function crearBarra() {
        if (barra || !document.body) {
            return;
        }

        inyectarEstilo();

        barra = document.createElement('div');
        barra.className = 'wms-barra';
        barra.setAttribute('role', 'status');
        barra.setAttribute('aria-live', 'polite');

        var punto = document.createElement('span');
        punto.className = 'wms-punto';

        texto = document.createElement('span');

        boton = document.createElement('button');
        boton.type = 'button';
        boton.textContent = 'Sincronizar';
        boton.hidden = true;
        boton.addEventListener('click', function () {
            estado.sincronizando = true;
            boton.disabled = true;
            pintar();
            window.WmsApi.sincronizar().then(function () {
                boton.disabled = false;
            });
        });

        barra.appendChild(punto);
        barra.appendChild(texto);
        barra.appendChild(boton);
        document.body.appendChild(barra);
        pintar();
    }

    function pintar() {
        if (!barra) {
            return;
        }

        var modo = 'online';
        var mensaje = 'Conectado';

        if (!estado.online) {
            modo = 'offline';
            mensaje = 'Sin conexión · modo offline';
        }

        if (estado.pendientes > 0) {
            modo = estado.online ? 'pendiente' : 'offline';
            mensaje = estado.pendientes + ' cambio' + (estado.pendientes === 1 ? '' : 's') + ' por enviar';
        }

        if (estado.errores > 0) {
            modo = 'error';
            mensaje = estado.errores + ' operación' + (estado.errores === 1 ? '' : 'es') + ' con error';
        }

        if (estado.sincronizando) {
            mensaje = 'Sincronizando…';
        } else if (estado.aplicadas > 0 && estado.pendientes === 0) {
            modo = 'online';
            mensaje = estado.aplicadas + ' cambio' + (estado.aplicadas === 1 ? '' : 's') + ' sincronizado' + (estado.aplicadas === 1 ? '' : 's');
        }

        barra.dataset.estado = modo;
        texto.textContent = mensaje;
        boton.hidden = !(estado.online && (estado.pendientes > 0 || estado.errores > 0));

        var todoEnOrden = estado.online
            && !estado.sincronizando
            && estado.pendientes === 0
            && estado.errores === 0
            && estado.aplicadas === 0;

        barra.style.display = todoEnOrden ? 'none' : 'flex';
    }

    function refrescar() {
        if (!window.WmsDB) {
            return;
        }

        window.WmsDB.pendientes().then(function (filas) {
            estado.pendientes = filas.filter(function (f) { return f.estado !== 'error'; }).length;
            estado.errores = filas.filter(function (f) { return f.estado === 'error'; }).length;
            pintar();
        });
    }

    function recargarSiEsSeguro() {
        var activo = document.activeElement;
        var escribiendo = activo && /^(INPUT|TEXTAREA|SELECT)$/.test(activo.tagName);
        var modalAbierto = Array.prototype.some.call(
            document.querySelectorAll('.modal'),
            function (m) { return m.style.display && m.style.display !== 'none'; }
        );

        if (!escribiendo && !modalAbierto) {
            window.location.reload();
        }
    }

    function conectarEventos() {
        window.addEventListener('online', function () {
            estado.online = true;
            estado.aplicadas = 0;
            pintar();
            window.WmsApi.sincronizar();
        });

        window.addEventListener('offline', function () {
            estado.online = false;
            pintar();
            refrescar();
        });

        document.addEventListener('wms:cola', function (evento) {
            estado.pendientes = evento.detail.pendientes;
            pintar();
        });

        document.addEventListener('wms:sync-inicio', function () {
            estado.sincronizando = true;
            estado.aplicadas = 0;
            pintar();
        });

        document.addEventListener('wms:sync-fin', function (evento) {
            estado.sincronizando = false;
            estado.aplicadas = evento.detail.aplicadas;
            estado.pendientes = evento.detail.pendientes;
            pintar();
            refrescar();

            if (evento.detail.aplicadas > 0) {
                window.setTimeout(function () {
                    recargarSiEsSeguro();
                }, 2500);

                window.setTimeout(function () {
                    estado.aplicadas = 0;
                    pintar();
                }, 9000);
            }
        });

        document.addEventListener('wms:sesion-expirada', function () {
            if (!/login\.html$/i.test(window.location.pathname)) {
                window.location.replace('login.html?motivo=sesion');
            }
        });
    }

    function registrarServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            return;
        }

        var esSeguro = window.location.protocol === 'https:'
            || window.location.hostname === 'localhost'
            || window.location.hostname === '127.0.0.1';

        if (!esSeguro) {
            return;
        }

        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function (error) {
                if (window.console && console.warn) {
                    console.warn('No se pudo registrar el service worker:', error);
                }
            });
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        crearBarra();
        conectarEventos();
        refrescar();
        registrarServiceWorker();
    });

    window.addEventListener('load', function () {
        if (!barra) {
            crearBarra();
        }

        refrescar();
    });
})();
