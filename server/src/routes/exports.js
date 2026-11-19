/**
 * Exportaciones del inventario: PDF imprimible (HTML) y XLSX.
 * Se mantienen las mismas columnas, filtros y nombres de archivo que PHP.
 */
import express from 'express';
import ExcelJS from 'exceljs';
import { query } from '../db.js';
import { texto, mbsub, cantidad, escaparHtml, hoy } from '../http.js';
import { requireSessionHtml } from '../auth.js';

const router = express.Router();

const COLUMNAS_INVENTARIO = [
    'CÓDIGO', 'DESCRIPCIÓN', 'LOTE/CONDICIÓN', 'UNIDAD', 'TOMA FÍSICA ANTERIOR',
    'STOCK ACTUAL', 'CONSUMIDO', 'INCREMENTADO', 'DAÑADO', 'STOCK MÍNIMO',
];
const COLUMNAS_ALMACEN = [
    'N°', 'DESCRIPCIÓN', 'CÓDIGO', 'LOTE', 'UNID', 'TOMA FÍSICA ANTERIOR',
    'ALMACÉN ACTUAL', 'CONSUMIDO', 'INCREMENTADO', 'DAÑADO', 'STOCK MÍNIMO',
];
const ANCHOS_INVENTARIO = [16, 48, 20, 11, 18, 16, 16, 16, 16, 16];
const ANCHOS_ALMACEN = [6, 48, 16, 20, 11, 18, 16, 16, 16, 16, 16];

function filtros(req) {
    const buscar = mbsub(texto(req.query.buscar), 100);
    const categoria = texto(req.query.categoria)
        .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/gu, '')
        .toUpperCase();

    return { buscar, categoria };
}

async function productosFiltrados({ buscar, categoria }, columnas) {
    const condiciones = [];
    const parametros = [];

    if (buscar !== '') {
        parametros.push(buscar);
        const p = `$${parametros.length}`;

        condiciones.push(`(POSITION(LOWER(${p}) IN LOWER(sku_codigo)) > 0
                           OR POSITION(LOWER(${p}) IN LOWER(nombre_descripcion)) > 0)`);
    }

    if (categoria !== '') {
        parametros.push(categoria);
        condiciones.push(`categoria = $${parametros.length}`);
    }

    let sql = `SELECT ${columnas} FROM productos`;

    if (condiciones.length > 0) {
        sql += ` WHERE ${condiciones.join(' AND ')}`;
    }

    sql += ' ORDER BY categoria ASC, sku_codigo ASC';

    const { rows } = await query(sql, parametros);

    return rows;
}

function textoFiltroHtml({ buscar, categoria }) {
    const partes = [];

    if (buscar !== '') {
        partes.push(`búsqueda "${buscar}"`);
    }

    if (categoria !== '') {
        partes.push(`categoría ${categoria}`);
    }

    return partes.length === 0 ? 'Todos los productos' : partes.join(' · ');
}

function plantillaPdf(productos, filtro) {
    const filas = productos.length === 0
        ? '<tr><td colspan="10" class="sin-datos">No hay productos registrados para el filtro seleccionado.</td></tr>'
        : productos.map(producto => `
                <tr>
                    <td>${escaparHtml(producto.sku_codigo)}</td>
                    <td>${escaparHtml(producto.nombre_descripcion)}</td>
                    <td>${escaparHtml(producto.lote_condicion ?? 'STOCK')}</td>
                    <td>${escaparHtml(producto.unidad_medida)}</td>
                    <td class="toma-fisica">${producto.toma_fisica_anterior === null ? '' : escaparHtml(cantidad(producto.toma_fisica_anterior))}</td>
                    <td>${producto.stock_actual === null ? '' : escaparHtml(cantidad(producto.stock_actual))}</td>
                    <td class="consumido">${producto.stock_consumido === null ? '' : escaparHtml(cantidad(producto.stock_consumido))}</td>
                    <td class="incrementado">${producto.stock_incrementado === null ? '' : escaparHtml(cantidad(producto.stock_incrementado))}</td>
                    <td class="danado">${producto.stock_danado === null ? '' : escaparHtml(cantidad(producto.stock_danado))}</td>
                    <td>${producto.stock_minimo === null ? '' : escaparHtml(cantidad(producto.stock_minimo))}</td>
                </tr>`).join('');

    const fecha = new Intl.DateTimeFormat('es-VE', {
        timeZone: 'America/Caracas',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).format(new Date());

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Reporte de Inventario - Termo Part</title>
    <style>
        body { font-family: Arial, sans-serif; color: #333; margin: 20px; }
        h2 { text-align: center; color: #1e3a8a; }
        .header-info { margin-bottom: 20px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px 10px; font-size: 12px; text-align: left; }
        th { background: #1e3a8a; color: white; }
        tr:nth-child(even) { background: #f8fafc; }
        .sin-datos { text-align: center; padding: 20px; color: #64748b; }
        .consumido { color: #b45309; font-weight: bold; }
        .incrementado { color: #166534; font-weight: bold; }
        .danado { color: #b91c1c; font-weight: bold; }
        .toma-fisica { color: #b45309; font-weight: bold; }
        @media print {
            body { margin: 0; }
        }
    </style>
</head>
<body onload="window.print();">
    <h2>TERMO PART, C.A. - ALMACÉN COMPLETO (WMS)</h2>
    <div class="header-info">
        <strong>Fecha de Emisión:</strong> ${escaparHtml(fecha)}<br>
        <strong>Almacén Principal:</strong> ES04<br>
        <strong>Filtro aplicado:</strong> ${escaparHtml(textoFiltroHtml(filtro))}<br>
        <strong>Total de productos:</strong> ${productos.length}
    </div>
    <table>
        <thead>
            <tr>
                <th>CÓDIGO</th>
                <th>Descripción del Repuesto</th>
                <th>Condición / Lote</th>
                <th>Unidad</th>
                <th>Toma Física Anterior</th>
                <th>Stock Actual</th>
                <th>Consumido</th>
                <th>Incrementado</th>
                <th>Dañado</th>
                <th>Stock Mínimo</th>
            </tr>
        </thead>
        <tbody>${filas}
        </tbody>
    </table>
</body>
</html>`;
}

function pintarHoja(hoja, columnas, anchos, titulo, filas) {
    const ultimaColumna = String.fromCharCode(64 + columnas.length);

    hoja.columns = anchos.map((ancho, indice) => ({
        width: ancho,
        style: indice >= 4 ? { numFmt: '#,##0.###' } : {},
    }));

    hoja.mergeCells(`A1:${ultimaColumna}1`);
    const celdaTitulo = hoja.getCell('A1');
    celdaTitulo.value = titulo;
    celdaTitulo.font = { bold: true, size: 14, color: { argb: 'FF1E3A8A' } };
    celdaTitulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
    celdaTitulo.alignment = { vertical: 'middle', horizontal: 'left' };
    hoja.getRow(1).height = 22;

    const encabezado = hoja.getRow(2);
    encabezado.values = columnas;
    encabezado.height = 30;
    encabezado.eachCell(celda => {
        celda.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
        celda.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        celda.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        };
    });

    filas.forEach(fila => {
        const renglon = hoja.addRow(fila);
        renglon.eachCell({ includeEmpty: true }, celda => {
            celda.border = {
                top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
                right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            };
            celda.alignment = { vertical: 'middle', wrapText: true };
        });
    });

    const ultimaFila = filas.length + 2;

    if (filas.length > 0) {
        hoja.autoFilter = { from: `A2`, to: `${ultimaColumna}${ultimaFila}` };
    }

    hoja.views = [{ state: 'frozen', ySplit: 2 }];
    hoja.pageSetup = { orientation: 'landscape', paperSize: 9, fitToWidth: 1, fitToHeight: 0 };
}

async function exportarPdf(req, res) {
    const filtro = filtros(req);
    const productos = await productosFiltrados(
        filtro,
        'sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, '
        + 'stock_consumido, stock_incrementado, stock_danado, stock_minimo, toma_fisica_anterior'
    );

    res.type('text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(plantillaPdf(productos, filtro));
}

async function exportarExcel(req, res) {
    const filtro = filtros(req);
    const productos = await productosFiltrados(
        filtro,
        'sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, '
        + 'stock_consumido, stock_incrementado, stock_danado, stock_minimo, toma_fisica_anterior'
    );

    const etiqueta = filtro.categoria !== ''
        ? `CATEGORÍA: ${filtro.categoria}`
        : (filtro.buscar !== '' ? `BÚSQUEDA: ${filtro.buscar}` : 'TODOS LOS PRODUCTOS');
    const titulo = filtro.categoria !== '' && filtro.buscar !== ''
        ? `CATEGORÍA: ${filtro.categoria} · BÚSQUEDA: ${filtro.buscar}`
        : etiqueta;

    const filasInventario = productos.map(producto => [
        producto.sku_codigo, producto.nombre_descripcion, producto.lote_condicion ?? 'STOCK',
        producto.unidad_medida, Number(producto.toma_fisica_anterior), Number(producto.stock_actual),
        Number(producto.stock_consumido), Number(producto.stock_incrementado),
        Number(producto.stock_danado), Number(producto.stock_minimo),
    ]);

    const filasAlmacen = productos.map((producto, indice) => [
        indice + 1, producto.nombre_descripcion, producto.sku_codigo, producto.lote_condicion ?? 'STOCK',
        producto.unidad_medida, Number(producto.toma_fisica_anterior), Number(producto.stock_actual),
        Number(producto.stock_consumido), Number(producto.stock_incrementado),
        Number(producto.stock_danado), Number(producto.stock_minimo),
    ]);

    const libro = new ExcelJS.Workbook();
    libro.creator = 'Termo Parts FW';
    libro.created = new Date();

    const hojaInventario = libro.addWorksheet('Inventario');
    pintarHoja(
        hojaInventario, COLUMNAS_INVENTARIO, ANCHOS_INVENTARIO,
        `INVENTARIO GENERAL - ${titulo}`, filasInventario
    );

    const hojaAlmacen = libro.addWorksheet('ALMACEN ES04 COMPLETO');
    pintarHoja(
        hojaAlmacen, COLUMNAS_ALMACEN, ANCHOS_ALMACEN,
        `ALMACEN ES04 COMPLETO - ${titulo}`, filasAlmacen
    );

    const contenido = Buffer.from(await libro.xlsx.writeBuffer());

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename=Inventario_TermoPart_${hoy()}.xlsx`);
    res.set('Content-Length', String(contenido.length));
    res.set('Cache-Control', 'max-age=0');
    res.set('Pragma', 'no-cache');
    res.send(contenido);
}

// Rutas PHP originales y alias limpios usados por los rewrites de Vercel.
for (const ruta of ['/exportar_pdf.php', '/api/exportar_pdf']) {
    router.get(ruta, requireSessionHtml, exportarPdf);
}

for (const ruta of ['/exportar_excel.php', '/api/exportar_excel']) {
    router.get(ruta, requireSessionHtml, exportarExcel);
}

export default router;
