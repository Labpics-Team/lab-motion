param([string]$Harness = (Join-Path $PSScriptRoot 'verify.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid process harness syntax' }
$owner = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$lifetime = [scriptblock]::Create($owner.Extent.Text)
$bootBranch = $owner.Find({
    param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
        $node.Clauses[0].Item1.Extent.Text -eq '!$finished -or $identity.exitCode -ne 0 -or !$identity.traceExists'
}, $true)
if (!$bootBranch) { throw 'Отсутствует исходная ветка отказа нативного процесса.' }
$bootFailure = [scriptblock]::Create(($bootBranch.Clauses[0].Item2.Statements | ForEach-Object { $_.Extent.Text }) -join "`n")

# Исполняется настоящий try/catch/finally; подменены только process/file boundaries.
$originalOutput = $env:LAB_MOTION_PROBE_OUTPUT
$cases = 0
try {
    # Настоящий .NET getter без запуска процесса квалифицирует null при его отказе.
    $unassociated = [Diagnostics.Process]::new()
    try {
        $unassociatedHandle = $unassociated.Handle
        if ($null -ne $unassociatedHandle) { throw 'Неожиданная семантика getter несвязанного Process.' }
    } finally { $unassociated.Dispose() }
    foreach ($fault in @('none', 'start', 'handle', 'start-time', 'hash', 'wait', 'refresh', 'evidence', 'own-timeout', 'foreign-pid', 'hash-kill', 'hash-dispose', 'dispose',
        'handle-null', 'handle-zero', 'start-time-null', 'start-time-invalid')) {
        $script:fault = $fault
        $script:killed = $false
        $script:disposed = $false
        $script:pidStopped = $false
        $script:warned = $false
        $script:bootMessages = @()
        $script:waitReached = $false
        $script:getterReached = $false
        $exe = 'owned.exe'
        $appOutput = 'app'
        $output = 'output'
        $tracePath = 'trace.json'
        $previousOutput = 'previous-output'
        $env:LAB_MOTION_PROBE_OUTPUT = 'current-output'
        $process = $null
        $primaryFailure = $null
        $script:owned = [pscustomobject]@{ Id = 4242; Handle = 42; StartTime = [DateTime]::UtcNow; HasExited = $false; ExitCode = 0 }
        if ($fault -in @('handle', 'start-time')) {
            $property = if ($fault -eq 'handle') { 'Handle' } else { 'StartTime' }
            $script:owned.PSObject.Properties.Remove($property)
            $script:owned | Add-Member ScriptProperty $property {
                $script:getterReached = $true
                throw [InvalidOperationException]::new('primary-identity')
            }
        }
        if ($fault -eq 'handle-null') { $script:owned.Handle = $null }
        if ($fault -eq 'handle-zero') { $script:owned.Handle = [IntPtr]::Zero }
        if ($fault -eq 'start-time-null') { $script:owned.StartTime = $null }
        if ($fault -eq 'start-time-invalid') { $script:owned.StartTime = 'not-a-date' }
        $script:owned | Add-Member ScriptMethod WaitForExit {
            param([int]$Timeout = 0)
            if ($Timeout -eq 60000) {
                $script:waitReached = $true
                if ($script:fault -eq 'wait') { throw [InvalidOperationException]::new('primary-wait') }
                if ($script:fault -in @('own-timeout', 'foreign-pid')) { return $false }
                $this.HasExited = $true
                return $true
            }
            $this.HasExited = $true
        }
        $script:owned | Add-Member ScriptMethod Refresh {
            if ($script:fault -eq 'refresh') { throw [InvalidOperationException]::new('primary-refresh') }
        }
        $script:owned | Add-Member ScriptMethod Kill {
            $script:killed = $true
            if ($script:fault -eq 'hash-kill') { throw [IO.IOException]::new('cleanup-kill') }
            $this.HasExited = $true
        }
        $script:owned | Add-Member ScriptMethod Dispose {
            $script:disposed = $true
            if ($script:fault -in @('hash-dispose', 'dispose')) { throw [IO.IOException]::new('cleanup-dispose') }
        }
        function Start-Process {
            param($FilePath, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
            if ($script:fault -eq 'start') { throw [InvalidOperationException]::new('primary-start') }
            return $script:owned
        }
        function Get-FileHash {
            param($LiteralPath, $Algorithm)
            if ($script:fault -in @('hash', 'hash-kill', 'hash-dispose')) { throw [InvalidOperationException]::new('primary-hash') }
            return @{ Hash = 'fixture' }
        }
        function Get-Process {
            param($Id, $ErrorAction)
            if ($script:fault -eq 'own-timeout') {
                return [pscustomobject]@{ Id = $Id; Path = 'owned.exe'; StartTime = $script:owned.StartTime }
            }
            return [pscustomobject]@{ Id = $Id; Path = 'foreign.exe'; StartTime = [DateTime]::MinValue }
        }
        function Stop-Process { param($Id, [switch]$Force); $script:pidStopped = $true; $script:owned.HasExited = $true }
        function Test-Path { param($LiteralPath); return $true }
        function Set-Content {
            param([Parameter(Position = 0)]$Path, $Encoding, [Parameter(ValueFromPipeline = $true)]$InputObject)
            process { if ($script:fault -eq 'evidence') { throw [IO.IOException]::new('primary-evidence') } }
        }
        function Write-Warning { param($Message, $WarningAction); $script:warned = $true }
        function Write-Host { param($Object); $script:bootMessages += [string]$Object }
        $observed = $null
        try { & $lifetime } catch { $observed = $_ }
        if ($env:LAB_MOTION_PROBE_OUTPUT -ne $previousOutput) { throw "Environment restore failed: $fault" }
        if ($script:disposed -ne ($fault -ne 'start')) { throw "Process disposal failed: $fault" }
        if ($script:pidStopped -ne ($fault -eq 'own-timeout')) { throw "PID ownership check failed: $fault" }
        $needsKill = $fault -in @('handle', 'start-time', 'hash', 'wait', 'foreign-pid', 'hash-kill', 'hash-dispose',
            'handle-null', 'handle-zero', 'start-time-null', 'start-time-invalid')
        if ($script:killed -ne $needsKill) { throw "Owned process cleanup failed: $fault" }
        $expectsWait = $fault -notin @('start', 'handle', 'start-time', 'hash', 'hash-kill', 'hash-dispose',
            'handle-null', 'handle-zero', 'start-time-null', 'start-time-invalid')
        if ($script:waitReached -ne $expectsWait) { throw "Identity refusal reached normal wait: $fault" }
        if ($fault -in @('handle', 'start-time') -and !$script:getterReached) { throw "Throwing getter not reached: $fault" }
        if ($fault -eq 'none') {
            if ($observed) { throw $observed }
        } elseif (!$observed) { throw "Expected failure missing: $fault" }
        $expectsBootMessage = $fault -in @('own-timeout', 'foreign-pid')
        if ($script:bootMessages.Count -ne [int]$expectsBootMessage) { throw "Диагностика вне boot-отказа: $fault" }
        if ($fault -in @('handle', 'handle-null', 'handle-zero')) {
            if ($observed.Exception.Message -notmatch 'Не получен действительный handle') { throw "Handle validation error missing: $fault" }
        }
        if ($fault -in @('start-time', 'start-time-null', 'start-time-invalid')) {
            if ($observed.Exception.Message -notmatch 'Не получено время запуска') { throw "Start-time validation error missing: $fault" }
        }
        if ($fault -in @('hash-kill', 'hash-dispose')) {
            if ($observed.Exception.Message -notmatch 'primary-hash' -or !$script:warned) { throw "Primary error lost: $fault" }
        }
        $cases++
    }

    # Настоящая AST-ветка получает только identity: здесь нет Process или файловых reads.
    $bootCases = @(
        @{ completed = $false; exitCode = $null; traceExists = $true; expected = '{"completed":false,"exitCode":null,"traceExists":true}' },
        @{ completed = $true; exitCode = -1; traceExists = $true; expected = '{"completed":true,"exitCode":-1,"traceExists":true}' },
        @{ completed = $true; exitCode = 0; traceExists = $false; expected = '{"completed":true,"exitCode":0,"traceExists":false}' },
        @{ completed = $true; exitCode = [int]::MinValue; traceExists = $false; expected = '{"completed":true,"exitCode":-2147483648,"traceExists":false}' },
        @{ completed = $true; exitCode = [int]::MaxValue; traceExists = $false; expected = '{"completed":true,"exitCode":2147483647,"traceExists":false}' },
        @{ completed = 'private-completed'; exitCode = 'private-exit'; traceExists = 'private-trace'; expected = '{"completed":null,"exitCode":null,"traceExists":null}' },
        @{ completed = 1; exitCode = [long]::MaxValue; traceExists = 0; expected = '{"completed":null,"exitCode":null,"traceExists":null}' },
        @{ completed = $null; exitCode = $null; traceExists = $null; expected = '{"completed":null,"exitCode":null,"traceExists":null}' }
    )
    foreach ($control in $bootCases) {
        $identity = [ordered]@{ completed = $control.completed; exitCode = $control.exitCode; traceExists = $control.traceExists; pid = 'private-pid'; path = 'private-path' }
        $script:bootMessages = @()
        $observed = $null
        try { & $bootFailure } catch { $observed = $_ }
        if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.') { throw 'Boot-диагностика заменила первичную ошибку.' }
        $expected = 'Нативный процесс: ' + $control.expected
        if ($script:bootMessages.Count -ne 1 -or $script:bootMessages[0] -cne $expected -or $script:bootMessages[0].Length -gt 128) { throw 'Boot-диагностика нарушила закрытый bounded контракт.' }
    }
    function Write-Host { param($Object); throw [IO.IOException]::new('private-diagnostic-error') }
    $observed = $null
    try { & $bootFailure } catch { $observed = $_ }
    if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.') { throw 'Отказ вывода замаскировал boot-ошибку.' }
} finally { $env:LAB_MOTION_PROBE_OUTPUT = $originalOutput }
"process cleanup: $cases PASS; getter primitive: PASS; boot projection: $($bootCases.Count) PASS; output failure: PASS"
