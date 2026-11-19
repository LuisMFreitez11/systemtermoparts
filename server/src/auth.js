/**
 * Sesión propia (no Supabase Auth), compatible en datos con el backend PHP.
 *
 * En lugar de sesiones en archivo se usa una cookie firmada con HMAC-SHA256:
 * no necesita almacenamiento compartido, sobrevive a reinicios y funciona igual
 * en local, en un VPS o en funciones serverless.
 *
 * Contrato de la cookie: base64url(JSON) + "." + HMAC. La cookie no se puede
 * leer ni modificar sin el secreto del servidor.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { json } from './http.js';

const DURACION_MINIMA = 60;
const DURACION_MAXIMA = 60 * 60 * 24 * 30;

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

function firmar(carga) {
    return crypto.createHmac('sha256', config.sesion.secreto).update(carga).digest('base64url');
}

function crearToken(usuario) {
    const duracion = Math.min(
        DURACION_MAXIMA,
        Math.max(DURACION_MINIMA, config.sesion.vigenciaSegundos)
    );

    const payload = {
        u: usuario.usuario_id,
        n: usuario.usuario,
        c: usuario.nombre_completo,
        r: usuario.rol,
        e: Math.floor(Date.now() / 1000) + duracion,
    };

    const carga = base64url(JSON.stringify(payload));

    return { token: `${carga}.${firmar(carga)}`, duracion };
}

function leerSesion(req) {
    const cabecera = String(req.headers.cookie ?? '');
    const nombre = config.sesion.nombre;
    let valor = null;

    for (const parte of cabecera.split(';')) {
        const indice = parte.indexOf('=');

        if (indice === -1) {
            continue;
        }

        if (parte.slice(0, indice).trim() === nombre) {
            valor = parte.slice(indice + 1).trim();
            break;
        }
    }

    if (!valor || !valor.includes('.')) {
        return null;
    }

    const [carga, firma] = valor.split('.', 2);
    const esperada = firmar(carga);

    if (firma.length !== esperada.length) {
        return null;
    }

    if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) {
        return null;
    }

    let payload;

    try {
        payload = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!payload || typeof payload.e !== 'number' || payload.e < Math.floor(Date.now() / 1000)) {
        return null;
    }

    if (!Number.isInteger(payload.u) || typeof payload.n !== 'string' || typeof payload.r !== 'string') {
        return null;
    }

    return {
        usuario_id: payload.u,
        usuario: payload.n,
        nombre_completo: String(payload.c ?? ''),
        rol: payload.r,
    };
}

/** El navegador necesita SameSite=None cuando el frontend vive en otro dominio. */
function esCruzado(req) {
    const origen = String(req.get('origin') ?? '');

    if (origen === '') {
        return false;
    }

    const hostOrigen = origen.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
    const hostActual = String(req.get('x-forwarded-host') ?? req.get('host') ?? '')
        .replace(/:\d+$/, '')
        .toLowerCase();

    return hostOrigen !== hostActual;
}

function atributosCookie(req, duracion) {
    const cruzado = esCruzado(req);
    const sameSite = cruzado ? 'None' : (config.sesion.sameSite || 'Lax');
    const segura = cruzado || config.sesion.segura;

    const partes = ['Path=/', 'HttpOnly', `SameSite=${sameSite}`];

    if (segura) {
        partes.push('Secure');
    }

    if (config.sesion.dominio) {
        partes.push(`Domain=${config.sesion.dominio}`);
    }

    if (duracion > 0) {
        partes.push(`Max-Age=${duracion}`);
    }

    return partes.join('; ');
}

function establecerSesion(req, res, usuario) {
    const { token, duracion } = crearToken(usuario);

    res.append(
        'Set-Cookie',
        `${config.sesion.nombre}=${token}; ${atributosCookie(req, duracion)}`
    );
}

function limpiarSesion(req, res) {
    res.append(
        'Set-Cookie',
        `${config.sesion.nombre}=; ${atributosCookie(req, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    );
}

/** Adjunta req.usuario si la cookie es válida y vigente. */
function leerUsuario(req, _res, next) {
    req.usuario = leerSesion(req);
    next();
}

function requireSession(req, res, next) {
    if (!req.usuario) {
        json(res, 401, {
            exito: false,
            mensaje: 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.',
            no_autenticado: true,
        });
        return;
    }

    next();
}

/** Para enlaces que abren una página (exportaciones): redirige en vez de 401. */
function requireSessionHtml(req, res, next) {
    if (req.usuario) {
        next();
        return;
    }

    if (config.app.urlFrontend) {
        res.redirect(302, `${config.app.urlFrontend}/login.html`);
        return;
    }

    json(res, 401, {
        exito: false,
        mensaje: 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.',
        no_autenticado: true,
    });
}

function requireAdmin(req, res, next) {
    if (!req.usuario) {
        requireSession(req, res, next);
        return;
    }

    if (req.usuario.rol !== 'ADMIN') {
        json(res, 403, { exito: false, mensaje: 'No tienes permiso para realizar esta acción.' });
        return;
    }

    next();
}

const espera = milisegundos => new Promise(resolver => setTimeout(resolver, milisegundos));

async function login(db, usuario, clave) {
    const nombreUsuario = String(usuario ?? '').trim();
    const clavePlana = String(clave ?? '');

    if (nombreUsuario === '' || clavePlana === '') {
        return { ok: false, status: 422, mensaje: 'Escribe tu usuario y tu clave.' };
    }

    try {
        const { rows } = await db.query(
            `SELECT usuario_id, usuario, nombre_completo, clave_hash, rol, activo
             FROM usuarios WHERE usuario = $1 LIMIT 1`,
            [nombreUsuario]
        );
        const fila = rows[0];
        const valida = fila
            && Number(fila.activo) === 1
            && await bcrypt.compare(clavePlana, String(fila.clave_hash));

        if (!valida) {
            // Misma pausa que el backend PHP para no filtrar qué usuarios existen.
            await espera(250);

            return { ok: false, status: 401, mensaje: 'Usuario o clave incorrectos.' };
        }

        const usuarioSesion = {
            usuario_id: Number(fila.usuario_id),
            usuario: fila.usuario,
            nombre_completo: String(fila.nombre_completo ?? ''),
            rol: fila.rol,
        };

        await db.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE usuario_id = $1', [usuarioSesion.usuario_id]);

        // Rehash oportunista: PHP usa $2y$, bcryptjs genera $2b$. Ambos se leen.
        if (String(fila.clave_hash).startsWith('$2y$')) {
            bcrypt.hash(clavePlana, 10)
                .then(nuevo => db.query('UPDATE usuarios SET clave_hash = $1 WHERE usuario_id = $2', [nuevo, usuarioSesion.usuario_id]))
                .catch(() => {});
        }

        const nombreMostrar = usuarioSesion.nombre_completo !== ''
            ? usuarioSesion.nombre_completo
            : usuarioSesion.usuario;

        return {
            ok: true,
            status: 200,
            mensaje: `Bienvenido, ${nombreMostrar}.`,
            usuario: usuarioSesion,
        };
    } catch (error) {
        console.error('[WMS] Error al iniciar sesión:', error.message);

        return { ok: false, status: 500, mensaje: 'No se pudo iniciar sesión.' };
    }
}

async function cambiarClave(db, usuario, claveActual, claveNueva) {
    if (!usuario) {
        return { ok: false, status: 401, mensaje: 'Tu sesión expiró o no has iniciado sesión. Vuelve a entrar al sistema.' };
    }

    if (String(claveActual ?? '') === '' || String(claveNueva ?? '') === '') {
        return { ok: false, status: 422, mensaje: 'Completa la clave actual y la nueva clave.' };
    }

    if (Array.from(String(claveNueva)).length < 6) {
        return { ok: false, status: 422, mensaje: 'La nueva clave debe tener al menos 6 caracteres.' };
    }

    try {
        const { rows } = await db.query('SELECT clave_hash FROM usuarios WHERE usuario_id = $1', [usuario.usuario_id]);

        if (rows.length === 0 || !(await bcrypt.compare(String(claveActual), String(rows[0].clave_hash)))) {
            return { ok: false, status: 422, mensaje: 'La clave actual no es correcta.' };
        }

        const nuevoHash = await bcrypt.hash(String(claveNueva), 10);
        await db.query('UPDATE usuarios SET clave_hash = $1 WHERE usuario_id = $2', [nuevoHash, usuario.usuario_id]);

        return { ok: true, status: 200, mensaje: 'Clave actualizada correctamente.' };
    } catch (error) {
        console.error('[WMS] Error al cambiar la clave:', error.message);

        return { ok: false, status: 500, mensaje: 'No se pudo cambiar la clave.' };
    }
}

export {
    leerUsuario,
    requireSession,
    requireSessionHtml,
    requireAdmin,
    establecerSesion,
    limpiarSesion,
    login,
    cambiarClave,
    crearToken,
    leerSesion,
};
