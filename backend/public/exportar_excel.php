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

$sql = "SELECT sku_codigo, nombre_descripcion, categoria, lote_condicion, unidad_medida, stock_actual, stock_consumido, stock_incrementado, stock_danado, stock_minimo, toma_fisica_anterior FROM productos";
if ($condiciones !== []) {
    $sql .= ' WHERE ' . implode(' AND ', $condiciones);
}
$sql .= ' ORDER BY categoria ASC, sku_codigo ASC';

$stmt = $pdo->prepare($sql);
$stmt->execute($parametros);
$productos = $stmt->fetchAll();

/**
 * Limpia el texto para que no introduzca saltos o tabulaciones dentro de la celda.
 */
function limpiarTexto(mixed $valor): string
{
    return trim(str_replace(["\r\n", "\r", "\n", "\t"], ' ', (string) $valor));
}

/**
 * Escapa un valor para incluirlo de forma segura dentro de un XML.
 */
function escaparXml(mixed $valor): string
{
    $texto = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', (string) $valor) ?? '';

    return htmlspecialchars($texto, ENT_QUOTES | ENT_XML1, 'UTF-8');
}

/**
 * Genera una celda de texto con estilo.
 */
function celdaTexto(string $referencia, mixed $valor, int $estilo): string
{
    return '<c r="' . $referencia . '" s="' . $estilo . '" t="inlineStr"><is><t xml:space="preserve">'
        . escaparXml($valor) . '</t></is></c>';
}

/**
 * Genera una celda numérica con estilo.
 */
function celdaNumero(string $referencia, mixed $valor, int $estilo): string
{
    $numero = rtrim(rtrim(number_format((float) $valor, 3, '.', ''), '0'), '.');
    if ($numero === '' || $numero === '-0') {
        $numero = '0';
    }

    return '<c r="' . $referencia . '" s="' . $estilo . '"><v>' . $numero . '</v></c>';
}

/**
 * Devuelve la letra de una columna a partir de su índice base cero.
 */
function letraColumna(int $indice): string
{
    $letra = '';
    $indice++;

    while ($indice > 0) {
        $modulo = ($indice - 1) % 26;
        $letra = chr(65 + $modulo) . $letra;
        $indice = intdiv($indice - 1, 26);
    }

    return $letra;
}

/**
 * Construye el XML de una hoja con título, encabezados y filas de datos.
 *
 * @param array<int, array<int, mixed>> $filas La primera fila es el encabezado.
 * @param array<int, float|int> $anchos Ancho de cada columna.
 */
function construirHoja(array $filas, array $anchos, string $titulo): string
{
    $numColumnas = max(array_map('count', $filas));
    $ultimaColumna = letraColumna($numColumnas - 1);
    $ultimaFila = count($filas) + 1;

    $sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
    $sheet .= '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    $sheet .= '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
    $sheet .= '<dimension ref="A1:' . $ultimaColumna . $ultimaFila . '"/>';
    $sheet .= '<sheetViews><sheetView showGridLines="0" workbookViewId="0">';
    $sheet .= '<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>';
    $sheet .= '<selection pane="bottomLeft" activeCell="A3" sqref="A3"/>';
    $sheet .= '</sheetView></sheetViews>';
    $sheet .= '<sheetFormatPr defaultRowHeight="15"/>';
    $sheet .= '<cols>';

    foreach ($anchos as $indice => $ancho) {
        $numeroColumna = $indice + 1;
        $sheet .= '<col min="' . $numeroColumna . '" max="' . $numeroColumna . '" width="' . $ancho . '" customWidth="1"/>';
    }

    $sheet .= '</cols>';
    $sheet .= '<sheetData>';

    // Fila de título.
    $sheet .= '<row r="1" ht="30" customHeight="1">';
    $sheet .= celdaTexto('A1', $titulo, 4);
    $sheet .= '</row>';

    // Encabezados y datos.
    foreach ($filas as $indice => $fila) {
        $numeroFila = $indice + 2;
        $altura = $indice === 0 ? ' ht="26" customHeight="1"' : ' ht="18" customHeight="1"';

        $sheet .= '<row r="' . $numeroFila . '"' . $altura . '>';

        foreach ($fila as $indiceColumna => $valor) {
            $referencia = letraColumna($indiceColumna) . $numeroFila;

            if ($indice === 0) {
                $sheet .= celdaTexto($referencia, $valor, 1);
            } elseif (is_int($valor) || is_float($valor)) {
                $sheet .= celdaNumero($referencia, $valor, 3);
            } else {
                $sheet .= celdaTexto($referencia, $valor, 2);
            }
        }

        $sheet .= '</row>';
    }

    $sheet .= '</sheetData>';
    if (count($filas) > 1) {
        $sheet .= '<autoFilter ref="A2:' . $ultimaColumna . $ultimaFila . '"/>';
    }
    $sheet .= '<mergeCells count="1"><mergeCell ref="A1:' . $ultimaColumna . '1"/></mergeCells>';
    $sheet .= '<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>';
    $sheet .= '<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>';
    $sheet .= '</worksheet>';

    return $sheet;
}

/**
 * Crea un archivo ZIP (sin compresión) con los archivos indicados.
 * Se implementa manualmente para no depender de la extensión zip de PHP.
 *
 * @param array<string, string> $archivos
 */
function crearZip(array $archivos): string
{
    $ahora = getdate();
    $horaDos = ($ahora['hours'] << 11) | ($ahora['minutes'] << 5) | intdiv($ahora['seconds'], 2);
    $fechaDos = (($ahora['year'] - 1980) << 9) | ($ahora['mon'] << 5) | $ahora['mday'];

    $contenido = '';
    $directorioCentral = '';
    $offset = 0;
    $total = 0;

    foreach ($archivos as $nombre => $datos) {
        $nombre = str_replace('\\', '/', $nombre);
        $crc = crc32($datos);
        $tamano = strlen($datos);
        $largoNombre = strlen($nombre);

        $cabeceraLocal = pack(
            'VvvvvvVVVvv',
            0x04034b50,
            20,
            0x0800,
            0,
            $horaDos,
            $fechaDos,
            $crc,
            $tamano,
            $tamano,
            $largoNombre,
            0
        ) . $nombre;

        $contenido .= $cabeceraLocal . $datos;

        $directorioCentral .= pack(
            'VvvvvvvVVVvvvvvVV',
            0x02014b50,
            20,
            20,
            0x0800,
            0,
            $horaDos,
            $fechaDos,
            $crc,
            $tamano,
            $tamano,
            $largoNombre,
            0,
            0,
            0,
            0,
            0,
            $offset
        ) . $nombre;

        $offset += strlen($cabeceraLocal) + $tamano;
        $total++;
    }

    $finDirectorio = pack(
        'VvvvvVVv',
        0x06054b50,
        0,
        0,
        $total,
        $total,
        strlen($directorioCentral),
        $offset,
        0
    );

    return $contenido . $directorioCentral . $finDirectorio;
}

$partesFiltro = [];
if ($categoria !== '') {
    $partesFiltro[] = 'CATEGORÍA: ' . $categoria;
}
if ($buscar !== '') {
    $partesFiltro[] = 'BÚSQUEDA: ' . $buscar;
}
$textoFiltro = $partesFiltro === [] ? 'TODOS LOS PRODUCTOS' : implode(' · ', $partesFiltro);

$filasInventario = [[
    'CÓDIGO',
    'DESCRIPCIÓN',
    'LOTE/CONDICIÓN',
    'UNIDAD',
    'TOMA FÍSICA ANTERIOR',
    'STOCK ACTUAL',
    'CONSUMIDO',
    'INCREMENTADO',
    'DAÑADO',
    'STOCK MÍNIMO',
]];

$filasAlmacen = [[
    'N°',
    'DESCRIPCIÓN',
    'CÓDIGO',
    'LOTE',
    'UNID',
    'TOMA FÍSICA ANTERIOR',
    'ALMACÉN ACTUAL',
    'CONSUMIDO',
    'INCREMENTADO',
    'DAÑADO',
    'STOCK MÍNIMO',
]];

$numero = 0;
foreach ($productos as $p) {
    $numero++;

    $fila = [
        limpiarTexto($p['sku_codigo']),
        limpiarTexto($p['nombre_descripcion']),
        limpiarTexto($p['lote_condicion'] ?? 'STOCK'),
        limpiarTexto($p['unidad_medida']),
        (float) $p['toma_fisica_anterior'],
        (float) $p['stock_actual'],
        (float) $p['stock_consumido'],
        (float) $p['stock_incrementado'],
        (float) $p['stock_danado'],
        (float) $p['stock_minimo'],
    ];

    $filasInventario[] = $fila;

    $filasAlmacen[] = [
        $numero,
        limpiarTexto($p['nombre_descripcion']),
        limpiarTexto($p['sku_codigo']),
        limpiarTexto($p['lote_condicion'] ?? 'STOCK'),
        limpiarTexto($p['unidad_medida']),
        (float) $p['toma_fisica_anterior'],
        (float) $p['stock_actual'],
        (float) $p['stock_consumido'],
        (float) $p['stock_incrementado'],
        (float) $p['stock_danado'],
        (float) $p['stock_minimo'],
    ];
}

$hojaInventario = construirHoja(
    $filasInventario,
    [16, 48, 20, 11, 18, 16, 16, 16, 16, 16],
    'INVENTARIO GENERAL - ' . $textoFiltro
);

$hojaAlmacen = construirHoja(
    $filasAlmacen,
    [6, 48, 16, 20, 11, 18, 16, 16, 16, 16, 16],
    'ALMACEN ES04 COMPLETO - ' . $textoFiltro
);

$styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$styles .= '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
$styles .= '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.###"/></numFmts>';
$styles .= '<fonts count="3">';
$styles .= '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
$styles .= '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
$styles .= '<font><b/><sz val="14"/><color rgb="FF1E3A8A"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
$styles .= '</fonts>';
$styles .= '<fills count="4">';
$styles .= '<fill><patternFill patternType="none"/></fill>';
$styles .= '<fill><patternFill patternType="gray125"/></fill>';
$styles .= '<fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill>';
$styles .= '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>';
$styles .= '</fills>';
$styles .= '<borders count="2">';
$styles .= '<border><left/><right/><top/><bottom/><diagonal/></border>';
$styles .= '<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>';
$styles .= '</borders>';
$styles .= '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
$styles .= '<cellXfs count="5">';
$styles .= '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
$styles .= '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>';
$styles .= '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>';
$styles .= '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>';
$styles .= '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>';
$styles .= '</cellXfs>';
$styles .= '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
$styles .= '<dxfs count="0"/>';
$styles .= '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>';
$styles .= '</styleSheet>';

$workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$workbook .= '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
$workbook .= '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="24325"/>';
$workbook .= '<workbookPr defaultThemeVersion="166925"/>';
$workbook .= '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>';
$workbook .= '<sheets>';
$workbook .= '<sheet name="Inventario" sheetId="1" r:id="rId1"/>';
$workbook .= '<sheet name="ALMACEN ES04 COMPLETO" sheetId="2" r:id="rId2"/>';
$workbook .= '</sheets>';
$workbook .= '<calcPr calcId="191029"/>';
$workbook .= '</workbook>';

$workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$workbookRels .= '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
$workbookRels .= '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>';
$workbookRels .= '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>';
$workbookRels .= '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
$workbookRels .= '</Relationships>';

$rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$rootRels .= '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
$rootRels .= '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>';
$rootRels .= '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>';
$rootRels .= '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>';
$rootRels .= '</Relationships>';

$contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$contentTypes .= '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
$contentTypes .= '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
$contentTypes .= '<Default Extension="xml" ContentType="application/xml"/>';
$contentTypes .= '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
$contentTypes .= '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
$contentTypes .= '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
$contentTypes .= '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
$contentTypes .= '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';
$contentTypes .= '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
$contentTypes .= '</Types>';

$fechaXml = gmdate('Y-m-d\TH:i:s\Z');

$core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$core .= '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">';
$core .= '<dc:title>Inventario Termo Part</dc:title>';
$core .= '<dc:creator>Termo Part WMS</dc:creator>';
$core .= '<cp:lastModifiedBy>Termo Part WMS</cp:lastModifiedBy>';
$core .= '<dcterms:created xsi:type="dcterms:W3CDTF">' . $fechaXml . '</dcterms:created>';
$core .= '<dcterms:modified xsi:type="dcterms:W3CDTF">' . $fechaXml . '</dcterms:modified>';
$core .= '</cp:coreProperties>';

$app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
$app .= '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">';
$app .= '<Application>Microsoft Excel</Application>';
$app .= '<DocSecurity>0</DocSecurity>';
$app .= '<ScaleCrop>false</ScaleCrop>';
$app .= '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>';
$app .= '<TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Inventario</vt:lpstr><vt:lpstr>ALMACEN ES04 COMPLETO</vt:lpstr></vt:vector></TitlesOfParts>';
$app .= '<Company>Termo Part</Company>';
$app .= '<LinksUpToDate>false</LinksUpToDate>';
$app .= '<SharedDoc>false</SharedDoc>';
$app .= '<HyperlinksChanged>false</HyperlinksChanged>';
$app .= '<AppVersion>16.0300</AppVersion>';
$app .= '</Properties>';

$xlsx = crearZip([
    '[Content_Types].xml' => $contentTypes,
    '_rels/.rels' => $rootRels,
    'docProps/app.xml' => $app,
    'docProps/core.xml' => $core,
    'xl/workbook.xml' => $workbook,
    'xl/_rels/workbook.xml.rels' => $workbookRels,
    'xl/styles.xml' => $styles,
    'xl/worksheets/sheet1.xml' => $hojaInventario,
    'xl/worksheets/sheet2.xml' => $hojaAlmacen,
]);

header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
header('Content-Disposition: attachment; filename=Inventario_TermoPart_' . date('Y-m-d') . '.xlsx');
header('Content-Length: ' . strlen($xlsx));
header('Cache-Control: max-age=0');
header('Pragma: no-cache');

echo $xlsx;
exit;
