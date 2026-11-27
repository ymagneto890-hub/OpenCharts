$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$vbsPath = Join-Path $projectRoot "iniciar_opencharts.vbs"
$iconPath = Join-Path $projectRoot "public\icons\OpenCharts.ico"

# Fallback to Chrome PWA icon if local icon is missing
$pwaIconPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Web Applications\_crx_idemibpphagihbobmgmaojhjfidlfpdl\OpenCharts.ico"
if ((-not (Test-Path $iconPath)) -and (Test-Path $pwaIconPath)) {
  Copy-Item -Path $pwaIconPath -Destination $iconPath -Force
}

$desktopDir = [Environment]::GetFolderPath("Desktop")
$desktopShortcutPath = Join-Path $desktopDir "OpenCharts.lnk"
$projectShortcutPath = Join-Path $projectRoot "OpenCharts.lnk"
$startMenuShortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Aplicaciones de Chrome\OpenCharts.lnk"

$wsh = New-Object -ComObject WScript.Shell

function Set-OpenChartsShortcut([string]$lnkPath) {
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $sc.Arguments = "`"$vbsPath`""
  $sc.WorkingDirectory = $projectRoot
  if (Test-Path $iconPath) {
    $sc.IconLocation = "$iconPath,0"
  }
  $sc.Description = "OpenCharts - Simulador de Trading (Inicio Automatico)"
  $sc.WindowStyle = 1
  $sc.Save()
  Write-Output "Acceso directo configurado: $lnkPath"
}

Set-OpenChartsShortcut $desktopShortcutPath
Set-OpenChartsShortcut $projectShortcutPath

if (Test-Path (Split-Path -Parent $startMenuShortcutPath)) {
  Set-OpenChartsShortcut $startMenuShortcutPath
}
