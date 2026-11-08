param([string]$Harness = (Join-Path $PSScriptRoot 'verify-input.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
class ClientAreaAnimation {
    static [bool] $Current = $true
    static [bool] $FailRead = $false
    static [bool] $FailNextWrite = $false
    static [int] $Writes = 0
    static [long] $SetEnteredQpc = 100
    static [long] $SetReturnedQpc = 110
    static [bool] $SetSucceeded = $true
    static [long] $ReadbackQpc = 120
    static [object] $ReadbackEnabled = $null
    static [long] $QpcFrequency = 10000000
    static [void] Write([bool]$value) {
        if ([ClientAreaAnimation]::FailNextWrite) {
            [ClientAreaAnimation]::FailNextWrite = $false
            throw [InvalidOperationException]::new('primary-system-preference')
        }
        [ClientAreaAnimation]::Writes = [ClientAreaAnimation]::Writes + 1
        [ClientAreaAnimation]::Current = $value
        [ClientAreaAnimation]::ReadbackEnabled = $value
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
        'Read-InputPhaseField', 'Get-InputPhaseSummary', 'Get-RestSummary')
})
if ($readers.Count -ne 6) { throw 'Missing actual completion readers/arbitration/phase projection' }
$completionReaders = [scriptblock]::Create(($readers | ForEach-Object { $_.Extent.Text }) -join "`n")
. $completionReaders
$finishDefinition = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Finish-Tool'
})
if ($finishDefinition.Count -ne 1) { throw 'Missing actual Finish-Tool' }
. ([scriptblock]::Create($finishDefinition[0].Extent.Text))
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

    # Настоящий Finish-Tool из AST, без child: ждём, останавливаем и освобождаем независимо.
    $toolCases = 0
    foreach ($toolFault in @('healthy', 'wait', 'timeout', 'wait-null', 'wait-invalid', 'wait-kill',
        'wait-stop-wait', 'wait-stop-false', 'wait-stop-null', 'wait-stop-running', 'wait-stop-has-null',
        'wait-dispose', 'wait-all', 'exhausted', 'stdout', 'stderr', 'evidence', 'json', 'exit',
        'stdout-dispose', 'stderr-dispose', 'evidence-dispose', 'json-dispose', 'exit-dispose', 'dispose')) {
        $script:toolFault = $toolFault
        $script:toolWaits = [Collections.Generic.List[int]]::new()
        $script:toolKills = 0
        $script:toolDisposes = 0
        $script:toolStopReads = 0
        $script:toolOrder = [Collections.Generic.List[string]]::new()
        $script:warnings.Clear()
        $toolProcess = [pscustomobject]@{ IsExited = $false }
        $toolProcess | Add-Member ScriptMethod WaitForExit {
            param([int]$Timeout = -1)
            if ($Timeout -lt 0) { throw 'tool-unbounded-wait' }
            $script:toolWaits.Add($Timeout)
            $script:toolOrder.Add('wait')
            if ($script:toolWaits.Count -eq 1) {
                if ($script:toolFault.StartsWith('wait')) {
                    if ($script:toolFault -eq 'wait-null') { return $null }
                    if ($script:toolFault -eq 'wait-invalid') { return 'false' }
                    throw [IO.IOException]::new('tool-primary-wait')
                }
                if ($script:toolFault -in @('timeout', 'exhausted')) { return $false }
            } else {
                if ($script:toolFault -in @('wait-stop-wait', 'wait-all')) { throw [IO.IOException]::new('tool-secondary-stop-wait') }
                if ($script:toolFault -eq 'wait-stop-null') { return $null }
                if ($script:toolFault -eq 'wait-stop-false') { return $false }
            }
            $this.IsExited = $script:toolFault -ne 'wait-stop-running'
            return $true
        }
        $toolProcess | Add-Member ScriptMethod Kill {
            param([bool]$EntireProcessTree)
            $script:toolKills++
            $script:toolOrder.Add('kill')
            if (!$EntireProcessTree -or $script:tool.ended) { throw 'tool-finish-before-dispose-control' }
            if ($script:toolFault -in @('wait-kill', 'wait-all')) { throw [IO.IOException]::new('tool-secondary-kill') }
        }
        $toolProcess | Add-Member ScriptProperty HasExited {
            if ($script:toolWaits.Count -gt 1) { $script:toolStopReads++ }
            if ($script:toolFault -eq 'wait-stop-has-null') { return $null }
            return $this.IsExited
        }
        $toolProcess | Add-Member ScriptProperty ExitCode {
            if ($script:toolFault.StartsWith('exit')) { return 7 }
            return 0
        }
        $toolProcess | Add-Member ScriptMethod Dispose {
            $script:toolDisposes++
            $script:toolOrder.Add('dispose')
            if (!$script:tool.ended) { throw 'tool-ended-not-recorded' }
            if ($script:toolFault.EndsWith('dispose') -or $script:toolFault -eq 'wait-all') {
                throw [IO.IOException]::new('tool-secondary-dispose')
            }
        }
        $toolStdout = [pscustomobject]@{ Stream = 'stdout' }
        $toolStderr = [pscustomobject]@{ Stream = 'stderr' }
        foreach ($stream in @($toolStdout, $toolStderr)) {
            $stream | Add-Member ScriptMethod GetAwaiter { return $this }
            $stream | Add-Member ScriptMethod GetResult {
                if ($script:toolFault.StartsWith($this.Stream)) { throw [IO.IOException]::new('tool-primary-' + $this.Stream) }
                if ($this.Stream -eq 'stderr') { return '' }
                if ($script:toolFault.StartsWith('json')) { return '{invalid' }
                return '{"finished":true}'
            }
        }
        $name = if ($toolFault.StartsWith('evidence')) { 'missing-parent/tool' } else { 'finish-control' }
        $script:tool = @{ name = $name; arguments = @(); process = $toolProcess; stdout = $toolStdout;
            stderr = $toolStderr; prefix = ''; ended = $false }
        $commands = [Collections.Generic.List[object]]::new()
        $toolTimeout = if ($toolFault -eq 'exhausted') { 0 } else { 100 }
        $toolObserved = $null
        $toolResult = $null
        try { $toolResult = Finish-Tool $script:tool $toolTimeout } catch { $toolObserved = $_ }
        $needsStop = $toolFault.StartsWith('wait') -or $toolFault -in @('timeout', 'exhausted')
        if ($script:toolKills -ne [int]$needsStop -or $script:toolDisposes -ne 1 -or
            $script:toolWaits.Count -ne (1 + [int]$needsStop)) { throw 'tool-finish-once-only-control' }
        if ($needsStop -and ($script:toolOrder[1] -ne 'kill' -or $script:toolOrder[-1] -ne 'dispose')) {
            throw 'tool-finish-before-dispose-control'
        }
        if (@($script:toolWaits | Where-Object { $_ -lt 0 -or $_ -gt $toolTimeout }).Count -or
            ($needsStop -and $script:toolWaits[1] -gt $script:toolWaits[0])) { throw 'tool-finish-original-budget-control' }
        if ($toolFault -eq 'exhausted' -and ($script:toolWaits[1] -ne 0 -or $script:toolStopReads -ne 1)) {
            throw 'tool-finish-original-budget-control'
        }
        if ($toolFault -eq 'healthy') {
            if ($toolObserved -or !$toolResult.finished -or $commands.Count -ne 1 -or $script:warnings.Count) {
                throw 'tool-finish-healthy-control'
            }
        } else {
            $expectedPrimary = switch -Wildcard ($toolFault) {
                'wait-null' { 'bool после ожидания'; break }
                'wait-invalid' { 'bool после ожидания'; break }
                'wait*' { 'tool-primary-wait'; break }
                'timeout' { 'Таймаут winapp'; break }
                'exhausted' { 'Таймаут winapp'; break }
                'stdout*' { 'tool-primary-stdout'; break }
                'stderr*' { 'tool-primary-stderr'; break }
                'exit*' { 'exit 7'; break }
                'dispose' { 'tool-secondary-dispose'; break }
                default { $null }
            }
            if (!$toolObserved -or ($expectedPrimary -and $toolObserved.Exception.Message -notmatch [regex]::Escape($expectedPrimary)) -or
                (!$expectedPrimary -and $toolObserved.Exception.Message -match 'tool-secondary-dispose')) {
                throw 'tool-finish-primary-control'
            }
        }
        $expectedSecondary = switch ($toolFault) {
            'wait-kill' { 'tool-secondary-kill' }
            'wait-stop-wait' { 'tool-secondary-stop-wait' }
            'wait-stop-false' { 'не подтвердила завершение' }
            'wait-stop-null' { 'bool после остановки' }
            'wait-stop-running' { 'не подтвердила завершение' }
            'wait-stop-has-null' { 'bool HasExited' }
            'wait-all' { 'tool-secondary-kill', 'tool-secondary-stop-wait', 'tool-secondary-dispose' }
            default { if ($toolFault -ne 'dispose' -and $toolFault.EndsWith('dispose')) { 'tool-secondary-dispose' } }
        }
        foreach ($message in @($expectedSecondary)) {
            if ($message -and !@($script:warnings | Where-Object { $_ -match [regex]::Escape($message) }).Count) {
                throw 'tool-finish-secondary-control'
            }
        }
        $toolCases++
    }
    "tool finish: $toolCases synthetic controls PASS"

    # Настоящие Scenario/Invoke-Ui/Finish-Tool; подменены только trace, системная настройка и child.
    $releaseDefinitions = @($ast.EndBlock.Statements | Where-Object {
        $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Scenario', 'Invoke-Ui')
    })
    if ($releaseDefinitions.Count -ne 2) { throw 'Missing actual release Scenario/Invoke-Ui' }
    $releaseFunctions = [scriptblock]::Create(($releaseDefinitions | ForEach-Object { $_.Extent.Text }) -join "`n")
    # Scenario и Finish-Tool читают присваивания владельца; числа ниже — ожидания, не значения по умолчанию.
    $configurationExpectations = [ordered]@{ restTimeoutSeconds = 8; toolTimeoutMilliseconds = 30000 }
    foreach ($configurationName in $configurationExpectations.Keys) {
        $configuration = @($ast.EndBlock.Statements | Where-Object {
            $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
            $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $_.Left.VariablePath.UserPath -ceq $configurationName
        })
        if ($configuration.Count -ne 1) { throw 'release-config-missing-control' }
        . ([scriptblock]::Create($configuration[0].Extent.Text))
        $configuredValue = Get-Variable -Name $configurationName -Scope Local -ValueOnly
        if ($configuredValue -isnot [int] -or $configuredValue -ne $configurationExpectations[$configurationName]) {
            throw 'release-config-owner-budget-control'
        }
    }
    $releaseCases = 0
    foreach ($releaseFault in @('healthy', 'delayed-exit', 'settled', 'race', 'read', 'setter', 'readback',
        'read-finish', 'setter-finish', 'finish', 'start', 'budget', 'local',
        'local-healthy', 'local-delayed-exit', 'local-settled', 'local-race', 'local-read',
        'local-action', 'local-action-finish', 'local-toggle-exit', 'local-finish', 'local-start')) {
        & {
            param([string]$Probe)
            . $releaseFunctions
            $script:releaseProbe = $Probe
            $script:releaseProbeReads = 0
            $script:releaseProbeStarts = 0
            $script:releaseProbeWaits = [Collections.Generic.List[int]]::new()
            $script:releaseProbeActionWaits = [Collections.Generic.List[int]]::new()
            $script:releaseProbeActionDisposes = 0
            $script:releaseProbeLocalDisabled = $false
            $script:releaseProbeKills = 0
            $script:releaseProbeDisposes = 0
            $script:releaseProbeReadBeforeFinish = $false
            $script:releaseProbeSettled = $Probe -in @('settled', 'local-settled')
            $script:releaseProbeTool = $null
            $script:releaseProbeArguments = @()
            $script:window = 'fixture-window'
            $script:warnings.Clear()
            $commands = [Collections.Generic.List[object]]::new()
            $scenarios = [Collections.Generic.List[object]]::new()
            [ClientAreaAnimation]::Current = $true
            [ClientAreaAnimation]::Writes = 0
            [ClientAreaAnimation]::FailNextWrite = $Probe -in @('setter', 'setter-finish')
            [ClientAreaAnimation]::FailRead = $Probe -eq 'readback'
            function Wait-Rest { param([long]$After = 0) }
            function Read-Trace {
                $script:releaseProbeReads++
                if ($script:releaseProbeReads -eq 1) {
                    return [pscustomobject]@{ sequence = 9; kind = 'completed'; data = [pscustomobject]@{ reason = 'settled'; operation = 1 } }
                }
                if ($script:releaseProbeStarts -gt 0 -and $script:releaseProbeWaits.Count -eq 0) {
                    $script:releaseProbeReadBeforeFinish = $true
                }
                if ($script:releaseProbe -in @('read', 'read-finish', 'local-read')) { throw [IO.IOException]::new('release-primary-read') }
                $rows = @(
                    [pscustomobject]@{ sequence = 10; kind = 'intent'; data = [pscustomobject]@{
                        operation = 2; trigger = 'pressed'; pressed = $false; localAnimation = $true; systemAnimation = $true } },
                    [pscustomobject]@{ sequence = 11; kind = 'motion'; data = [pscustomobject]@{
                        pageOperation = 2; nativeOperation = 20; phase = 'requested' } }
                )
                if ($script:releaseProbeSettled) {
                    $rows += [pscustomobject]@{ sequence = 12; kind = 'completed'; data = [pscustomobject]@{ operation = 2; reason = 'settled' } }
                } elseif (![ClientAreaAnimation]::Current -or $script:releaseProbeLocalDisabled) {
                    $rows += [pscustomobject]@{ sequence = 12; kind = 'completed'; data = [pscustomobject]@{ operation = 2; reason = 'snap' } }
                }
                # Setter может опоздать уже после допустимого snapshot: настоящий snap guard обязан отказать.
                if ($script:releaseProbe -in @('race', 'local-race')) { $script:releaseProbeSettled = $true }
                return $rows
            }
            function Start-Tool {
                param([string]$Name, [string[]]$Arguments)
                $script:releaseProbeStarts++
                $isToggle = $Name -eq 'disable-animation'
                if ($isToggle) {
                    if (($Arguments -join ',') -cne 'ui,send-keys,space,--target,Animation,--via,send-input,-w,fixture-window,--json') {
                        throw 'local-release-space-arguments-control'
                    }
                    if ($script:releaseProbe -in @('local-action', 'local-action-finish')) { throw [IO.IOException]::new('local-primary-toggle') }
                    $script:releaseProbeLocalDisabled = $true
                } else { $script:releaseProbeArguments = $Arguments }
                if ($script:releaseProbe -in @('start', 'local-start')) { throw [IO.IOException]::new('release-primary-start') }
                if ($script:releaseProbe -eq 'budget') { [Threading.Thread]::Sleep(30) }
                $owned = [pscustomobject]@{ IsExited = $false; IsToggle = $isToggle; Tool = $null }
                $owned | Add-Member ScriptMethod WaitForExit {
                    param([int]$Timeout)
                    if ($Timeout -lt 0 -or $Timeout -gt 30000) { throw 'release-unbounded-wait' }
                    if ($this.IsToggle) { $script:releaseProbeActionWaits.Add($Timeout) }
                    else { $script:releaseProbeWaits.Add($Timeout) }
                    if (!$this.IsToggle -and $script:releaseProbeWaits.Count -eq 1 -and
                        $script:releaseProbe -in @('read-finish', 'setter-finish', 'finish', 'local-action-finish', 'local-finish')) {
                        throw [IO.IOException]::new('release-secondary-finish')
                    }
                    # В delayed-exit приложение settles, пока прежний sync consumer ждёт CLI.
                    if (!$this.IsToggle -and $script:releaseProbe -in @('delayed-exit', 'local-delayed-exit') -and
                        [ClientAreaAnimation]::Current -and !$script:releaseProbeLocalDisabled) { $script:releaseProbeSettled = $true }
                    $this.IsExited = $true
                    return $true
                }
                $owned | Add-Member ScriptMethod Kill {
                    param([bool]$EntireProcessTree)
                    if (!$EntireProcessTree -or ![object]::ReferenceEquals($this, $script:releaseProbeTool.process)) { throw 'release-wrong-child' }
                    $script:releaseProbeKills++
                }
                $owned | Add-Member ScriptProperty HasExited { return $this.IsExited }
                $owned | Add-Member ScriptProperty ExitCode {
                    if ($this.IsToggle -and $script:releaseProbe -eq 'local-toggle-exit') { return 1 }
                    return 0
                }
                $owned | Add-Member ScriptMethod Dispose {
                    if (!$this.Tool.ended) { throw 'release-disposed-before-finish' }
                    if ($this.IsToggle) { $script:releaseProbeActionDisposes++ }
                    else { $script:releaseProbeDisposes++ }
                }
                $stdout = [pscustomobject]@{ Stream = 'stdout' }
                $stderr = [pscustomobject]@{ Stream = 'stderr' }
                foreach ($stream in @($stdout, $stderr)) {
                    $stream | Add-Member ScriptMethod GetAwaiter { return $this }
                    $stream | Add-Member ScriptMethod GetResult {
                        if ($this.Stream -eq 'stderr') { return '' }
                        return '{"finished":true}'
                    }
                }
                $tool = @{ process = $owned; stdout = $stdout; stderr = $stderr; prefix = '';
                    ended = $false; name = $Name; arguments = $Arguments }
                $owned.Tool = $tool
                if (!$isToggle) { $script:releaseProbeTool = $tool }
                return $tool
            }
            try {
                $observed = $null
                $isLocal = $Probe.StartsWith('local-')
                $name = if ($isLocal) { 'disable-animation' } elseif ($Probe -eq 'local') { 'mouse-hold' } else { 'system-disable-animation' }
                try {
                    if ($isLocal) {
                        Scenario 'disable-animation' @('send-keys', 'space', '--target', 'Animation', '--via', 'send-input') @('drag', 'Press', 'Press', '--hold-ms', '0')
                    } else { Scenario $name @('drag', 'Press', 'Press', '--hold-ms', '0') }
                } catch { $observed = $_ }
                $expectedPrimary = switch ($Probe) {
                    'settled' { 'Операция завершилась до запрета анимации.' }
                    'race' { 'completed/snap не наблюдался' }
                    'read' { 'release-primary-read' }
                    'read-finish' { 'release-primary-read' }
                    'setter' { 'primary-system-preference' }
                    'setter-finish' { 'primary-system-preference' }
                    'readback' { 'cleanup-setting-read' }
                    'finish' { 'release-secondary-finish' }
                    'start' { 'release-primary-start' }
                    'local-settled' { 'Операция завершилась до запрета анимации.' }
                    'local-race' { 'completed/snap не наблюдался' }
                    'local-read' { 'release-primary-read' }
                    'local-action' { 'local-primary-toggle' }
                    'local-action-finish' { 'local-primary-toggle' }
                    'local-toggle-exit' { 'winapp disable-animation: exit 1' }
                    'local-finish' { 'release-secondary-finish' }
                    'local-start' { 'release-primary-start' }
                    default { $null }
                }
                if ($null -eq $expectedPrimary) {
                    if ($null -ne $observed -or $scenarios.Count -ne 1) { throw "release-healthy-control: $Probe $observed" }
                } elseif ($null -eq $observed -or !$observed.Exception.Message.Contains($expectedPrimary) -or $scenarios.Count -ne 0) {
                    throw "release-primary-control: $Probe $observed"
                }
                $writes = if ($isLocal -or $Probe -in @('settled', 'read', 'read-finish', 'setter', 'setter-finish', 'start', 'local')) { 0 } else { 1 }
                $starts = if ($isLocal -and $Probe -notin @('local-settled', 'local-read', 'local-start')) { 2 } else { 1 }
                if ([ClientAreaAnimation]::Writes -ne $writes -or $script:releaseProbeStarts -ne $starts) { throw "release-effect-control: $Probe" }
                $toggleFinished = $isLocal -and $Probe -notin @('local-settled', 'local-read', 'local-start', 'local-action', 'local-action-finish')
                if ($script:releaseProbeActionWaits.Count -ne [int]$toggleFinished -or $script:releaseProbeActionDisposes -ne [int]$toggleFinished) {
                    throw "local-release-toggle-result-control: $Probe"
                }
                if ($isLocal -and $script:releaseProbeTool -and $script:releaseProbeTool.name -cne 'disable-animation-press') {
                    throw 'local-release-child-name-control'
                }
                if ($Probe -notin @('start', 'local-start')) {
                    $waits = if ($Probe -in @('read-finish', 'setter-finish', 'finish', 'local-action-finish', 'local-finish')) { 2 } else { 1 }
                    $kills = if ($waits -eq 2) { 1 } else { 0 }
                    if ($script:releaseProbeWaits.Count -ne $waits -or $script:releaseProbeKills -ne $kills -or
                        $script:releaseProbeDisposes -ne 1 -or !$script:releaseProbeTool.ended) { throw "release-owned-finish-control: $Probe" }
                    if ($Probe -ne 'local' -and !$script:releaseProbeReadBeforeFinish) { throw "release-delayed-observation-control: $Probe" }
                } elseif ($script:releaseProbeWaits.Count -ne 0 -or $script:releaseProbeDisposes -ne 0) { throw 'release-failed-start-control' }
                if ($Probe -eq 'budget' -and $script:releaseProbeWaits[0] -gt 29980) { throw 'release-original-deadline-control' }
                if ($Probe -in @('read-finish', 'setter-finish', 'local-action-finish') -and @($script:warnings | Where-Object { $_ -match 'release-secondary-finish' }).Count -ne 1) {
                    throw 'release-secondary-observable-control'
                }
                if (($script:releaseProbeArguments -join "`n") -cne (@('ui', 'drag', 'Press', 'Press', '--hold-ms', '0', '-w', 'fixture-window', '--json') -join "`n")) {
                    throw 'release-arguments-control'
                }
            } finally {
                [ClientAreaAnimation]::FailRead = $false
                [ClientAreaAnimation]::FailNextWrite = $false
                [ClientAreaAnimation]::Current = $true
            }
        } $releaseFault
        $releaseCases++
    }
    "interruption release: $releaseCases synthetic controls PASS"

    # Настоящая проекция и failure-ветка из AST: синтетические случаи, не WinUI/runtime RCA.
    $systemSetterReceipt = $null
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
    # Тот же completed payload: false/true различаются, недоступное чтение не становится false.
    $completedGetterCases = 0
    foreach ($getterCase in @(
        @{ name = 'false'; value = $false; expected = $false },
        @{ name = 'true'; value = $true; expected = $true },
        @{ name = 'unavailable'; value = $null; expected = $null },
        @{ name = 'malformed'; value = '::error::secret'; expected = $null },
        @{ name = 'missing'; expected = $null }
    )) {
        $completedData = @{ operation = 17; nativeOperation = 14; reason = 'settled'; end = 'Finished'; isCurrent = $true }
        if ($getterCase.ContainsKey('value')) { $completedData.systemAnimation = $getterCase.value }
        $completedEvent = [pscustomobject]@{ sequence = 10; kind = 'completed'; data = [pscustomobject]$completedData }
        $getterText = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($completedEvent)
        $getterSummary = $getterText | ConvertFrom-Json
        $actual = $getterSummary.rows[0][6]
        if ($getterSummary.schema -ne 2 -or $getterSummary.count -ne 1 -or $getterSummary.rows.Count -ne 1 -or
            $getterSummary.rows[0].Count -ne 14 -or $getterSummary.omitted -ne 0 -or $getterSummary.invalid -ne 0 -or
            $getterSummary.rows[0][0] -ne 10 -or $getterSummary.rows[0][1] -cne 'completed' -or
            $getterSummary.rows[0][2] -ne 17 -or $getterSummary.rows[0][3] -ne 14 -or
            $getterSummary.rows[0][7] -cne 'settled' -or $getterSummary.rows[0][8] -cne 'Finished' -or
            $getterSummary.rows[0][9] -cne $true -or $getterText -match 'secret|::error::' -or
            $getterText.Length -gt 1800 -or [Text.Encoding]::UTF8.GetByteCount($getterText) -gt 1800) {
            throw "phase-completed-getter-control: $($getterCase.name)"
        }
        if ($null -eq $getterCase.expected) {
            if ($null -ne $actual) { throw "phase-completed-getter-control: $($getterCase.name)" }
        } elseif ($actual -isnot [bool] -or $actual -cne $getterCase.expected) {
            throw "phase-completed-getter-control: $($getterCase.name)"
        }
        $completedGetterCases++
    }
    "completion getter projection: $completedGetterCases synthetic controls PASS"
    # Last-issued snapshot не заменяет receipt; zero допускается reader, но producer отдаёт null.
    $completedNotificationCases = 0
    foreach ($notificationCase in @(
        @{ name = 'none'; notification = $null; failed = $false; expectedNotification = $null; expectedFailure = $false },
        @{ name = 'positive'; notification = 7; failed = $false; expectedNotification = 7; expectedFailure = $false },
        @{ name = 'upper'; notification = 9007199254740991L; failed = $true; expectedNotification = 9007199254740991L; expectedFailure = $true },
        @{ name = 'zero-consumer'; notification = 0; failed = $false; expectedNotification = 0; expectedFailure = $false },
        @{ name = 'out-of-range'; notification = 9007199254740992L; failed = $true; expectedNotification = $null; expectedFailure = $true },
        @{ name = 'negative'; notification = -1; failed = $false; expectedNotification = $null; expectedFailure = $false },
        @{ name = 'malformed'; notification = '::error::secret'; failed = 'true'; expectedNotification = $null; expectedFailure = $null },
        @{ name = 'missing'; expectedNotification = $null; expectedFailure = $null }
    )) {
        $completedData = @{ operation = 17; nativeOperation = 14; reason = 'settled'; end = 'Finished'; isCurrent = $true }
        if ($notificationCase.ContainsKey('notification')) { $completedData.notification = $notificationCase.notification }
        if ($notificationCase.ContainsKey('failed')) { $completedData.diagnosticFailed = $notificationCase.failed }
        $completedEvent = [pscustomobject]@{ sequence = 10; kind = 'completed'; data = [pscustomobject]$completedData }
        $notificationText = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($completedEvent)
        $notificationSummary = $notificationText | ConvertFrom-Json
        $actualNotification = $notificationSummary.rows[0][10]
        $actualFailure = $notificationSummary.rows[0][12]
        if ($notificationSummary.schema -ne 2 -or $notificationSummary.count -ne 1 -or $notificationSummary.rows.Count -ne 1 -or
            $notificationSummary.rows[0].Count -ne 14 -or $notificationSummary.omitted -ne 0 -or $notificationSummary.invalid -ne 0 -or
            $notificationSummary.rows[0][0] -ne 10 -or $notificationSummary.rows[0][1] -cne 'completed' -or
            $notificationSummary.rows[0][2] -ne 17 -or $notificationSummary.rows[0][3] -ne 14 -or
            $notificationSummary.rows[0][7] -cne 'settled' -or $notificationSummary.rows[0][8] -cne 'Finished' -or
            $notificationSummary.rows[0][9] -cne $true -or $null -ne $notificationSummary.rows[0][11] -or
            $notificationText -match 'secret|::error::' -or $notificationText.Length -gt 1800 -or
            [Text.Encoding]::UTF8.GetByteCount($notificationText) -gt 1800) {
            throw "phase-completed-notification-control: $($notificationCase.name)"
        }
        if ($null -eq $notificationCase.expectedNotification) {
            if ($null -ne $actualNotification) { throw "phase-completed-notification-control: $($notificationCase.name)" }
        } elseif (($actualNotification -isnot [int] -and $actualNotification -isnot [long]) -or
            $actualNotification -ne $notificationCase.expectedNotification) {
            throw "phase-completed-notification-control: $($notificationCase.name)"
        }
        if ($null -eq $notificationCase.expectedFailure) {
            if ($null -ne $actualFailure) { throw "phase-completed-notification-control: $($notificationCase.name)" }
        } elseif ($actualFailure -isnot [bool] -or $actualFailure -cne $notificationCase.expectedFailure) {
            throw "phase-completed-notification-control: $($notificationCase.name)"
        }
        $completedNotificationCases++
    }
    "completion notification projection: $completedNotificationCases synthetic controls PASS"
    # Исходный AST Get-InputPhaseSummary, не копия producer: поле14 только closed tuple.
    $subscriptionCases = @(
        @{ name = 'no-entry'; snapshot = @{ Registration = 7; RawEntries = 0; AdmittedEntries = 0; LastEntry = 'None'; LastEntryQpc = $null; QpcFrequency = 10000000; Attached = $true; Active = $true; Faulted = $false }; current = $true; expected = '[7,0,0,"None",null,10000000,true,true,false,true]' },
        @{ name = 'admitted'; snapshot = @{ Registration = 7; RawEntries = 2; AdmittedEntries = 2; LastEntry = 'Admitted'; LastEntryQpc = 200; QpcFrequency = 10000000; Attached = $true; Active = $true; Faulted = $false }; current = $true; expected = '[7,2,2,"Admitted",200,10000000,true,true,false,true]' },
        @{ name = 'rejected-retired'; snapshot = @{ Registration = 7; RawEntries = 3; AdmittedEntries = 2; LastEntry = 'Rejected'; LastEntryQpc = 250; QpcFrequency = 10000000; Attached = $true; Active = $false; Faulted = $true }; current = $true; expected = '[7,3,2,"Rejected",250,10000000,true,false,true,true]' },
        @{ name = 'old-subscription'; snapshot = @{ Registration = 7; RawEntries = 3; AdmittedEntries = 2; LastEntry = 'Rejected'; LastEntryQpc = 250; QpcFrequency = 10000000; Attached = $false; Active = $false; Faulted = $false }; current = $false; expected = '[7,3,2,"Rejected",250,10000000,false,false,false,false]' },
        @{ name = 'malformed'; snapshot = @{ Registration = '::error::secret'; RawEntries = -1; AdmittedEntries = 9007199254740992L; LastEntry = 'private-outcome'; LastEntryQpc = 0; QpcFrequency = 'private-frequency'; Attached = 1; Active = 'true'; Faulted = 'false' }; current = 'private-current'; expected = '[null,null,null,null,null,null,null,null,null,null]' },
        @{ name = 'missing-fields'; snapshot = @{}; current = $null; expected = '[null,null,null,null,null,null,null,null,null,null]' },
        @{ name = 'missing-snapshot'; snapshot = $null; current = $true; expected = 'null' }
    )
    foreach ($control in $subscriptionCases) {
        $data = [pscustomobject]@{ operation = 17; nativeOperation = 14; reason = 'settled'; end = 'Finished'; isCurrent = $true;
            systemAnimation = $false; notification = 2; queued = $null; diagnosticFailed = $false;
            subscriptionDiagnostics = if ($null -ne $control.snapshot) { [pscustomobject]$control.snapshot } else { $null };
            subscriptionIsCurrent = $control.current }
        $event = [pscustomobject]@{ sequence = 10; kind = 'completed'; data = $data }
        $text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($event)
        $summary = $text | ConvertFrom-Json
        $first13 = ConvertTo-Json -InputObject @($summary.rows[0][0..12]) -Compress
        $tuple = ConvertTo-Json -InputObject $summary.rows[0][13] -Compress
        if ($summary.rows[0].Count -ne 14 -or $first13 -cne '[10,"completed",17,14,null,null,false,"settled","Finished",true,2,null,false]' -or
            $tuple -cne $control.expected -or $summary.count -ne 1 -or $summary.omitted -ne 0 -or
            $text.Length -gt 1800 -or $text -match 'secret|private|::error::') { throw "phase-subscription-control: $($control.name)" }
    }
    $manySubscriptions = @(1..100 | ForEach-Object {
        [pscustomobject]@{ sequence = $_; kind = 'completed'; data = [pscustomobject]@{
            operation = $_; subscriptionIsCurrent = $true; subscriptionDiagnostics = [pscustomobject]@{
                Registration = 9007199254740991L; RawEntries = 9007199254740991L; AdmittedEntries = 9007199254740991L;
                LastEntry = 'Admitted'; LastEntryQpc = 9007199254740991L; QpcFrequency = 10000000;
                Attached = $true; Active = $true; Faulted = $false } } }
    })
    $text = Get-InputPhaseSummary -Name 'system-disable-animation' -After 0 -Events $manySubscriptions
    $summary = $text | ConvertFrom-Json
    if ($text.Length -gt 1800 -or $summary.count -ne 100 -or $summary.rows.Count -gt 12 -or
        $summary.omitted -ne (100 - $summary.rows.Count) -or $summary.rows[0][0] -ne 1 -or $summary.rows[-1][0] -ne 100 -or
        $summary.rows[-1][13][0] -ne 9007199254740991L) { throw 'phase-subscription-bounded-control' }
    "subscription snapshot projection: $($subscriptionCases.Count) synthetic controls PASS; bounded PASS"
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
    # Истинные helper-функции из AST; timestamps здесь синтетические, не Windows receipt.
    $setterControl = [pscustomobject]@{ SetEnteredQpc = 100L; SetReturnedQpc = 110L; SetSucceeded = $true;
        ReadbackQpc = 120L; ReadbackEnabled = $false; QpcFrequency = 10000000L }
    $timingEvents = @(
        [pscustomobject]@{ sequence = 10; kind = 'systemNotification'; data = [pscustomobject]@{
            notification = 7; phase = 'Received'; clientAreaAnimation = $true; qpc = 105L; qpcFrequency = 10000000L } },
        [pscustomobject]@{ sequence = 11; kind = 'systemNotification'; data = [pscustomobject]@{
            notification = 7; phase = 'Queued'; queued = $true; qpc = 106L; qpcFrequency = 10000000L } },
        [pscustomobject]@{ sequence = 12; kind = 'systemNotification'; data = [pscustomobject]@{
            notification = 7; phase = 'Delegate'; qpc = 130L; qpcFrequency = 10000000L } },
        [pscustomobject]@{ sequence = 13; kind = 'systemApply'; data = [pscustomobject]@{
            notification = 7; outcome = 'Deduplicated'; enabled = $true; observed = $true; qpc = 131L; qpcFrequency = 10000000L } },
        [pscustomobject]@{ sequence = 14; kind = 'completed'; data = [pscustomobject]@{
            operation = 17; systemAnimation = $false; qpc = 140L; qpcFrequency = 10000000L } }
    )
    $timingText = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events $timingEvents -Setter $setterControl
    $timingSummary = $timingText | ConvertFrom-Json
    if (($timingSummary.setter -join ',') -cne '100,110,True,120,False,10000000' -or
        $timingSummary.timingCount -ne 5 -or $timingSummary.timingOmitted -ne 0 -or
        $timingSummary.timing[0][5] -isnot [bool] -or !$timingSummary.timing[0][5] -or
        $timingSummary.timing[3][1] -cne 'systemApply' -or $timingSummary.timing[3][6] -cne 'Deduplicated' -or
        $timingSummary.timing[3][7] -isnot [bool] -or !$timingSummary.timing[3][7] -or
        $timingSummary.rows[-1][6] -isnot [bool] -or $timingSummary.rows[-1][6]) { throw 'phase-qpc-healthy-control' }
    foreach ($outcome in @('Missing', 'Stale', 'Detached', 'Deduplicated', 'Update')) {
        $timingEvents[3].data.outcome = $outcome
        $timingSummary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($timingEvents[3]) | ConvertFrom-Json
        if ($timingSummary.timing[0][6] -cne $outcome -or @($timingSummary.setter | Where-Object { $null -ne $_ }).Count) {
            throw 'phase-qpc-outcome-or-unavailable-control'
        }
    }
    $timingEvents[0].data.clientAreaAnimation = $false
    $timingEvents[0].data.qpc = $null
    $timingEvents[0].data.qpcFrequency = 1000L
    $timingSummary = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($timingEvents[0]) -Setter $setterControl | ConvertFrom-Json
    if ($timingSummary.timing[0][5] -isnot [bool] -or $timingSummary.timing[0][5] -or
        $null -ne $timingSummary.timing[0][2] -or $timingSummary.timing[0][3] -ne 1000 -or
        $timingSummary.setter[5] -ne 10000000) { throw 'phase-qpc-unrelated-unavailable-frequency-control' }
    $badTiming = [pscustomobject]@{ sequence = 10; kind = 'systemApply'; data = [pscustomobject]@{
        qpc = 9007199254740992L; qpcFrequency = 0; notification = 'secret'; outcome = 'secret'; enabled = 'false'; observed = 1;
        arbitrary = '::error::secret' } }
    $badSetter = [pscustomobject]@{ SetEnteredQpc = -1; SetReturnedQpc = 'secret'; SetSucceeded = 'true';
        ReadbackQpc = 9007199254740992L; ReadbackEnabled = 'false'; QpcFrequency = 0 }
    $timingText = Get-InputPhaseSummary -Name 'system-disable-animation' -After 9 -Events @($badTiming) -Setter $badSetter
    $timingSummary = $timingText | ConvertFrom-Json
    if ($timingText -match 'secret|arbitrary|::error::' -or @($timingSummary.setter | Where-Object { $null -ne $_ }).Count -or
        @($timingSummary.timing[0][2..8] | Where-Object { $null -ne $_ }).Count) { throw 'phase-qpc-malformed-control' }
    $manyTiming = @(1..100 | ForEach-Object {
        [pscustomobject]@{ sequence = $_; kind = 'completed'; data = [pscustomobject]@{
            operation = 9007199254740991L; qpc = 9007199254740991L; qpcFrequency = 10000000L } }
    })
    $timingText = Get-InputPhaseSummary -Name 'system-disable-animation' -After 0 -Events $manyTiming -Setter $setterControl
    $timingSummary = $timingText | ConvertFrom-Json
    if ([Text.Encoding]::UTF8.GetByteCount($timingText) -gt 1800 -or $timingSummary.count -ne 100 -or
        $timingSummary.timingCount -ne 100 -or $timingSummary.omitted -ne (100 - $timingSummary.rows.Count) -or
        $timingSummary.timingOmitted -ne (100 - $timingSummary.timing.Count) -or
        $timingSummary.rows[0][0] -ne 1 -or $timingSummary.rows[-1][0] -ne 100 -or
        $timingSummary.timing[0][0] -ne 1 -or $timingSummary.timing[-1][0] -ne 100) { throw 'phase-qpc-bounded-control' }
    $phaseCases += 9
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
    # Failure-only Wait-Rest branch из настоящего AST, без polling/часов/нового Read-Trace.
    $waitAst = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Wait-Rest' })[0]
    $terminalAst = @($waitAst.Body.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
    if ($terminalAst.Count -ne 1) { throw 'rest-terminal-AST-control' }
    $restFailure = [scriptblock]::Create($terminalAst[0].Extent.Text)
    $initialRestEvents = @(
        [pscustomobject]@{ sequence = 1L; kind = 'intent'; data = [pscustomobject]@{ operation = 1L; trigger = 'attach'; pressed = $false; localAnimation = $true; systemAnimation = $true } },
        [pscustomobject]@{ sequence = 2L; kind = 'completed'; data = [pscustomobject]@{ operation = 1L; reason = 'settled'; end = 'Finished' } })
    $rest = Get-RestSummary -After 0 -Events $initialRestEvents | ConvertFrom-Json
    if ($rest.after -ne 0 -or $rest.intent[0] -ne 1 -or $rest.intent[5] -cne 'attach' -or
        $rest.completion[0] -ne 2 -or $rest.completion[2] -cne 'settled') { throw 'rest-initial-attach-control' }
    $laterRestEvents = @($initialRestEvents) + @([pscustomobject]@{ sequence = 3L; kind = 'intent'; data = $null })
    $rest = Get-RestSummary -After 2 -Events $laterRestEvents | ConvertFrom-Json
    if ($rest.intent[0] -ne 3 -or $rest.intent[1] -ne $null -or $rest.completion -ne $null -or $rest.invalid -ne 1) {
        throw 'rest-snapshot-null-control'
    }
    $malformedRest = @([pscustomobject]@{ sequence = 'private'; kind = 'intent'; data = 'private' },
        [pscustomobject]@{ sequence = 4L; kind = 'intent'; data = [pscustomobject]@{
            operation = 'private'; pressed = 'false'; localAnimation = 0; systemAnimation = 'true'; trigger = '::error::private' } },
        [pscustomobject]@{ sequence = 5L; kind = 'completed'; data = [pscustomobject]@{ operation = 'private'; reason = 'private'; end = 'private' } })
    $restText = Get-RestSummary -After 9007199254740991 -Events $malformedRest
    if ($restText -match 'private|::error::' -or $restText.Length -gt 1800 -or
        ($restText | ConvertFrom-Json).completion -ne $null) { throw 'rest-closed-bounded-control' }
    $events = $initialRestEvents
    $After = 0L
    $baselineRestFailure = $null
    try { throw 'Кнопка не вернулась в отпущенное состояние за 8 секунд.' } catch { $baselineRestFailure = $_ }
    $observed = $null
    try { & $restFailure } catch { $observed = $_ }
    if ($null -eq $observed -or $observed.Exception.Message -cne $baselineRestFailure.Exception.Message -or
        $observed.FullyQualifiedErrorId -cne $baselineRestFailure.FullyQualifiedErrorId -or
        !$observed.ErrorDetails.Message.Contains('wait-rest:') -or !$observed.ErrorDetails.Message.Contains('attach')) {
        throw 'rest-healthy-rejection-control'
    }
    try {
        function Get-RestSummary { throw 'secondary-rest-diagnostic' }
        $observed = $null
        try { & $restFailure } catch { $observed = $_ }
        if ($null -eq $observed -or $observed.Exception.Message -cne $baselineRestFailure.Exception.Message -or
            $observed.FullyQualifiedErrorId -cne $baselineRestFailure.FullyQualifiedErrorId -or
            !$observed.ErrorDetails.Message.Contains('wait-rest: unavailable') -or $observed.Exception.Message -match 'secondary-rest') {
            throw 'rest-secondary-primary-control'
        }
    } finally { . $completionReaders }
    'wait-rest diagnostics: initial/null/malformed/primary-preserved actual AST controls PASS'
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
