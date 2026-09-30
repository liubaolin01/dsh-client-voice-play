# Voice helper for dsh-client-voice-play: two Windows speech backends. ASCII-only
# on purpose -- a .ps1 with non-ASCII text needs a UTF-8 BOM or PowerShell 5.1
# reads it as GBK and the string literals break the parser.
#
# Backends:
#   winrt  Windows.Media.SpeechSynthesis (OneCore). Sees the OneCore voice set,
#          which includes voices SAPI5 cannot select (e.g. Microsoft Kangkang).
#   sapi   System.Speech (SAPI5). Older set; still the only path for Desktop
#          voices such as "Microsoft Zira Desktop".
#
# Modes:
#   -List                               print {"winrt":[...],"sapi":[...]} JSON
#   -TextFile <p> -OutFile <p>          synthesize UTF-8 text into a WAV file
#     [-Backend winrt|sapi] [-VoiceName <name>]
#     [-RateMultiplier 0.5..2] [-VolumeLevel 0..1]
#
# The text travels through a UTF-8 file, never through the command line, so
# Chinese text and quoting survive intact.

[CmdletBinding()]
param(
    [switch]$List,
    [ValidateSet('winrt', 'sapi')]
    [string]$Backend = 'winrt',
    [string]$TextFile = "",
    [string]$OutFile = "",
    [string]$VoiceName = "",
    [double]$RateMultiplier = 1,
    [double]$VolumeLevel = 1
)

$ErrorActionPreference = 'Stop'

#region ---------- helpers ----------
function Await($WinRtTask, $ResultType) {
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

function Get-WinRtVoices {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $rows = @()
    foreach ($voice in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
        $rows += [pscustomobject]@{
            name    = $voice.DisplayName
            culture = $voice.Language
            gender  = [string]$voice.Gender
        }
    }
    return $rows
}

function Get-SapiVoices {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $rows = @()
        foreach ($voice in $synth.GetInstalledVoices()) {
            $info = $voice.VoiceInfo
            $rows += [pscustomobject]@{
                name    = $info.Name
                culture = $info.Culture.Name
                gender  = [string]$info.Gender
            }
        }
    } finally {
        $synth.Dispose()
    }
    return $rows
}

# ConvertTo-Json unwraps a single-element array, so build the array text by hand.
function To-JsonArray($rows) {
    $items = @()
    foreach ($row in $rows) { $items += (ConvertTo-Json -InputObject $row -Compress) }
    return '[' + ($items -join ',') + ']'
}
#endregion

if ($List) {
    $winrt = @()
    $sapi = @()
    try { $winrt = @(Get-WinRtVoices) } catch { $winrt = @() }
    try { $sapi = @(Get-SapiVoices) } catch { $sapi = @() }
    [Console]::Out.Write('{"winrt":' + (To-JsonArray $winrt) + ',"sapi":' + (To-JsonArray $sapi) + '}')
    exit 0
}

if ([string]::IsNullOrWhiteSpace($TextFile) -or [string]::IsNullOrWhiteSpace($OutFile)) {
    [Console]::Error.Write('TextFile and OutFile are required')
    exit 2
}
if (-not (Test-Path -LiteralPath $TextFile)) {
    [Console]::Error.Write("TextFile not found: $TextFile")
    exit 2
}

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) {
    [Console]::Error.Write('text is empty')
    exit 3
}

if ($Backend -eq 'winrt') {
    #region ---------- WinRT (OneCore) ----------
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]

    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $voice = $null
    $allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
    if (-not [string]::IsNullOrWhiteSpace($VoiceName)) {
        $voice = $allVoices | Where-Object { $_.DisplayName -eq $VoiceName } | Select-Object -First 1
    }
    # Pick a Chinese voice explicitly when none was named (or the named one does
    # not exist): the system default voice may not match the text language, which
    # makes WinRT fail or produce nothing at all.
    if (-not $voice) {
        $voice = $allVoices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
    }
    if ($voice) { $synth.Voice = $voice }

    # SSML needs the text XML-escaped. Both arguments are cast to [string] so the
    # (string, string) overload is chosen -- a bare [char] would pick the char
    # overload and throw on a multi-character replacement.
    $amp = [string][char]38
    $escaped = $text.Replace($amp, $amp + 'amp;').Replace([string]'<', $amp + 'lt;').Replace([string]'>', $amp + 'gt;').Replace([string]'"', $amp + 'quot;')
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture
    $rate = [Math]::Max(0.5, [Math]::Min(2.0, $RateMultiplier)).ToString($invariant)
    $level = [Math]::Max(0.0, [Math]::Min(1.0, $VolumeLevel)).ToString($invariant)
    $lang = if ($voice) { $voice.Language } else { 'zh-CN' }
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + $lang +
        '"><prosody rate="' + $rate + '" volume="' + $level + '">' + $escaped + '</prosody></speak>'

    $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $file = [System.IO.File]::Create($OutFile)
    try { $netStream.CopyTo($file) } finally { $file.Close(); $netStream.Close() }
    #endregion
} else {
    #region ---------- SAPI5 ----------
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        if (-not [string]::IsNullOrWhiteSpace($VoiceName)) {
            try { $synth.SelectVoice($VoiceName) } catch { }
        } else {
            # Unnamed: prefer a Chinese voice, so an English default voice cannot
            # silently render Chinese into an empty WAV.
            try {
                $zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
                if ($zh) { $synth.SelectVoice($zh.VoiceInfo.Name) }
            } catch { }
        }
        $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [Math]::Round(($RateMultiplier - 1) * 5)))
        $synth.Volume = [Math]::Max(0, [Math]::Min(100, [Math]::Round($VolumeLevel * 100)))
        $synth.SetOutputToWaveFile($OutFile)
        $synth.Speak($text)
    } finally {
        try { $synth.SetOutputToNull() } catch { }
        $synth.Dispose()
    }
    #endregion
}

[Console]::Out.Write('OK')
exit 0
