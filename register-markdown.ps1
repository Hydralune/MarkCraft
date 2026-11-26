param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath $Executable).FullName
$applicationIcon = '"{0}",0' -f $exe
$documentIcon = '"{0}",-2' -f $exe
$openCommand = '"{0}" "%1"' -f $exe
$progId = 'MarkCraft.Markdown'
$app = 'Software\Classes\Applications\MarkCraft.exe'
$type = "Software\Classes\$progId"
$capabilities = 'Software\MarkCraft\Capabilities'

function Set-UserValues([string]$Path, [hashtable]$Values) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Path)
    try {
        foreach ($name in $Values.Keys) {
            $key.SetValue($name, $Values[$name], [Microsoft.Win32.RegistryValueKind]::String)
        }
    } finally {
        $key.Dispose()
    }
}

Set-UserValues $type @{ '' = 'Markdown 文档' }
Set-UserValues $app @{ FriendlyAppName = 'MarkCraft' }
Set-UserValues "$type\Application" @{ ApplicationName = 'MarkCraft'; ApplicationIcon = $applicationIcon }
foreach ($handler in @($type, $app)) {
    Set-UserValues "$handler\DefaultIcon" @{ '' = $documentIcon }
    Set-UserValues "$handler\shell\open\command" @{ '' = $openCommand }
}
Set-UserValues $capabilities @{
    ApplicationName = 'MarkCraft'
    ApplicationDescription = '本地 Markdown 编辑器'
    ApplicationIcon = $applicationIcon
}
foreach ($extension in @('.md', '.markdown', '.mdown', '.mkd')) {
    Set-UserValues "Software\Classes\$extension\OpenWithProgids" @{ $progId = '' }
    Set-UserValues "$app\SupportedTypes" @{ $extension = '' }
    Set-UserValues "$capabilities\FileAssociations" @{ $extension = $progId }
}
Set-UserValues 'Software\RegisteredApplications' @{ MarkCraft = $capabilities }

if (-not ('MarkCraft.ShellNotification' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace MarkCraft {
    public static class ShellNotification {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
'@
}
# SHCNE_ASSOCCHANGED invalidates the shell's association and icon caches.
[MarkCraft.ShellNotification]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
