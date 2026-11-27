$ErrorActionPreference = 'Stop'
$buildRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'build-tools'
$toolchain = Join-Path $buildRoot 'rustup\toolchains\stable-x86_64-pc-windows-gnu'
$cargo = Join-Path $toolchain 'bin\cargo.exe'
if (Test-Path -LiteralPath $cargo) {
    $env:CARGO_HOME = Join-Path $buildRoot 'cargo'
    $env:RUSTC = Join-Path $toolchain 'bin\rustc.exe'
    $env:RUSTDOC = Join-Path $toolchain 'bin\rustdoc.exe'
    $env:CARGO_TARGET_DIR = Join-Path $buildRoot 'target'
    $env:PATH = "$buildRoot\binutils\ucrt64\bin;$toolchain\bin;$toolchain\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;$env:PATH"
} else {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
}
Push-Location $PSScriptRoot
try {
    $profile = 'release'
    & $cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust 构建失败。' }
    $compiler = if ($env:RUSTC) { $env:RUSTC } else { 'rustc' }
    $hostLine = & $compiler -vV | Select-String '^host: '
    $triple = $hostLine.ToString().Substring(6).Trim()
    $metadata = & $cargo metadata --locked --format-version 1 --filter-platform $triple | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw '读取 Cargo 构建信息失败。' }
    $output = Join-Path $metadata.target_directory $profile
    if ($triple -eq 'x86_64-pc-windows-gnu') {
        $sdk = $metadata.packages | Where-Object name -eq 'webview2-com-sys' | Select-Object -First 1
        $loader = Join-Path (Split-Path $sdk.manifest_path -Parent) 'x64\WebView2Loader.dll'
        Copy-Item -LiteralPath $loader -Destination $output -Force
    }
    $binary = Join-Path $output 'MarkCraft.exe'
    # Cargo can hard-link its executable into the package cache. Stamp a private copy.
    $stagedBinary = Join-Path $output ("MarkCraft-" + [guid]::NewGuid().ToString("N") + ".exe")
    try {
        [IO.File]::Copy($binary, $stagedBinary)
        & (Join-Path $PSScriptRoot 'embed-icon.ps1') -Executable $stagedBinary -IconFile (Join-Path $PSScriptRoot 'ui\MarkCraft.ico')
        & (Join-Path $PSScriptRoot 'embed-icon.ps1') -Executable $stagedBinary -IconFile (Join-Path $PSScriptRoot 'ui\markdown-document.ico') -Group 2

        Move-Item -LiteralPath $stagedBinary -Destination $binary -Force
    } finally {
        if ([IO.File]::Exists($stagedBinary)) { [IO.File]::Delete($stagedBinary) }
    }
    Write-Output $binary
} finally {
    Pop-Location
}
