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
$outer = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$cleanup = [scriptblock]::Create($outer.Finally.Extent.Text.Substring(1, $outer.Finally.Extent.Text.Length - 2))

# Catch/finally взяты из настоящего harness; тело ввода заменено одной системной ошибкой.
$lifetime = [scriptblock]::Create('try { if ($injectPrimary) { [ClientAreaAnimation]::FailNextWrite = $true; [ClientAreaAnimation]::Write($false) } } ' +
    $outer.CatchClauses[0].Extent.Text + ' finally ' + $outer.Finally.Extent.Text)
$originalOutput = $env:LAB_MOTION_PRESS_TRACE
$cases = 0
try {
    foreach ($before in @($false, $true)) {
    foreach ($injectPrimary in @($false, $true)) {
    foreach ($fault in @('none', 'has-exited', 'close-main', 'close-wait', 'kill', 'kill-wait', 'refresh', 'dispose',
        'commands', 'close', 'record', 'restore-evidence', 'restore-read', 'failure-evidence', 'forced-close')) {
        $script:fault = $fault
        [ClientAreaAnimation]::Current = !$before
        [ClientAreaAnimation]::FailRead = $fault -eq 'restore-read'
        [ClientAreaAnimation]::Writes = 0
        $animationBefore = $before
        $saved = @{ LAB_MOTION_PRESS_TRACE = 'previous-trace' }
        $env:LAB_MOTION_PRESS_TRACE = 'current-trace'
        $passed = !$injectPrimary -and $fault -eq 'forced-close'
        $primaryFailure = $null
        $evidence = [IO.Path]::GetTempPath()
        $commands = @(@{ name = 'example' })
        $script:disposed = $false
        $script:recorderDisposed = $false
        $script:warnings = [Collections.Generic.List[string]]::new()
        $process = [pscustomobject]@{ IsExited = $false; ExitCode = 0 }
        $process | Add-Member ScriptProperty HasExited {
            if ($script:fault -eq 'has-exited') { throw [InvalidOperationException]::new('cleanup-has-exited') }
            return $this.IsExited
        }
        $process | Add-Member ScriptMethod CloseMainWindow {
            if ($script:fault -eq 'close-main') { throw [InvalidOperationException]::new('cleanup-close-main') }
            return $true
        }
        $process | Add-Member ScriptMethod WaitForExit {
            param([int]$Timeout = 0)
            if ($Timeout -eq 5000) {
                if ($script:fault -eq 'close-wait') { throw [InvalidOperationException]::new('cleanup-close-wait') }
                if ($script:fault -in @('kill', 'kill-wait', 'forced-close')) { return $false }
            } elseif ($script:fault -eq 'kill-wait') { throw [InvalidOperationException]::new('cleanup-kill-wait') }
            $this.IsExited = $true
            return $true
        }
        $process | Add-Member ScriptMethod Kill {
            param([bool]$EntireProcessTree)
            if ($script:fault -eq 'kill') { throw [IO.IOException]::new('cleanup-kill') }
            $this.IsExited = $true
        }
        $process | Add-Member ScriptMethod Refresh {
            if ($script:fault -eq 'refresh') { throw [InvalidOperationException]::new('cleanup-refresh') }
        }
        $process | Add-Member ScriptMethod Dispose {
            $script:disposed = $true
            if ($script:fault -eq 'dispose') { throw [IO.IOException]::new('cleanup-dispose') }
        }
        $recording = $null
        if ($fault -eq 'record') {
            $recorder = [pscustomobject]@{ HasExited = $false }
            $recorder | Add-Member ScriptMethod Kill { throw [IO.IOException]::new('cleanup-recorder') }
            $recorder | Add-Member ScriptMethod Dispose { $script:recorderDisposed = $true }
            $recording = @{ ended = $false; process = $recorder }
        }
        function Set-Content {
            param([Parameter(Position = 0)][string]$Path, [Parameter(ValueFromPipeline = $true)]$InputObject)
            process {
                $name = [IO.Path]::GetFileName($Path)
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
        if ($fault -eq 'record' -and !$script:recorderDisposed) { throw 'Recorder disposal was skipped' }
        if ($injectPrimary) {
            if (!$observed -or $observed.Exception.Message -notmatch 'primary-system-preference') {
                throw "Primary system error lost: before=$before fault=$fault"
            }
            $expectedWarning = if ($fault -eq 'failure-evidence') { 'Не удалось записать первичную ошибку.' } elseif ($fault -notin @('none', 'forced-close')) { 'Очистка после ошибки не завершена.' } else { $null }
            if ($expectedWarning -and !$script:warnings.Contains($expectedWarning)) { throw "Cleanup fault not observable: $fault" }
        } else {
            $expectsFailure = $fault -notin @('none', 'failure-evidence')
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
} finally { $env:LAB_MOTION_PRESS_TRACE = $originalOutput }
"cleanup: $cases PASS"
