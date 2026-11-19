/**
 * Utilidades HTTP compartidas: respuestas JSON, errores, normalización de
 * parámetros y formato de cantidades (idéntico a lo que devolvía PHP).
 */
import { config } from './config.js';

class HttpError extends Error {
    constructor(status, mensaje, extra = {}) {
        super(mensaje);
        this.status = status;
        this.extra = extra;
    }
}

function json(res, status, payload) {
    if (res.headersSent) {
        return;
    }

    res.status(status);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.json(payload);
}

function error(res, status, mensaje, extra = {}) {
    json(res, status, { exito: false, mensaje, ...extra });
}

function lanzar(status, mensaje, extra = {}) {
    throw new HttpError(status, mensaje, extra);
}

/** Parámetro de query como texto, igual que Http::parametro de PHP. */
function parametro(req, nombre, defecto = '') {
    const valor = req.query?.[nombre];

    return typeof valor === 'string' ? valor : defecto;
}

function cuerpo(req) {
    return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/** Equivalente a is_numeric() de PHP. */
function esNumerico(valor) {
    if (typeof valor === 'number') {
        return Number.isFinite(valor);
    }

    if (typeof valor !== 'string') {
        return false;
    }

    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(valor.trim());
}

function numero(valor) {
    return esNumerico(valor) ? Number(valor) : null;
}

/** Equivalente a filter_var(..., FILTER_VALIDATE_INT). */
function entero(valor) {
    if (typeof valor === 'number') {
        return Number.isSafeInteger(valor) ? valor : null;
    }

    if (typeof valor !== 'string') {
        return null;
    }

    const limpio = valor.trim();

    if (!/^[+-]?\d+$/.test(limpio)) {
        return null;
    }

    const numeroEntero = Number(limpio);

    return Number.isSafeInteger(numeroEntero) ? numeroEntero : null;
}

function texto(valor, defecto = '') {
    if (valor === null || valor === undefined || (typeof valor === 'object')) {
        return defecto;
    }

    return String(valor).trim();
}

/** Equivalente a mb_substr: corta por puntos de código, no por bytes. */
function mbsub(valor, maximo) {
    const caracteres = Array.from(String(valor ?? ''));

    return caracteres.length <= maximo ? caracteres.join('') : caracteres.slice(0, maximo).join('');
}

/** Redondeo "mitad lejos de cero", como round() de PHP. */
function redondear(valor, decimales = 3) {
    const factor = 10 ** decimales;
    const escalado = Number(valor) * factor;
    const ajustado = escalado >= 0
        ? Math.round(escalado + 1e-9)
        : -Math.round(Math.abs(escalado) + 1e-9);

    return ajustado / factor;
}

/** Formatea una cantidad con hasta 3 decimales, sin ceros sobrantes.
 *  Replica `number_format($valor, 3)` de PHP, incluido su redondeo. */
function cantidad(valor) {
    const numero = Number(valor ?? 0);
    const seguro = Number.isFinite(numero) ? redondear(numero, 3) : 0;
    const limpio = seguro.toFixed(3).replace(/\.?0+$/, '');

    return limpio === '' || limpio === '-0' ? '0' : limpio;
}

/** `date('Y-m-d')` en la zona horaria configurada. */
function hoy() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.zonaHoraria,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());

    return partes;
}

/** Fecha "YYYY-MM-DD" real (rechaza 2026-02-31). */
function esFecha(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        return false;
    }

    const [anio, mes, dia] = valor.split('-').map(Number);
    const fecha = new Date(Date.UTC(anio, mes - 1, dia));

    return fecha.getUTCFullYear() === anio
        && fecha.getUTCMonth() === mes - 1
        && fecha.getUTCDate() === dia;
}

/** ISO 8601 con el offset de la zona configurada, como date('c'). */
function ahoraIso() {
    const fecha = new Date();
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.zonaHoraria,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(fecha);

    const obtener = tipo => partes.find(parte => parte.type === tipo)?.value ?? '00';
    const local = Date.UTC(
        Number(obtener('year')),
        Number(obtener('month')) - 1,
        Number(obtener('day')),
        Number(obtener('hour')),
        Number(obtener('minute')),
        Number(obtener('second'))
    );
    const diferenciaMinutos = Math.round((local - fecha.getTime()) / 60000);
    const signo = diferenciaMinutos >= 0 ? '+' : '-';
    const absoluto = Math.abs(diferenciaMinutos);
    const offset = `${signo}${String(Math.floor(absoluto / 60)).padStart(2, '0')}:${String(absoluto % 60).padStart(2, '0')}`;

    return `${obtener('year')}-${obtener('month')}-${obtener('day')}T`
        + `${obtener('hour')}:${obtener('minute')}:${obtener('second')}${offset}`;
}

function escaparHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[caracter]);
}

function limpiarTexto(valor) {
    return String(valor ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/** CORS: refleja el origen solo si está permitido (mismo criterio que PHP). */
function cors(req, res, next) {
    const origen = String(req.get('origin') ?? '');

    if (origen !== '') {
        const hostOrigen = origen.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
        const hostActual = String(req.get('x-forwarded-host') ?? req.get('host') ?? '')
            .replace(/:\d+$/, '')
            .toLowerCase();
        const permitido = hostOrigen === hostActual || config.cors.origenes.includes(origen);

        if (permitido) {
            res.set('Access-Control-Allow-Origin', origen);
            res.set('Vary', 'Origin');
            res.set('Access-Control-Allow-Credentials', 'true');
            res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Idempotency-Key, X-Requested-With');
            res.set('Access-Control-Max-Age', '86400');
        }
    }

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    next();
}

export {
    HttpError,
    json,
    error,
    lanzar,
    parametro,
    cuerpo,
    esNumerico,
    numero,
    entero,
    texto,
    mbsub,
    redondear,
    cantidad,
    hoy,
    esFecha,
    ahoraIso,
    escaparHtml,
    limpiarTexto,
    cors,
};
