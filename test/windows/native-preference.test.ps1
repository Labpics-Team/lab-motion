param([string]$Harness = (Join-Path $PSScriptRoot 'verify-input.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'native-reader-syntax' }
$definitions = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Read-InputPhaseField', 'Get-InputPhaseSummary')
})
if ($definitions.Count -ne 2) { throw 'native-reader-definitions' }
. ([scriptblock]::Create(($definitions | ForEach-Object { $_.Extent.Text }) -join "`n"))

$native = [pscustomobject]@{ State = 'Ready'; SameSource = $true; ControlPassed = $true;
    SourceHResult = 0; DelegateHResult = 0; MarshalHResult = 0; ControlHResult = 0;
    ControlCount = 1L; ControlQpc = 100L; QpcFrequency = 10000000L; AddHResult = 0;
    Count = 2L; LastEntryQpc = 380L; Attached = $true; Active = $true; Faulted = $false; RemoveHResult = $null }
$data = [pscustomobject]@{ operation = 17L; reason = 'settled'; end = 'Finished'; qpc = 400L;
    qpcFrequency = 10000000L; subscriptionDiagnostics = [pscustomobject]@{ Registration = 1L };
    nativeDiagnostics = $native }
$events = @([pscustomobject]@{ sequence = 395L; kind = 'completed'; data = $data })
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events
$decoded = $text | ConvertFrom-Json
if ($decoded.native.Count -ne 19 -or $decoded.native[0] -ne 395 -or $decoded.native[1] -ne 1 -or
    $decoded.native[9] -ne 1 -or $decoded.native[13] -ne 2 -or $decoded.native[14] -ne 380 -or
    $decoded.rows[0].Count -ne 14 -or $text.Length -gt 1800 -or $text -match '[^\x00-\x7f]') { throw 'native-reader-healthy' }

# Control count не присваивается actual count; zero остаётся отдельным наблюдением.
$native.Count = 0L
$native.LastEntryQpc = $null
if ((Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events | ConvertFrom-Json).native[13] -ne 0) {
    throw 'native-reader-control-not-actual'
}
$native.State = 'Faulted'; $native.Active = $false; $native.Faulted = $true; $native.RemoveHResult = -2147467259
$decoded = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events | ConvertFrom-Json
if (!$decoded.native[15] -or $decoded.native[16] -or !$decoded.native[17] -or $decoded.native[18] -ne -2147467259) {
    throw 'native-reader-failed-remove-not-detached'
}
foreach ($missingData in @($null, 'malformed-data', [pscustomobject]@{ operation = 18L })) {
    $newest = @($events) + @([pscustomobject]@{ sequence = 400L; kind = 'completed'; data = $missingData })
    if ((Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $newest | ConvertFrom-Json).native -ne $null) {
        throw 'native-reader-latest-null-clears-positive'
    }
}
$native.State = 'private-state'; $native.SourceHResult = '::error::'; $native.LastEntryQpc = 'secret'
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events
$decoded = $text | ConvertFrom-Json
if ($text -match 'private|secret|::error::' -or $decoded.native[2] -ne $null -or $decoded.native[5] -ne $null -or
    $decoded.native[14] -ne $null) { throw 'native-reader-closed-malformed' }

$identity = [pscustomobject]@{ State = 'Hashed'; Version = '10.0.14.0'; Mvid = '12345678-1234-1234-1234-123456789abc'; Sha256 = 'a' * 64 }
$entry = [pscustomobject]@{ Order = 4L; Qpc = 340L; Type = 'COM'; HResult = -2147467262; ThrowingOwner = 'WinRTRuntime' }
$projection = [pscustomobject]@{ UISettingsAssembly = $identity; WinRTRuntimeAssembly = $identity;
    StartedQpc = 100L; QpcFrequency = 10000000L; Active = $true; Faulted = $true; ReentrantSkipped = 2L;
    Count = 4L; Omitted = 3L; ProjectionCount = 2L; ProjectionOmitted = 1L; Last = $entry; LastProjection = $entry }
$native.State = 'Ready'; $native.SourceHResult = 0; $native.LastEntryQpc = 9007199254740991L
$native.Count = 9007199254740991L; $native.ControlQpc = 9007199254740991L
$many = @(1..40 | ForEach-Object { [pscustomobject]@{ sequence = 330L + $_; kind = 'completed'; data = [pscustomobject]@{
    operation = 9007199254740991L; qpc = 9007199254740991L; qpcFrequency = 10000000L;
    subscriptionDiagnostics = [pscustomobject]@{ Registration = $_ }; projectionDiagnostics = $projection; nativeDiagnostics = $native } } })
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $many
$decoded = $text | ConvertFrom-Json
if ($text.Length -gt 1800 -or $text -match '[^\x00-\x7f]' -or $decoded.omitted -le 0 -or
    $decoded.native[0] -ne 370 -or $decoded.native[1] -ne 40 -or $decoded.projection[1] -ne 40 -or
    $decoded.rows[0][0] -ne 331 -or $decoded.rows[-1][0] -ne 370) { throw 'native-reader-composed-bounded' }
'native reader: actual PowerShell healthy/control/fault/latest-null/malformed/composed-budget controls PASS'

$window = [pscustomobject]@{ State = 'Ready'; OwnerMatched = $true; SameSession = $true; SameDesktop = $true;
    ContextHResult = 0; ControlPassed = $true; ControlCount = 1L; ControlQpc = 100L; RawCount = 2L; ActionCount = 1L;
    LastRawQpc = 390L; LastActionQpc = 380L; QpcFrequency = 10000000L; ForwardCount = 2L;
    AddHResult = 0; RemoveHResult = $null; Attached = $true; Active = $true; Faulted = $false; Destroyed = $false }
$data | Add-Member -NotePropertyName windowDiagnostics -NotePropertyValue $window
$setter = [pscustomobject]@{ ContextStillMatches = $true }
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events -Setter $setter
$decoded = $text | ConvertFrom-Json
if ($decoded.window.Count -ne 22 -or $decoded.window[0] -ne 395 -or $decoded.window[1] -ne 1 -or
    $decoded.window[8] -ne 1 -or $decoded.window[10] -ne 2 -or $decoded.window[11] -ne 1 -or
    $decoded.window[15] -ne 2 -or $decoded.setter.Count -ne 7 -or $decoded.setter[6] -ne $true -or
    $decoded.native.Count -ne 19 -or $decoded.rows[0].Count -ne 14 -or $text.Length -gt 1800) { throw 'window-reader-healthy-additive' }
$window.RawCount = 0L; $window.ActionCount = 0L; $window.LastRawQpc = $null; $window.LastActionQpc = $null
$decoded = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events | ConvertFrom-Json
if ($decoded.window[8] -ne 1 -or $decoded.window[10] -ne 0 -or $decoded.window[11] -ne 0) { throw 'window-reader-control-not-system-delivery' }
$window.SameSession = $null; $window.SameDesktop = $null
$decoded = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events | ConvertFrom-Json
if ($decoded.window[4] -ne $null -or $decoded.window[5] -ne $null -or $decoded.setter[6] -ne $null) { throw 'window-reader-unknown-not-match' }
foreach ($missingData in @($null, 'malformed-data', [pscustomobject]@{ operation = 18L })) {
    $newest = @($events) + @([pscustomobject]@{ sequence = 400L; kind = 'completed'; data = $missingData })
    if ((Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $newest | ConvertFrom-Json).window -ne $null) {
        throw 'window-reader-latest-null-clears-positive'
    }
}
$window.State = 'private'; $window.ContextHResult = '::error::'; $window.LastRawQpc = 'secret'; $window.SameDesktop = 'Default'
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events
$decoded = $text | ConvertFrom-Json
if ($text -match 'private|secret|Default|::error::' -or $decoded.window[2] -ne $null -or $decoded.window[5] -ne $null -or
    $decoded.window[6] -ne $null -or $decoded.window[12] -ne $null) { throw 'window-reader-closed-no-context-values' }
$window.State = 'Ready'; $window.ContextHResult = 0; $window.LastRawQpc = 9007199254740991L; $window.SameDesktop = $true
$window.RawCount = 9007199254740991L; $window.ActionCount = 9007199254740991L; $window.LastActionQpc = 9007199254740991L
$window.ControlQpc = 9007199254740991L; $window.ForwardCount = 9007199254740991L
foreach ($event in $many) { $event.data | Add-Member -NotePropertyName windowDiagnostics -NotePropertyValue $window }
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $many
$decoded = $text | ConvertFrom-Json
if ($text.Length -gt 1800 -or $text -match '[^\x00-\x7f]' -or $decoded.window[0] -ne 370 -or $decoded.window[1] -ne 40 -or
    $decoded.native[1] -ne 40 -or $decoded.projection[1] -ne 40) { throw 'window-reader-composed-fixed-budget' }
'window reader: synthetic/control/context/unknown/latest-null/closed/composed-budget controls PASS'
