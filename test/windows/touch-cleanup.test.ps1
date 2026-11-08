param([string]$Harness = (Join-Path $PSScriptRoot 'verify-touch.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'process-tools.ps1')

# Исполняются настоящие функции и case finally; подменена только граница Process/streams/evidence.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'touch-cleanup-syntax-control' }
$configuration = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $_.Left.VariablePath.UserPath -ceq 'toolTimeoutMilliseconds'
})
if ($configuration.Count -ne 1) { throw 'touch-cleanup-config-control' }
. ([scriptblock]::Create($configuration[0].Extent.Text))
if ($toolTimeoutMilliseconds -isnot [int] -or $toolTimeoutMilliseconds -ne 30000) { throw 'touch-cleanup-budget-control' }
$caseOwners = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.TryStatementAst] -and $null -ne $node.Finally -and
    $node.Finally.Extent.Text.Contains('if ($null -ne $caseFailure)')
}, $true))
if ($caseOwners.Count -ne 1) { throw 'touch-cleanup-case-owner-control' }
$body = $caseOwners[0].Finally.Extent.Text
$caseCleanup = [scriptblock]::Create($body.Substring(1, $body.Length - 2))
$evidence = Join-Path ([IO.Path]::GetTempPath()) ('lab-motion-touch-cleanup-' + [guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($evidence)
$case = $evidence
$name = 'fixture'
$script:warnings = [Collections.Generic.List[string]]::new()
function Write-Warning {
    param([string]$Message, $WarningAction)
    if ($WarningAction -ne 'Continue') { throw 'touch-cleanup-warning-control' }
    $script:warnings.Add($Message)
}
function Set-Content {
    param([Parameter(Position = 0)][string]$Path, [Parameter(ValueFromPipeline = $true)]$InputObject)
    process { if ($script:fault -eq 'evidence') { throw [IO.IOException]::new('secondary-evidence') } }
}

function New-ControlProcess {
    $owned = [pscustomobject]@{ IsExited = $script:fault -eq 'already-exited'; Reads = 0; Refreshed = $false;
        Kills = 0; Waits = [Collections.Generic.List[int]]::new(); Disposes = 0 }
    $owned | Add-Member ScriptProperty HasExited {
        $this.Reads++
        if ($script:fault -eq 'has') { throw [IO.IOException]::new('primary-has') }
        if ($script:fault.StartsWith('has-null') -or $script:fault -eq 'has-invalid') {
            if ($script:fault -eq 'has-invalid') { return 'false' }
            return $null
        }
        if ($this.Refreshed -and $script:fault -eq 'has-late') { return $null }
        return $this.IsExited
    }
    $owned | Add-Member ScriptProperty ExitCode {
        if ($script:fault -eq 'exit-null') { return $null }
        if ($script:fault -eq 'exit') { throw [IO.IOException]::new('primary-exit') }
        return 0
    }
    $owned | Add-Member ScriptMethod CloseMainWindow {
        if ($script:fault.Contains('close')) { throw [IO.IOException]::new('primary-close') }
        return $true
    }
    $owned | Add-Member ScriptMethod WaitForExit {
        param([int]$Timeout = -1)
        if ($Timeout -lt 0 -or $Timeout -gt $script:budget) { throw 'touch-unbounded-wait-control' }
        $this.Waits.Add($Timeout)
        if ($this.Kills -eq 0) {
            if ($script:fault -eq 'wait-null') { return $null }
            if ($script:fault.StartsWith('wait')) { throw [IO.IOException]::new('primary-wait') }
            if ($script:fault -in @('timeout', 'kill', 'stop-wait', 'stop-null', 'stop-false')) { return $false }
        } else {
            if ($script:fault -eq 'stop-wait') { throw [IO.IOException]::new('secondary-stop-wait') }
            if ($script:fault -eq 'stop-null') { return $null }
            if ($script:fault -eq 'stop-false') { return $false }
        }
        $this.IsExited = $true
        return $true
    }
    $owned | Add-Member ScriptMethod Kill {
        param([bool]$EntireProcessTree)
        if (!$EntireProcessTree) { throw 'touch-wrong-child-control' }
        $this.Kills++
        if ($script:fault.Contains('kill')) { throw [IO.IOException]::new('secondary-kill') }
        $this.IsExited = $true
    }
    $owned | Add-Member ScriptMethod Refresh { $this.Refreshed = $true }
    $owned | Add-Member ScriptMethod Dispose {
        $this.Disposes++
        if ($script:fault.Contains('dispose')) { throw [IO.IOException]::new('secondary-dispose') }
    }
    return $owned
}

$cases = 0
try {
    foreach ($primary in @($false, $true)) {
        foreach ($fault in @('healthy', 'already-exited', 'timeout', 'wait', 'wait-null', 'has', 'has-null', 'has-invalid',
            'has-late', 'exit', 'exit-null', 'close', 'kill', 'stop-wait', 'stop-null', 'stop-false', 'dispose',
            'wait-kill', 'wait-kill-dispose', 'has-null-close-kill-dispose', 'evidence')) {
            $script:fault = $fault
            $script:budget = 5000
            $script:warnings.Clear()
            $process = New-ControlProcess
            $caseFailure = $null
            if ($primary) {
                try { throw [IO.IOException]::new('primary-touch') } catch { $caseFailure = $_ }
            }
            $original = $caseFailure
            $primaryFailure = $null
            $failures = [Collections.Generic.List[string]]::new()
            . $caseCleanup
            if ($process.Disposes -ne 1 -or $process.Kills -gt 1 -or $process.Waits.Count -gt 2) {
                throw "touch-cleanup-ownership-control: $fault"
            }
            if ($primary -and ![object]::ReferenceEquals($caseFailure, $original)) { throw 'touch-cleanup-primary-control' }
            if (!$primary -and ($null -ne $caseFailure) -ne ($fault -notin @('healthy', 'already-exited'))) {
                throw "touch-cleanup-outcome-control: $fault"
            }
            if ($fault -in @('wait', 'wait-null', 'close', 'kill', 'wait-kill', 'wait-kill-dispose', 'has-null-close-kill-dispose')) {
                if ($process.Kills -ne 1 -or $process.Waits.Count -eq 0) { throw 'touch-cleanup-independent-stop-control' }
            }
            foreach ($secondary in @('kill', 'dispose')) {
                if ($fault.Contains($secondary) -and ($primary -or $fault.Contains('wait') -or $fault.Contains('has-null'))) {
                    if (!@($script:warnings | Where-Object { $_ -match "secondary-$secondary" }).Count) {
                        throw "touch-cleanup-secondary-control: $fault $secondary"
                    }
                }
            }
            $cases++
        }
    }
    foreach ($fault in @('healthy', 'timeout', 'wait', 'wait-kill', 'wait-kill-dispose', 'dispose', 'exit-null', 'has-null')) {
        $script:fault = $fault
        $script:budget = $toolTimeoutMilliseconds
        $script:warnings.Clear()
        $owned = New-ControlProcess
        $stream = [pscustomobject]@{}
        $stream | Add-Member ScriptMethod WaitAsync {
            param([TimeSpan]$Timeout)
            if ($Timeout.TotalMilliseconds -lt 0 -or $Timeout.TotalMilliseconds -gt $script:budget) { throw 'touch-unbounded-stream-control' }
            return $this
        }
        $stream | Add-Member ScriptMethod GetAwaiter { return $this }
        $stream | Add-Member ScriptMethod GetResult { return '{"passed":true}' }
        $tool = @{ process = $owned; stdout = $stream; stderr = $stream; prefix = ''; ended = $false; name = 'fixture'; arguments = @() }
        $commands = [Collections.Generic.List[object]]::new()
        $observed = $null
        try { $null = Finish-Tool $tool } catch { $observed = $_ }
        if ($owned.Disposes -ne 1 -or !$tool.ended -or $owned.Kills -gt 1) { throw 'touch-tool-ownership-control' }
        if (($null -eq $observed) -ne ($fault -eq 'healthy')) { throw "touch-tool-outcome-control: $fault" }
        if ($fault.StartsWith('wait') -and !$observed.Exception.Message.Contains('primary-wait')) { throw 'touch-tool-primary-control' }
        if ($fault.Contains('kill') -and !@($script:warnings | Where-Object { $_ -match 'secondary-kill' }).Count) {
            throw 'touch-tool-secondary-control'
        }
        $cases++
    }
    # Настоящие Task<string>: exited child не означает готовность redirected stream.
    foreach ($taskFault in @('healthy', 'stdout-pending', 'stderr-pending', 'stdout-pending-dispose',
        'stderr-pending-dispose', 'stdout-fault-stderr-pending', 'exhausted')) {
        $script:fault = if ($taskFault.EndsWith('dispose')) { 'dispose' } else { 'healthy' }
        $script:budget = 25
        $script:warnings.Clear()
        $owned = New-ControlProcess
        $stdoutSource = [Threading.Tasks.TaskCompletionSource[string]]::new()
        $stderrSource = [Threading.Tasks.TaskCompletionSource[string]]::new()
        if ($taskFault -eq 'stdout-fault-stderr-pending') {
            $stdoutSource.SetException([IO.IOException]::new('primary-stream-task'))
        } elseif (!$taskFault.StartsWith('stdout-pending') -and $taskFault -ne 'exhausted') {
            $stdoutSource.SetResult('{"passed":true}')
        }
        if (!$taskFault.StartsWith('stderr-pending') -and $taskFault -ne 'stdout-fault-stderr-pending') {
            $stderrSource.SetResult('')
        }
        $tool = @{ process = $owned; stdout = $stdoutSource.Task; stderr = $stderrSource.Task; prefix = '';
            ended = $false; name = 'task-fixture'; arguments = @() }
        $commands = [Collections.Generic.List[object]]::new()
        $observed = $null
        $taskBudget = if ($taskFault -eq 'exhausted') { 0 } else { $script:budget }
        $taskClock = [Diagnostics.Stopwatch]::StartNew()
        try {
            try { $result = Finish-Tool $tool -Timeout $taskBudget } catch { $observed = $_ }
            if ($taskClock.ElapsedMilliseconds -gt 5000 -or $owned.Disposes -ne 1 -or !$tool.ended -or $owned.Kills -ne 0) {
                throw 'touch-task-deadline-disposal-control'
            }
            if ($taskFault -eq 'healthy') {
                if ($observed -or !$result.passed -or $commands.Count -ne 1) { throw 'touch-task-healthy-control' }
            } else {
                if ($null -eq $observed) { throw 'touch-task-missing-failure-control' }
                $exception = $observed.Exception
                if ($taskFault -eq 'stdout-fault-stderr-pending') {
                    if (!$exception.ToString().Contains('primary-stream-task')) { throw 'touch-task-primary-control' }
                } else {
                    while ($exception -isnot [TimeoutException] -and $null -ne $exception.InnerException) { $exception = $exception.InnerException }
                    if ($exception -isnot [TimeoutException]) { throw 'touch-task-timeout-control' }
                }
                if ($taskFault.EndsWith('dispose') -and
                    !@($script:warnings | Where-Object { $_ -match 'secondary-dispose' }).Count) { throw 'touch-task-secondary-control' }
            }
        } finally {
            $null = $stdoutSource.TrySetCanceled()
            $null = $stderrSource.TrySetCanceled()
        }
        $cases++
    }
    $outer = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
    # Настоящий terminal + catch: первая case error видна caller даже при двух отказах записи.
    $terminal = [scriptblock]::Create(($outer.Body.Statements | Select-Object -Last 2 | ForEach-Object { $_.Extent.Text }) -join "`n")
    $catchBody = $outer.CatchClauses[0].Body.Extent.Text
    $terminalCatch = [scriptblock]::Create($catchBody.Substring(1, $catchBody.Length - 2))
    function node {
        param($Oracle, $OutputDirectory)
        $script:LASTEXITCODE = $script:oracleExit
    }
    foreach ($terminalFault in @('case-log-fail', 'case-log-oracle-fail', 'oracle-fail', 'healthy')) {
        $script:fault = 'evidence'
        $script:oracleExit = [int]($terminalFault -in @('case-log-oracle-fail', 'oracle-fail'))
        $script:warnings.Clear()
        $primaryFailure = $null
        $firstError = $null
        $failures = [Collections.Generic.List[string]]::new()
        $directions = 0
        foreach ($direction in @(1, -1)) {
            $name = "direction-$direction"
            $caseFailure = $null
            if ($terminalFault.StartsWith('case-log')) {
                try { throw [IO.IOException]::new("primary-direction-$direction") } catch { $caseFailure = $_ }
                if ($null -eq $firstError) { $firstError = $caseFailure }
                # То же первое diagnostic write, что в настоящем case catch.
                try { $caseFailure | Out-String | Set-Content (Join-Path $case 'failure.txt') }
                catch { Save-CleanupFailure $_ ([ref]$caseFailure) }
            }
            $process = $null
            . $caseCleanup
            $directions++
        }
        $observed = $null
        $output = $evidence
        try {
            try { . $terminal } catch { . $terminalCatch }
        } catch { $observed = $_ }
        if ($directions -ne 2) { throw 'touch-terminal-both-directions-control' }
        if ($null -ne $firstError) {
            if ($null -eq $observed -or ![object]::ReferenceEquals($observed.Exception, $firstError.Exception) -or
                !$observed.Exception.Message.Contains('primary-direction-1') -or
                !$script:warnings.Contains('Не удалось записать первичную ошибку touch.') -or
                !@($script:warnings | Where-Object { $_ -match 'Touch-квалификация не прошла' }).Count) {
                throw 'touch-terminal-primary-fallback-control'
            }
        } elseif (($null -eq $observed) -ne ($terminalFault -eq 'healthy')) { throw 'touch-terminal-oracle-control' }
        $cases++
    }
    $restoreBody = $outer.Finally.Extent.Text
    $restore = [scriptblock]::Create($restoreBody.Substring(1, $restoreBody.Length - 2))
    $oldControlEnvironment = [Environment]::GetEnvironmentVariable('LAB_MOTION_TOUCH_CLEANUP_CONTROL')
    try {
        foreach ($primary in @($false, $true)) {
            $saved = @{ 'LAB_MOTION_TOUCH_CLEANUP_CONTROL' = 'restored'; 'LAB_MOTION_INVALID=NAME' = 'invalid' }
            $primaryFailure = $null
            if ($primary) { try { throw 'primary-touch-restore' } catch { $primaryFailure = $_ } }
            $script:warnings.Clear()
            $observed = $null
            try { & $restore } catch { $observed = $_ }
            if ([Environment]::GetEnvironmentVariable('LAB_MOTION_TOUCH_CLEANUP_CONTROL') -ne 'restored' -or
                ($primary -and ($null -ne $observed -or !$script:warnings.Contains('Восстановление окружения после ошибки touch не завершено.'))) -or
                (!$primary -and $null -eq $observed)) { throw 'touch-environment-arbitration-control' }
            $cases++
        }
    } finally { [Environment]::SetEnvironmentVariable('LAB_MOTION_TOUCH_CLEANUP_CONTROL', $oldControlEnvironment) }
    "touch cleanup: $cases synthetic function controls PASS (not native execution)"
} finally {
    if ([IO.Directory]::Exists($evidence)) { [IO.Directory]::Delete($evidence, $true) }
}
