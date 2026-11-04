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
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Read-ProcessHasExited', 'Read-ProcessExitCode')
})
if ($readers.Count -ne 2) { throw 'Missing actual completion readers' }
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
        'has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait', 'record-has-null-kill')) {
        $script:fault = $fault
        [ClientAreaAnimation]::Current = !$before
        [ClientAreaAnimation]::FailRead = $fault -eq 'restore-read'
        [ClientAreaAnimation]::Writes = 0
        $animationBefore = $before
        $saved = @{ LAB_MOTION_PRESS_TRACE = 'previous-trace' }
        $env:LAB_MOTION_PRESS_TRACE = 'current-trace'
        $passed = !$injectPrimary -and $fault -in @('forced-close', 'record-healthy')
        $primaryFailure = $null
        $commands = @(@{ name = 'example' })
        $script:disposed = $false
        $script:recorderDisposed = $false
        $script:closeReached = $false
        $script:closeWaitReached = $false
        $script:killReached = $false
        $script:killWaitReached = $false
        $script:recorderKillReached = $false
        $script:recorderWaitReached = $false
        $script:exitCodeReached = $false
        $script:closeEvidence = $null
        $script:warnings = [Collections.Generic.List[string]]::new()
        $process = [pscustomobject]@{ IsExited = $false; Refreshed = $false }
        $process | Add-Member ScriptProperty HasExited {
            if ($script:fault -eq 'has-exited') { throw [InvalidOperationException]::new('cleanup-has-exited') }
            if ($script:fault -in @('has-null', 'has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait')) { return $null }
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
            if ($script:fault -in @('close-main', 'has-null-close-main')) { throw [InvalidOperationException]::new('cleanup-close-main') }
            return $true
        }
        $process | Add-Member ScriptMethod WaitForExit {
            param([int]$Timeout = 0)
            if ($Timeout -eq 5000) {
                $script:closeWaitReached = $true
                if ($script:fault -in @('close-wait', 'has-null-close-wait')) { throw [InvalidOperationException]::new('cleanup-close-wait') }
                if ($script:fault -in @('kill', 'kill-wait', 'forced-close', 'has-null-kill', 'has-null-kill-wait')) { return $false }
            } else {
                $script:killWaitReached = $true
                if ($script:fault -in @('kill-wait', 'has-null-kill-wait')) { throw [InvalidOperationException]::new('cleanup-kill-wait') }
            }
            $this.IsExited = $true
            return $true
        }
        $process | Add-Member ScriptMethod Kill {
            param([bool]$EntireProcessTree)
            $script:killReached = $true
            if ($script:fault -in @('kill', 'has-null-kill')) { throw [IO.IOException]::new('cleanup-kill') }
            $this.IsExited = $true
        }
        $process | Add-Member ScriptMethod Refresh {
            $this.Refreshed = $true
            if ($script:fault -eq 'refresh') { throw [InvalidOperationException]::new('cleanup-refresh') }
        }
        $process | Add-Member ScriptMethod Dispose {
            $script:disposed = $true
            if ($script:fault -eq 'dispose') { throw [IO.IOException]::new('cleanup-dispose') }
        }
        $recording = $null
        if ($fault -eq 'record' -or $fault.StartsWith('record-')) {
            $recorder = [pscustomobject]@{ IsExited = $false }
            $recorder | Add-Member ScriptProperty HasExited {
                if ($script:fault -eq 'record-has-exited') { throw [InvalidOperationException]::new('cleanup-record-has-exited') }
                if ($script:fault -in @('record-has-null', 'record-has-null-kill')) { return $null }
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
            $recorder | Add-Member ScriptMethod Dispose { $script:recorderDisposed = $true }
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
        if ($fault -in @('none', 'record-healthy')) {
            if ($null -eq $script:closeEvidence -or $script:closeEvidence.exited -isnot [bool] -or
                !$script:closeEvidence.exited -or $script:closeEvidence.exitCode -ne 0) { throw 'Healthy completion evidence lost' }
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
                    $script:killReached -ne ($fault -in @('has-null-kill', 'has-null-kill-wait')) -or
                    $script:killWaitReached -ne ($fault -eq 'has-null-kill-wait')) { throw 'Double fault invocation path changed' }
            }
        }
        if ($injectPrimary) {
            if (!$observed -or $observed.Exception.Message -notmatch 'primary-system-preference') {
                throw "Primary system error lost: before=$before fault=$fault"
            }
            $expectedWarning = if ($fault -eq 'failure-evidence') { 'Не удалось записать первичную ошибку.' } elseif ($fault -notin @('none', 'forced-close', 'record-healthy')) { 'Очистка после ошибки не завершена.' } else { $null }
            if ($expectedWarning -and !$script:warnings.Contains($expectedWarning)) { throw "Cleanup fault not observable: $fault" }
        } else {
            $expectsFailure = $fault -notin @('none', 'failure-evidence', 'record-healthy')
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
    $primaryFailure = $null
    $passed = $false
    $recording = $null
    & $cleanup
    if (![ClientAreaAnimation]::Current -or [ClientAreaAnimation]::Writes -ne 0) { throw 'Cleanup changed an unowned preference' }
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
