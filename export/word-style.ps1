$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$settings = [IO.File]::ReadAllText($env:MARKCRAFT_WORD_SETTINGS) | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::Open($env:MARKCRAFT_WORD_DOC, 'Update')
try {
    function Read-Part($path) {
        $xml = [Xml.XmlDocument]::new()
        $stream = $zip.GetEntry($path).Open()
        try { $xml.Load($stream) } finally { $stream.Dispose() }
        return ,$xml
    }
    function Save-Part($path, $xml) {
        $stream = $zip.GetEntry($path).Open()
        try { $stream.SetLength(0); $xml.Save($stream) } finally { $stream.Dispose() }
    }
    $styles = Read-Part 'word/styles.xml'
    $ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    $manager = [Xml.XmlNamespaceManager]::new($styles.NameTable)
    $manager.AddNamespace('w', $ns)
    # Insert new properties in the order required by WordprocessingML.
    $following = @{
        pPr = 'w:rPr|w:r|w:hyperlink|w:bookmarkStart|w:fldSimple'
        spacing = 'w:ind|w:jc|w:outlineLvl|w:rPr|w:sectPr'
        ind = 'w:jc|w:outlineLvl|w:rPr|w:sectPr'
        jc = 'w:textDirection|w:textAlignment|w:outlineLvl|w:rPr|w:sectPr'
        tblCellMar = 'w:tblLook|w:tblCaption|w:tblDescription'
        top = 'w:left|w:start|w:bottom|w:right|w:end'
        bottom = 'w:right|w:end'
        shd = 'w:noWrap|w:tcMar|w:textDirection|w:tcFitText|w:vAlign'
    }
    function Child($parent, $name) {
        $el = $parent.SelectSingleNode("w:$name", $manager)
        if (!$el) {
            $el = $parent.OwnerDocument.CreateElement('w', $name, $ns)
            if ($name -in 'tcPr','tblPr' -or ($name -eq 'pPr' -and $parent.LocalName -eq 'p')) {
                [void]$parent.PrependChild($el)
            } elseif ($following[$name] -and ($next = $parent.SelectSingleNode($following[$name], $manager))) {
                [void]$parent.InsertBefore($el, $next)
            } else { [void]$parent.AppendChild($el) }
        }
        return ,$el
    }
    function Put($el, $name, $value) { [void]$el.SetAttribute($name, $ns, [string]$value) }
    function Update-Style($id, $font, $points, $color, $leading, $after) {
        $s = $styles.SelectSingleNode("//w:style[@w:styleId='$id']", $manager)
        if (!$s) { return }
        if ($font -or $points -or $color) {
            $r = Child $s 'rPr'
            if ($font) {
                $f = Child $r 'rFonts'
                foreach ($k in 'asciiTheme','hAnsiTheme','eastAsiaTheme','cstheme','csTheme') { $f.RemoveAttribute($k, $ns) }
                foreach ($k in 'ascii','hAnsi','eastAsia','cs') { Put $f $k $font }
            }
            if ($points) {
                foreach ($k in 'sz','szCs') { Put (Child $r $k) 'val' ([math]::Round(2*$points)) }
            }
            if ($color) {
                $c = Child $r 'color'
                foreach ($k in 'themeColor','themeTint','themeShade') { $c.RemoveAttribute($k, $ns) }
                Put $c 'val' $color.TrimStart('#')
            }
        }
        if ($leading -or $null -ne $after) {
            $sp = Child (Child $s 'pPr') 'spacing'
            if ($leading) { Put $sp 'line' ([math]::Round(240*$leading)); Put $sp 'lineRule' 'auto' }
            if ($null -ne $after) { Put $sp 'after' ([math]::Round(20*$after)) }
        }
    }
    foreach ($id in 'Normal','FirstParagraph','BodyText','BlockText') {
        Update-Style $id $settings.bodyFont $settings.bodySize $null $settings.leading $settings.after
    }
    $tableSize = if ($settings.bodySize) { [math]::Max(8, $settings.bodySize - 0.5) }
    Update-Style 'Compact' $settings.bodyFont $tableSize $null $settings.leading $null
    Update-Style 'TableHeadingText' $settings.headingFont $tableSize $settings.color $null $null
    for ($i=0; $i -lt 6; $i++) {
        $id = 'Heading' + ($i+1)
        Update-Style $id $settings.headingFont $settings.headings[$i] $settings.color $null $settings.headingAfter
        $heading = $styles.SelectSingleNode("//w:style[@w:styleId='$id']", $manager)
        if ($heading -and ($settings.headingAlign -or $null -ne $settings.headingBefore)) {
            $props = Child $heading 'pPr'
            if ($null -ne $settings.headingBefore) {
                Put (Child $props 'spacing') 'before' ([math]::Round(20*$settings.headingBefore))
            }
            if ($settings.headingAlign) { Put (Child $props 'jc') 'val' $settings.headingAlign }
        }
    }
    Update-Style 'Title' $settings.headingFont $settings.headings[0] $settings.color $null $null
    Save-Part 'word/styles.xml' $styles

    if ($settings.bodyAlign -or $null -ne $settings.firstIndent -or $settings.headerFill -or $null -ne $settings.cellPadding) {
        $doc = Read-Part 'word/document.xml'
        # BodyText has descendants such as Compact (table cells and list items).
        # Keep paragraph alignment and indentation scoped to the manuscript's prose.
        if ($settings.bodyAlign -or $null -ne $settings.firstIndent) {
            $prose = '//w:body/w:p[(not(w:pPr/w:pStyle) or w:pPr/w:pStyle[@w:val="Normal" or @w:val="BodyText" or @w:val="FirstParagraph"]) and not(w:pPr/w:numPr) and not(.//w:drawing) and .//w:t]'
            foreach ($p in $doc.SelectNodes($prose, $manager)) {
                $props = Child $p 'pPr'
                if ($settings.bodyAlign) { Put (Child $props 'jc') 'val' $settings.bodyAlign }
                if ($null -ne $settings.firstIndent) {
                    $ind = Child $props 'ind'
                    foreach ($attr in 'hanging','hangingChars','firstLine') { $ind.RemoveAttribute($attr, $ns) }
                    Put $ind 'firstLineChars' ([math]::Round(100*$settings.firstIndent))
                }
            }
        }
        if ($settings.headerFill) {
            foreach ($cell in $doc.SelectNodes('//w:tr[w:trPr/w:tblHeader[not(@w:val="0" or @w:val="false" or @w:val="off")]]/w:tc', $manager)) {
                $shd = Child (Child $cell 'tcPr') 'shd'
                foreach ($attr in 'themeFill','themeFillTint','themeFillShade') { $shd.RemoveAttribute($attr, $ns) }
                Put $shd 'val' 'clear'
                Put $shd 'fill' $settings.headerFill.TrimStart('#')
            }
        }
        if ($null -ne $settings.cellPadding) {
            foreach ($tbl in $doc.SelectNodes('//w:tbl', $manager)) {
                $margins = Child (Child $tbl 'tblPr') 'tblCellMar'
                foreach ($side in 'top','bottom') {
                    $margin = Child $margins $side
                    Put $margin 'type' 'dxa'
                    Put $margin 'w' ([math]::Round(20*$settings.cellPadding))
                }
            }
        }
        Save-Part 'word/document.xml' $doc
    }
} finally { $zip.Dispose() }
