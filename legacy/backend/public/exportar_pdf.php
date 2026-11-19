<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/bootstrap.php';

Auth::requiereSesion(false);

$buscar = mb_substr(trim((string) ($_GET['buscar'] ?? '')), 0, 100);

$categoria = preg_replace('/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/u', '', trim((string) ($_GET['categoria'] ?? ''))) ?? '';
$categoria = mb_strtoupper($categoria);

$condiciones = [];
$parametros = [];

if ($buscar !== '') {
    $condiciones[] = '(POSITION(LOWER(:buscar_codigo) IN LOWER(sku_codigo)) > 0 OR POSITION(LOWER(:buscar_descripcion) IN LOWER(nombre_descripcion)) > 0)';
    $parametros[':buscar_codigo'] = $buscar;
    $parametros[':buscar_descripcion'] = $buscar;
}

if ($categoria !== '') {
    $condiciones[] = 'categoria = :categoria';
    $parametros[':categoria'] = $categoria;
}

$sql = "SELECT * FROM productos";
if ($condiciones !== []) {
    $sql .= ' WHERE ' . implode(' AND ', $condiciones);
}
$sql .= ' ORDER BY categoria ASC, sku_codigo ASC';

$stmt = $pdo->prepare($sql);
$stmt->execute($parametros);
$productos = $stmt->fetchAll();

/**
 * Escapa cualquier valor para mostrarlo de forma segura en HTML.
 */
function e(mixed $valor): string
{
    return htmlspecialchars((string) ($valor ?? ''), ENT_QUOTES, 'UTF-8');
}

/**
 * Muestra una cantidad sin ceros decimales innecesarios.
 */
function cantidad(mixed $valor): string
{
    $numero = rtrim(rtrim(number_format((float) $valor, 3, '.', ''), '0'), '.');

    return $numero === '' || $numero === '-0' ? '0' : $numero;
}

$partesFiltro = [];
if ($buscar !== '') {
    $partesFiltro[] = 'búsqueda "' . $buscar . '"';
}
if ($categoria !== '') {
    $partesFiltro[] = 'categoría ' . $categoria;
}
$textoFiltro = $partesFiltro === [] ? 'Todos los productos' : implode(' · ', $partesFiltro);

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
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
        <strong>Fecha de Emisión:</strong> <?= date('d/m/Y H:i:s') ?><br>
        <strong>Almacén Principal:</strong> ES04<br>
        <strong>Filtro aplicado:</strong> <?= e($textoFiltro) ?><br>
        <strong>Total de productos:</strong> <?= count($productos) ?>
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
        <tbody>
            <?php if ($productos === []): ?>
            <tr>
                <td colspan="10" class="sin-datos">No hay productos registrados para el filtro seleccionado.</td>
            </tr>
            <?php else: ?>
                <?php foreach ($productos as $p): ?>
                <tr>
                    <td><?= e($p['sku_codigo']) ?></td>
                    <td><?= e($p['nombre_descripcion']) ?></td>
                    <td><?= e($p['lote_condicion'] ?? 'STOCK') ?></td>
                    <td><?= e($p['unidad_medida']) ?></td>
                    <td class="toma-fisica"><?= e($p['toma_fisica_anterior'] === null ? '' : cantidad($p['toma_fisica_anterior'])) ?></td>
                    <td><?= e($p['stock_actual'] === null ? '' : cantidad($p['stock_actual'])) ?></td>
                    <td class="consumido"><?= e($p['stock_consumido'] === null ? '' : cantidad($p['stock_consumido'])) ?></td>
                    <td class="incrementado"><?= e($p['stock_incrementado'] === null ? '' : cantidad($p['stock_incrementado'])) ?></td>
                    <td class="danado"><?= e($p['stock_danado'] === null ? '' : cantidad($p['stock_danado'])) ?></td>
                    <td><?= e($p['stock_minimo'] === null ? '' : cantidad($p['stock_minimo'])) ?></td>
                </tr>
                <?php endforeach; ?>
            <?php endif; ?>
        </tbody>
    </table>
</body>
</html>
