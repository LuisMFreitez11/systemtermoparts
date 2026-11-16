/**
 * Adaptación a celulares.
 * Copia el nombre de cada columna (thead) a cada celda (data-etiqueta) para que
 * en pantallas pequeñas las tablas se puedan mostrar como tarjetas.
 * Funciona también con las tablas que se vuelven a dibujar al filtrar o cargar.
 */
(function () {
    'use strict';

    let pendiente = false;

    function esPantallaPequena() {
        return typeof window.matchMedia === 'function'
            ? window.matchMedia('(max-width: 900px)').matches
            : window.innerWidth <= 900;
    }

    function etiquetarTablas() {
        pendiente = false;

        if (!esPantallaPequena()) {
            return;
        }

        document.querySelectorAll('table').forEach(tabla => {
            const encabezados = [...tabla.querySelectorAll('thead th')].map(th =>
                (th.textContent || '').replace(/\s+/g, ' ').trim()
            );

            if (encabezados.length === 0) {
                return;
            }

            tabla.querySelectorAll('tbody tr').forEach(fila => {
                [...fila.children].forEach((celda, indice) => {
                    if (celda.tagName !== 'TD' || celda.hasAttribute('colspan')) {
                        return;
                    }

                    const etiqueta = encabezados[indice];

                    if (etiqueta && celda.getAttribute('data-etiqueta') !== etiqueta) {
                        celda.setAttribute('data-etiqueta', etiqueta);
                    }
                });
            });

            if (tabla.getAttribute('data-movil-listo') !== '1') {
                tabla.setAttribute('data-movil-listo', '1');
            }
        });
    }

    function programarEtiquetado() {
        if (pendiente) {
            return;
        }

        pendiente = true;
        window.setTimeout(etiquetarTablas, 0);
    }

    document.addEventListener('DOMContentLoaded', () => {
        etiquetarTablas();

        const observador = new MutationObserver(programarEtiquetado);
        observador.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('resize', programarEtiquetado);
        window.addEventListener('orientationchange', programarEtiquetado);
    });
})();
