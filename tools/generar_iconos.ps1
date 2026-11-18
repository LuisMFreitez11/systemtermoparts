# Genera los iconos PNG de la PWA sin dependencias externas (Windows / .NET).
# Uso: powershell -ExecutionPolicy Bypass -File tools/generar_iconos.ps1

Add-Type -AssemblyName System.Drawing

$destino = Join-Path $PSScriptRoot '..\frontend\icons'

function New-Icono {
    param([int]$Tamano, [string]$Archivo, [bool]$Maskable)

    $bmp = New-Object System.Drawing.Bitmap($Tamano, $Tamano)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(30, 58, 138))

    # Fondo con degradado
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Tamano, $Tamano)
    $pincelFondo = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(30, 58, 138),
        [System.Drawing.Color]::FromArgb(14, 116, 144),
        45.0
    )
    $g.FillRectangle($pincelFondo, $rect)

    # Escala del contenido (los iconos maskable dejan margen de seguridad)
    $escala = if ($Maskable) { 0.62 } else { 0.78 }
    $centro = $Tamano / 2.0
    $largo = $Tamano * $escala

    $pluma = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]($Tamano * 0.045))
    $pluma.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pluma.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    # Copo de nieve: 3 ejes
    $g.DrawLine($pluma, $centro, $centro - $largo / 2, $centro, $centro + $largo / 2)
    $dx = [Math]::Cos([Math]::PI / 6) * $largo / 2
    $dy = [Math]::Sin([Math]::PI / 6) * $largo / 2
    $g.DrawLine($pluma, $centro - $dx, $centro - $dy, $centro + $dx, $centro + $dy)
    $g.DrawLine($pluma, $centro + $dx, $centro - $dy, $centro - $dx, $centro + $dy)

    # Estantes del almacén
    $anchoEstante = $largo * 0.78
    $altoEstante = [float]($Tamano * 0.052)
    $pincelBlanco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillRectangle($pincelBlanco, $centro - $anchoEstante / 2, $centro + $largo * 0.12, $anchoEstante, $altoEstante)
    $g.FillRectangle($pincelBlanco, $centro - $anchoEstante / 2, $centro + $largo * 0.26, $anchoEstante, $altoEstante)

    # Punto superior
    $radio = [float]($Tamano * 0.055)
    $g.FillEllipse($pincelBlanco, $centro - $radio, $centro - $largo / 2 - $radio, $radio * 2, $radio * 2)

    $ruta = Join-Path $destino $Archivo
    $bmp.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose()
    $bmp.Dispose()

    Write-Output "Generado: $ruta"
}

New-Icono -Tamano 192 -Archivo 'icon-192.png' -Maskable $false
New-Icono -Tamano 512 -Archivo 'icon-512.png' -Maskable $false
New-Icono -Tamano 192 -Archivo 'icon-maskable-192.png' -Maskable $true
New-Icono -Tamano 512 -Archivo 'icon-maskable-512.png' -Maskable $true
