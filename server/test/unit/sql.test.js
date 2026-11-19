import test from 'node:test';
import assert from 'node:assert/strict';

import { valoresLote, arregloInt } from '../../src/sql.js';

test('valoresLote genera marcadores consecutivos y parámetros en orden', () => {
    const { sql, parametros } = valoresLote(
        [
            { producto_id: 1, stock_actual: 10.5 },
            { producto_id: 2, stock_actual: 3 },
        ],
        ['producto_id', 'stock_actual']
    );

    assert.equal(sql, '($1, $2), ($3, $4)');
    assert.deepEqual(parametros, [1, 10.5, 2, 3]);
});

test('valoresLote con una sola fila', () => {
    const { sql, parametros } = valoresLote([{ a: 'x' }], ['a']);

    assert.equal(sql, '($1)');
    assert.deepEqual(parametros, ['x']);
});

test('valoresLote respeta valores nulos', () => {
    const { parametros } = valoresLote([{ a: null, b: 0 }], ['a', 'b']);

    assert.deepEqual(parametros, [null, 0]);
});

test('arregloInt produce el literal de un arreglo PostgreSQL', () => {
    assert.equal(arregloInt([1, 2, 3]), '{1,2,3}');
    assert.equal(arregloInt(['4', 5]), '{4,5}');
    assert.equal(arregloInt([]), '{}');
});
