$ErrorActionPreference = 'Stop'
try {
    Set-Location -LiteralPath $launch.dir
    $Host.UI.RawUI.WindowTitle = $launch.title
    $sessionId = $launch.id
    switch ($launch.agent) {
        'codex' {
            $env:CODEX_HOME = $launch.root
            $cli = Get-Command codex.exe,codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
            if (!$cli) { throw '此会话使用自定义记录目录，请安装 Codex CLI 后重试。' }
            & $cli resume $sessionId
        }
        'claude' {
            $env:CLAUDE_CONFIG_DIR = $launch.root
            $cli = Get-Command claude.exe,claude.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
            if (!$cli) { $cli = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
            if (!(Test-Path -LiteralPath $cli -PathType Leaf)) { throw '找不到 Claude Code。请安装 Claude Code 并重新打开 MarkCraft。' }
            & $cli --resume $sessionId
        }
        'antigravity' {
            & $launch.agy --gemini-dir $launch.root --app-data-dir $launch.store --conversation $sessionId
        }
        'deepseek' {
            $env:DSH_HOME = $launch.root
            $cli = Get-Command dsh.exe,dsh.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
            if (!$cli) {
                $handler = Get-Item 'Registry::HKEY_CLASSES_ROOT\dsh\shell\open\command' -ErrorAction SilentlyContinue
                if ($handler -and $handler.GetValue('') -match '^"([^"]+\\DeepSeek Harness\.exe)"') {
                    $cli = Join-Path (Split-Path -Parent $Matches[1]) 'resources\runtime\cli\bin\dsh.cmd'
                }
            }
            if (!$cli -or !(Test-Path -LiteralPath $cli -PathType Leaf)) { throw '找不到 DeepSeek Harness 的 dsh 程序。请检查安装目录和 PATH。' }
            $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            Write-Host ($launch.title + "  ·  " + $launch.dir)
            Write-Host '输入消息后回车，直接回车关闭窗口。'
            while ($message = Read-Host '你') {
                $message | & $cli headless --session-id $sessionId -
                if ($LASTEXITCODE -ne 0) { break }
            }
        }
    }
    if ($LASTEXITCODE) { throw "智能体已退出（$LASTEXITCODE）。" }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    [void](Read-Host '按回车关闭窗口')
}
