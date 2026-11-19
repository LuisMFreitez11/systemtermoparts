/**
 * Aplicación Express del WMS Termo Parts FW.
 *
 * Se monta cada router en DOS rutas:
 *   - la ruta "PHP" original (`/api.php`, `/api_activos.php`, ...), para que el
 *     frontend y el backend PHP sigan siendo intercambiables en local;
 *   - la ruta limpia que usa Vercel tras el `rewrite` (`/api/activos`, ...).
 *
 * El contrato JSON, los códigos de estado y los mensajes son idénticos a los
 * del backend PHP; el frontend no necesita saber qué motor responde.
 */
import express from 'express';
import path from 'node:path';
import { config, RAIZ_PROYECTO } from './config.js';
import { cors, json as jsonResponse, HttpError } from './http.js';
import { leerUsuario } from './auth.js';

import productos from './routes/productos.js';
import activos from './routes/activos.js';
import herramientas from './routes/herramientas.js';
import entradas from './routes/entradas.js';
import danados from './routes/danados.js';
import historial from './routes/historial.js';
import sesion from './routes/sesion.js';
import exportsRouter from './routes/exports.js';
import health from './routes/health.js';

const app = express();

app.disable('x-powered-by');
// Vercel y cualquier proxy por delante: la IP real llega en X-Forwarded-For.
app.set('trust proxy', 1);

app.use(cors);

// El cuerpo crudo hace falta para la huella de idempotencia: PHP usaba
// php://input, y la huella debe coincidir byte a byte entre ambos backends.
const guardarCuerpoCrudo = (req, _res, buffer) => {
    req.rawBody = buffer && buffer.length > 0 ? buffer.toString('utf8') : '';
};

app.use(express.json({ limit: '4mb', verify: guardarCuerpoCrudo }));
app.use(express.urlencoded({ extended: false, limit: '4mb', verify: guardarCuerpoCrudo }));

// Adjunta req.usuario (o null) sin bloquear: cada endpoint decide.
app.use(leerUsuario);

const MONTAJES = [
    [['/api.php', '/api/productos'], productos],
    [['/api_activos.php', '/api/activos'], activos],
    [['/api_herramientas.php', '/api/herramientas'], herramientas],
    [['/api_entradas.php', '/api/entradas'], entradas],
    [['/api_danados.php', '/api/danados'], danados],
    [['/api_historial.php', '/api/historial'], historial],
    [['/api_sesion.php', '/api/sesion'], sesion],
    [['/'], exportsRouter],
    [['/health.php', '/api/health'], health],
];

for (const [rutas, router] of MONTAJES) {
    for (const ruta of rutas) {
        app.use(ruta, router);
    }
}

app.get(['/api', '/api/'], (_req, res) => {
    jsonResponse(res, 200, {
        exito: true,
        servicio: 'wms-termo-part',
        mensaje: 'API del WMS Termo Parts FW. Usa /health.php para monitoreo.',
    });
});

// En local, el mismo servidor Node sirve el frontend (`pnpm start`):
// mismo origen, sin CORS ni cookies entre sitios. En Vercel el frontend lo
// publica la plataforma y las funciones de `api/` solo atienden `/api/*`.
if (!process.env.VERCEL) {
    app.use(express.static(path.join(RAIZ_PROYECTO, 'frontend'), {
        extensions: ['html'],
        index: 'index.html',
    }));
}

app.use((_req, res) => {
    jsonResponse(res, 404, { exito: false, mensaje: 'Recurso no encontrado.' });
});

// eslint-disable-next-line no-unused-vars
app.use((fallo, _req, res, _next) => {
    if (fallo instanceof HttpError) {
        jsonResponse(res, fallo.status, { exito: false, mensaje: fallo.message, ...fallo.extra });
        return;
    }

    if (fallo?.type === 'entity.parse.failed' || fallo instanceof SyntaxError) {
        jsonResponse(res, 400, {
            exito: false,
            mensaje: 'El cuerpo de la petición no es un JSON válido.',
        });
        return;
    }

    if (fallo?.type === 'entity.too.large') {
        jsonResponse(res, 413, { exito: false, mensaje: 'La petición es demasiado grande.' });
        return;
    }

    console.error('[WMS] Error no controlado:', fallo);

    jsonResponse(res, 500, {
        exito: false,
        mensaje: config.debug
            ? `Error interno: ${fallo?.message ?? fallo}`
            : 'Ocurrió un error inesperado en el servidor.',
    });
});

export default app;
