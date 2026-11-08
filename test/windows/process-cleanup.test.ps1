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
$traceFunction = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BootTraceSummary'
}, $true)
if (!$traceFunction) { throw 'Отсутствует исходная закрытая проекция MainPage trace.' }
. ([scriptblock]::Create($traceFunction.Extent.Text))

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
        $script:traceReads = 0
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
        function Get-Content { param($LiteralPath, [switch]$Raw); $script:traceReads++; return '{}' }
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
        if ($script:bootMessages.Count -ne (2 * [int]$expectsBootMessage)) { throw "Диагностика вне boot-отказа: $fault" }
        if ($script:traceReads -ne [int]$expectsBootMessage) { throw "Saved trace прочитан вне boot-отказа: $fault" }
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

    # Настоящая AST-ветка получает identity и подменённую границу сохранённого файла, не Process.
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
        $script:traceReads = 0
        $observed = $null
        try { & $bootFailure } catch { $observed = $_ }
        if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.') { throw 'Boot-диагностика заменила первичную ошибку.' }
        $expected = 'Нативный процесс: ' + $control.expected
        $expectedCount = if ($control.traceExists -is [bool] -and $control.traceExists) { 2 } else { 1 }
        if ($script:bootMessages.Count -ne $expectedCount -or $script:bootMessages[0] -cne $expected -or $script:bootMessages[0].Length -gt 128) { throw 'Boot-диагностика нарушила закрытый bounded контракт.' }
        if ($expectedCount -eq 2 -and $script:bootMessages[1] -cne 'Нативный trace: {"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}') { throw 'Пустой trace выдал выдуманное значение.' }
        if ($script:traceReads -ne ($expectedCount - 1)) { throw 'traceExists refusal всё равно прочитал файл.' }
    }

    # Исполняется AST исходной функции с настоящим JSON decoder; file boundary подменена.
    $traceCases = @(
        @{ name = 'captured'; json = '{"status":"captured","error":null,"runs":[{"kind":"lifetime"}]}'; expected = '{"status":"captured","knownFailureCode":null,"lastRunKind":"lifetime","errorType":null,"activeProbe":null}' },
        @{ name = 'require'; json = '{"status":"error","error":"System.InvalidOperationException: Idle потерял identity или завершил новую операцию observer.\r\nprivate-stack","runs":[{"kind":"idle-reentrant-retarget","trace":["private-run"]}]}'; expected = '{"status":"error","knownFailureCode":"idle-next-identity","lastRunKind":"idle-reentrant-retarget","errorType":null,"activeProbe":null}' },
        @{ name = 'timeout'; json = '{"status":"error","error":"System.TimeoutException: Событие native runtime не получено.\nprivate-stack","runs":[]}'; expected = '{"status":"error","knownFailureCode":"native-event-timeout","lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'last-saved'; json = '{"status":"error","error":"System.InvalidOperationException: Начальная скорость потеряна.","runs":[{"kind":"smooth-settle"},{"kind":"lifetime"}]}'; expected = '{"status":"error","knownFailureCode":"lifetime-initial-velocity","lastRunKind":"lifetime","errorType":null,"activeProbe":null}' },
        @{ name = 'unknown'; json = '{"status":"private-status","error":"private-error","runs":[{"kind":"private-kind"}],"path":"private-path","pid":"private-pid"}'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'types'; json = '{"status":true,"error":5,"runs":{"kind":"lifetime"}}'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'last-invalid'; json = '{"status":"error","error":"System.InvalidOperationException: Начальная скорость потеряна.private-tail","runs":[{"kind":"lifetime"},{"kind":5}]}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'stack-only'; json = '{"status":"error","error":"private-error\nSystem.InvalidOperationException: Начальная скорость потеряна.","runs":[{"kind":"LIFETIME"}]}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'captured-error'; json = '{"status":"captured","error":"System.InvalidOperationException: Начальная скорость потеряна.","runs":[]}'; expected = '{"status":"captured","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'missing'; json = '{}'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'malformed'; json = 'private-not-json'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'array-root'; json = '[{"status":"captured"},{"status":"error"}]'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'singleton-array-root'; json = '[{"status":"error","error":"System.InvalidOperationException: Начальная скорость потеряна.","runs":[]}]'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'empty-array-root'; json = '[]'; expected = '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'full-frame-message-only'; json = '{"status":"error","error":"System.InvalidOperationException: private-message\n   at NativeWindow.MainPage.Progress(String direction) in private-path:line 215\n   at NativeWindow.MainPage.Run(Object sender, RoutedEventArgs args)","runs":[{"kind":"lifetime"}]}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":"lifetime","errorType":null,"activeProbe":null}' },
        @{ name = 'typed-overrides-display'; json = '{"status":"error","error":"System.InvalidOperationException: Начальная скорость потеряна.\n   at NativeWindow.MainPage.Lifetime()","runs":[{"kind":"lifetime"}],"errorType":"Timeout","activeProbe":"Progress"}'; expected = '{"status":"error","knownFailureCode":"lifetime-initial-velocity","lastRunKind":"lifetime","errorType":"Timeout","activeProbe":"Progress"}' },
        @{ name = 'unknown-type-known-probe'; json = '{"status":"error","errorType":"Private","activeProbe":"Progress"}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":"Progress"}' },
        @{ name = 'unknown-probe-known-type'; json = '{"status":"error","errorType":"InvalidOperation","activeProbe":"Private"}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":"InvalidOperation","activeProbe":null}' },
        @{ name = 'typed-captured'; json = '{"status":"captured","errorType":"Timeout","activeProbe":"Progress"}'; expected = '{"status":"captured","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'metadata-types'; json = '{"status":"error","errorType":1,"activeProbe":true}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'metadata-case'; json = '{"status":"error","errorType":"timeout","activeProbe":"progress"}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'metadata-structure'; json = '{"status":"error","errorType":["Timeout"],"activeProbe":{"value":"Progress"}}'; expected = '{"status":"error","knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}' },
        @{ name = 'boundary-probe'; json = '{"status":"error","error":"System.InvalidOperationException: Native boundary или SetTarget не подтвердили цель и единственный terminal.","runs":[{"kind":"boundary-progress-interior-setter"}],"errorType":"InvalidOperation","activeProbe":"Boundaries"}'; expected = '{"status":"error","knownFailureCode":"boundary-completion","lastRunKind":"boundary-progress-interior-setter","errorType":"InvalidOperation","activeProbe":"Boundaries"}' },
        @{ name = 'retarget-probe'; json = '{"status":"error","error":"System.InvalidOperationException: Retarget не подтвердил единственный terminal последнего native request.","runs":[{"kind":"retarget-preserve"}],"errorType":"InvalidOperation","activeProbe":"Retarget"}'; expected = '{"status":"error","knownFailureCode":"retarget-terminal","lastRunKind":"retarget-preserve","errorType":"InvalidOperation","activeProbe":"Retarget"}' }
    )
    foreach ($type in @('InvalidOperation', 'Timeout', 'ObjectDisposed', 'Argument', 'ArgumentOutOfRange', 'ArgumentNull', 'InvalidCast', 'NullReference', 'COM')) {
        $fixture = @{ status = 'error'; errorType = $type } | ConvertTo-Json -Compress
        $expected = [ordered]@{ status = 'error'; knownFailureCode = $null; lastRunKind = $null; errorType = $type; activeProbe = $null } | ConvertTo-Json -Compress
        $traceCases += @{ name = 'type-' + $type; json = $fixture; expected = $expected }
    }
    foreach ($probe in @('IdleRetarget', 'Retarget', 'Settle', 'Lifetime', 'Progress', 'Boundaries')) {
        $fixture = @{ status = 'error'; activeProbe = $probe } | ConvertTo-Json -Compress
        $expected = [ordered]@{ status = 'error'; knownFailureCode = $null; lastRunKind = $null; errorType = $null; activeProbe = $probe } | ConvertTo-Json -Compress
        $traceCases += @{ name = 'probe-' + $probe; json = $fixture; expected = $expected }
    }
    $maximum = [ordered]@{ status = 'captured'; knownFailureCode = 'lifetime-initial-velocity'; lastRunKind = 'boundary-progress-interior-setter'; errorType = 'ArgumentOutOfRange'; activeProbe = 'IdleRetarget' } | ConvertTo-Json -Compress
    if ($maximum.Length -gt 180) { throw 'Typed metadata превысили прежний trace cap.' }
    foreach ($control in $traceCases) {
        $script:traceFixture = $control.json
        $script:traceReads = 0
        function Get-Content { param($LiteralPath, [switch]$Raw); $script:traceReads++; return $script:traceFixture }
        $actual = Get-BootTraceSummary 'fixture' | ConvertTo-Json -Compress
        if ($actual -cne $control.expected -or $actual.Length -gt 180 -or $script:traceReads -ne 1) { throw "Закрытая trace projection не подтверждена: $($control.name)" }
        $identity = [ordered]@{ completed = $true; exitCode = 1; traceExists = $true }
        $script:bootMessages = @()
        $observed = $null
        try { & $bootFailure } catch { $observed = $_ }
        if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.' -or $script:bootMessages.Count -ne 2 -or $script:bootMessages[1] -cne ('Нативный trace: ' + $control.expected)) { throw 'Trace projection потеряла первичный throw или закрытый output.' }
    }
    # Неизвестные status/error не дают текстовый fallback; unreadable сохраняет null.
    function Get-Content { param($LiteralPath, [switch]$Raw); throw [IO.IOException]::new('private-read-error') }
    $actual = Get-BootTraceSummary 'fixture' | ConvertTo-Json -Compress
    if ($actual -cne '{"status":null,"knownFailureCode":null,"lastRunKind":null,"errorType":null,"activeProbe":null}') { throw 'Отказ чтения выдал ложный trace.' }
    $script:bootMessages = @()
    $observed = $null
    try { & $bootFailure } catch { $observed = $_ }
    if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.' -or $script:bootMessages.Count -ne 2) { throw 'Отказ чтения заменил boot primary.' }

    function Write-Host { param($Object); throw [IO.IOException]::new('private-diagnostic-error') }
    $observed = $null
    try { & $bootFailure } catch { $observed = $_ }
    if (!$observed -or $observed.Exception.Message -ne 'Нативный процесс не подтвердил успешное завершение.') { throw 'Отказ вывода замаскировал boot-ошибку.' }
} finally { $env:LAB_MOTION_PROBE_OUTPUT = $originalOutput }
"process cleanup: $cases PASS; getter primitive: PASS; boot projection: $($bootCases.Count) PASS; saved trace: $($traceCases.Count) PASS; output failure: PASS"
