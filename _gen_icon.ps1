Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Fundo gradiente simples (azul escuro -> roxo)
$rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 38, 80, 220),
    [System.Drawing.Color]::FromArgb(255, 110, 60, 200),
    45.0
)
$g.FillRectangle($brush, $rect)

# Letras "BM"
$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
$style = [System.Drawing.FontStyle]1  # 1 = Bold
$unit = [System.Drawing.GraphicsUnit]2  # 2 = Pixel
$font = New-Object System.Drawing.Font $fontFamily, ([single]480), $style, $unit
$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('BM', $font, $textBrush, [single]($size / 2), [single]($size / 2 + 20), $format)

$out = Join-Path $PSScriptRoot 'app-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "icon written: $out"
