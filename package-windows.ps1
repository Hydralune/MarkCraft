param([string]$Output = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
$Repo = $PSScriptRoot
$binary = & (Join-Path $Repo 'build-windows.ps1') | Select-Object -Last 1
if (!$binary -or !(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'MarkCraft build failed' }
$Build = Split-Path $binary -Parent
$version = (Select-String '^version = "([^"]+)"' (Join-Path $Repo 'Cargo.toml') | Select-Object -First 1).Matches.Groups[1].Value
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('markcraft-package-' + [guid]::NewGuid().ToString('N'))
$root=Join-Path $Stage "MarkCraft-v$version-windows-x64"
try {
    $licenses=Join-Path $root 'licenses'
    New-Item -ItemType Directory -Path $licenses -Force | Out-Null
    New-Item -ItemType Directory -Path $Output -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Build 'MarkCraft.exe'),(Join-Path $Build 'WebView2Loader.dll'),(Join-Path $Repo 'LICENSE'),(Join-Path $Repo 'register-markdown.ps1'),(Join-Path $Repo 'integrations/deepseek-handoff/install-harness-plugin.ps1') -Destination $root
    Copy-Item -LiteralPath (Join-Path $Repo 'ui/guide.md') -Destination (Join-Path $root '使用指南.md')
    Copy-Item -LiteralPath (Join-Path $Repo 'docs/对话资料库.md') -Destination $root
    Copy-Item -LiteralPath (Join-Path $Repo 'examples') -Destination $root -Recurse
    Get-ChildItem (Join-Path $Repo 'vendor') -File | Where-Object Name -Match 'LICENSE|NOTICE' | Copy-Item -Destination $licenses
    Copy-Item -LiteralPath (Join-Path $Repo 'themes/Claudette-LICENSE.txt') -Destination $licenses
    Push-Location $Repo
    try {
      npm.cmd pack ./integrations/deepseek-handoff --pack-destination $root | Out-Null
      if($LASTEXITCODE) {throw 'npm pack failed'}
      $metadata=(& cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-gnu | ConvertFrom-Json)
      if($LASTEXITCODE) {throw 'cargo metadata failed'}
      $metaLines = $metadata.packages | Sort-Object name,version | ForEach-Object {"$($_.name) $($_.version)    $($_.license)    $($_.repository)"}
      [IO.File]::WriteAllLines((Join-Path $licenses 'Rust-dependencies.txt'),[string[]]$metaLines)
    } finally {Pop-Location}
    [IO.File]::WriteAllText((Join-Path $root '先读我.txt'),"MarkCraft v$version · Windows x64"+[Environment]::NewLine+"解压整个文件夹后双击 MarkCraft.exe。开始写作可按 Ctrl+O。首次使用对话资料库，请从「视图 → 对话资料库」选择来源并保存。"+[Environment]::NewLine+"程序使用系统 WebView2 运行时。Word 等格式导出需安装 Pandoc。「使用指南.md」和「对话资料库.md」可离线查看。"+[Environment]::NewLine+"各智能体图标归各自权利人所有。MarkCraft 使用 MIT 许可证。")
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $name="MarkCraft-v$version-windows-x64.zip"
    $zip=Join-Path $Output $name
    [IO.Compression.ZipFile]::CreateFromDirectory($root,(Join-Path $Stage $name),[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)
    Copy-Item -LiteralPath (Join-Path $Stage $name) -Destination $zip -Force
    $sum=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $Output 'SHA256SUMS.txt'),"$sum  $name"+[char]10,[Text.Encoding]::ASCII)
    Get-Item -LiteralPath $zip | Select Name,Length;Write-Output $sum
} finally {
    $stagePath=[IO.Path]::GetFullPath($Stage)
    $tempPath=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($stagePath) -eq $tempPath -and [IO.Path]::GetFileName($stagePath) -match '^markcraft-package-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $stagePath)) {
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}
