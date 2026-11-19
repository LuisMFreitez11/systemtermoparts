/**
 * Idempotencia de escrituras (todas las acciones POST de la API).
 *
 * Diferencias con la versión PHP, que corregimos aquí:
 *  - El reclamo de la clave es ATÓMICO (`INSERT ... ON CONFLICT DO NOTHING`).
 *    Antes, dos clics simultáneos podían chocar con la PK y ejecutar la
 *    operación dos veces porque el error se interpretaba como "tabla no
 *    disponible".
 *  - Una clave reutilizada con otro cuerpo devuelve 409 y NO ejecuta nada.
 *  - Los reintentos mientras la operación está en curso ESPERAN la respuesta
 *    original y la replican (replay), en vez de duplicar el consumo. Si el
 *    proceso original murió, la clave caduca y se puede reclamar de nuevo.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { parametro } from './http.js';

const PATRON_CLAVE = /^[A-Za-z0-9._:-]{8,120}$/;
const PAUSA_MS = 120;

const pausa = milisegundos => new Promise(resolver => {
    const temporizador = setTimeout(resolver, milisegundos);
    // No mantener vivo el proceso solo por esperar un reintento.
    temporizador.unref?.();
});

/**
 * Huella idéntica a la de PHP: endpoint + acción + cuerpo crudo.
 * Se omite el usuario a propósito para que una operación encolada pueda
 * reintentarse contra cualquiera de los dos backends durante la transición.
 */
function huellaDe(endpoint, req) {
    return crypto
        .createHash('sha256')
        .update(`${endpoint}|${parametro(req, 'accion')}|${req.rawBody ?? ''}`)
        .digest('hex');
}

async function insertarReclamo(clave, huella, endpoint, usuarioId) {
    const { rowCount } = await query(
        `INSERT INTO operaciones_idempotencia (clave, huella, endpoint, usuario_id, estado)
         VALUES ($1, $2, $3, $4, 'EN_PROCESO')
         ON CONFLICT (clave) DO NOTHING`,
        [clave, huella, endpoint.slice(0, 120), usuarioId ?? null]
    );

    return rowCount === 1;
}

async function leerReclamo(clave) {
    const { rows } = await query(
        `SELECT estado, huella, codigo_http, respuesta,
                EXTRACT(EPOCH FROM (NOW() - actualizado_en))::int AS edad
         FROM operaciones_idempotencia WHERE clave = $1`,
        [clave]
    );

    return rows[0] ?? null;
}

async function liberarReclamo(clave) {
    await query('DELETE FROM operaciones_idempotencia WHERE clave = $1', [clave]);
}

async function completarReclamo(clave, status, payload) {
    if (status >= 200 && status < 300) {
        await query(
            `UPDATE operaciones_idempotencia
             SET estado = 'COMPLETADA', codigo_http = $2, respuesta = $3, actualizado_en = NOW()
             WHERE clave = $1`,
            [clave, status, JSON.stringify(payload)]
        );
        return;
    }

    // Un error no se cachea: el usuario debe poder corregir y reintentar.
    await liberarReclamo(clave);
}

async function limpiarAntiguas() {
    const ttl = Math.max(3600, config.idempotencia.ttlSegundos);

    await query(
        `DELETE FROM operaciones_idempotencia
         WHERE actualizado_en < NOW() - ($1::int * INTERVAL '1 second')`,
        [ttl]
    );
}

/**
 * Almacén de claves. Es un objeto para poder sustituirlo en las pruebas por
 * uno en memoria sin tocar PostgreSQL.
 */
const almacenSql = {
    insertar: insertarReclamo,
    leer: leerReclamo,
    liberar: liberarReclamo,
    completar: completarReclamo,
    limpiar: limpiarAntiguas,
};

function responderReplay(res, fila) {
    const codigo = Number(fila.codigo_http) || 200;

    res.status(codigo);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('X-Idempotent-Replay', 'true');
    res.send(String(fila.respuesta ?? '{}'));
}

function conflicto(res) {
    res.status(409).json({
        exito: false,
        mensaje: 'La clave de idempotencia ya fue usada con otra operación.',
        idempotencia_conflicto: true,
    });
}

function enProceso(res) {
    res.status(409).json({
        exito: false,
        mensaje: 'La operación está en proceso. Espera unos segundos antes de reintentar.',
        idempotencia_en_proceso: true,
    });
}

/**
 * Intenta quedarse con la clave. Devuelve:
 *   { estado: 'reclamada' }                 → hay que ejecutar la operación
 *   { estado: 'replay', fila }              → responder con la copia guardada
 *   { estado: 'conflicto' | 'en_proceso' }  → responder 409
 */
async function reclamar(almacen, clave, huella, endpoint, usuarioId) {
    if (await almacen.insertar(clave, huella, endpoint, usuarioId)) {
        return { estado: 'reclamada' };
    }

    const limite = Date.now() + Math.max(0, config.idempotencia.esperaMaximaSegundos) * 1000;

    // Sondeo corto: el clic "duplicado" recibe la MISMA respuesta del primero.
    for (;;) {
        const fila = await almacen.leer(clave);

        if (!fila) {
            // Se liberó (error del primero) o la limpieza TTL la borró.
            if (await almacen.insertar(clave, huella, endpoint, usuarioId)) {
                return { estado: 'reclamada' };
            }
        } else if (fila.huella !== huella) {
            return { estado: 'conflicto' };
        } else if (fila.estado === 'COMPLETADA') {
            return { estado: 'replay', fila };
        } else if (Number(fila.edad) >= config.idempotencia.enProcesoMaxSegundos) {
            // Proceso caído a mitad de la operación: se libera y se reintenta.
            await almacen.liberar(clave);

            if (await almacen.insertar(clave, huella, endpoint, usuarioId)) {
                return { estado: 'reclamada' };
            }
        }

        if (config.idempotencia.esperaMaximaSegundos <= 0 || Date.now() >= limite) {
            return { estado: 'en_proceso' };
        }

        await pausa(PAUSA_MS);
    }
}

/**
 * Middleware para montar en cada router: `router.use(idempotencia('api.php'))`.
 * Debe ejecutarse DESPUÉS de autenticar: no se reclaman claves anónimas.
 */
function idempotencia(endpoint, almacen = almacenSql) {
    return async (req, res, next) => {
        if (req.method !== 'POST' || !config.idempotencia.activa) {
            next();
            return;
        }

        const clave = String(req.get('x-idempotency-key') ?? '').trim();

        // Sin clave válida se comporta como antes: la operación se ejecuta una vez.
        if (!PATRON_CLAVE.test(clave)) {
            next();
            return;
        }

        const usuarioId = req.usuario?.usuario_id ?? null;
        const huella = huellaDe(endpoint, req);
        let resultado;

        try {
            resultado = await reclamar(almacen, clave, huella, endpoint, usuarioId);
        } catch (error) {
            // Si la tabla no existe o la base falla, la API sigue operando.
            console.error('[WMS] Idempotencia no disponible:', error.message);
            next();
            return;
        }

        if (resultado.estado === 'conflicto') {
            conflicto(res);
            return;
        }

        if (resultado.estado === 'en_proceso') {
            enProceso(res);
            return;
        }

        if (resultado.estado === 'replay') {
            responderReplay(res, resultado.fila);
            return;
        }

        let payloadCapturado;
        const jsonOriginal = res.json.bind(res);

        res.json = payload => {
            payloadCapturado = payload;

            return jsonOriginal(payload);
        };

        res.on('finish', () => {
            if (payloadCapturado === undefined) {
                // Respuesta que no pasó por res.json (redirect, envío crudo).
                almacen.liberar(clave).catch(() => {});
                return;
            }

            Promise.resolve()
                .then(() => almacen.completar(clave, res.statusCode, payloadCapturado))
                .then(() => (Math.random() < 0.02 ? almacen.limpiar() : undefined))
                .catch(error => {
                    console.error('[WMS] No se pudo cerrar la idempotencia:', error.message);
                });
        });

        next();
    };
}

export { idempotencia, huellaDe, almacenSql, PATRON_CLAVE };
