import test from 'node:test';
import assert from 'node:assert/strict';

import {
    esNumerico,
    numero,
    entero,
    texto,
    mbsub,
    redondear,
    cantidad,
    esFecha,
    escaparHtml,
    limpiarTexto,
    hoy,
    ahoraIso,
} from '../../src/http.js';

test('esNumerico acepta lo mismo que is_numeric() de PHP', () => {
    for (const valor of ['1', '1.5', '.5', '1.', '+2', '-3.25', '1e3', ' 7 ']) {
        assert.equal(esNumerico(valor), true, `debería aceptar ${JSON.stringify(valor)}`);
    }

    for (const valor of ['', ' ', 'abc', '1,5', '1 2', null, undefined, {}, []]) {
        assert.equal(esNumerico(valor), false, `debería rechazar ${JSON.stringify(valor)}`);
    }

    assert.equal(esNumerico(42), true);
    assert.equal(esNumerico(Number.NaN), false);
    assert.equal(esNumerico(Number.POSITIVE_INFINITY), false);
});

test('numero convierte o devuelve null', () => {
    assert.equal(numero('2.5'), 2.5);
    assert.equal(numero(' 4 '), 4);
    assert.equal(numero('x'), null);
    assert.equal(numero(null), null);
});

test('entero replica FILTER_VALIDATE_INT', () => {
    assert.equal(entero('12'), 12);
    assert.equal(entero('+12'), 12);
    assert.equal(entero(' 12 '), 12);
    assert.equal(entero('12.5'), null);
    assert.equal(entero('12abc'), null);
    assert.equal(entero(''), null);
    assert.equal(entero(null), null);
    assert.equal(entero(7), 7);
    assert.equal(entero(7.5), null);
});

test('texto recorta y evita objetos', () => {
    assert.equal(texto('  hola  '), 'hola');
    assert.equal(texto(null, 'x'), 'x');
    assert.equal(texto({}, 'x'), 'x');
    assert.equal(texto(0), '0');
});

test('mbsub corta por caracteres, no por bytes', () => {
    assert.equal(mbsub('aaaa', 2), 'aa');
    assert.equal(mbsub('año', 2), 'añ');
    assert.equal(mbsub('áéíóú', 3), 'áéí');
    assert.equal(mbsub(null, 3), '');
});

test('redondear usa mitad lejos de cero como round() de PHP', () => {
    assert.equal(redondear(1.0005, 3), 1.001);
    assert.equal(redondear(-1.0005, 3), -1.001);
    assert.equal(redondear(2.0004, 3), 2);
    assert.equal(redondear(0.1 + 0.2, 3), 0.3);
    assert.equal(redondear(10, 3), 10);
});

test('cantidad imita el formato de 3 decimales sin ceros sobrantes', () => {
    assert.equal(cantidad(1), '1');
    assert.equal(cantidad(1.5), '1.5');
    assert.equal(cantidad('2.250'), '2.25');
    assert.equal(cantidad(0), '0');
    assert.equal(cantidad(null), '0');
    assert.equal(cantidad(1.2345), '1.235');
});

test('esFecha rechaza fechas imposibles', () => {
    assert.equal(esFecha('2026-02-28'), true);
    assert.equal(esFecha('2024-02-29'), true);
    assert.equal(esFecha('2026-02-29'), false);
    assert.equal(esFecha('2026-13-01'), false);
    assert.equal(esFecha('2026-1-1'), false);
    assert.equal(esFecha('01/01/2026'), false);
    assert.equal(esFecha(''), false);
});

test('hoy y ahoraIso respetan la zona configurada', () => {
    assert.match(hoy(), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(ahoraIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('escaparHtml neutraliza los cinco caracteres peligrosos', () => {
    assert.equal(escaparHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(escaparHtml(null), '');
});

test('limpiarTexto colapsa saltos de línea y tabuladores', () => {
    assert.equal(limpiarTexto('  a\r\n\tb  '), 'a b');
});
