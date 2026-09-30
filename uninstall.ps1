# dsh-client-voice-play uninstaller (Windows PowerShell 5.1+)
#
# Reverses install.ps1:
#   1. remove the insert row from the profile patch layer
#   2. remove the junction in %DSH_HOME%\profiles\node_modules
#   3. remove %DSH_HOME%\plugins\dsh-client-voice-play  (only with -PurgeFiles)
#
# Restart dsh afterwards. ASCII-only on purpose (see install.ps1).

[CmdletBinding()]
param(
    [string]$DshHome = "",
    [string]$Profile = "",
    [switch]$PurgeFiles
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-client-voice-play'

function Write-Step([string]$Text) { Write-Host "  $Text" }

# Remove a directory junction without touching its target (see install.ps1).
function Remove-Junction([string]$Path) {
    try { (Get-Item -LiteralPath $Path -Force).Delete() } catch { }
    if (Test-Path -LiteralPath $Path) { & cmd.exe /c "rmdir /q `"$Path`"" | Out-Null }
    if (Test-Path -LiteralPath $Path) { throw "could not remove the junction: $Path" }
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}

$ProfilesRoot = Join-Path $DshHome 'profiles'
if ([string]::IsNullOrWhiteSpace($Profile)) {
    if (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'desktop')) { $Profile = 'desktop' }
    elseif (Test-Path -LiteralPath (Join-Path $ProfilesRoot 'web')) { $Profile = 'web' }
    else { throw "no desktop/web profile found under $ProfilesRoot; pass -Profile <name>" }
}

$Target = Join-Path $DshHome "plugins\$PluginName"
$Link = Join-Path $ProfilesRoot "node_modules\$PluginName"
$PatchPath = Join-Path $ProfilesRoot "$Profile\cordis.patch.yml"

Write-Host "[1/3] drop the insert row from $PatchPath"
if (Test-Path -LiteralPath $PatchPath) {
    $text = [System.IO.File]::ReadAllText($PatchPath, [System.Text.Encoding]::UTF8)
    if ($text -notmatch [regex]::Escape($PluginName)) {
        Write-Step 'no row found -- nothing to do'
    } else {
        $pattern = "(?ms)^#\s*$([regex]::Escape($PluginName))[^\n]*\n- insert:\n(?:[ \t]+.*\n?)*"
        $stripped = [regex]::Replace($text, $pattern, '')
        if ($stripped -eq $text) {
            throw "found '$PluginName' in the patch layer but could not isolate the row; remove it by hand: $PatchPath"
        }
        $backup = "$PatchPath.bak-$PluginName-removed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $PatchPath -Destination $backup -Force
        [System.IO.File]::WriteAllText($PatchPath, $stripped, (New-Object System.Text.UTF8Encoding($false)))
        Write-Step "row removed (backup: $backup)"
    }
} else {
    Write-Step 'patch layer not found -- skipped'
}

Write-Host "[2/3] remove the junction"
if (Test-Path -LiteralPath $Link) {
    $item = Get-Item -LiteralPath $Link -Force
    if ($item.LinkType -eq 'Junction') {
        Remove-Junction $Link
        Write-Step 'junction removed'
    } else {
        Write-Step "skipped: not a junction ($Link)"
    }
} else {
    Write-Step 'no junction -- skipped'
}

Write-Host "[3/3] plugin files"
if ($PurgeFiles) {
    if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Recurse -Force
        Write-Step "removed $Target"
    } else {
        Write-Step 'not installed -- skipped'
    }
} else {
    Write-Step "kept $Target (pass -PurgeFiles to delete it)"
}

Write-Host ''
Write-Host 'Done. RESTART dsh to drop the playback button.'
