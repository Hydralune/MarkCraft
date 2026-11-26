$Document = $env:MARKCRAFT_WORD_DOC
$OutputImage = $env:MARKCRAFT_WORD_PNG
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$word = New-Object -ComObject Word.Application
try {
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $doc = $word.Documents.Open($Document, $false, $true, $false)
    try {
        $doc.ActiveWindow.View.Type = 3
        $doc.Repaginate()
        $page = $doc.ActiveWindow.Panes.Item(1).Pages.Item(1)
        $stream = [IO.MemoryStream]::new([byte[]]$page.EnhMetaFileBits)
        $picture = [Drawing.Imaging.Metafile]::new($stream)
        $width = 1024
        $height = [int][Math]::Round($width * $page.Height / $page.Width)
        $bitmap = [Drawing.Bitmap]::new($width, $height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::White)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($picture, [Drawing.Rectangle]::new(0, 0, $width, $height))
            $bitmap.Save($OutputImage, [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
            $picture.Dispose()
            $stream.Dispose()
        }
    } finally { $doc.Close(0) }
} finally { try { $word.Quit() } catch {} }
exit 0
