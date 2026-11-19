/**
 * Acceso a PostgreSQL.
 *
 * Dos detalles críticos para la paridad con PHP:
 *  - `numeric` e `int8` se devuelven como string (igual que pdo_pgsql).
 *  - `timestamp` y `timestamptz` se devuelven como texto "YYYY-MM-DD HH:MM:SS"
 *    en lugar de `Date`, porque el frontend compara y muestra esos valores
 *    tal cual. Si se dejaran como Date, el JSON saldría en ISO y rompería la UI.
 *
 * La zona horaria se fija por conexión (`SET TIME ZONE`), igual que hace
 * `Database::conexion()` en PHP. Como `pg` no permite hooks asíncronos de
 * conexión, se guarda la promesa del `SET` en el cliente y se espera antes de
 * la primera consulta: así nunca se ejecuta un `BEGIN` en paralelo con el `SET`.
 *
 * El objeto `db` es el punto de inyección para las pruebas: los tests
 * reemplazan `db.query` / `db.withTransaction` por dobles en memoria sin tocar
 * la base real.
 */
import pg from 'pg';
import { config } from './config.js';

const { Pool, types } = pg;

types.setTypeParser(1114, valor => valor); // timestamp
types.setTypeParser(1184, valor => valor); // timestamptz
types.setTypeParser(1082, valor => valor); // date

const ZONA = config.zonaHoraria.replace(/'/g, "''");

let pool = null;

function obtenerPool() {
    if (pool) {
        return pool;
    }

    pool = new Pool({
        ...config.db,
        application_name: 'termopart-wms-node',
    });

    pool.on('connect', cliente => {
        // Se guarda la promesa; `preparar` la espera antes de usar el cliente.
        cliente.__zonaLista = cliente
            .query(`SET TIME ZONE '${ZONA}'`)
            .catch(() => {
                // Si la zona no existe, PostgreSQL mantiene la del servidor.
            });
    });

    pool.on('error', error => {
        console.error('[WMS] Error en el pool de PostgreSQL:', error.message);
    });

    return pool;
}

/** Garantiza que la conexión ya tenga aplicada la zona horaria. */
async function preparar(cliente) {
    if (cliente.__zonaLista) {
        const pendiente = cliente.__zonaLista;
        cliente.__zonaLista = null;
        await pendiente;
    }

    return cliente;
}

/**
 * Ejecuta `fn` dentro de una transacción con un cliente dedicado.
 * Garantiza rollback y liberación del cliente ante cualquier error.
 */
async function ejecutarTransaccion(fn) {
    const cliente = await preparar(await obtenerPool().connect());

    try {
        await cliente.query('BEGIN');
        const resultado = await fn(cliente);
        await cliente.query('COMMIT');

        return resultado;
    } catch (error) {
        try {
            await cliente.query('ROLLBACK');
        } catch {
            // La conexión ya no es utilizable; el release la descarta.
        }

        throw error;
    } finally {
        cliente.release();
    }
}

/**
 * Detecta violaciones de unicidad, de clave foránea o de restricción
 * (mismo criterio que Database::esConflicto de PHP).
 */
function esConflicto(error) {
    return ['23000', '23503', '23505'].includes(String(error?.code ?? ''));
}

async function consultar(texto, parametros = []) {
    const cliente = await preparar(await obtenerPool().connect());

    try {
        return await cliente.query(texto, parametros);
    } finally {
        cliente.release();
    }
}

const db = {
    query: consultar,
    withTransaction: ejecutarTransaccion,
    esConflicto,
};

/** Delegados: mantienen la firma original y pasan siempre por `db`. */
function query(texto, parametros = []) {
    return db.query(texto, parametros);
}

function withTransaction(fn) {
    return db.withTransaction(fn);
}

async function cerrar() {
    if (!pool) {
        return;
    }

    const actual = pool;
    pool = null;

    await actual.end();
}

export { db, query, withTransaction, esConflicto, cerrar, obtenerPool };
