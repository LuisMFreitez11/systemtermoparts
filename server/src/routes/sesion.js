/**
 * Endpoint `/api_sesion.php`: estado, login, logout y cambio de clave.
 *
 * Importante: aquí NO se aplica idempotencia. Repetir un login con la misma
 * clave devolvería la respuesta guardada sin `Set-Cookie` y el usuario quedaría
 * sin sesión; y un logout repetido no debe romper nada.
 */
import express from 'express';
import { db } from '../db.js';
import { json, error, parametro, cuerpo } from '../http.js';
import {
    requireSession, establecerSesion, limpiarSesion, login, cambiarClave,
} from '../auth.js';
import { registrar, ipCliente } from '../audit.js';

const router = express.Router();
const ACCIONES = new Set(['estado', 'login', 'logout', 'cambiar_clave']);
const POST = new Set(['login', 'logout', 'cambiar_clave']);

router.all('/', async (req, res) => {
    const accion = parametro(req, 'accion');

    if (!ACCIONES.has(accion)) {
        error(res, 400, 'Acción no válida.');
        return;
    }

    if (POST.has(accion) && req.method !== 'POST') {
        error(res, 405, 'Esta acción requiere el método POST.');
        return;
    }

    if (accion === 'estado') {
        json(res, 200, { autenticado: req.usuario !== null, usuario: req.usuario });
        return;
    }

    const data = cuerpo(req);

    if (accion === 'login') {
        const resultado = await login(db, data.usuario, data.clave);

        if (!resultado.ok) {
            error(res, resultado.status, resultado.mensaje);
            return;
        }

        establecerSesion(req, res, resultado.usuario);

        await registrar(db, {
            accion: 'INICIO_SESION',
            detalle: 'Ingresó al sistema',
            usuario: resultado.usuario,
            ip: ipCliente(req),
        });

        json(res, 200, {
            exito: true,
            mensaje: resultado.mensaje,
            usuario: resultado.usuario,
        });
        return;
    }

    if (accion === 'logout') {
        if (req.usuario) {
            await registrar(db, {
                accion: 'CIERRE_SESION',
                detalle: 'Salió del sistema',
                usuario: req.usuario,
                ip: ipCliente(req),
            });
        }

        limpiarSesion(req, res);
        json(res, 200, { exito: true, mensaje: 'Sesión cerrada.' });
        return;
    }

    // cambiar_clave exige sesión activa.
    if (!req.usuario) {
        error(res, 401, 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.');
        return;
    }

    const resultado = await cambiarClave(db, req.usuario, data.clave_actual, data.clave_nueva);

    if (resultado.ok) {
        await registrar(db, {
            accion: 'CAMBIO_CLAVE',
            detalle: 'Cambió su clave de acceso',
            usuario: req.usuario,
            ip: ipCliente(req),
        });
    }

    json(res, resultado.status, { exito: resultado.ok, mensaje: resultado.mensaje });
});

export { requireSession };
export default router;
