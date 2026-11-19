/**
 * Utilidades SQL para operaciones por lote.
 *
 * El objetivo es eliminar el N+1: en vez de un INSERT/UPDATE por material,
 * se envía un solo statement con todas las filas.
 */

/** Genera `($1,$2), ($3,$4)...` y el arreglo de parámetros. */
function valoresLote(filas, columnas) {
    const parametros = [];
    let indice = 1;

    const grupos = filas.map(fila => {
        const marcadores = columnas.map(columna => {
            parametros.push(fila[columna]);

            return `$${indice++}`;
        });

        return `(${marcadores.join(', ')})`;
    });

    return { sql: grupos.join(', '), parametros };
}

/** Arreglo de placeholders para `= ANY($n::int[])`. */
function arregloInt(valores) {
    return `{${valores.map(valor => Number(valor)).join(',')}}`;
}

export { valoresLote, arregloInt };
