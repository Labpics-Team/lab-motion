param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$output = [IO.Path]::GetFullPath($OutputDirectory)
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
$source = $output + '-source'
foreach ($path in @($output, $evidence, $source)) {
    if (Test-Path -LiteralPath $path) { throw "Каталог уже существует: $path" }
}
New-Item -ItemType Directory -Path $output, $evidence | Out-Null
$patch = Join-Path $PSScriptRoot 'winapp-touch-trace.patch'
$upstream = 'e3cd0b94f3e7b776ac51ba0564f4908094e979b5'
$patchSha256 = 'F43DF69B3492DA03A67AE9DB88F52BD6FE48DA7DD02EEEF20D71DF55B5AE3D5B'
# 360 с — заранее выбранный предел опыта, а не оценка длительности сборки.
# Baseline job 125663792174: 223 с; арифметический резерв 317 с не гарантирует срок.
# https://github.com/Labpics-Team/lab-motion/actions/runs/41558699752/job/125663792174
$budgetSeconds = 360
$timer = [Diagnostics.Stopwatch]::StartNew()
$commands = [Collections.Generic.List[object]]::new()
$identity = [ordered]@{
    passed = $false
    variant = '0.7.1-touch-trace'
    repository = 'https://github.com/microsoft/winappCli.git'
    tag = 'v0.7.1'
    upstreamCommit = $upstream
    patchSha256 = $patchSha256
    startedUtc = [DateTime]::UtcNow.ToString('o')
    budgetSeconds = $budgetSeconds
    source = $source
    telemetry = 'public-stub'
    commands = $commands
}

function Invoke-BuildCommand([string]$Name, [string]$Executable, [string[]]$Arguments) {
    $remaining = [int][Math]::Floor(($script:budgetSeconds - $script:timer.Elapsed.TotalSeconds) * 1000)
    if ($remaining -le 0) { throw 'Исчерпан общий бюджет сборки диагностического CLI.' }
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if (Test-Path -LiteralPath $script:source) { $info.WorkingDirectory = $script:source }
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $command = [ordered]@{ name = $Name; executable = $Executable; arguments = $Arguments; exitCode = $null; timedOut = $false }
    $script:commands.Add($command)
    $child = [Diagnostics.Process]::Start($info)
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    try {
        if (!$child.WaitForExit($remaining)) {
            $command.timedOut = $true
            throw "Исчерпан общий бюджет на шаге $Name."
        }
        $command.exitCode = $child.ExitCode
        if ($child.ExitCode -ne 0) { throw "$Name завершился с кодом $($child.ExitCode)." }
        return $stdout.GetAwaiter().GetResult()
    } finally {
        try {
            if (!$child.HasExited) { $child.Kill($true); $child.WaitForExit() }
            $command.exitCode = $child.ExitCode
            [IO.File]::WriteAllText((Join-Path $script:evidence "$Name.stdout.log"), $stdout.GetAwaiter().GetResult())
            [IO.File]::WriteAllText((Join-Path $script:evidence "$Name.stderr.log"), $stderr.GetAwaiter().GetResult())
        } finally { $child.Dispose() }
    }
}

try {
    $identity.patchSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $patch).Hash
    if ($identity.patchSha256 -ne $patchSha256) { throw 'SHA256 применяемого патча не совпал с рассмотренными байтами.' }
    Invoke-BuildCommand 'clone' 'git' @('-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--branch', 'v0.7.1',
        'https://github.com/microsoft/winappCli.git', $source) | Out-Null
    $actualCommit = (Invoke-BuildCommand 'source' 'git' @('-C', $source, 'rev-parse', 'HEAD')).Trim()
    $identity.actualUpstreamCommit = $actualCommit
    if ($actualCommit -ne $upstream) { throw 'Tag winappCli больше не указывает на закреплённый commit.' }
    Invoke-BuildCommand 'patch-check' 'git' @('-C', $source, 'apply', '--check', $patch) | Out-Null
    Invoke-BuildCommand 'patch-apply' 'git' @('-C', $source, 'apply', $patch) | Out-Null
    $identity.sdk = (Invoke-BuildCommand 'sdk-version' 'dotnet' @('--version')).Trim()
    if ($identity.sdk -ne '10.0.403') { throw 'Для диагностической сборки требуется .NET SDK 10.0.403.' }
    Invoke-BuildCommand 'sdk-info' 'dotnet' @('--info') | Out-Null
    $project = Join-Path $source 'src/winapp-CLI/WinApp.Cli/WinApp.Cli.csproj'
    $buildArguments = @('publish', $project, '-c', 'Release', '-r', 'win-x64', '--self-contained', '-o', $output,
        '/p:Version=0.7.1.0', '/p:AssemblyVersion=0.7.1.0', '/p:FileVersion=0.7.1.0',
        '/p:InformationalVersion=0.7.1-touch-trace', '/p:IncludeSourceRevisionInInformationalVersion=false')
    Invoke-BuildCommand 'publish' 'dotnet' $buildArguments | Out-Null
    $properties = (Invoke-BuildCommand 'release-properties' 'dotnet' @('msbuild', $project, '-p:Configuration=Release',
        '-p:RuntimeIdentifier=win-x64', '-getProperty:PublishAot,SelfContained,PublishSingleFile,OptimizationPreference,ControlFlowGuard,TrimMode,TreatWarningsAsErrors,NuGetAudit')) | ConvertFrom-Json
    $expected = @{ PublishAot = 'true'; SelfContained = 'true'; PublishSingleFile = 'true';
        OptimizationPreference = 'Size'; ControlFlowGuard = 'Guard'; TrimMode = 'full'; TreatWarningsAsErrors = 'true'; NuGetAudit = 'true' }
    foreach ($name in $expected.Keys) {
        if ($properties.Properties.$name -ne $expected[$name]) { throw "Изменён build gate: $name." }
    }
    $assets = Get-Content -Raw (Join-Path $source 'src/winapp-CLI/WinApp.Cli/obj/project.assets.json') | ConvertFrom-Json
    $pkcs = @($assets.libraries.PSObject.Properties.Name | Where-Object { $_ -like 'System.Security.Cryptography.Pkcs/*' })
    if ($pkcs.Count -ne 1 -or $pkcs[0] -ne 'System.Security.Cryptography.Pkcs/8.0.2') { throw 'Не подтверждена исправленная зависимость Pkcs 8.0.2.' }
    $identity.pkcs = $pkcs[0]
    $exe = Join-Path $output 'winapp.exe'
    # Читаем PE напрямую: запуск CLI не нужен для подтверждения x64 NativeAOT.
    $stream = [IO.File]::OpenRead($exe)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Нет DOS-заголовка PE.' }
        $stream.Position = 0x3c
        $pe = $reader.ReadUInt32()
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Ожидался x64 PE.' }
        $stream.Position = $pe + 24
        if ($reader.ReadUInt16() -ne 0x20b) { throw 'Ожидался PE32+.' }
        $stream.Position = $pe + 24 + 112 + 14 * 8
        $clrRva = $reader.ReadUInt32()
        $clrSize = $reader.ReadUInt32()
        if ($clrRva -ne 0 -or $clrSize -ne 0) { throw 'CLI содержит CLR descriptor вместо NativeAOT.' }
    } finally { $reader.Dispose() }
    $identity.pe = @{ machine = 'x64'; format = 'PE32+'; clrRva = $clrRva; clrSize = $clrSize }
    $identity.exeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash
    $identity.signature = [string](Get-AuthenticodeSignature -LiteralPath $exe).Status
    $identity.files = @(Get-ChildItem -LiteralPath $output -File | ForEach-Object {
        @{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash }
    })
    if ($timer.Elapsed.TotalSeconds -gt $budgetSeconds) { throw 'Сборка и чтение идентичности превысили бюджет опыта.' }
    $identity.passed = $true
} catch {
    $_ | Out-String | Set-Content (Join-Path $evidence 'failure.txt')
    throw
} finally {
    $identity.elapsedSeconds = $timer.Elapsed.TotalSeconds
    $identity.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $json = $identity | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText((Join-Path $evidence 'identity.json'), $json)
    if ($identity.passed) { [IO.File]::WriteAllText((Join-Path $output 'identity.json'), $json) }
}
