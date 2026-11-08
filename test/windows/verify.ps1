param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Для проверки Composition нужна Windows.'
}
Get-Command dotnet -ErrorAction Stop | Out-Null
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'process-cleanup.test.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Проверка владения нативным процессом не прошла.' }
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'interaction-cleanup.test.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Проверка освобождения touch-потребителя не прошла.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Каталог результата уже существует.' }
New-Item -ItemType Directory -Path $output | Out-Null
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$consumer = Join-Path $repository 'examples/windows/NativeWindow.csproj'
$unit = Join-Path $PSScriptRoot 'lifecycle.csproj'
$appOutput = Join-Path $output 'app'
$unitOutput = Join-Path $output 'unit'
$buildOutput = Join-Path $output 'build'

function Invoke-Dotnet([string]$Log, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    Push-Location -LiteralPath $PSScriptRoot
    try {
        # Windows PowerShell 5.1 превращает даже служебный stderr в ErrorRecord.
        $ErrorActionPreference = 'Continue'
        & dotnet @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $output $Log)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
    if ($code -ne 0) { throw "dotnet завершился с кодом $code. Журнал: $Log" }
}

function Get-BootTraceSummary([string]$Path) {
    $traceSummary = [ordered]@{ status = $null; knownFailureCode = $null; lastRunKind = $null; errorType = $null; activeProbe = $null }
    try {
        # Читается только уже сохранённый MainPage trace; наружу выходят конечные literals.
        $saved = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -NoEnumerate
        if ($saved -isnot [pscustomobject]) { return $traceSummary }
        $status = $saved.PSObject.Properties['status']
        if ($status -and $status.Value -is [string] -and $status.Value -cin @('captured', 'error')) {
            $traceSummary.status = $status.Value
        }
        $runs = $saved.PSObject.Properties['runs']
        if ($runs -and $runs.Value -is [array] -and $runs.Value.Count -gt 0) {
            $last = $runs.Value[-1]
            if ($last -is [pscustomobject]) {
                $kind = $last.PSObject.Properties['kind']
                if ($kind -and $kind.Value -is [string] -and $kind.Value -cin @('idle-reentrant-retarget',
                    'retarget-preserve', 'retarget-reset-mutant', 'smooth-settle', 'lifetime',
                    'progress-up', 'progress-down', 'progress-reverse', 'progress-velocity',
                    'boundary-progress-lower-settle', 'boundary-progress-lower-setter',
                    'boundary-progress-interior-settle', 'boundary-progress-interior-setter',
                    'boundary-progress-upper-settle', 'boundary-progress-upper-setter',
                    'boundary-raw-x-lower-settle', 'boundary-raw-x-interior-settle', 'boundary-raw-x-upper-settle',
                    'boundary-raw-y-lower-settle', 'boundary-raw-y-interior-settle', 'boundary-raw-y-upper-settle')) {
                    $traceSummary.lastRunKind = $kind.Value
                }
            }
        }
        if ($traceSummary.status -ceq 'error') {
            # Новые поля принадлежат typed producer; display error/stack не источник.
            $errorType = $saved.PSObject.Properties['errorType']
            if ($errorType -and $errorType.Value -is [string] -and $errorType.Value -cin @('InvalidOperation',
                'Timeout', 'ObjectDisposed', 'Argument', 'ArgumentOutOfRange', 'ArgumentNull', 'InvalidCast', 'NullReference', 'COM')) {
                $traceSummary.errorType = $errorType.Value
            }
            $activeProbe = $saved.PSObject.Properties['activeProbe']
            if ($activeProbe -and $activeProbe.Value -is [string] -and $activeProbe.Value -cin @('IdleRetarget', 'Retarget', 'Settle', 'Lifetime', 'Progress', 'Boundaries')) {
                $traceSummary.activeProbe = $activeProbe.Value
            }
        }
        $errorValue = $saved.PSObject.Properties['error']
        if ($traceSummary.status -ceq 'error' -and $errorValue -and $errorValue.Value -is [string]) {
            # ToString содержит stack; классифицируется только точная известная первая строка.
            $firstLine = ($errorValue.Value -split '\r?\n', 2)[0]
            $traceSummary.knownFailureCode = switch -CaseSensitive ($firstLine) {
                'System.InvalidOperationException: Idle передал observer ещё незавершённую операцию.' { 'idle-first-completion' }
                'System.InvalidOperationException: Idle потерял identity или завершил новую операцию observer.' { 'idle-next-identity' }
                'System.InvalidOperationException: Новая операция observer не завершилась своим native Idle.' { 'idle-next-completion' }
                'System.InvalidOperationException: Завершения поколений перепутаны.' { 'retarget-completion' }
                'System.InvalidOperationException: Retarget потерял logical operation или origin.' { 'retarget-operation' }
                'System.InvalidOperationException: Retarget потерял request identity или превысил один Idle handoff.' { 'retarget-request-budget' }
                'System.InvalidOperationException: Retarget не подтвердил единственный terminal последнего native request.' { 'retarget-terminal' }
                'System.InvalidOperationException: Retarget смешал callbacks разных запросов или неверное завершение.' { 'retarget-callback' }
                'System.InvalidOperationException: Нет native admission исходного retarget.' { 'retarget-admission' }
                'System.InvalidOperationException: Нет движения исходного retarget до handoff.' { 'retarget-first-motion' }
                'System.InvalidOperationException: Retarget вернул позицию назад.' { 'retarget-position' }
                'System.InvalidOperationException: Не сохранена семантика native velocity.' { 'retarget-velocity' }
                'System.InvalidOperationException: Траектория не отличает сохранение скорости от сброса.' { 'retarget-trajectory' }
                'System.InvalidOperationException: Native settling дальше половины физического пикселя от цели.' { 'settling-distance' }
                'System.InvalidOperationException: Пружина из покоя не завершилась.' { 'settle-completion' }
                'System.InvalidOperationException: Критическая пружина перескочила цель.' { 'settle-overshoot' }
                'System.InvalidOperationException: Начальная скорость потеряна.' { 'lifetime-initial-velocity' }
                'System.InvalidOperationException: Stop выдал неверное завершение.' { 'lifetime-stop' }
                'System.InvalidOperationException: Dispose выдал неверное завершение.' { 'lifetime-dispose' }
                'System.InvalidOperationException: Канал доступен или сообщает события после Dispose.' { 'lifetime-retirement' }
                'System.InvalidOperationException: Native boundary или SetTarget не подтвердили цель и единственный terminal.' { 'boundary-completion' }
                'System.InvalidOperationException: Нормализованный канал завершился дальше 0.001 от цели.' { 'progress-completion' }
                'System.InvalidOperationException: Не наблюдалось промежуточное движение прогресса.' { 'progress-intermediate' }
                'System.InvalidOperationException: Нормализация потеряла поколения разворота.' { 'progress-reverse' }
                'System.InvalidOperationException: Скорость канала возвращается не в единицах прогресса в секунду.' { 'progress-velocity' }
                'System.TimeoutException: Событие native runtime не получено.' { 'native-event-timeout' }
                default { $null }
            }
        }
    } catch {
        # Повреждённый/недоступный trace не становится успехом и не меняет boot throw.
    }
    return $traceSummary
}

Invoke-Dotnet 'dotnet.txt' @('--info')
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-native-preference.ps1') -OutputDirectory (Join-Path $output 'native-diagnostics')
if ($LASTEXITCODE -ne 0) { throw 'Native diagnostic helper build/controls не прошли.' }
Invoke-Dotnet 'unit-build.log' @('build', $unit, '--configuration', 'Release', '--artifacts-path', $buildOutput, '--output', $unitOutput)
Invoke-Dotnet 'unit.json' @((Join-Path $unitOutput 'lifecycle.dll'))
$unitResult = Get-Content -LiteralPath (Join-Path $output 'unit.json') -Raw | ConvertFrom-Json
$expectedLifecycle = @('idle-reentrant-observe', 'idle-reentrant-retarget', 'idle-reentrant-stop',
    'idle-reentrant-snap', 'idle-reentrant-dispose', 'idle-reentrant-throw',
    'replacement-stale-callbacks', 'own-request-ignored', 'invalid-spring-preserves-operation') | Sort-Object
if (!$unitResult.passed -or $unitResult.results.Count -ne $expectedLifecycle.Count -or @($unitResult.results | Where-Object { !$_.passed }).Count -ne 0) {
    throw 'Lifecycle-пробы не подтвердили все сценарии.'
}
if ($unitResult.bindings.Count -ne 15 -or @($unitResult.bindings | Where-Object { !$_.Passed }).Count -ne 0) {
    throw 'Проверки привязок и единиц прогресса не подтвердили все пятнадцать сценариев.'
}
if ($unitResult.pans.Count -ne 22 -or @($unitResult.pans | Where-Object { !$_.Passed }).Count -ne 0) {
    throw 'Проверки канала ввода не подтвердили все двадцать два сценария.'
}
if ($unitResult.continuations.Count -ne 16 -or @($unitResult.continuations | Where-Object { !$_.Passed }).Count -ne 0) {
    throw 'Проверки продолжения движения не подтвердили все шестнадцать сценариев.'
}
$actualLifecycle = @($unitResult.results | ForEach-Object { $_.scenario }) | Sort-Object
if (Compare-Object $expectedLifecycle $actualLifecycle) { throw 'Состав lifecycle-сценариев изменился.' }
if ($unitResult.retargetMeter.Count -ne 14 -or @($unitResult.retargetMeter | Where-Object { !$_.Passed }).Count -ne 0) {
    throw 'Измеритель retarget не различил все четырнадцать контрольных историй.'
}

Invoke-Dotnet 'consumer-build.log' @('build', $consumer, '--configuration', 'Release', '--runtime', 'win-x64', '--artifacts-path', $buildOutput, '--output', $appOutput)
Copy-Item -LiteralPath (Join-Path $output 'native-diagnostics/LabMotion.PreferenceDiagnostics.dll') -Destination $appOutput
$exe = Join-Path $appOutput 'NativeWindow.exe'
$tracePath = Join-Path $output 'trace.json'
$previousOutput = $env:LAB_MOTION_PROBE_OUTPUT
$env:LAB_MOTION_PROBE_OUTPUT = $tracePath
$process = $null
$primaryFailure = $null
try {
    $process = Start-Process -FilePath $exe -WorkingDirectory $appOutput -WindowStyle Hidden -PassThru
    # PowerShell может вернуть null вместо ошибки getter; допуск проверяем явно.
    $handle = $process.Handle
    if ($null -eq $handle -or $handle -eq [IntPtr]::Zero) {
        throw 'Не получен действительный handle собственного процесса.'
    }
    $started = $process.StartTime
    if ($started -isnot [DateTime]) {
        throw 'Не получено время запуска собственного процесса.'
    }
    $identity = [ordered]@{
        pid = $process.Id
        path = $exe
        started = $started.ToUniversalTime().ToString('o')
        exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
        librarySha256 = (Get-FileHash -LiteralPath (Join-Path $appOutput 'LabMotion.WinUI.dll') -Algorithm SHA256).Hash
    }
    $finished = $process.WaitForExit(60000)
    if (!$finished) {
        # PID может быть повторно использован; завершаем только свой экземпляр.
        $current = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if ($current -and $current.Path -eq $exe -and $current.StartTime -eq $started) {
            Stop-Process -Id $current.Id -Force
            $process.WaitForExit()
        }
    }
    $process.Refresh()
    $identity.completed = $finished
    $identity.exitCode = if ($finished) { $process.ExitCode } else { $null }
    $identity.traceExists = Test-Path -LiteralPath $tracePath
    $identity | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $output 'process.json')
    if (!$finished -or $identity.exitCode -ne 0 -or !$identity.traceExists) {
        try {
            $summary = [ordered]@{
                completed = if ($identity.completed -is [bool]) { $identity.completed } else { $null }
                exitCode = if ($identity.exitCode -is [int]) { $identity.exitCode } else { $null }
                traceExists = if ($identity.traceExists -is [bool]) { $identity.traceExists } else { $null }
            }
            Write-Host ('Нативный процесс: ' + ($summary | ConvertTo-Json -Compress))
        } catch {
            # Диагностика не заменяет первичный отказ и не выводит сырую ошибку.
        }
        if ($identity.traceExists -is [bool] -and $identity.traceExists) {
            try {
                Write-Host ('Нативный trace: ' + ((Get-BootTraceSummary $tracePath) | ConvertTo-Json -Compress))
            } catch {
                # Отказ чтения/вывода не подменяет первичную ошибку процесса.
            }
        }
        throw 'Нативный процесс не подтвердил успешное завершение.'
    }
} catch {
    $primaryFailure = $_
    throw
} finally {
    try {
        try {
            if ($process) {
                try {
                    if (!$process.HasExited) {
                        # Process владеет handle запуска; новый поиск по PID здесь не нужен.
                        $process.Kill()
                        $process.WaitForExit()
                    }
                } finally { $process.Dispose() }
            }
        } catch {
            if ($null -eq $primaryFailure) { throw }
            Write-Warning 'Cleanup нативного процесса не подтверждён; первичная ошибка сохранена.' -WarningAction Continue
        }
    } finally {
        $env:LAB_MOTION_PROBE_OUTPUT = $previousOutput
    }
}

$trace = Get-Content -LiteralPath $tracePath -Raw | ConvertFrom-Json
if ($trace.status -ne 'captured' -or $trace.error -or $trace.runs.Count -ne 23) {
    throw 'Не получены все двадцать три нативных сценария.'
}
$expected = @('idle-reentrant-retarget', 'lifetime', 'retarget-preserve:-1', 'retarget-preserve:1',
    'retarget-reset-mutant:-1', 'retarget-reset-mutant:1', 'smooth-settle',
    'progress-up', 'progress-down', 'progress-reverse', 'progress-velocity',
    'boundary-progress-lower-settle', 'boundary-progress-lower-setter',
    'boundary-progress-interior-settle', 'boundary-progress-interior-setter',
    'boundary-progress-upper-settle', 'boundary-progress-upper-setter',
    'boundary-raw-x-lower-settle', 'boundary-raw-x-interior-settle', 'boundary-raw-x-upper-settle',
    'boundary-raw-y-lower-settle', 'boundary-raw-y-interior-settle', 'boundary-raw-y-upper-settle') | Sort-Object
$actual = @($trace.runs | ForEach-Object {
    if ($_.kind -like 'retarget-*') { "$($_.kind):$($_.direction)" } else { $_.kind }
}) | Sort-Object
if (Compare-Object $expected $actual) { throw 'Состав нативных сценариев изменился.' }
foreach ($run in $trace.runs) {
    if ($run.trace.Count -eq 0 -or @($run.trace | Where-Object { $_.Phase -eq 'inertia' }).Count -eq 0) {
        throw "Сценарий $($run.kind) не наблюдал нативное движение."
    }
    if ($run.kind -like 'boundary-*' -and !$run.passed) {
        throw "Сценарий $($run.kind) не подтвердил границы движения."
    }
}
[ordered]@{ passed = $true; lifecycleScenarios = $expectedLifecycle.Count; bindingScenarios = 15; disposalScenarios = 14; panScenarios = 22; continuationScenarios = 16; retargetMeterScenarios = 14; nativeScenarios = 23; scale = $trace.scale } |
    ConvertTo-Json | Tee-Object -FilePath (Join-Path $output 'result.json')
