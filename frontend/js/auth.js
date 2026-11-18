/**
 * Autenticación del lado del cliente.
 * - Consulta la sesión activa y redirige al login si no hay usuario.
 * - Intercepta respuestas 401 de las APIs para cerrar la pantalla.
 * - Muestra el usuario conectado y los accesos a historial / cerrar sesión.
 */
(function () {
    'use strict';

    const enLogin = /login\.html$/i.test(window.location.pathname);
    let usuarioActual = null;
    let redirigiendo = false;

    function escaparHtml(valor) {
        return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[caracter]);
    }

    function urlLogin() {
        const destino = window.location.pathname.split('/').pop() + window.location.search;
        return 'login.html?redirect=' + encodeURIComponent(destino || 'index.html');
    }

    function redirigirLogin() {
        if (enLogin || redirigiendo) {
            return;
        }

        redirigiendo = true;
        window.location.replace(urlLogin());
    }

    async function consultarEstado() {
        try {
            const res = await apiFetch('api_sesion.php?accion=estado', {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' }
            });

            const datos = await res.json().catch(() => null);

            if (!res.ok || !datos || !datos.autenticado) {
                usuarioActual = null;
                redirigirLogin();
                return null;
            }

            usuarioActual = datos.usuario;
            return usuarioActual;
        } catch (error) {
            usuarioActual = null;
            redirigirLogin();
            return null;
        }
    }

    async function cerrarSesion() {
        if (!confirm('¿Cerrar la sesión actual?')) {
            return;
        }

        try {
            await apiFetch('api_sesion.php?accion=logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                queue: false
            });
        } catch (error) {
            // Aun si falla la petición, se limpia la pantalla y se vuelve al login.
        }

        try {
            if (window.WmsDB) {
                await window.WmsDB.limpiarRespuestas();
            }
            if (window.sessionStorage) {
                window.sessionStorage.removeItem('wms:usuario');
            }
        } catch (error) {
            // Sin almacenamiento: se ignora.
        }

        window.location.replace('login.html');
    }

    async function cambiarClave() {
        const claveActual = prompt('Escribe tu clave actual:');

        if (claveActual === null) {
            return;
        }

        const claveNueva = prompt('Escribe la nueva clave (mínimo 6 caracteres):');

        if (claveNueva === null) {
            return;
        }

        if (claveNueva.length < 6) {
            alert('La nueva clave debe tener al menos 6 caracteres.');
            return;
        }

        const repetir = prompt('Repite la nueva clave:');

        if (repetir === null) {
            return;
        }

        if (repetir !== claveNueva) {
            alert('Las claves nuevas no coinciden.');
            return;
        }

        try {
            const res = await apiFetch('api_sesion.php?accion=cambiar_clave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clave_actual: claveActual, clave_nueva: claveNueva })
            });

            const datos = await res.json().catch(() => null);

            if (!datos) {
                throw new Error('Respuesta inválida del servidor.');
            }

            if (!res.ok || !datos.exito) {
                throw new Error(datos.mensaje || 'No se pudo cambiar la clave.');
            }

            alert(datos.mensaje || 'Clave actualizada correctamente.');
        } catch (error) {
            alert('Error: ' + error.message);
        }
    }

    function inyectarEstilos() {
        if (document.getElementById('authEstilos')) {
            return;
        }

        const estilo = document.createElement('style');
        estilo.id = 'authEstilos';
        estilo.textContent = `
            .auth-usuario { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
                border-radius: 6px; background: #e0f2fe; color: #075985; font-size: 13px; font-weight: 700;
                white-space: nowrap; }
            .auth-usuario small { font-weight: 600; color: #0369a1; }
            .btn-auth-historial { background: #475569; color: white; }
            .btn-auth-clave { background: #f1f5f9; color: #334155; }
            .btn-auth-salir { background: #e2e8f0; color: #334155; }
        `;
        document.head.appendChild(estilo);
    }

    function pintarBarraUsuario() {
        if (!usuarioActual) {
            return;
        }

        const grupo = document.querySelector('[data-auth]') || document.querySelector('.btn-group');
        if (!grupo || grupo.dataset.authListo === '1') {
            return;
        }

        const nombre = usuarioActual.nombre_completo || usuarioActual.usuario;
        const rol = usuarioActual.rol === 'ADMIN' ? 'Administrador' : 'Usuario';

        const contenedor = document.createElement('span');
        contenedor.className = 'auth-usuario';
        contenedor.innerHTML = `👤 ${escaparHtml(nombre)} <small>(${escaparHtml(rol)})</small>`;

        const historial = document.createElement('a');
        historial.href = 'historial.html';
        historial.className = 'btn btn-auth-historial';
        historial.textContent = '🕘 Mi historial';

        const salir = document.createElement('button');
        salir.type = 'button';
        salir.className = 'btn btn-auth-salir';
        salir.textContent = 'Cerrar sesión';
        salir.addEventListener('click', cerrarSesion);

        const clave = document.createElement('button');
        clave.type = 'button';
        clave.className = 'btn btn-auth-clave';
        clave.textContent = '🔑 Cambiar clave';
        clave.addEventListener('click', cambiarClave);

        grupo.appendChild(contenedor);
        if (!/historial\.html$/i.test(window.location.pathname)) {
            grupo.appendChild(historial);
        }
        grupo.appendChild(clave);
        grupo.appendChild(salir);
        grupo.dataset.authListo = '1';
    }

    // Cualquier API que responda 401 con "no_autenticado" devuelve al login.
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const respuesta = await fetchOriginal(...args);

        if (respuesta.status === 401) {
            try {
                const copia = respuesta.clone();
                const datos = await copia.json();

                if (datos && datos.no_autenticado) {
                    redirigirLogin();
                }
            } catch (error) {
                // La respuesta no era JSON; se deja pasar.
            }
        }

        return respuesta;
    };

    const listo = consultarEstado().then(usuario => {
        if (usuario) {
            inyectarEstilos();
            pintarBarraUsuario();
            document.dispatchEvent(new CustomEvent('auth-listo', { detail: usuario }));
        }

        return usuario;
    });

    window.Auth = {
        listo,
        get usuario() {
            return usuarioActual;
        },
        get esAdmin() {
            return usuarioActual !== null && usuarioActual.rol === 'ADMIN';
        },
        cerrarSesion,
        cambiarClave
    };

    document.addEventListener('DOMContentLoaded', () => {
        if (usuarioActual) {
            inyectarEstilos();
            pintarBarraUsuario();
        }
    });

    listo.then(() => {
        // Si la consulta terminó después del DOMContentLoaded, se pinta igualmente.
        if (usuarioActual) {
            inyectarEstilos();
            pintarBarraUsuario();
        }
    });
})();
