# Generates icon-512.png and icon-192.png — blue tile with a white mic glyph
Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$blue  = [System.Drawing.Color]::FromArgb(255, 26, 140, 255)
$white = [System.Drawing.Brushes]::White

$g.Clear($blue)

# Mic capsule
$capsule = New-Object System.Drawing.Drawing2D.GraphicsPath
$capsule.AddArc(216, 110, 80, 80, 180, 180)
$capsule.AddArc(216, 200, 80, 80, 0, 180)
$capsule.CloseFigure()
$g.FillPath($white, $capsule)

# U-shaped stand
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 28)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($pen, 176, 130, 160, 220, 0, 180)

# Stem + base
$g.DrawLine($pen, 256, 350, 256, 400)
$g.DrawLine($pen, 196, 408, 316, 408)

$g.Dispose()
$bmp.Save("$PSScriptRoot\icon-512.png", [System.Drawing.Imaging.ImageFormat]::Png)

$small = New-Object System.Drawing.Bitmap($bmp, 192, 192)
$small.Save("$PSScriptRoot\icon-192.png", [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$bmp.Dispose()
Write-Output "icons generated"
