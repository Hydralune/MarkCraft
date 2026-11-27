param(
    [string]$Package = (Join-Path $PSScriptRoot 'markcraft-handoff-0.3.0.tgz'),
    [string]$HarnessExecutable
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$agentRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $agentRoot 'profiles\desktop'
if (!(Test-Path -LiteralPath $profileDir -PathType Container)) {
    throw 'Open DeepSeek Harness once, then select its data folder in MarkCraft.'
}
$env:DSH_HOME = $agentRoot
$cli = $null
if ($HarnessExecutable) {
    if ((Split-Path $HarnessExecutable -Leaf) -ne 'DeepSeek Harness.exe') { throw 'Select DeepSeek Harness.exe inside its installed application folder.' }
    $candidates = @((Split-Path (Resolve-Path -LiteralPath $HarnessExecutable).Path -Parent))
} else {
    $candidates = @(
        Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
            Where-Object Path | ForEach-Object { Split-Path $_.Path -Parent }
        Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } | ForEach-Object { $_.InstallLocation }
        Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
        Join-Path $env:ProgramFiles 'DeepSeek Harness'
    )
}
foreach ($candidate in $candidates) {
    if (!$candidate -or ![IO.Directory]::Exists($candidate)) { continue }
    $bin = [IO.Path]::Combine($candidate,'resources\runtime\cli\bin\dsh.cmd')
    if (Test-Path -LiteralPath $bin -PathType Leaf) { $cli = $bin; break }
}
if (!$cli -and !$HarnessExecutable) {
    $cli = Get-Command dsh.cmd,dsh.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty Source
}
if (!$cli) { throw 'Open DeepSeek Harness, or select its installed DeepSeek Harness.exe in MarkCraft.' }
& $cli plugin --profile desktop add $packagePath
if ($LASTEXITCODE -ne 0) { throw "Harness plugin installer exited with code $LASTEXITCODE." }
$manifest = Join-Path $profileDir 'node_modules\markcraft-handoff\package.json'
if (!(Test-Path -LiteralPath $manifest) -or (Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json).version -ne '0.3.0') {
    throw 'The desktop profile did not report markcraft-handoff 0.3.0. Check the selected data folder.'
}
Write-Output 'Installed markcraft-handoff 0.3.0. Reopen Harness and refresh the connection in MarkCraft.'
