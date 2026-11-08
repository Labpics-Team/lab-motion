# Только функции: загрузка не запускает приложение, ввод или системную настройку.
function Read-ProcessHasExited($Process) {
    # PowerShell может подавить исключение getter и вернуть null: не приводим его к bool.
    $exited = $Process.HasExited
    if ($exited -isnot [bool]) { throw 'Процесс не вернул bool HasExited.' }
    return $exited
}

function Read-ProcessExitCode($Process) {
    $exitCode = $Process.ExitCode
    if ($exitCode -isnot [int]) { throw 'Процесс не вернул int ExitCode.' }
    return $exitCode
}

function Save-CleanupFailure([Management.Automation.ErrorRecord]$Failure, [ref]$FirstFailure) {
    # Исключение из следующего finally не должно заменять уже сохранённую ошибку.
    if ($null -eq $FirstFailure.Value) { $FirstFailure.Value = $Failure }
    else { Write-Warning ('Вторичная ошибка очистки: ' + $Failure.Exception.Message) -WarningAction Continue }
}

function Finish-Tool($Tool, [int]$Timeout = $toolTimeoutMilliseconds) {
    $toolClock = [Diagnostics.Stopwatch]::StartNew()
    $waitCompleted = $false
    $killAttempted = $false
    $finishFailure = $null
    $result = $null
    try {
        if ($Timeout -lt 0) { throw 'Finish-Tool требует конечный неотрицательный Timeout.' }
        $remaining = [int][Math]::Max(0, $Timeout - $toolClock.ElapsedMilliseconds)
        $waitResult = $Tool.process.WaitForExit($remaining)
        if ($waitResult -isnot [bool]) { throw 'winapp не вернул bool после ожидания.' }
        $waitCompleted = $waitResult
        if (!$waitCompleted) { throw "Таймаут winapp: $($Tool.name)" }
        # Exit child не гарантирует EOF: descendant может ещё держать redirected pipe.
        $remaining = [int][Math]::Max(0, $Timeout - $toolClock.ElapsedMilliseconds)
        $text = $Tool.stdout.WaitAsync([TimeSpan]::FromMilliseconds($remaining)).GetAwaiter().GetResult()
        $remaining = [int][Math]::Max(0, $Timeout - $toolClock.ElapsedMilliseconds)
        $errors = $Tool.prefix + $Tool.stderr.WaitAsync([TimeSpan]::FromMilliseconds($remaining)).GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $evidence "$($Tool.name).stderr.log"), $errors)
        [IO.File]::WriteAllText((Join-Path $evidence "$($Tool.name).json"), $text)
        if (!(Read-ProcessHasExited $Tool.process)) { throw 'winapp не подтвердил завершение после ожидания.' }
        $exitCode = Read-ProcessExitCode $Tool.process
        $commands.Add(@{ name = $Tool.name; arguments = $Tool.arguments; exitCode = $exitCode })
        if ($exitCode -ne 0) { throw "winapp $($Tool.name): exit $exitCode" }
        $result = $text | ConvertFrom-Json
    } catch { $finishFailure = $_ }
    finally {
        # Ошибка ожидания не отменяет единственную попытку остановить свой child.
        if (!$waitCompleted -and !$killAttempted) {
            $killAttempted = $true
            try { $Tool.process.Kill($true) } catch { Save-CleanupFailure $_ ([ref]$finishFailure) }
            try {
                # Остановка расходует только остаток исходного Timeout, не новый срок.
                $remaining = [int][Math]::Max(0, $Timeout - $toolClock.ElapsedMilliseconds)
                $stopped = $Tool.process.WaitForExit($remaining)
                if ($stopped -isnot [bool]) { throw 'winapp не вернул bool после остановки.' }
                $stopConfirmed = Read-ProcessHasExited $Tool.process
                if (!$stopped -or !$stopConfirmed) { throw 'Остановка winapp не подтвердила завершение.' }
            } catch { Save-CleanupFailure $_ ([ref]$finishFailure) }
        }
        $Tool.ended = $true
        try { $Tool.process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$finishFailure) }
    }
    if ($null -ne $finishFailure) { throw $finishFailure }
    return $result
}

# Владелец caller освобождает Process в finally и сохраняет отказ после закрытия.
# Graceful проверяет исход приложения; запись требует только подтверждённого завершения.
function Close-OwnedProcess($Process, [int]$Timeout, [switch]$Graceful) {
    if ($Timeout -lt 0) { throw 'Закрытие требует конечный неотрицательный Timeout.' }
    $closeClock = [Diagnostics.Stopwatch]::StartNew()
    $cleanupFailure = $null
    $completionReadFailed = $false
    $stopFailed = $false
    $needsClose = $true
    $forced = $false
    $result = $null
    try { $needsClose = !(Read-ProcessHasExited $Process) }
    catch { $completionReadFailed = $true; Save-CleanupFailure $_ ([ref]$cleanupFailure) }
    if ($needsClose) {
        $forceStop = !$Graceful
        if ($Graceful) {
            try {
                $null = $Process.CloseMainWindow()
                $remaining = [int][Math]::Max(0, $Timeout - $closeClock.ElapsedMilliseconds)
                $waitResult = $Process.WaitForExit($remaining)
                if ($waitResult -isnot [bool]) { throw 'Закрытие не вернуло bool после ожидания.' }
                $forceStop = !$waitResult
            } catch { $stopFailed = $true; $forceStop = $true; Save-CleanupFailure $_ ([ref]$cleanupFailure) }
        }
        if ($forceStop) {
            $forced = $true
            try { $Process.Kill($true) } catch { $stopFailed = $true; Save-CleanupFailure $_ ([ref]$cleanupFailure) }
            # Отказ Kill не отменяет независимое конечное наблюдение завершения.
            try {
                $remaining = [int][Math]::Max(0, $Timeout - $closeClock.ElapsedMilliseconds)
                $stopped = $Process.WaitForExit($remaining)
                if ($stopped -isnot [bool]) { throw 'Остановка не вернула bool после ожидания.' }
                if (!$stopped) { throw 'Остановка не подтвердила завершение.' }
            } catch { $stopFailed = $true; Save-CleanupFailure $_ ([ref]$cleanupFailure) }
        }
    }
    if (!$completionReadFailed -and !$stopFailed) {
        try {
            if ($Graceful) { $Process.Refresh() }
            $exited = Read-ProcessHasExited $Process
            if (!$exited) { throw 'Процесс не подтвердил завершение после очистки.' }
            $exitCode = if ($Graceful) { Read-ProcessExitCode $Process } else { $null }
            $result = @{ exited = $exited; forced = $forced; exitCode = $exitCode }
        } catch { Save-CleanupFailure $_ ([ref]$cleanupFailure) }
    }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    return $result
}
