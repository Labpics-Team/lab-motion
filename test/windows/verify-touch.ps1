param(
    [Parameter(Mandatory = $true)][string]$ApplicationDirectory,
    [Parameter(Mandatory = $true)][string]$ToolDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Ввод принадлежит одноразовому runner, а не рабочему столу разработчика.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Touch-квалификация запускается только в hosted-сессии GitHub.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Каталог результата уже существует.' }
New-Item -ItemType Directory -Path $output | Out-Null
$app = Join-Path ([IO.Path]::GetFullPath($ApplicationDirectory)) 'NativeWindow.exe'
$executables = @(Get-ChildItem -LiteralPath $ToolDirectory -Filter winapp.exe -Recurse -File)
if ($executables.Count -ne 1) { throw 'Ожидался проверенный winapp.exe из input harness.' }
$cli = $executables[0].FullName
$saved = @{}
foreach ($name in @('LAB_MOTION_PROBE_OUTPUT', 'LAB_MOTION_PRESS_TRACE', 'LAB_MOTION_INTERACTION_OUTPUT',
    'LAB_MOTION_INTERACTION_DIRECTION', 'WINAPP_UI_WORKFLOW_ID',
    'WINAPP_CLI_TELEMETRY_OPTOUT', 'WINAPP_CLI_UPDATE_CHECK')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}

function Invoke-Ui([string]$Name, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($script:cli)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in (@('ui') + $Arguments + @('-w', $script:window, '--json'))) { $info.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::Start($info)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    try {
        if (!$child.WaitForExit(30000)) { throw "Таймаут winapp: $Name" }
        $text = $stdout.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $script:case "$Name.json"), $text)
        [IO.File]::WriteAllText((Join-Path $script:case "$Name.stderr.log"), $stderr.GetAwaiter().GetResult())
        if ($child.ExitCode -ne 0) { throw "winapp $Name завершился с кодом $($child.ExitCode)." }
        return $text | ConvertFrom-Json
    } finally {
        try {
            if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
        } finally { $child.Dispose() }
    }
}

function Read-Trace {
    if (!(Test-Path -LiteralPath $script:trace)) { return @() }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $stream = [IO.FileStream]::new($script:trace, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            $reader = [IO.StreamReader]::new($stream)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $lines = $text.Split("`n") | Select-Object -SkipLast 1
            return @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        } catch [IO.IOException] { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 20 }
    }
}

function Wait-Trace([string]$Phase) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $script:process.Refresh()
        if ($script:process.HasExited) { throw 'Приложение завершилось до native readback.' }
        $events = @(Read-Trace)
        if (@($events | Where-Object { $_.kind -in @('error', 'truncated') }).Count) { throw 'Трасса содержит ошибку или обрезана.' }
        if ($Phase -eq 'ready') {
            $ready = @($events | Where-Object kind -eq 'ready')
            if ($ready.Count) { return $ready[-1] }
        } else {
            $inertia = @($events | Where-Object { $_.kind -eq 'motion' -and $_.data.phase -eq 'inertia' -and $_.data.requestId -eq 0 })
            if ($inertia.Count) {
                $idle = @($events | Where-Object { $_.sequence -gt $inertia[-1].sequence -and $_.kind -eq 'motion' -and $_.data.phase -eq 'idle' })
                if ($idle.Count) { return $idle[-1] }
            }
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Не получен native $Phase за 10 секунд."
}

function Find-Stage($Elements) {
    foreach ($element in $Elements) {
        if ($element.PSObject.Properties['automationId'] -and $element.automationId -eq 'TouchStage') { $element }
        if ($element.PSObject.Properties['children']) { Find-Stage $element.children }
    }
}

$failures = [Collections.Generic.List[string]]::new()
try {
    & node --test (Join-Path $PSScriptRoot 'assert-touch.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Проверки touch oracle не прошли.' }
    $env:LAB_MOTION_PROBE_OUTPUT = $null
    $env:LAB_MOTION_PRESS_TRACE = $null
    $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
    $env:WINAPP_CLI_UPDATE_CHECK = '0'
    foreach ($direction in @(1, -1)) {
        $axis = 'y'
        $name = $axis + $(if ($direction -eq 1) { '-down' } else { '-up' })
        $script:case = (New-Item -ItemType Directory -Path (Join-Path $output $name)).FullName
        $script:trace = Join-Path $case 'trace.jsonl'
        $script:process = $null
        try {
            $env:LAB_MOTION_INTERACTION_OUTPUT = $trace
            $env:LAB_MOTION_INTERACTION_DIRECTION = [string]$direction
            $env:WINAPP_UI_WORKFLOW_ID = [guid]::NewGuid().ToString()
            $script:process = Start-Process -FilePath $app -WorkingDirectory $ApplicationDirectory -WindowStyle Hidden -PassThru
            $ready = Wait-Trace 'ready'
            $process.Refresh()
            if ($process.MainWindowHandle -eq 0) { throw 'Нет окна собственного процесса.' }
            $script:window = $process.MainWindowHandle.ToInt64().ToString()
            @{ pid = $process.Id; window = $window; source = (git -C $PSScriptRoot rev-parse HEAD);
                os = [Environment]::OSVersion.VersionString; appSha256 = (Get-FileHash $app).Hash;
                librarySha256 = (Get-FileHash (Join-Path $ApplicationDirectory 'LabMotion.WinUI.dll')).Hash;
                cliSha256 = (Get-FileHash $cli).Hash; cliVersion = '0.7.1' } |
                ConvertTo-Json | Set-Content (Join-Path $case 'identity.json')
            $inspect = Invoke-Ui 'inspect' @('inspect', '--depth', '8')
            $windows = @($inspect.windows | Where-Object { [string]$_.hwnd -eq $window })
            if ($windows.Count -ne 1 -or $windows[0].coordinateSpace -ne 'physical-screen-pixels') { throw 'Не подтверждены координаты окна.' }
            $stages = @(Find-Stage $windows[0].elements)
            if ($stages.Count -ne 1 -or $stages[0].isOffscreen) { throw 'Не найден видимый TouchStage.' }
            $stage = $stages[0]
            $width = [double]$ready.data.width
            $height = [double]$ready.data.height
            $scale = [double]$ready.data.scale
            if ($scale -le 0 -or [Math]::Abs($stage.width - $width * $scale) -gt 2 -or
                [Math]::Abs($stage.height - $height * $scale) -gt 2 -or
                [Math]::Abs($windows[0].scale - $scale) -gt 0.001) { throw 'UIA и native viewport расходятся.' }
            $start = @{ x = $width / 2; y = $height / 2 - $direction * 40 }
            $end = @{ x = $width / 2; y = $height / 2 + $direction * 40 }
            $screenStart = @{ x = [int][Math]::Round($stage.x + $start.x * $scale); y = [int][Math]::Round($stage.y + $start.y * $scale) }
            $screenEnd = @{ x = [int][Math]::Round($stage.x + $end.x * $scale); y = [int][Math]::Round($stage.y + $end.y * $scale) }
            $scenario = @{ schema = 2; coordinates = 'native'; name = $name; axis = $axis; direction = $direction; gesture = 'swipe'; durationMs = 300;
                start = $start; end = $end; coordinateSpace = 'viewport-dip'; viewport = @{ width = $width; height = $height; scale = $scale };
                injection = @{ start = $screenStart; end = $screenEnd; coordinateSpace = 'screen-pixel'; exitCode = $null } }
            $scenario | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $case 'scenario.json')
            Invoke-Ui 'before' @('screenshot', '--output', (Join-Path $case 'before.png')) | Out-Null
            Invoke-Ui 'swipe' @('touch', '--at', "$($screenStart.x),$($screenStart.y)", '--gesture', 'swipe',
                '--to-point', "$($screenEnd.x),$($screenEnd.y)", '--duration-ms', '300') | Out-Null
            $scenario.injection.exitCode = 0
            $scenario | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $case 'scenario.json')
            Wait-Trace 'idle' | Out-Null
            Invoke-Ui 'after' @('screenshot', '--output', (Join-Path $case 'after.png')) | Out-Null
        } catch {
            $failures.Add($name)
            $_ | Out-String | Set-Content (Join-Path $case 'failure.txt')
        } finally {
            if ($process) {
                try {
                    $forced = $false
                    if (!$process.HasExited) {
                        $null = $process.CloseMainWindow()
                        if (!$process.WaitForExit(5000)) { $forced = $true; $process.Kill($true); $process.WaitForExit() }
                    }
                    $process.Refresh()
                    if ($forced -or $process.ExitCode -ne 0) { $failures.Add("$name-close") }
                    @{ exited = $process.HasExited; forced = $forced; exitCode = $process.ExitCode } |
                        ConvertTo-Json | Set-Content (Join-Path $case 'close.json')
                } finally { $process.Dispose() }
            }
        }
    }
    & node (Join-Path $PSScriptRoot 'assert-touch.mjs') $output
    if ($LASTEXITCODE -ne 0 -or $failures.Count) { throw "Touch-квалификация не прошла. Harness failures: $($failures -join ', ')" }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
}
