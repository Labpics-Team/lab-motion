param([string]$Harness = (Join-Path $PSScriptRoot 'verify-input.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
class ClientAreaAnimation {
    static [bool] $Current = $true
    static [bool] $FailRead = $false
    static [bool] $FailNextWrite = $false
    static [int] $Writes = 0
    static [void] Write([bool]$value) {
        if ([ClientAreaAnimation]::FailNextWrite) {
            [ClientAreaAnimation]::FailNextWrite = $false
            throw [InvalidOperationException]::new('primary-system-preference')
        }
        [ClientAreaAnimation]::Writes = [ClientAreaAnimation]::Writes + 1
        [ClientAreaAnimation]::Current = $value
    }
    static [bool] Read() {
        if ([ClientAreaAnimation]::FailRead) { throw [IO.IOException]::new('cleanup-setting-read') }
        return [ClientAreaAnimation]::Current
    }
}
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid harness syntax' }
$readers = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Read-ProcessHasExited', 'Read-ProcessExitCode', 'Save-CleanupFailure',
        'Read-InputPhaseField', 'Get-InputPhaseSummary')
})
if ($readers.Count -ne 5) { throw 'Missing actual completion readers/arbitration/phase projection' }
$completionReaders = [scriptblock]::Create(($readers | ForEach-Object { $_.Extent.Text }) -join "`n")
. $completionReaders
$outer = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$cleanup = [scriptblock]::Create($outer.Finally.Extent.Text.Substring(1, $outer.Finally.Extent.Text.Length - 2))

# Catch/finally взяты из настоящего harness; тело ввода заменено одной системной ошибкой.
$lifetime = [scriptblock]::Create('try { if ($injectPrimary) { [ClientAreaAnimation]::FailNextWrite = $true; [ClientAreaAnimation]::Write($false) } } ' +
    $outer.CatchClauses[0].Extent.Text + ' finally ' + $outer.Finally.Extent.Text)
$originalOutput = $env:LAB_MOTION_PRESS_TRACE
$evidence = Join-Path ([IO.Path]::GetTempPath()) ('lab-motion-input-cleanup-' + [guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($evidence)
$cases = 0
try {
    foreach ($before in @($false, $true)) {
    foreach ($injectPrimary in @($false, $true)) {
    foreach ($fault in @('none', 'has-exited', 'close-main', 'close-wait', 'kill', 'kill-wait', 'refresh', 'dispose',
        'commands', 'close', 'record', 'restore-evidence', 'restore-read', 'failure-evidence', 'forced-close',
        'has-null', 'has-invalid', 'has-exited-late', 'has-null-late', 'has-invalid-late',
        'exit-code', 'exit-code-null', 'exit-code-invalid', 'post-refresh-running',
        'record-healthy', 'record-has-exited', 'record-has-null', 'record-has-invalid',
        'record-has-exited-late', 'record-has-null-late', 'record-has-invalid-late',
        'has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait', 'record-has-null-kill',
        'has-null-dispose', 'record-has-null-app-close', 'record-has-null-dispose', 'has-null-restore-read', 'has-null-restore-env',
        'close-main-kill', 'close-main-kill-wait', 'close-wait-kill', 'close-wait-kill-wait', 'record-already-closed')) {
        $script:fault = $fault
        $compound = $fault -in @('has-null-dispose', 'record-has-null-app-close', 'record-has-null-dispose', 'has-null-restore-read', 'has-null-restore-env')
        [ClientAreaAnimation]::Current = !$before
        [ClientAreaAnimation]::FailRead = $fault -in @('restore-read', 'has-null-restore-read')
        [ClientAreaAnimation]::Writes = 0
        $animationBefore = $before
        $saved = @{ LAB_MOTION_PRESS_TRACE = 'previous-trace' }
        if ($fault -eq 'has-null-restore-env') { $saved['LAB_MOTION_INVALID=NAME'] = 'invalid-name-control' }
        $env:LAB_MOTION_PRESS_TRACE = 'current-trace'
        $passed = (!$injectPrimary -and $fault -in @('forced-close', 'record-healthy', 'record-already-closed')) -or $compound
        $primaryFailure = $null
        $commands = @(@{ name = 'example' })
        $script:disposed = $false
        $script:recorderDisposed = $false
        $script:closeReached = $false
        $script:closeWaitReached = $false
        $script:killReached = $false
        $script:killWaitReached = $false
        $script:killCount = 0
        $script:killWaitCount = 0
        $script:killCountAtDispose = 0
        $script:killWaitCountAtDispose = 0
        $script:recorderKillReached = $false
        $script:recorderWaitReached = $false
        $script:exitCodeReached = $false
        $script:closeEvidence = $null
        $script:warnings = [Collections.Generic.List[string]]::new()
        $process = [pscustomobject]@{ IsExited = $false; Refreshed = $false }
        $process | Add-Member ScriptProperty HasExited {
            if ($script:fault -eq 'has-exited') { throw [InvalidOperationException]::new('cleanup-has-exited') }
            if ($script:fault -in @('has-null', 'has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait',
                'has-null-dispose', 'has-null-restore-read', 'has-null-restore-env')) { return $null }
            if ($script:fault -eq 'has-invalid') { return 'false' }
            if ($this.Refreshed) {
                if ($script:fault -eq 'has-exited-late') { throw [InvalidOperationException]::new('cleanup-has-exited-late') }
                if ($script:fault -eq 'has-null-late') { return $null }
                if ($script:fault -eq 'has-invalid-late') { return 1 }
                if ($script:fault -eq 'post-refresh-running') { return $false }
            }
            return $this.IsExited
        }
        $process | Add-Member ScriptProperty ExitCode {
            $script:exitCodeReached = $true
            if ($script:fault -eq 'exit-code') { throw [InvalidOperationException]::new('cleanup-exit-code') }
            if ($script:fault -eq 'exit-code-null') { return $null }
            if ($script:fault -eq 'exit-code-invalid') { return '0' }
            return 0
        }
        $process | Add-Member ScriptMethod CloseMainWindow {
            $script:closeReached = $true
            if ($script:fault -in @('close-main', 'has-null-close-main', 'record-has-null-app-close',
                'close-main-kill', 'close-main-kill-wait')) { throw [InvalidOperationException]::new('cleanup-close-main') }
            return $true
        }
        $process | Add-Member ScriptMethod WaitForExit {
            param([int]$Timeout = 0)
            if ($Timeout -eq 5000) {
                $script:closeWaitReached = $true
                if ($script:fault -in @('close-wait', 'has-null-close-wait', 'close-wait-kill', 'close-wait-kill-wait')) { throw [InvalidOperationException]::new('cleanup-close-wait') }
                if ($script:fault -in @('kill', 'kill-wait', 'forced-close', 'has-null-kill', 'has-null-kill-wait')) { return $false }
            } else {
                $script:killWaitReached = $true
                $script:killWaitCount++
                if ($script:fault -in @('kill-wait', 'has-null-kill-wait', 'close-main-kill-wait', 'close-wait-kill-wait')) { throw [InvalidOperationException]::new('cleanup-kill-wait') }
            }
            $this.IsExited = $true
            return $true
        }
        $process | Add-Member ScriptMethod Kill {
            param([bool]$EntireProcessTree)
            $script:killReached = $true
            $script:killCount++
            if ($script:fault -in @('kill', 'has-null-kill', 'close-main-kill', 'close-wait-kill')) { throw [IO.IOException]::new('cleanup-kill') }
            $this.IsExited = $true
        }
        $process | Add-Member ScriptMethod Refresh {
            $this.Refreshed = $true
            if ($script:fault -eq 'refresh') { throw [InvalidOperationException]::new('cleanup-refresh') }
        }
        $process | Add-Member ScriptMethod Dispose {
            $script:disposed = $true
            $script:killCountAtDispose = $script:killCount
            $script:killWaitCountAtDispose = $script:killWaitCount
            if ($script:fault -in @('dispose', 'has-null-dispose')) { throw [IO.IOException]::new('cleanup-dispose') }
        }
        $recording = $null
        if ($fault -eq 'record' -or $fault.StartsWith('record-')) {
            $recorder = [pscustomobject]@{ IsExited = $fault -eq 'record-already-closed' }
            $recorder | Add-Member ScriptProperty HasExited {
                if ($script:fault -eq 'record-has-exited') { throw [InvalidOperationException]::new('cleanup-record-has-exited') }
                if ($script:fault -in @('record-has-null', 'record-has-null-kill', 'record-has-null-app-close', 'record-has-null-dispose')) { return $null }
                if ($script:fault -eq 'record-has-invalid') { return 'false' }
                if ($this.IsExited) {
                    if ($script:fault -eq 'record-has-exited-late') { throw [InvalidOperationException]::new('cleanup-record-has-exited-late') }
                    if ($script:fault -eq 'record-has-null-late') { return $null }
                    if ($script:fault -eq 'record-has-invalid-late') { return 1 }
                }
                return $this.IsExited
            }
            $recorder | Add-Member ScriptMethod Kill {
                $script:recorderKillReached = $true
                if ($script:fault -in @('record', 'record-has-null-kill')) { throw [IO.IOException]::new('cleanup-recorder') }
                $this.IsExited = $true
            }
            $recorder | Add-Member ScriptMethod WaitForExit { $script:recorderWaitReached = $true }
            $recorder | Add-Member ScriptMethod Dispose {
                $script:recorderDisposed = $true
                if ($script:fault -eq 'record-has-null-dispose') { throw [IO.IOException]::new('cleanup-recorder-dispose') }
            }
            $recording = @{ ended = $false; process = $recorder; stderr = $null; prefix = '' }
        }
        function Set-Content {
            param([Parameter(Position = 0)][string]$Path, [Parameter(ValueFromPipeline = $true)]$InputObject)
            process {
                $name = [IO.Path]::GetFileName($Path)
                if ($name -eq 'close.json') { $script:closeEvidence = $InputObject | ConvertFrom-Json }
                if ($name -eq "$script:fault.json" -or
                    ($script:fault -eq 'restore-evidence' -and $name -eq 'animation-restored.json') -or
                    ($script:fault -eq 'failure-evidence' -and $name -eq 'failure.txt')) {
                    throw [IO.IOException]::new('cleanup-evidence')
                }
            }
        }
        function Write-Warning {
            param([string]$Message, $WarningAction)
            if ($WarningAction -ne 'Continue') { throw 'Cleanup warning can replace the primary under Stop' }
            $script:warnings.Add($Message)
        }
        $observed = $null
        try { & $lifetime } catch { $observed = $_ }
        if ([ClientAreaAnimation]::Current -ne $before -or [ClientAreaAnimation]::Writes -ne 1 -or
            $env:LAB_MOTION_PRESS_TRACE -ne 'previous-trace' -or !$script:disposed) {
            throw "Cleanup restoration/disposal failed: before=$before primary=$injectPrimary fault=$fault"
        }
        if ($recording -and !$script:recorderDisposed) { throw 'Recorder disposal was skipped' }
        if ($fault -in @('has-exited', 'has-null', 'has-invalid')) {
            if (!$script:closeReached -or !$script:closeWaitReached -or $script:exitCodeReached) {
                throw 'Invalid initial completion lost own-process termination or admitted exit code'
            }
        }
        if ($fault -in @('record-has-exited', 'record-has-null', 'record-has-invalid')) {
            if (!$script:recorderKillReached -or !$script:recorderWaitReached) { throw 'Invalid recorder completion lost termination' }
        }
        if ($fault -in @('has-exited-late', 'has-null-late', 'has-invalid-late', 'post-refresh-running')) {
            if (!$script:closeReached -or $script:exitCodeReached) { throw 'Late completion did not guard exit code' }
        }
        if ($fault -in @('none', 'record-healthy', 'record-already-closed')) {
            if ($null -eq $script:closeEvidence -or $script:closeEvidence.exited -isnot [bool] -or
                !$script:closeEvidence.exited -or $script:closeEvidence.exitCode -ne 0) { throw 'Healthy completion evidence lost' }
            if ($script:killCount -ne 0) { throw 'Healthy graceful close forced a kill' }
        }
        if ($fault -eq 'record-already-closed' -and ($script:recorderKillReached -or $script:recorderWaitReached)) {
            throw 'Already closed recorder was stopped again'
        }
        if ($fault -in @('close-main', 'close-wait', 'has-null-close-main', 'has-null-close-wait', 'record-has-null-app-close')) {
            if ($script:killCountAtDispose -ne 1 -or $script:killWaitCountAtDispose -ne 1 -or !$process.IsExited -or
                $script:exitCodeReached -or $null -ne $script:closeEvidence) { throw 'Graceful failure lost independent forced stop before Dispose' }
        }
        if ($fault -in @('close-main-kill', 'close-main-kill-wait', 'close-wait-kill', 'close-wait-kill-wait')) {
            $firstMessage = if ($fault.StartsWith('close-main-')) { 'cleanup-close-main' } else { 'cleanup-close-wait' }
            $secondary = if ($fault.EndsWith('-kill-wait')) { 'cleanup-kill-wait' } else { 'cleanup-kill' }
            if (!$injectPrimary -and (!$observed -or $observed.Exception.Message -notmatch [regex]::Escape($firstMessage))) {
                throw 'Forced failure replaced first graceful error'
            }
            if (!@($script:warnings | Where-Object { $_ -match [regex]::Escape($secondary) }).Count -or
                $script:killCountAtDispose -ne 1 -or $script:killWaitCountAtDispose -ne [int]($fault.EndsWith('-kill-wait')) -or
                $script:exitCodeReached -or $null -ne $script:closeEvidence) { throw 'Forced stop failure retried or lost its warning' }
        }
        if ($fault -in @('kill', 'kill-wait', 'has-null-kill', 'has-null-kill-wait') -and $script:killCount -ne 1) {
            throw 'An already attempted Kill was retried'
        }
        if ($compound) {
            if (!$injectPrimary -and (!$passed -or !$observed -or $observed.Exception.Message -notmatch 'bool HasExited')) {
                throw "First cleanup error lost after successful body: $fault"
            }
            $secondary = switch ($fault) {
                'has-null-dispose' { 'cleanup-dispose' }
                'record-has-null-app-close' { 'cleanup-close-main' }
                'record-has-null-dispose' { 'cleanup-recorder-dispose' }
                'has-null-restore-read' { 'cleanup-setting-read' }
                'has-null-restore-env' { 'Вторичная ошибка очистки:' }
            }
            if (!@($script:warnings | Where-Object { $_ -match [regex]::Escape($secondary) }).Count) {
                throw "Subsequent cleanup stage error not observable: $fault"
            }
            if (!$script:closeReached) { throw 'Compound error cancelled application cleanup' }
            if ($fault.StartsWith('record-')) {
                if (!$script:recorderKillReached -or !$script:recorderWaitReached) { throw 'Compound recorder error cancelled stop' }
            } elseif (!$script:closeWaitReached -or $script:exitCodeReached) { throw 'Compound application error cancelled stop or admitted exit code' }
        }
        if (!$injectPrimary -and $fault -in @('close-main', 'close-wait', 'kill', 'kill-wait', 'record')) {
            $terminationMessage = if ($fault -eq 'record') { 'cleanup-recorder' } else { 'cleanup-' + $fault }
            if (!$observed -or $observed.Exception.Message -notmatch [regex]::Escape($terminationMessage) -or $script:warnings.Count) {
                throw "Standalone termination error changed: $fault"
            }
        }
        if ($fault -in @('has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait', 'record-has-null-kill')) {
            if (!$injectPrimary -and (!$observed -or $observed.Exception.Message -notmatch 'bool HasExited')) {
                throw "First completion error lost through termination: $fault"
            }
            $secondary = switch ($fault) {
                'has-null-close-main' { 'cleanup-close-main' }
                'has-null-close-wait' { 'cleanup-close-wait' }
                'has-null-kill' { 'cleanup-kill' }
                'has-null-kill-wait' { 'cleanup-kill-wait' }
                'record-has-null-kill' { 'cleanup-recorder' }
            }
            if (!@($script:warnings | Where-Object { $_ -match [regex]::Escape($secondary) }).Count) {
                throw "Secondary termination error not observable: $fault"
            }
            if ($fault -eq 'record-has-null-kill') {
                if (!$script:recorderKillReached -or $script:recorderWaitReached -or !$script:closeReached) {
                    throw 'Recorder double fault lost own termination or application cleanup'
                }
            } else {
                if (!$script:closeReached -or $script:exitCodeReached) { throw 'Application double fault lost close or admitted exit code' }
                if ($script:closeWaitReached -ne ($fault -ne 'has-null-close-main') -or
                    !$script:killReached -or
                    $script:killWaitReached -ne ($fault -ne 'has-null-kill')) { throw 'Double fault invocation path changed' }
            }
        }
        if ($injectPrimary) {
            if (!$observed -or $observed.Exception.Message -notmatch 'primary-system-preference') {
                throw "Primary system error lost: before=$before fault=$fault"
            }
            $expectedWarning = if ($fault -eq 'failure-evidence') { 'Не удалось записать первичную ошибку.' } elseif ($fault -notin @('none', 'forced-close', 'record-healthy', 'record-already-closed')) { 'Очистка после ошибки не завершена.' } else { $null }
            if ($expectedWarning -and !$script:warnings.Contains($expectedWarning)) { throw "Cleanup fault not observable: $fault" }
        } else {
            $expectsFailure = $fault -notin @('none', 'failure-evidence', 'record-healthy', 'record-already-closed')
            if ([bool]$observed -ne $expectsFailure) { throw "Cleanup exit contract failed: before=$before fault=$fault" }
        }
        $cases++
    }
    }
    }
    # Без разрешённого изменения null не должен превращаться в запись предпочтения.
    $animationBefore = $null
    [ClientAreaAnimation]::Current = $true
    [ClientAreaAnimation]::FailRead = $false
    [ClientAreaAnimation]::Writes = 0
    $script:fault = 'none'
    $saved = @{ LAB_MOTION_PRESS_TRACE = 'previous-trace' }
    $env:LAB_MOTION_PRESS_TRACE = 'current-trace'
    $script:disposed = $false
    $script:closeReached = $false
    $script:killCount = 0
    $script:killWaitCount = 0
    $script:warnings.Clear()
    $primaryFailure = $null
    $passed = $false
    $recording = $null
    & $cleanup
    if (![ClientAreaAnimation]::Current -or [ClientAreaAnimation]::Writes -ne 0 -or !$script:disposed -or
        $env:LAB_MOTION_PRESS_TRACE -ne 'previous-trace' -or $script:closeReached -or $script:killCount -ne 0 -or $script:warnings.Count) {
        throw 'Cleanup changed an unowned preference or stopped an already closed app'
    }
    $cases++
    $process = $null
    $script:disposed = $false
    $script:recorderDisposed = $false
    & $cleanup
    if ($script:disposed -or $script:recorderDisposed -or [ClientAreaAnimation]::Writes -ne 0) { throw 'Cleanup invented an unowned process/preference' }
    $cases++
    # Здоровые типы сохраняют оба bool и ненулевой int без приведения.
    foreach ($value in @($false, $true)) {
        $actual = Read-ProcessHasExited ([pscustomobject]@{ HasExited = $value })
        if ($actual -isnot [bool] -or $actual -ne $value) { throw 'Healthy bool completion changed' }
    }
    foreach ($value in @(0, 7)) {
        $actual = Read-ProcessExitCode ([pscustomobject]@{ ExitCode = $value })
        if ($actual -isnot [int] -or $actual -ne $value) { throw 'Healthy int exit code changed' }
    }
    # Настоящий helper получает ErrorRecord и ref текущего scope; второй отказ не заменяет первый.
    $firstControl = [Management.Automation.ErrorRecord]::new([IO.IOException]::new('first-cleanup-control'),
        'first-cleanup-control', [Management.Automation.ErrorCategory]::ReadError, $null)
    $secondControl = [Management.Automation.ErrorRecord]::new([IO.IOException]::new('second-cleanup-control'),
        'second-cleanup-control', [Management.Automation.ErrorCategory]::CloseError, $null)
    $first = $null
    $script:warnings.Clear()
    Save-CleanupFailure $firstControl ([ref]$first)
    Save-CleanupFailure $secondControl ([ref]$first)
    if (![object]::ReferenceEquals($first, $firstControl) -or $script:warnings.Count -ne 1 -or
        $script:warnings[0] -notmatch 'second-cleanup-control') { throw 'First-error arbitration/reference changed' }

    # Настоящая проекция и failure-ветка из AST: синтетические случаи, не WinUI/runtime RCA.
    $phaseEvents = @(
        [pscustomobject]@{ sequence = 10; kind = 'intent'; data = [pscustomobject]@{ operation = 2; trigger = 'pressed'; pressed = $false; localAnimation = $true; systemAnimation = $true } },
        [pscustomobject]@{ sequence = 11; kind = 'motion'; data = [pscustomobject]@{ pageOperation = 2; nativeOperation = 20; phase = 'requested' } },
        [pscustomobject]@{ sequence = 12; kind = 'completed'; data = [pscustomobject]@{ operation = 2; nativeOperation = 20; reason = 'settled'; end = 'Finished'; isCurrent = $true } },
        [pscustomobject]@{ sequence = 13; kind = 'intent'; data = [pscustomobject]@{ operation = 3; trigger = 'localPreference'; pressed = $false; localAnimation = $false; systemAnimation = $true } },
        [pscustomobject]@{ sequence = 14; kind = 'snapRequested'; data = [pscustomobject]@{ operation = 3 } },
        [pscustomobject]@{ sequence = 15; kind = 'snapReadback'; data = [pscustomobject]@{ operation = 3 } }
    )
    $phaseCases = 0
    foreach ($name in @('disable-animation', 'system-disable-animation')) {
        $phaseEvents[3].data.trigger = if ($name -eq 'disable-animation') { 'localPreference' } else { 'systemPreference' }
        $phaseEvents[3].data.localAnimation = $name -eq 'system-disable-animation'
        $phaseEvents[3].data.systemAnimation = $name -eq 'disable-animation'
        $summary = Get-InputPhaseSummary -Name $name -After 9 -Events $phaseEvents | ConvertFrom-Json
        if ($summary.scenario -cne $name -or $summary.rows.Count -ne 6 -or $summary.omitted -ne 0 -or
            $summary.rows[0][1] -cne 'release' -or $summary.rows[1][2] -ne 2 -or $summary.rows[1][3] -ne 20 -or
            $summary.rows[2][7] -cne 'settled' -or $summary.rows[2][0] -ge $summary.rows[3][0] -or
            $summary.rows[3][1] -cne $phaseEvents[3].data.trigger -or
            $summary.rows[3][5] -ne $phaseEvents[3].data.localAnimation -or $summary.rows[3][6] -ne $phaseEvents[3].data.systemAnimation -or
            $summary.rows[4][1] -cne 'snapRequested' -or $summary.rows[5][1] -cne 'snapReadback') {
            throw 'phase-healthy-order-or-operation-control'
        }
        $noPreference = Get-InputPhaseSummary -Name $name -After 9 -Events @($phaseEvents | Where-Object kind -ne 'intent') | ConvertFrom-Json
        if (@($noPreference.rows | Where-Object { $_[1] -in @('localPreference', 'systemPreference') }).Count -ne 0 -or
            $noPreference.rows.Count -ne 4) { throw 'phase-no-preference-control' }
        $missedSnap = Get-InputPhaseSummary -Name $name -After 12 -Events @($phaseEvents[3]) | ConvertFrom-Json
        if ($missedSnap.rows.Count -ne 1 -or $missedSnap.rows[0][1] -cne $phaseEvents[3].data.trigger) {
            throw 'phase-preference-without-snap-control'
        }
        $missedReadback = Get-InputPhaseSummary -Name $name -After 12 -Events @($phaseEvents[3], $phaseEvents[4]) | ConvertFrom-Json
        if ($missedReadback.rows.Count -ne 2 -or $missedReadback.rows[1][1] -cne 'snapRequested') {
            throw 'phase-snap-without-readback-control'
        }
        $phaseCases += 4
    }
    $missing = Get-InputPhaseSummary -Name 'untrusted-name' -After 9 -Events @() | ConvertFrom-Json
    if ($missing.scenario -cne 'unknown' -or $missing.rows.Count -ne 0 -or $missing.count -ne 0) { throw 'phase-missing-control' }
    $malformed = @(
        [pscustomobject]@{ sequence = '::error::secret'; kind = 'completed'; data = 'secret' },
        [pscustomobject]@{ sequence = 10; kind = 'completed'; data = [pscustomobject]@{ operation = 'secret'; nativeOperation = -1; reason = '::error::secret'; end = 'secret'; isCurrent = 'true'; arbitrary = 'secret' } },
        [pscustomobject]@{ sequence = 11; kind = 'ignored'; data = 'secret' }
    )
    $text = Get-InputPhaseSummary -Name '::error::secret' -After 9 -Events $malformed
    $bad = $text | ConvertFrom-Json
    if ($text -match 'secret|::error::|arbitrary' -or $bad.invalid -ne 1 -or $bad.rows.Count -ne 1 -or
        $null -ne $bad.rows[0][2] -or $null -ne $bad.rows[0][3] -or $null -ne $bad.rows[0][7] -or
        $null -ne $bad.rows[0][8] -or $null -ne $bad.rows[0][9]) { throw 'phase-malformed-redaction-control' }
    $many = @(1..100 | ForEach-Object {
        [pscustomobject]@{ sequence = $_; kind = 'completed'; data = [pscustomobject]@{ operation = 9007199254740991L; nativeOperation = 9007199254740991L; reason = 'interaction'; end = 'Stopped'; isCurrent = $false } }
    })
    $text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 0 -Events $many
    $bounded = $text | ConvertFrom-Json
    if ($text.Length -gt 1800 -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 1800 -or $bounded.count -ne 100 -or
        $bounded.rows.Count -gt 12 -or $bounded.omitted -ne (100 - $bounded.rows.Count) -or
        $bounded.rows[0][0] -ne 1 -or $bounded.rows[-1][0] -ne 100) { throw 'phase-bounded-first-last-control' }
    $phaseCases += 3
    # Новые фазы не выводятся из intent: receipt/queue/delegate — отдельные события.
    $received = [pscustomobject]@{ sequence = 10; kind = 'systemNotification'; data = [pscustomobject]@{
        notification = 7; phase = 'Received'; queued = $null; diagnosticFailed = $false } }
    $queueResult = [pscustomobject]@{ sequence = 11; kind = 'systemNotification'; data = [pscustomobject]@{
        notification = 7; phase = 'Queued'; queued = $false; diagnosticFailed = $false } }
    $delegate = [pscustomobject]@{ sequence = 12; kind = 'systemNotification'; data = [pscustomobject]@{
        notification = 7; phase = 'Delegate'; queued = $null; diagnosticFailed = $false } }
    $summary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($received) | ConvertFrom-Json
    if ($summary.schema -ne 2 -or $summary.rows.Count -ne 1 -or $summary.rows[0][1] -cne 'systemCallback' -or
        $summary.rows[0][10] -ne 7 -or $null -ne $summary.rows[0][11] -or $summary.rows[0][12] -cne $false) {
        throw 'phase-notification-received-only-control'
    }
    $summary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($received, $queueResult) | ConvertFrom-Json
    if ($summary.rows.Count -ne 2 -or $summary.rows[1][1] -cne 'systemQueued' -or
        $summary.rows[1][10] -ne 7 -or $summary.rows[1][11] -isnot [bool] -or $summary.rows[1][11] -cne $false -or
        @($summary.rows | Where-Object { $_[1] -in @('systemDelegate', 'systemPreference', 'snapRequested') }).Count -ne 0) {
        throw 'phase-notification-queue-rejected-control'
    }
    $queueResult.data.queued = $true
    foreach ($delegateBeforeResult in @($false, $true)) {
        $queueResult.sequence = if ($delegateBeforeResult) { 12 } else { 11 }
        $delegate.sequence = if ($delegateBeforeResult) { 11 } else { 12 }
        $notificationEvents = if ($delegateBeforeResult) { @($received, $delegate, $queueResult) } else { @($received, $queueResult, $delegate) }
        $notificationEvents += $phaseEvents[3]
        $summary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events $notificationEvents | ConvertFrom-Json
        $queueIndex = if ($delegateBeforeResult) { 2 } else { 1 }
        $delegateIndex = if ($delegateBeforeResult) { 1 } else { 2 }
        if ($summary.rows.Count -ne 4 -or $summary.rows[$queueIndex][1] -cne 'systemQueued' -or
            $summary.rows[$queueIndex][11] -cne $true -or $summary.rows[$delegateIndex][1] -cne 'systemDelegate' -or
            $summary.rows[$delegateIndex][10] -ne 7 -or $summary.rows[3][1] -cne 'systemPreference' -or
            $summary.rows[3][6] -cne $false) {
            if ($delegateBeforeResult) { throw 'phase-notification-delegate-before-result-control' }
            throw 'phase-notification-accepted-control'
        }
    }
    $queueResult.data.diagnosticFailed = $true
    $summary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($queueResult) | ConvertFrom-Json
    if ($summary.rows.Count -ne 1 -or $summary.rows[0][12] -isnot [bool] -or $summary.rows[0][12] -cne $true) {
        throw 'phase-notification-diagnostic-failed-control'
    }
    $notificationBad = @(
        [pscustomobject]@{ sequence = 10; kind = 'systemNotification'; data = [pscustomobject]@{
            phase = 'Queued'; notification = 9007199254740992L; queued = 'false'; diagnosticFailed = 'true'; arbitrary = 'secret' } },
        [pscustomobject]@{ sequence = 11; kind = 'systemNotification'; data = [pscustomobject]@{
            phase = '::error::secret'; notification = 1; queued = $true; diagnosticFailed = $false } }
    )
    $text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events $notificationBad
    $summary = $text | ConvertFrom-Json
    if ($text -match 'secret|::error::|arbitrary' -or $summary.rows.Count -ne 1 -or
        $null -ne $summary.rows[0][10] -or $null -ne $summary.rows[0][11] -or $null -ne $summary.rows[0][12]) {
        throw 'phase-notification-malformed-control'
    }
    $notificationMany = @(1..100 | ForEach-Object {
        [pscustomobject]@{ sequence = $_; kind = 'systemNotification'; data = [pscustomobject]@{
            notification = 9007199254740991L; phase = 'Queued'; queued = $false; diagnosticFailed = $true } }
    })
    $text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 0 -Events $notificationMany
    $summary = $text | ConvertFrom-Json
    if ($text.Length -gt 1800 -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 1800 -or $summary.rows.Count -gt 12 -or
        $summary.count -ne 100 -or $summary.omitted -ne (100 - $summary.rows.Count) -or
        $summary.rows[0][0] -ne 1 -or $summary.rows[-1][0] -ne 100) { throw 'phase-notification-bounded-control' }
    $phaseCases += 7
    $scenarioAst = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Scenario' })[0]
    $failureAst = @($scenarioAst.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and
        $node.Extent.Text.StartsWith('if (!$stopped.Count)') }, $true))[0]
    $phaseFailure = [scriptblock]::Create($failureAst.Clauses[0].Item2.Extent.Text.TrimStart('{').TrimEnd('}'))
    $before = 9
    $events = $phaseEvents
    foreach ($Name in @('disable-animation', 'system-disable-animation')) {
        $observed = $null
        try { & $phaseFailure } catch { $observed = $_ }
        if ($null -eq $observed -or $observed.FullyQualifiedErrorId -notmatch 'InputSnapNotObserved' -or
            !$observed.Exception.Message.Contains("[scenario=$Name]") -or
            !$observed.ErrorDetails.Message.Contains('input-phase:')) { throw 'phase-named-failure-control' }
        $phaseCases++
    }
    try {
        function Get-InputPhaseSummary { throw 'secondary-phase-projection-control' }
        $observed = $null
        try { & $phaseFailure } catch { $observed = $_ }
        if ($null -eq $observed -or $observed.FullyQualifiedErrorId -notmatch 'InputSnapNotObserved' -or
            $observed.Exception.Message -match 'secondary-phase-projection-control' -or
            !$observed.ErrorDetails.Message.Contains('input-phase: unavailable')) { throw 'phase-primary-preserved-control' }
        $phaseCases++
    } finally { . $completionReaders }
    "phase diagnostics: $phaseCases synthetic controls PASS"
    # Настоящий неассоциированный .NET getter: процесс не запускается и ничего не меняет.
    $unassociated = [Diagnostics.Process]::new()
    try {
        $unassociatedExited = $unassociated.HasExited
        if ($null -ne $unassociatedExited) { throw 'Unassociated HasExited no longer yields null' }
        $rejected = $false
        try { $null = Read-ProcessHasExited $unassociated } catch { $rejected = $_.Exception.Message -match 'bool HasExited' }
        if (!$rejected) { throw 'Actual .NET completion getter was accepted' }
    } finally { $unassociated.Dispose() }
} finally {
    $env:LAB_MOTION_PRESS_TRACE = $originalOutput
    [IO.Directory]::Delete($evidence, $true)
}
"cleanup: $cases PASS"
'completion readers: 4 healthy controls + actual .NET getter PASS'
'cleanup arbitration: actual ErrorRecord/ref control PASS'
