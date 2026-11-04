param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Для проверки Composition нужна Windows.'
}
Get-Command dotnet -ErrorAction Stop | Out-Null
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'process-cleanup.test.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Проверка владения нативным процессом не прошла.' }
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

Invoke-Dotnet 'dotnet.txt' @('--info')
Invoke-Dotnet 'unit-build.log' @('build', $unit, '--configuration', 'Release', '--artifacts-path', $buildOutput, '--output', $unitOutput)
Invoke-Dotnet 'unit.json' @((Join-Path $unitOutput 'lifecycle.dll'))
$unitResult = Get-Content -LiteralPath (Join-Path $output 'unit.json') -Raw | ConvertFrom-Json
$expectedLifecycle = @('idle-reentrant-observe', 'idle-reentrant-retarget', 'idle-reentrant-stop',
    'idle-reentrant-snap', 'idle-reentrant-dispose', 'idle-reentrant-throw',
    'replacement-stale-callbacks', 'own-request-ignored', 'invalid-spring-preserves-operation') | Sort-Object
if (!$unitResult.passed -or $unitResult.results.Count -ne $expectedLifecycle.Count -or @($unitResult.results | Where-Object { !$_.passed }).Count -ne 0) {
    throw 'Lifecycle-пробы не подтвердили все сценарии.'
}
if ($unitResult.bindings.Count -ne 14 -or @($unitResult.bindings | Where-Object { !$_.Passed }).Count -ne 0) {
    throw 'Проверки привязок и единиц прогресса не подтвердили все четырнадцать сценариев.'
}
$actualLifecycle = @($unitResult.results | ForEach-Object { $_.scenario }) | Sort-Object
if (Compare-Object $expectedLifecycle $actualLifecycle) { throw 'Состав lifecycle-сценариев изменился.' }

Invoke-Dotnet 'consumer-build.log' @('build', $consumer, '--configuration', 'Release', '--runtime', 'win-x64', '--artifacts-path', $buildOutput, '--output', $appOutput)
$exe = Join-Path $appOutput 'NativeWindow.exe'
$tracePath = Join-Path $output 'trace.json'
$previousOutput = $env:LAB_MOTION_PROBE_OUTPUT
$env:LAB_MOTION_PROBE_OUTPUT = $tracePath
$process = $null
$primaryFailure = $null
try {
    $process = Start-Process -FilePath $exe -WorkingDirectory $appOutput -WindowStyle Hidden -PassThru
    # Удерживаем handle своего запуска до чтения необязательной identity.
    $null = $process.Handle
    $started = $process.StartTime
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
if ($trace.status -ne 'captured' -or $trace.error -or $trace.runs.Count -ne 11) {
    throw 'Не получены все одиннадцать нативных сценариев.'
}
$expected = @('idle-reentrant-retarget', 'lifetime', 'retarget-preserve:-1', 'retarget-preserve:1',
    'retarget-reset-mutant:-1', 'retarget-reset-mutant:1', 'smooth-settle',
    'progress-up', 'progress-down', 'progress-reverse', 'progress-velocity') | Sort-Object
$actual = @($trace.runs | ForEach-Object {
    if ($_.kind -like 'retarget-*') { "$($_.kind):$($_.direction)" } else { $_.kind }
}) | Sort-Object
if (Compare-Object $expected $actual) { throw 'Состав нативных сценариев изменился.' }
foreach ($run in $trace.runs) {
    if ($run.trace.Count -eq 0 -or @($run.trace | Where-Object { $_.Phase -eq 'inertia' }).Count -eq 0) {
        throw "Сценарий $($run.kind) не наблюдал нативное движение."
    }
}
[ordered]@{ passed = $true; lifecycleScenarios = $expectedLifecycle.Count; bindingScenarios = 14; nativeScenarios = 11; scale = $trace.scale } |
    ConvertTo-Json | Tee-Object -FilePath (Join-Path $output 'result.json')
