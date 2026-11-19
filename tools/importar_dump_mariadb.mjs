/**
 * Importa un volcado de phpMyAdmin (MariaDB) al esquema PostgreSQL de Supabase.
 *
 * Uso:
 *   node tools/importar_dump_mariadb.mjs "ruta/al/volcado.sql"            # solo valida
 *   node tools/importar_dump_mariadb.mjs "ruta/al/volcado.sql" --aplicar  # escribe en Supabase
 *
 * Qué hace con --aplicar (todo en UNA transacción):
 *   1. Copia el contenido actual de las 12 tablas al esquema `respaldo_AAAAMMDD`.
 *   2. Vacía las tablas (TRUNCATE ... RESTART IDENTITY CASCADE).
 *   3. Inserta el volcado con los IDs originales, en orden de claves foráneas.
 *   4. Ajusta las secuencias IDENTITY al máximo ID.
 *   5. Verifica conteos e integridad referencial; si algo falla, ROLLBACK.
 *
 * No toca `operaciones_idempotencia` ni las políticas RLS.
 *
 * Detalles del volcado que resuelve:
 *   - El archivo viene con "doble codificación" (UTF-8 que contiene mojibake
 *     latin1, p. ej. "generaciÃ³n"); se repara a UTF-8 real.
 *   - Escapes de MySQL (\' \\ \n \r \t \0 \Z) y valores NULL.
 *   - `movimiento_id` huérfano en entradas/matriculas dañadas -> NULL, igual
 *     que hacía `database/migracion_supabase.php`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { withTransaction, query, cerrar } from '../server/src/db.js';

/** Orden de inserción que respeta las claves foráneas. */
const TABLAS = [
    'usuarios',
    'productos',
    'herramientas',
    'activos',
    'movimientos_inventario',
    'activo_materiales',
    'herramientas_movimientos',
    'historial_usuario',
    'entradas_almacen',
    'materiales_danados',
    'tomas_fisicas',
    'toma_fisica_detalle',
];

/** Claves foráneas que se validan antes de escribir. */
const CLAVES_FORANEAS = [
    ['activo_materiales', 'activo_id', 'activos', 'activo_id', false],
    ['activo_materiales', 'producto_id', 'productos', 'producto_id', false],
    ['movimientos_inventario', 'producto_id', 'productos', 'producto_id', false],
    ['herramientas_movimientos', 'herramienta_id', 'herramientas', 'herramienta_id', false],
    ['herramientas_movimientos', 'usuario_id', 'usuarios', 'usuario_id', true],
    ['historial_usuario', 'usuario_id', 'usuarios', 'usuario_id', true],
    ['entradas_almacen', 'producto_id', 'productos', 'producto_id', false],
    ['entradas_almacen', 'movimiento_id', 'movimientos_inventario', 'movimiento_id', true],
    ['materiales_danados', 'producto_id', 'productos', 'producto_id', false],
    ['materiales_danados', 'movimiento_id', 'movimientos_inventario', 'movimiento_id', true],
    ['toma_fisica_detalle', 'toma_id', 'tomas_fisicas', 'toma_id', false],
    ['toma_fisica_detalle', 'producto_id', 'productos', 'producto_id', false],
];

const TAMANO_LOTE = 400;

// ---------------------------------------------------------------------------
// 1. Lectura y reparación de codificación
// ---------------------------------------------------------------------------

// Caracteres que CP1252 define en 0x80-0x9F (donde Latin-1 no tiene nada).
const CP1252_EXTRA = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
};

/**
 * Repara solo los tramos con "doble codificación" (UTF-8 leído como CP1252 y
 * vuelto a guardar como UTF-8), por ejemplo "PAÃ‘01" -> "PAÑ01".
 *
 * No se puede reparar el archivo entero: este volcado mezcla texto correcto
 * ("generación", "°C") con unos pocos tramos dañados. Se intenta reparar cada
 * tramo no ASCII y se conserva el original si no forma UTF-8 válido.
 */
function repararCodificacion(texto) {
    let reparados = 0;

    const resultado = texto.replace(/[^\x00-\x7F]+/g, tramo => {
        // Solo los tramos con los "caracteres guía" del mojibake UTF-8->CP1252
        // ("Ã", "Â", "â") pueden estar doblemente codificados. Esto evita
        // tocar texto correcto como "Ñ°" o "º".
        if (!/[\u00C3\u00C2\u00E2]/.test(tramo)) {
            return tramo;
        }

        const bytes = [];

        for (const caracter of tramo) {
            const codigo = caracter.codePointAt(0);

            if (CP1252_EXTRA[codigo] !== undefined) {
                bytes.push(CP1252_EXTRA[codigo]);
            } else if (codigo <= 0xFF) {
                bytes.push(codigo);
            } else {
                return tramo; // contiene algo que CP1252 no puede representar
            }
        }

        // Un solo carácter nunca es UTF-8 válido (salvo ASCII), así que los
        // acentos correctos ("ó", "°") se quedan intactos.
        if (bytes.length < 2) {
            return tramo;
        }

        try {
            const reparado = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));

            if (reparado !== tramo) {
                reparados++;
            }

            return reparado;
        } catch {
            return tramo;
        }
    });

    return { texto: resultado, reparado: reparados > 0, tramos: reparados };
}

// ---------------------------------------------------------------------------
// 2. Parser de INSERT de MySQL
// ---------------------------------------------------------------------------

function leerCadena(sql, inicio) {
    // inicio apunta a la comilla de apertura
    let i = inicio + 1;
    let valor = '';

    while (i < sql.length) {
        const caracter = sql[i];

        if (caracter === '\\') {
            const siguiente = sql[i + 1];
            const escapes = { 0: '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };
            valor += Object.hasOwn(escapes, siguiente) ? escapes[siguiente] : siguiente;
            i += 2;
            continue;
        }

        if (caracter === "'") {
            if (sql[i + 1] === "'") { // '' también escapa
                valor += "'";
                i += 2;
                continue;
            }

            return { valor, fin: i + 1 };
        }

        valor += caracter;
        i++;
    }

    throw new Error('Cadena sin cerrar en el volcado.');
}

function leerTupla(sql, inicio) {
    // inicio apunta al paréntesis de apertura
    let i = inicio + 1;
    const valores = [];

    while (i < sql.length) {
        while (/\s/.test(sql[i])) i++;

        if (sql[i] === ')') {
            return { valores, fin: i + 1 };
        }

        if (sql[i] === "'") {
            const { valor, fin } = leerCadena(sql, i);
            valores.push(valor);
            i = fin;
        } else {
            let j = i;
            while (j < sql.length && sql[j] !== ',' && sql[j] !== ')') j++;
            const crudo = sql.slice(i, j).trim();
            valores.push(/^null$/i.test(crudo) ? null : crudo);
            i = j;
        }

        while (/\s/.test(sql[i])) i++;

        if (sql[i] === ',') {
            i++;
            continue;
        }

        if (sql[i] === ')') {
            return { valores, fin: i + 1 };
        }

        throw new Error(`Tupla mal formada cerca de: ${sql.slice(i, i + 60)}`);
    }

    throw new Error('Tupla sin cerrar en el volcado.');
}

function parsearInsert(sql, inicio) {
    // INSERT INTO `tabla` (`a`, `b`) VALUES (...), (...);
    const cabecera = /^INSERT INTO `(\w+)`\s*\(([^)]*)\)\s*VALUES\s*/i.exec(sql.slice(inicio, inicio + 4000));

    if (!cabecera) {
        throw new Error(`INSERT no reconocido cerca de: ${sql.slice(inicio, inicio + 120)}`);
    }

    const tabla = cabecera[1];
    const columnas = [...cabecera[2].matchAll(/`(\w+)`/g)].map(m => m[1]);
    let i = inicio + cabecera[0].length;
    const filas = [];

    while (i < sql.length) {
        while (/\s/.test(sql[i])) i++;

        if (sql[i] !== '(') {
            break;
        }

        const { valores, fin } = leerTupla(sql, i);

        if (valores.length !== columnas.length) {
            throw new Error(`La tabla ${tabla} tiene una fila con ${valores.length} valores y ${columnas.length} columnas.`);
        }

        filas.push(valores);
        i = fin;

        while (/\s/.test(sql[i])) i++;

        if (sql[i] === ',') {
            i++;
            continue;
        }

        break;
    }

    // Consumir el ';' final
    while (i < sql.length && sql[i] !== ';') i++;

    return { tabla, columnas, filas, fin: i + 1 };
}

function parsearVolcado(texto) {
    const datos = new Map();
    let posicion = 0;

    while (true) {
        const inicio = texto.indexOf('INSERT INTO `', posicion);

        if (inicio === -1) {
            break;
        }

        const { tabla, columnas, filas, fin } = parsearInsert(texto, inicio);
        const actual = datos.get(tabla) ?? { columnas: null, filas: [] };

        if (actual.columnas === null) {
            actual.columnas = columnas;
        } else if (actual.columnas.join(',') !== columnas.join(',')) {
            throw new Error(`La tabla ${tabla} aparece con columnas distintas en el volcado.`);
        }

        actual.filas.push(...filas);
        datos.set(tabla, actual);
        posicion = fin;
    }

    return datos;
}

// ---------------------------------------------------------------------------
// 3. Validaciones
// ---------------------------------------------------------------------------

function validar(datos, columnasPg) {
    const errores = [];

    for (const tabla of TABLAS) {
        if (!datos.has(tabla)) {
            errores.push(`El volcado no trae la tabla ${tabla}.`);
            continue;
        }

        const { columnas } = datos.get(tabla);

        if (!columnasPg.has(tabla)) {
            errores.push(`La tabla ${tabla} no existe en Supabase.`);
            continue;
        }

        const faltantes = columnas.filter(c => !columnasPg.get(tabla).has(c));
        if (faltantes.length > 0) {
            errores.push(`${tabla}: columnas inexistentes en Supabase -> ${faltantes.join(', ')}`);
        }
    }

    // Integridad referencial dentro del propio volcado.
    const ids = new Map();
    for (const [tabla, pk] of [['productos', 'producto_id'], ['activos', 'activo_id'], ['herramientas', 'herramienta_id'], ['usuarios', 'usuario_id'], ['movimientos_inventario', 'movimiento_id'], ['tomas_fisicas', 'toma_id']]) {
        if (!datos.has(tabla)) continue;
        const { columnas, filas } = datos.get(tabla);
        const indice = columnas.indexOf(pk);
        ids.set(tabla, new Set(filas.map(fila => fila[indice])));
    }

    for (const [tabla, columna, destino, destinoPk, opcional] of CLAVES_FORANEAS) {
        if (!datos.has(tabla)) continue;

        const { columnas, filas } = datos.get(tabla);
        const indice = columnas.indexOf(columna);
        const destinoIds = ids.get(destino);
        let huerfanos = 0;

        for (const fila of filas) {
            const valor = fila[indice];

            if (valor === null || valor === '' || valor === '0') {
                continue;
            }

            if (!destinoIds.has(valor)) {
                huerfanos++;

                if (!opcional) {
                    errores.push(`${tabla}.${columna}=${valor} no existe en ${destino}.${destinoPk}.`);
                }
            }
        }

        if (huerfanos > 0 && opcional) {
            console.warn(`  Aviso: ${tabla}.${columna} tiene ${huerfanos} referencia(s) huérfana(s); se guardarán como NULL.`);
        }
    }

    return errores;
}

/**
 * Convierte en NULL las referencias huérfanas de columnas opcionales
 * (`usuario_id`, `movimiento_id`), porque el esquema las declara
 * `ON DELETE SET NULL`. Devuelve cuántas ajustó.
 */
function depurarReferencias(datos) {
    let ajustadas = 0;

    for (const [tabla, columna, destino, destinoPk, opcional] of CLAVES_FORANEAS) {
        if (!opcional || !datos.has(tabla) || !datos.has(destino)) {
            continue;
        }

        const { columnas, filas } = datos.get(tabla);
        const indice = columnas.indexOf(columna);
        const destinoDatos = datos.get(destino);
        const indicePk = destinoDatos.columnas.indexOf(destinoPk);
        const validos = new Set(destinoDatos.filas.map(fila => fila[indicePk]));

        for (const fila of filas) {
            const valor = fila[indice];

            if (valor !== null && valor !== '' && valor !== '0' && !validos.has(valor)) {
                fila[indice] = null;
                ajustadas++;
            }
        }
    }

    return ajustadas;
}

// ---------------------------------------------------------------------------
// 4. Escritura
// ---------------------------------------------------------------------------

async function columnasDeSupabase() {
    const { rows } = await query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
    `);

    const mapa = new Map();

    for (const fila of rows) {
        if (!mapa.has(fila.table_name)) {
            mapa.set(fila.table_name, new Set());
        }

        mapa.get(fila.table_name).add(fila.column_name);
    }

    return mapa;
}

function valorPostgres(valor) {
    return valor;
}

async function aplicar(datos, columnasPg, conRespaldo) {
    const marca = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const resumen = [];

    await withTransaction(async cliente => {
        // Respaldo del estado actual (DDL transaccional en PostgreSQL).
        if (conRespaldo) {
            const esquema = `respaldo_${marca}`;
            await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${esquema}`);

            for (const tabla of TABLAS) {
                await cliente.query(`CREATE TABLE IF NOT EXISTS ${esquema}.${tabla} AS TABLE public.${tabla}`);
            }

            console.log(`  Respaldo creado en el esquema ${esquema}.`);
        }

        await cliente.query(`TRUNCATE TABLE ${TABLAS.map(t => `public.${t}`).join(', ')} RESTART IDENTITY CASCADE`);

        for (const tabla of TABLAS) {
            const { columnas, filas } = datos.get(tabla);
            const columnasValidas = columnas.filter(c => columnasPg.get(tabla).has(c));
            const indices = columnasValidas.map(c => columnas.indexOf(c));

            if (filas.length === 0) {
                resumen.push([tabla, 0]);
                continue;
            }

            const listaColumnas = columnasValidas.map(c => `"${c}"`).join(', ');

            for (let inicio = 0; inicio < filas.length; inicio += TAMANO_LOTE) {
                const lote = filas.slice(inicio, inicio + TAMANO_LOTE);
                const parametros = [];
                const tuplas = [];

                for (const fila of lote) {
                    const marcadores = [];

                    for (const indice of indices) {
                        parametros.push(valorPostgres(fila[indice]));
                        marcadores.push(`$${parametros.length}`);
                    }

                    tuplas.push(`(${marcadores.join(', ')})`);
                }

                await cliente.query(
                    `INSERT INTO public.${tabla} (${listaColumnas}) VALUES ${tuplas.join(', ')}`,
                    parametros
                );
            }

            resumen.push([tabla, filas.length]);
        }

        // Secuencias IDENTITY al máximo ID insertado.
        const pks = {
            usuarios: 'usuario_id', productos: 'producto_id', herramientas: 'herramienta_id',
            activos: 'activo_id', movimientos_inventario: 'movimiento_id',
            activo_materiales: 'id', herramientas_movimientos: 'movimiento_id',
            historial_usuario: 'historial_id', entradas_almacen: 'entrada_id',
            materiales_danados: 'danado_id', tomas_fisicas: 'toma_id', toma_fisica_detalle: 'detalle_id',
        };

        for (const [tabla, pk] of Object.entries(pks)) {
            await cliente.query(
                `SELECT setval(
                     pg_get_serial_sequence($1, $2),
                     GREATEST(COALESCE((SELECT MAX("${pk}") FROM public.${tabla}), 0), 1),
                     COALESCE((SELECT MAX("${pk}") FROM public.${tabla}), 0) > 0
                 )`,
                [`public.${tabla}`, pk]
            );
        }

        // Verificación dentro de la misma transacción.
        for (const [tabla, esperado] of resumen) {
            const { rows } = await cliente.query(`SELECT COUNT(*)::int AS n FROM public.${tabla}`);

            if (rows[0].n !== esperado) {
                throw new Error(`Conteo distinto en ${tabla}: esperado ${esperado}, hay ${rows[0].n}.`);
            }
        }

        for (const [tabla, columna, destino, destinoPk, opcional] of CLAVES_FORANEAS) {
            const { rows } = await cliente.query(`
                SELECT COUNT(*)::int AS n
                FROM public.${tabla} t
                WHERE t."${columna}" IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.${destino} d WHERE d."${destinoPk}" = t."${columna}"
                  )
            `);

            if (rows[0].n > 0 && !opcional) {
                throw new Error(`Quedaron ${rows[0].n} fila(s) de ${tabla} sin ${destino} (${columna}).`);
            }
        }
    });

    return resumen;
}

// ---------------------------------------------------------------------------
// 5. Programa
// ---------------------------------------------------------------------------

const [archivo, ...opciones] = process.argv.slice(2);
const aplicarCambios = opciones.includes('--aplicar');
const conRespaldo = !opciones.includes('--sin-respaldo');

if (!archivo) {
    console.error('Uso: node tools/importar_dump_mariadb.mjs "ruta/al/volcado.sql" [--aplicar] [--sin-respaldo]');
    process.exit(1);
}

const ruta = path.resolve(archivo);

if (!fs.existsSync(ruta)) {
    console.error(`No existe el archivo: ${ruta}`);
    process.exit(1);
}

const crudo = fs.readFileSync(ruta, 'utf8');
const { texto, reparado } = repararCodificacion(crudo);
const datos = parsearVolcado(texto);

console.log(`Archivo: ${ruta}`);
console.log(`Codificación reparada: ${reparado ? 'sí (mojibake latin1)' : 'no hacía falta'}`);
console.log('\nFilas en el volcado:');

for (const tabla of TABLAS) {
    console.log('  ', tabla.padEnd(26), datos.get(tabla)?.filas.length ?? 0);
}

const columnasPg = await columnasDeSupabase();
const errores = validar(datos, columnasPg);

if (errores.length > 0) {
    console.error('\nEl volcado no se puede importar:');
    for (const error of errores) console.error('  -', error);
    await cerrar();
    process.exit(1);
}

console.log('\nValidación: OK (tablas, columnas e integridad referencial).');

const referenciasAjustadas = depurarReferencias(datos);

if (referenciasAjustadas > 0) {
    console.log(`Referencias huérfanas opcionales convertidas a NULL: ${referenciasAjustadas}`);
}

if (!aplicarCambios) {
    console.log('\nModo simulación. Ejecuta con --aplicar para escribir en Supabase.');
    await cerrar();
    process.exit(0);
}

console.log('\nAplicando en Supabase (una sola transacción)...');
const resumen = await aplicar(datos, columnasPg, conRespaldo);

console.log('\nFilas insertadas:');
for (const [tabla, filas] of resumen) {
    console.log('  ', tabla.padEnd(26), filas);
}

await cerrar();
console.log('\nImportación completada.');
