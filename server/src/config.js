/**
 * Configuración del backend Node.
 *
 * Prioridad: variables de entorno > server/.env > backend/.env > valores por
 * defecto. Se reutiliza `backend/.env` para no duplicar credenciales: el mismo
 * archivo sirve a PHP y a Node durante la transición.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_PROYECTO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function leerEnv(archivo) {
    const valores = {};

    if (!fs.existsSync(archivo)) {
        return valores;
    }

    for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
        const limpia = linea.trim();

        if (limpia === '' || limpia.startsWith('#') || !limpia.includes('=')) {
            continue;
        }

        const indice = limpia.indexOf('=');
        const nombre = limpia.slice(0, indice).trim();
        let valor = limpia.slice(indice + 1).trim();

        if (valor.length >= 2 && (valor[0] === '"' || valor[0] === "'") && valor.endsWith(valor[0])) {
            valor = valor.slice(1, -1);
        }

        if (nombre !== '') {
            valores[nombre] = valor;
        }
    }

    return valores;
}

const archivoEnv = {
    ...leerEnv(path.join(RAIZ_PROYECTO, 'backend', '.env')),
    ...leerEnv(path.join(RAIZ_PROYECTO, 'server', '.env')),
};

function env(nombre, defecto = '') {
    const valor = process.env[nombre];

    if (typeof valor === 'string' && valor !== '') {
        return valor;
    }

    return archivoEnv[nombre] ?? defecto;
}

function flag(nombre, defecto = '0') {
    const valor = env(nombre, defecto).toLowerCase();

    return valor === '1' || valor === 'true' || valor === 'yes' || valor === 'on';
}

function entero(nombre, defecto) {
    const valor = Number.parseInt(env(nombre, String(defecto)), 10);

    return Number.isFinite(valor) ? valor : defecto;
}

/**
 * Convierte un DSN estilo PDO (`pgsql:host=x;port=5432;dbname=y`) en las
 * propiedades que espera `pg`.
 */
function analizarDsn(dsn) {
    const resultado = {};
    const cuerpo = dsn.includes(':') ? dsn.slice(dsn.indexOf(':') + 1) : dsn;

    for (const parte of cuerpo.split(';')) {
        if (!parte.includes('=')) {
            continue;
        }

        const [clave, ...resto] = parte.split('=');
        resultado[clave.trim().toLowerCase()] = resto.join('=').trim();
    }

    return resultado;
}

const dsn = env('DB_PGSQL_DSN', 'pgsql:host=localhost;port=5432;dbname=termo_part_wms;sslmode=require');
const dsnPartes = analizarDsn(dsn);
const sslModo = (dsnPartes.sslmode || env('DB_PGSQL_SSLMODE', 'require')).toLowerCase();
const driver = env('DB_DRIVER', 'pgsql').toLowerCase();

const config = {
    debug: flag('APP_DEBUG', '0'),
    zonaHoraria: env('APP_TIMEZONE', 'America/Caracas'),
    driver,

    db: {
        host: env('DB_PGSQL_HOST', dsnPartes.host || 'localhost'),
        port: entero('DB_PGSQL_PORT', Number.parseInt(dsnPartes.port || '5432', 10)),
        database: env('DB_PGSQL_NAME', dsnPartes.dbname || 'termo_part_wms'),
        user: env('DB_PGSQL_USER', 'postgres'),
        password: env('DB_PGSQL_PASSWORD', ''),
        ssl: ['require', 'verify-ca', 'verify-full'].includes(sslModo) ? { rejectUnauthorized: false } : false,
        sslmode: sslModo,
        max: entero('DB_POOL_MAX', 3),
        idleTimeoutMillis: entero('DB_IDLE_TIMEOUT', 10000),
        connectionTimeoutMillis: entero('DB_CONNECT_TIMEOUT', 10000),
    },

    sesion: {
        nombre: env('SESSION_NAME', 'TERMOPART_SESS'),
        secreto: env('SESSION_SECRET', ''),
        vigenciaSegundos: entero('SESSION_LIFETIME', 0) || 43200,
        sameSite: env('SESSION_SAMESITE', 'Lax'),
        segura: flag('SESSION_SECURE', '0'),
        dominio: env('SESSION_DOMAIN', ''),
    },

    cors: {
        origenes: env('CORS_ALLOWED_ORIGINS', '')
            .split(',')
            .map(origen => origen.trim())
            .filter(Boolean),
    },

    idempotencia: {
        activa: flag('IDEMPOTENCY_ENABLED', '1'),
        ttlSegundos: entero('IDEMPOTENCY_TTL', 604800),
        enProcesoMaxSegundos: entero('IDEMPOTENCY_IN_PROGRESS', 120),
        esperaMaximaSegundos: entero('IDEMPOTENCY_WAIT', 8),
    },

    app: {
        urlFrontend: env('FRONTEND_URL', '').replace(/\/+$/, ''),
    },

    puerto: entero('PORT', 3000),
};

if (config.driver !== 'pgsql') {
    throw new Error(
        'Este backend solo implementa el driver "pgsql". ' +
        'Para MariaDB usa el backend PHP (backend/public) o define DB_DRIVER=pgsql.'
    );
}

if (config.sesion.secreto === '') {
    // Se deriva un secreto estable por proceso para desarrollo. En producción
    // debe definirse SESSION_SECRET: sin él, reiniciar invalida las sesiones.
    config.sesion.secreto = `dev-${config.db.user}-${config.db.database}-${config.db.password}`;
    config.sesion.secretoDerivado = true;
}

export { config, RAIZ_PROYECTO };
