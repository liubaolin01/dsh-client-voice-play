# dsh-client-voice-play installer (Windows PowerShell 5.1+)
#
# Registers the plugin with a DSH installation:
#   1. copy this folder to  %DSH_HOME%\plugins\dsh-client-voice-play
#   2. junction it into    %DSH_HOME%\profiles\node_modules\dsh-client-voice-play
#      (so any profile resolves the package by name -- client-modules reads the
#      package's dsh.client manifest to serve /plugins/dsh-client-voice-play/client.js)
#   3. append an insert row to the PROFILE patch layer
#      %DSH_HOME%\profiles\<profile>\cordis.patch.yml
#
# Why the profile layer and not %DSH_HOME%\cordis.patch.yml: the machine-level
# layer is reset to [] by the dsh restore mechanism, while a profile patch layer
# is the documented edit point ("Edit cordis.patch.yml, not this file") and is
# never overwritten once it exists.
#
# The patch layer is read at startup, so RESTART dsh after installing.
# Idempotent: re-running repairs the copy/junction and never duplicates the row.
# ASCII-only on purpose: a .ps1 with non-ASCII text needs a UTF-8 BOM or the GBK
# console misreads it.

[CmdletBinding()]
param(
    [string]$DshHome = "",
    [string]$Profile = ""
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-client-voice-play'

function Write-Step([string]$Text) { Write-Host "  $Text" }

# Remove a directory junction without touching its target. PowerShell 5.1's
# Remove-Item throws NullReferenceException on reparse points, and cmd's rmdir
# silently no-ops when the nested quotes get mangled, so try the .NET call
# first, fall back to rmdir, then prove the link is gone.
function Remove-Junction([string]$Path) {
    try { (Get-Item -LiteralPath $Path -Force).Delete() } catch { }
    if (Test-Path -LiteralPath $Path) { & cmd.exe /c "rmdir /q `"$Path`"" | Out-Null }
    if (Test-Path -LiteralPath $Path) { throw "could not remove the junction: $Path" }
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path -LiteralPath $DshHome)) { throw "DSH_HOME does not exist: $DshHome" }

# Pick the profile to register in: explicit -Profile, else the only one present,
# else prefer 'desktop' (the DSH desktop app) and fall back to 'web'.
$ProfilesRoot = Join-Path $DshHome 'profiles'
if ([string]::IsNullOrWhiteSpace($Profile)) {
    if (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'desktop')) { $Profile = 'desktop' }
    elseif (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'web')) { $Profile = 'web' }
    else { throw "no desktop/web profile found under $ProfilesRoot; pass -Profile <name>" }
}
$ProfileDir = Join-Path $ProfilesRoot $Profile
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile not found: $ProfileDir" }

$Source = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Source)) { throw 'cannot resolve the script folder' }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) {
    throw "package.json not found next to the script: $Source"
}

$PluginsDir = Join-Path $DshHome 'plugins'
$Target = Join-Path $PluginsDir $PluginName
$ModulesDir = Join-Path $ProfilesRoot 'node_modules'
$Link = Join-Path $ModulesDir $PluginName
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host "[1/3] DSH_HOME = $DshHome   profile = $Profile"

Write-Host "[2/3] copy plugin -> $Target"
New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
foreach ($extra in '_ref', '_tools') {
    Remove-Item -LiteralPath (Join-Path $Target $extra) -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Step 'copied'

New-Item -ItemType Directory -Force -Path $ModulesDir | Out-Null
if (Test-Path -LiteralPath $Link) {
    $existing = Get-Item -LiteralPath $Link -Force
    if ($existing.LinkType -ne 'Junction') { throw "refusing to delete a real directory: $Link" }
    if (@($existing.Target)[0] -eq $Target) {
        Write-Step 'junction already points here -- kept'
    } else {
        Remove-Junction $Link
        New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
        Write-Step "junction $Link -> $Target"
    }
} else {
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    Write-Step "junction $Link -> $Target"
}

Write-Host "[3/3] register in $PatchPath"
if (-not (Test-Path -LiteralPath $PatchPath)) {
    [System.IO.File]::WriteAllText($PatchPath, "[]`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Step 'created an empty patch layer'
}
$text = [System.IO.File]::ReadAllText($PatchPath, [System.Text.Encoding]::UTF8)
if ($text -match [regex]::Escape($PluginName)) {
    Write-Step 'already registered -- left untouched'
} else {
    $backup = "$PatchPath.bak-$PluginName-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $PatchPath -Destination $backup -Force
    Write-Step "backup: $backup"
    $block = "# $PluginName : read the current assistant reply aloud from its action row`n- insert:`n    - id: voice-play`n      name: '$PluginName'"
    $matches = [regex]::Matches($text, '(?m)^\[\s*\]\s*$')
    if ($matches.Count -gt 0) {
        $last = $matches[$matches.Count - 1]
        $text = $text.Substring(0, $last.Index) + $block + $text.Substring($last.Index + $last.Length)
    } else {
        $text = $text.TrimEnd() + "`n" + $block + "`n"
    }
    [System.IO.File]::WriteAllText($PatchPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step 'insert row added'
}

Write-Host ''
Write-Host 'Done. Next:'
Write-Host '  * RESTART the DSH app. The patch layer is read at startup; a running host'
Write-Host '    may or may not pick the new entry up on a page refresh, so restart is the'
Write-Host '    reliable path.'
Write-Host '  * after the restart a speaker button appears in the action row under a finished'
Write-Host '    reply (next to copy / like / branch): click to hear it, click again to stop.'
Write-Host '  * voice, rate, pitch, volume and the code-block switch live in'
Write-Host '    Settings -> Plugins -> "Voice playback".'
