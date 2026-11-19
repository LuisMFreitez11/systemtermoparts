import test from 'node:test';
import assert from 'node:assert/strict';

import { validarProducto, categoriaDesdeDescripcion } from '../../src/routes/productos.js';
import { validarActivo, normalizarMateriales, normalizarTipoActivo } from '../../src/routes/activos.js';
import { validarHerramienta } from '../../src/routes/herramientas.js';
import { validarEntrada } from '../../src/routes/entradas.js';
import { validarDanado } from '../../src/routes/danados.js';
import { hoy } from '../../src/http.js';

/** Ejecuta un validador y devuelve el error HttpError (o null). */
function capturar(fn) {
    try {
        return { valor: fn(), error: null };
    } catch (error) {
        return { valor: null, error };
    }
}

function mensajeDe(fn) {
    return capturar(fn).error?.message ?? '';
}

const PRODUCTO = {
    sku_codigo: 'ABC-1',
    nombre_descripcion: 'Filtro de aceite',
    lote_condicion: 'nuevo',
    unidad_medida: 'UND',
    stock_actual: '10',
    stock_minimo: '2',
};

test('categoriaDesdeDescripcion toma la primera palabra en mayúsculas', () => {
    assert.equal(categoriaDesdeDescripcion('Filtro de aceite'), 'FILTRO');
    assert.equal(categoriaDesdeDescripcion('  válvula  de paso'), 'VÁLVULA');
    assert.equal(categoriaDesdeDescripcion('---'), 'OTROS');
    assert.equal(categoriaDesdeDescripcion(''), 'OTROS');
    assert.equal(categoriaDesdeDescripcion('ñandú x'), 'ÑANDÚ');
});

test('validarProducto normaliza lote, categoría y números', () => {
    const producto = validarProducto(PRODUCTO);

    assert.equal(producto.sku_codigo, 'ABC-1');
    assert.equal(producto.categoria, 'FILTRO');
    assert.equal(producto.lote_condicion, 'STOCK');
    assert.equal(producto.stock_actual, 10);
    assert.equal(producto.stock_minimo, 2);

    assert.equal(validarProducto({ ...PRODUCTO, lote_condicion: 'STOK' }).lote_condicion, 'STOCK');
    assert.equal(validarProducto({ ...PRODUCTO, lote_condicion: 'recup' }).lote_condicion, 'RECUPERADO');
});

test('validarProducto rechaza campos obligatorios y rangos', () => {
    assert.match(mensajeDe(() => validarProducto({ ...PRODUCTO, sku_codigo: '' })), /código es obligatorio/);
    assert.match(mensajeDe(() => validarProducto({ ...PRODUCTO, nombre_descripcion: '' })), /descripción del producto es obligatoria/);
    assert.match(mensajeDe(() => validarProducto({ ...PRODUCTO, unidad_medida: '   ' })), /unidad de medida es obligatoria/);
    assert.match(mensajeDe(() => validarProducto({ ...PRODUCTO, stock_actual: '-1' })), /stock actual/);
    assert.match(mensajeDe(() => validarProducto({ ...PRODUCTO, stock_minimo: 'abc' })), /stock mínimo/);
    assert.equal(capturar(() => validarProducto({ ...PRODUCTO, stock_actual: '1000000000' })).error.status, 422);
});

test('validarProducto exige ID válido al actualizar y acumula errores', () => {
    const { error } = capturar(() => validarProducto({ ...PRODUCTO, producto_id: '0' }, true));

    assert.equal(error.status, 422);
    assert.match(error.message, /ID del producto no es válido/);
});

const ACTIVO = {
    fecha_ruta: '2026-02-28',
    activo: 'A-100',
    modelo: 'Caterpillar 320',
    nro_orden: 'OS-1',
    numero_reporte: 'R-9',
    nombre_cliente: 'Cliente',
    reparacion: 'Cambio de filtros',
};

test('validarActivo acepta un activo correcto y normaliza la fecha vacía', () => {
    const activo = validarActivo(ACTIVO);

    assert.equal(activo.fecha_ruta, '2026-02-28');
    assert.equal(activo.nombre_cliente, 'Cliente');
    assert.equal(validarActivo({ ...ACTIVO, fecha_ruta: '' }).fecha_ruta, null);
});

test('validarActivo rechaza fechas imposibles y activo vacío', () => {
    assert.match(mensajeDe(() => validarActivo({ ...ACTIVO, fecha_ruta: '2026-02-31' })), /fecha de ruta no es válida/);
    assert.match(mensajeDe(() => validarActivo({ ...ACTIVO, activo: '' })), /número de activo es obligatorio/);
    assert.match(mensajeDe(() => validarActivo({ ...ACTIVO, activo: 'x'.repeat(51) })), /no puede superar los 50/);
});

test('normalizarMateriales suma duplicados y valida cantidades', () => {
    const mapa = normalizarMateriales([
        { producto_id: '3', cantidad: '1' },
        { producto_id: 3, cantidad: '2.5' },
        { producto_id: 5, cantidad: 1 },
    ]);

    assert.equal(mapa.size, 2);
    assert.equal(mapa.get(3), 3.5);
    assert.equal(mapa.get(5), 1);

    assert.equal(normalizarMateriales(null).size, 0);
    assert.equal(normalizarMateriales('').size, 0);
    assert.match(mensajeDe(() => normalizarMateriales([{ producto_id: 0, cantidad: 1 }])), /producto de uno de los materiales/);
    assert.match(mensajeDe(() => normalizarMateriales([{ producto_id: 1, cantidad: 0 }])), /mayor o igual a 0,001/);
    assert.match(mensajeDe(() => normalizarMateriales('texto')), /lista de materiales no es válida/);
});

test('normalizarTipoActivo acepta CALLE/TALLER y rechaza el resto', () => {
    assert.equal(normalizarTipoActivo(''), 'CALLE');
    assert.equal(normalizarTipoActivo('taller'), 'TALLER');
    assert.match(mensajeDe(() => normalizarTipoActivo('AVION')), /CALLE o TALLER/);
});

const HERRAMIENTA = {
    codigo: 'H-1',
    nombre: 'Llave torque',
    marca: 'Stanley',
    modelo: 'X1',
    cantidad: '3',
    estado: 'disponible',
};

test('validarHerramienta normaliza estado, unidad y cantidad', () => {
    const herramienta = validarHerramienta(HERRAMIENTA);

    assert.equal(herramienta.estado, 'DISPONIBLE');
    assert.equal(herramienta.unidad_medida, 'UNIDAD');
    assert.equal(herramienta.cantidad, 3);
    assert.equal(validarHerramienta({ ...HERRAMIENTA, estado: 'en_reparacion' }).estado, 'EN REPARACION');
});

test('validarHerramienta rechaza códigos, cantidades y estados inválidos', () => {
    assert.match(mensajeDe(() => validarHerramienta({ ...HERRAMIENTA, codigo: '' })), /código de la herramienta es obligatorio/);
    assert.match(mensajeDe(() => validarHerramienta({ ...HERRAMIENTA, nombre: '' })), /nombre de la herramienta es obligatorio/);
    assert.match(mensajeDe(() => validarHerramienta({ ...HERRAMIENTA, cantidad: '-1' })), /número entero entre cero/);
    assert.match(mensajeDe(() => validarHerramienta({ ...HERRAMIENTA, cantidad: '1.5' })), /número entero entre cero/);
    assert.match(mensajeDe(() => validarHerramienta({ ...HERRAMIENTA, estado: 'ROTO' })), /estado no es válido/);
});

test('validarEntrada aplica la fecha de hoy por defecto', () => {
    const entrada = validarEntrada({ producto_id: '4', cantidad: '2.5' });

    assert.equal(entrada.fecha_entrada, hoy());
    assert.equal(entrada.cantidad, 2.5);
    assert.match(mensajeDe(() => validarEntrada({ producto_id: 0, cantidad: 1 })), /seleccionar un material/);
    assert.match(mensajeDe(() => validarEntrada({ producto_id: 1, cantidad: '0' })), /mayor o igual a 0,001/);
    assert.match(mensajeDe(() => validarEntrada({ producto_id: 1, cantidad: 1, fecha_entrada: '2026-99-01' })), /fecha de entrada no es válida/);
});

test('validarDanado exige motivo y cantidad', () => {
    const danado = validarDanado({ producto_id: '2', cantidad: '1', motivo: 'Golpe' });

    assert.equal(danado.motivo, 'Golpe');
    assert.equal(danado.fecha_dano, hoy());
    assert.match(mensajeDe(() => validarDanado({ producto_id: 2, cantidad: 1 })), /motivo o tipo de daño/);
    assert.match(mensajeDe(() => validarDanado({ producto_id: 2, cantidad: 0, motivo: 'x' })), /mayor o igual a 0,001/);
});
