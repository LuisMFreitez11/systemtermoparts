/**
 * Estado actual de la base de Supabase: conteos, stock, secuencias y RLS.
 *
 * Uso: node tools/estado-supabase.mjs
 */
import { query, cerrar } from '../server/src/db.js';

const TABLAS = [
    'usuarios', 'productos', 'herramientas', 'activos', 'movimientos_inventario',
    'activo_materiales', 'herramientas_movimientos', 'historial_usuario',
    'entradas_almacen', 'materiales_danados', 'tomas_fisicas', 'toma_fisica_detalle',
    'operaciones_idempotencia',
];

const conexion = await query('SELECT current_database() AS db, current_user AS usuario, version() AS version');
console.log('Conexión:', conexion.rows[0].db, '|', conexion.rows[0].usuario, '|', conexion.rows[0].version.split(' on ')[0]);

console.log('\nConteos:');
for (const tabla of TABLAS) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM public.${tabla}`);
    console.log('  ', tabla.padEnd(26), rows[0].n);
}

const resumen = await query(`
    SELECT COUNT(*)::int AS productos,
           COALESCE(SUM(stock_actual), 0)::text AS stock,
           COALESCE(SUM(stock_danado), 0)::text AS danado
    FROM public.productos
`);
console.log('\nStock:', resumen.rows[0]);

const activos = await query('SELECT tipo, COUNT(*)::int AS n FROM public.activos GROUP BY tipo ORDER BY tipo');
console.log('Activos:', activos.rows.map(fila => `${fila.tipo}=${fila.n}`).join(' · ') || 'sin activos');

const secuencias = await query(`
    SELECT sequencename, last_value::text AS ultimo
    FROM pg_sequences
    WHERE schemaname = 'public'
    ORDER BY sequencename
`);
console.log('\nSecuencias (último valor emitido):');
for (const fila of secuencias.rows) console.log('  ', fila.sequencename.padEnd(34), fila.ultimo);

const rls = await query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    ORDER BY relname
`);
const conRls = rls.rows.filter(fila => fila.relrowsecurity).length;
console.log(`\nRLS activo en ${conRls}/${rls.rows.length} tablas.`);

const respaldos = await query(`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'respaldo_%' ORDER BY schema_name
`);
if (respaldos.rows.length > 0) {
    console.log('Respaldos:', respaldos.rows.map(fila => fila.schema_name).join(', '));
}

await cerrar();
