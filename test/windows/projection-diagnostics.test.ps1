param([string]$Harness = (Join-Path $PSScriptRoot 'verify-input.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Отдельный процесс: тестовая assembly/event не входят в окно приложения.
Add-Type -Path @((Join-Path $PSScriptRoot '../../examples/windows/ProjectionDiagnostics.cs'),
    (Join-Path $PSScriptRoot 'projection-diagnostics-controls.cs'))
[NativeWindow.ProjectionDiagnosticControls]::Run()

$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'projection-reader-syntax' }
$definitions = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Read-InputPhaseField', 'Get-InputPhaseSummary')
})
if ($definitions.Count -ne 2) { throw 'projection-reader-definitions' }
. ([scriptblock]::Create(($definitions | ForEach-Object { $_.Extent.Text }) -join "`n"))
$identity = [pscustomobject]@{ State = 'Hashed'; Version = '10.0.14.0'; Mvid = '12345678-1234-1234-1234-123456789abc'; Sha256 = 'a' * 64 }
$entry = [pscustomobject]@{ Order = 4L; Qpc = 340L; Type = 'COM'; HResult = -2147467262; ThrowingOwner = 'WinRTRuntime' }
$projection = [pscustomobject]@{ UISettingsAssembly = $identity; WinRTRuntimeAssembly = $identity;
    StartedQpc = 100L; QpcFrequency = 10000000L; Active = $true; Faulted = $false; ReentrantSkipped = 0L;
    Count = 4L; Omitted = 3L; ProjectionCount = 2L; ProjectionOmitted = 1L; Last = $entry; LastProjection = $entry }
$events = @([pscustomobject]@{ sequence = 395L; kind = 'completed'; data = [pscustomobject]@{
    operation = 17L; reason = 'settled'; end = 'Finished'; qpc = 400L; qpcFrequency = 10000000L;
    subscriptionDiagnostics = [pscustomobject]@{ Registration = 1L }; projectionDiagnostics = $projection } })
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events
$decoded = $text | ConvertFrom-Json
if ($text.Length -gt 1800 -or $decoded.schema -ne 2 -or $decoded.rows[0].Count -ne 14 -or
    $decoded.projection[0] -ne 395 -or $decoded.projection[1] -ne 1 -or $decoded.projection[12][1][3] -ne -2147467262) {
    throw 'projection-reader-healthy'
}
$unknown = [pscustomobject]@{ State = 'raw-private-name'; Version = 'private-path'; Mvid = 'secret'; Sha256 = '::error::' }
$projection.UISettingsAssembly = $unknown
$projection.Last = [pscustomobject]@{ Type = 'private-type'; HResult = '0'; ThrowingOwner = 'raw-method'; Order = -1; Qpc = '123' }
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events
if ($text -match 'private|secret|::error::|raw-method' -or ($text | ConvertFrom-Json).projection[12][0][3] -ne $null) {
    throw 'projection-reader-closed-malformed'
}
$old = @([pscustomobject]@{ sequence = 395L; kind = 'completed'; data = [pscustomobject]@{ operation = 17L } })
if ((Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $old | ConvertFrom-Json).projection -ne $null) {
    throw 'projection-reader-old-null'
}
# Последняя captured registration, не предыдущая положительная запись другого поколения.
$events += [pscustomobject]@{ sequence = 400L; kind = 'completed'; data = [pscustomobject]@{ operation = 18L } }
if ((Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $events | ConvertFrom-Json).projection -ne $null) {
    throw 'projection-reader-latest-generation'
}
$projection.UISettingsAssembly = $identity
$projection.Last = $entry
$projection.Faulted = $true
$projection.ReentrantSkipped = 2L
$many = @(1..40 | ForEach-Object { [pscustomobject]@{ sequence = 330L + $_; kind = 'completed'; data = [pscustomobject]@{
    operation = 9007199254740991L; qpc = 9007199254740991L; qpcFrequency = 10000000L;
    subscriptionDiagnostics = [pscustomobject]@{ Registration = $_ }; projectionDiagnostics = $projection } } })
$text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 327 -Events $many
$decoded = $text | ConvertFrom-Json
if ($text.Length -gt 1800 -or $decoded.omitted -le 0 -or $decoded.rows[0][0] -ne 331 -or $decoded.rows[-1][0] -ne 370 -or
    $decoded.projection[1] -ne 40 -or !$decoded.projection[6] -or $decoded.projection[7] -ne 2) { throw 'projection-reader-bounded-fault' }
'projection reader: actual PowerShell healthy/malformed/old/latest/bounded-fault controls PASS'
