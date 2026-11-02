param(
    [Parameter(Mandatory = $true)][string]$ApplicationDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$ConfigureHostedAnimations
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Каталог результата уже существует.' }
$evidence = New-Item -ItemType Directory -Path (Join-Path $output 'evidence')
$app = Join-Path ([IO.Path]::GetFullPath($ApplicationDirectory)) 'NativeWindow.exe'
$trace = Join-Path $evidence 'press.jsonl'
$saved = @{}
foreach ($name in @('LAB_MOTION_PROBE_OUTPUT', 'LAB_MOTION_PRESS_TRACE', 'WINAPP_UI_WORKFLOW_ID', 'WINAPP_CLI_TELEMETRY_OPTOUT', 'WINAPP_CLI_UPDATE_CHECK')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}
$process = $null
$recording = $null
$passed = $false
$animationBefore = $null
$commands = [Collections.Generic.List[object]]::new()
$scenarios = [Collections.Generic.List[object]]::new()

function Start-Tool([string]$Name, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($script:cli)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::Start($info)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = if ($Name -eq 'record') { $null } else { $child.StandardError.ReadToEndAsync() }
    return @{ process = $child; stdout = $stdout; stderr = $stderr; prefix = ''; ended = $false; name = $Name; arguments = $Arguments }
}

function Finish-Tool($Tool, [int]$Timeout = 30000) {
    try {
        if (!$Tool.process.WaitForExit($Timeout)) {
            $Tool.process.Kill($true)
            $Tool.process.WaitForExit()
            throw "Таймаут winapp: $($Tool.name)"
        }
        $text = $Tool.stdout.GetAwaiter().GetResult()
        $errors = $Tool.prefix + $Tool.stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $evidence "$($Tool.name).stderr.log"), $errors)
        [IO.File]::WriteAllText((Join-Path $evidence "$($Tool.name).json"), $text)
        $commands.Add(@{ name = $Tool.name; arguments = $Tool.arguments; exitCode = $Tool.process.ExitCode })
        if ($Tool.process.ExitCode -ne 0) { throw "winapp $($Tool.name): exit $($Tool.process.ExitCode)" }
        return $text | ConvertFrom-Json
    } finally { $Tool.ended = $true; $Tool.process.Dispose() }
}

function Invoke-Ui([string]$Name, [string[]]$Arguments) {
    $tool = Start-Tool $Name (@('ui') + $Arguments + @('-w', $script:window, '--json'))
    Finish-Tool $tool | Out-Null
}

function Read-Trace {
    if (!(Test-Path -LiteralPath $trace)) { return @() }
    # Flush ненадолго владеет записью; повторяем лишь гонку совместного чтения.
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $stream = [IO.FileStream]::new($trace, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $reader = [IO.StreamReader]::new($stream)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            # Последняя строка могла ещё записываться; следующая выборка её увидит.
            $lines = $text.Split("`n") | Select-Object -SkipLast 1
            break
        }
        catch [IO.IOException] { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 20 }
    }
    return @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}

function Wait-Rest([long]$After = 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $events = @(Read-Trace)
        if (@($events | Where-Object { $_.kind -in @('error', 'truncated') }).Count) { throw 'Трасса ввода содержит ошибку или обрезана.' }
        $intents = @($events | Where-Object kind -eq 'intent')
        if ($intents.Count) {
            $last = $intents[-1].data
            $ends = @($events | Where-Object { $_.kind -in @('completed', 'snapReadback') -and $_.data.operation -eq $last.operation })
            if ($intents[-1].sequence -gt $After -and !$last.pressed -and $ends.Count) { return }
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Кнопка не вернулась в отпущенное состояние за 8 секунд.'
}

function Scenario([string]$Name, [string[]]$Arguments, [string[]]$BeforeArguments = @()) {
    Wait-Rest
    $before = @(Read-Trace)[-1].sequence
    if ($BeforeArguments.Count) { Invoke-Ui "$Name-press" $BeforeArguments }
    Invoke-Ui $Name $Arguments
    Wait-Rest $before
    if ($Name -eq 'disable-animation') {
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        do {
            $stopped = @(Read-Trace | Where-Object { $_.sequence -gt $before -and $_.kind -eq 'completed' -and $_.data.reason -eq 'snap' })
            if ($stopped.Count) { break }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$stopped.Count) { throw 'Переключатель не прервал движение: completed/snap не наблюдался.' }
    }
    $after = @(Read-Trace)[-1].sequence
    $scenarios.Add(@{ name = $Name; after = $before; through = $after })
}

try {
    & node --test (Join-Path $PSScriptRoot 'assert-input.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Проверки различающей силы input oracle не прошли.' }
    $env:LAB_MOTION_PROBE_OUTPUT = $null
    $env:LAB_MOTION_PRESS_TRACE = $trace
    $env:WINAPP_UI_WORKFLOW_ID = [guid]::NewGuid().ToString()
    $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
    $env:WINAPP_CLI_UPDATE_CHECK = '0'
    if ($ConfigureHostedAnimations) {
        if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
            throw 'Изменение настройки разрешено только в одноразовой hosted-сессии GitHub.'
        }
        Add-Type -Path (Join-Path $PSScriptRoot 'animation-settings.cs')
        $animationBefore = [ClientAreaAnimation]::Read()
        [ClientAreaAnimation]::Write($true)
        @{ before = $animationBefore; enabled = [ClientAreaAnimation]::Read() } |
            ConvertTo-Json | Set-Content (Join-Path $evidence 'animation-settings.json')
    }
    $zip = Join-Path $output 'winapp.zip'
    Invoke-WebRequest 'https://github.com/microsoft/winappCli/releases/download/v0.7.1/winappcli-x64.zip' -OutFile $zip
    $digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne 'd925d1e32cdc320b6d271f653fd2cd3c05b5d7558deb20d1b548bead77900fcf') { throw 'SHA256 winapp CLI не совпал.' }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $output 'tool')
    $executables = @(Get-ChildItem -LiteralPath (Join-Path $output 'tool') -Filter winapp.exe -Recurse -File)
    if ($executables.Count -ne 1) { throw 'Ожидался один winapp.exe.' }
    $script:cli = $executables[0].FullName
    $process = Start-Process -FilePath $app -WorkingDirectory $ApplicationDirectory -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'Приложение завершилось до появления окна.' }
        if ($process.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($process.MainWindowHandle -eq 0) { throw 'Не найдено окно собственного процесса.' }
    $script:window = $process.MainWindowHandle.ToInt64().ToString()
    @{ pid = $process.Id; window = $window; source = (git -C $PSScriptRoot rev-parse HEAD);
        os = [Environment]::OSVersion.VersionString; appSha256 = (Get-FileHash $app).Hash;
        librarySha256 = (Get-FileHash (Join-Path $ApplicationDirectory 'LabMotion.WinUI.dll')).Hash;
        cliVersion = '0.7.1'; cliZipSha256 = $digest } | ConvertTo-Json | Set-Content (Join-Path $evidence 'identity.json')
    Wait-Rest
    $initialIntent = @(Read-Trace | Where-Object kind -eq 'intent')[-1]
    if (!$initialIntent.data.systemAnimation) { throw 'UISettings не подтверждает включённую системную анимацию для animated-сценариев.' }
    Invoke-Ui 'inspect' @('inspect')
    Invoke-Ui 'rest-before' @('screenshot', '--output', (Join-Path $evidence 'rest-before.png'))

    $recordClock = [Diagnostics.Stopwatch]::StartNew()
    $recording = Start-Tool 'record' @('ui', 'record', '-w', $window, '--frames', '--duration-sec', '5', '--fps', '10', '--max-edge', '1000', '--output', (Join-Path $evidence 'press.mp4'), '--json')
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $started = $false
    $lineTask = $recording.process.StandardError.ReadLineAsync()
    do {
        if ($recording.process.HasExited) { throw 'Запись завершилась до подтверждения первого кадра.' }
        if (!$lineTask.Wait(100)) { continue }
        $line = $lineTask.GetAwaiter().GetResult()
        if ($null -eq $line) { throw 'Поток записи закрыт до первого кадра.' }
        $recording.prefix += "$line`n"
        try { $recordEvent = $line | ConvertFrom-Json } catch { $recordEvent = $null }
        if ($recordEvent -and $recordEvent.PSObject.Properties['event'] -and $recordEvent.event -eq 'recording-started') { $started = $true; break }
        $lineTask = $recording.process.StandardError.ReadLineAsync()
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$started) { throw 'Нет подтверждения первого кадра.' }
    $recording.stderr = $recording.process.StandardError.ReadToEndAsync()
    $inputStartedMs = $recordClock.Elapsed.TotalMilliseconds
    Scenario 'mouse-hold' @('drag', 'Press', 'Press', '--hold-ms', '1000')
    @{ inputStartedMs = $inputStartedMs; inputCompletedMs = $recordClock.Elapsed.TotalMilliseconds } |
        ConvertTo-Json | Set-Content (Join-Path $evidence 'capture-window.json')
    $recordResult = Finish-Tool $recording
    $recording = $null
    if ($recordResult.mode -ne 'wgc' -or $recordResult.frames -lt 10) { throw 'Запись не подтвердила одновременный WGC capture и ввод.' }

    Scenario 'mouse-interrupt' @('drag', 'Press', 'Press', '--hold-ms', '0')
    Scenario 'pointer-out' @('drag', 'Press', 'Animation', '--hold-ms', '100')
    Scenario 'keyboard' @('send-keys', 'space', '--target', 'Press', '--via', 'send-input')
    Scenario 'disable-animation' @('send-keys', 'space', '--target', 'Animation', '--via', 'send-input') @('drag', 'Press', 'Press', '--hold-ms', '0')
    Scenario 'reduced-motion' @('drag', 'Press', 'Press', '--hold-ms', '200')
    Invoke-Ui 'rest-after' @('screenshot', '--output', (Join-Path $evidence 'rest-after.png'))
    $scenarios | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'scenarios.json')
    & node (Join-Path $PSScriptRoot 'assert-input.mjs') $evidence
    if ($LASTEXITCODE -ne 0) { throw 'Проверка трассы ввода не прошла.' }
    $passed = $true
} catch {
    $_ | Out-String | Set-Content (Join-Path $evidence 'failure.txt')
    throw
} finally {
    if ($recording -and !$recording.ended) {
        if (!$recording.process.HasExited) { $recording.process.Kill($true); $recording.process.WaitForExit() }
        $remaining = if ($recording.stderr) { $recording.stderr.GetAwaiter().GetResult() } else { '' }
        [IO.File]::WriteAllText((Join-Path $evidence 'record.stderr.log'), $recording.prefix + $remaining)
    }
    $closed = $false
    if ($process) {
        $forced = $false
        if (!$process.HasExited) {
            $null = $process.CloseMainWindow()
            if (!$process.WaitForExit(5000)) { $forced = $true; $process.Kill($true); $process.WaitForExit() }
        }
        $process.Refresh()
        $closed = !$forced -and $process.HasExited -and $process.ExitCode -eq 0
        @{ exited = $process.HasExited; forced = $forced; exitCode = $process.ExitCode } | ConvertTo-Json | Set-Content (Join-Path $evidence 'close.json')
        $process.Dispose()
    }
    $commands | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'commands.json')
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    if ($null -ne $animationBefore) {
        [ClientAreaAnimation]::Write($animationBefore)
        @{ expected = $animationBefore; actual = [ClientAreaAnimation]::Read() } |
            ConvertTo-Json | Set-Content (Join-Path $evidence 'animation-restored.json')
    }
    if ($passed -and !$closed) { throw 'Приложение не подтвердило штатное завершение.' }
}
