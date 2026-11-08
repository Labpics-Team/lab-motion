param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native diagnostic compiler требует Windows.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Каталог native diagnostic build уже существует.' }
New-Item -ItemType Directory -Path $output | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Установленный vswhere не найден; новый toolchain не устанавливается.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or $installation -isnot [string] -or !$installation) { throw 'Установленный VC x64 toolchain не найден.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
if (!(Test-Path -LiteralPath $vcvars)) { throw 'Установленный VC x64 environment не найден.' }
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../examples/windows/native/PreferenceDiagnostics.cpp'))
$controls = Join-Path $PSScriptRoot 'native-preference-controls.cpp'
foreach ($path in @($output, $vcvars, $source, $controls)) {
    if ($path -match '["%!\r\n]') { throw 'Путь несовместим с конечной cmd compiler invocation.' }
}

function Compile([string]$Name, [string]$InputFile, [switch]$Library) {
    $object = Join-Path $output "$Name.obj"
    $target = Join-Path $output ($Name + $(if ($Library) { '.dll' } else { '.exe' }))
    $mode = if ($Library) { '/LD' } else { '' }
    # vcvars и cl живут в одном subprocess; полный set/runner env не публикуется.
    $command = 'call "{0}" >nul && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /MT /DWIN32_LEAN_AND_MEAN /DNOMINMAX {1} /Fo"{2}" "{3}" /link /OUT:"{4}" ole32.lib runtimeobject.lib comctl32.lib user32.lib' -f $vcvars, $mode, $object, $InputFile, $target
    Push-Location -LiteralPath $output
    try {
        & cmd.exe /d /s /c $command 2>&1 | Tee-Object -FilePath (Join-Path $output "$Name-build.log")
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0 -or !(Test-Path -LiteralPath $target)) { throw "Native diagnostic compiler не подтвердил $Name." }
}

Compile 'LabMotion.PreferenceDiagnostics' $source -Library
Compile 'native-preference-controls' $controls
& (Join-Path $output 'native-preference-controls.exe') 2>&1 | Tee-Object -FilePath (Join-Path $output 'native-preference-controls.log')
if ($LASTEXITCODE -ne 0) { throw 'Native diagnostic ABI/lifetime controls не прошли.' }

# Мутации собирают те же executable assertions против изменённого production source.
# Ошибка compiler/setup не считается RED: нужен точный отказ ожидаемого свойства.
$production = [IO.File]::ReadAllText($source)
$fixture = [IO.File]::ReadAllText($controls)
foreach ($mutation in @(
    @{ name = 'control-contamination'; from = 'record->snapshot.count = 0;'; to = 'record->snapshot.count = record->snapshot.controlCount;'; expected = 'control-separate-reset-before-add-zero-token' },
    @{ name = 'false-detach'; from = 'else state.flags |= Faulted;'; to = 'else state.flags = (state.flags | Faulted) & ~Attached;'; expected = 'failed-remove-attached-faulted' }
)) {
    if (!$production.Contains($mutation.from)) { throw 'Native mutation source point отсутствует.' }
    $mutant = $production.Replace($mutation.from, $mutation.to)
    $mutantSource = Join-Path $output ($mutation.name + '.cpp')
    [IO.File]::WriteAllText($mutantSource, $mutant)
    $mutantFixture = Join-Path $output ($mutation.name + '-controls.cpp')
    $include = '#include "../../examples/windows/native/PreferenceDiagnostics.cpp"'
    if (!$fixture.Contains($include)) { throw 'Native mutation fixture composition отсутствует.' }
    [IO.File]::WriteAllText($mutantFixture, $fixture.Replace($include, '#include "' + $mutation.name + '.cpp"'))
    Compile ($mutation.name + '-controls') $mutantFixture
    $result = & (Join-Path $output ($mutation.name + '-controls.exe')) 2>&1
    $code = $LASTEXITCODE
    $text = ($result | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -eq 0 -or $text.Trim() -cne $mutation.expected) { throw "Native mutation не отвергнута expected assertion: $($mutation.name)." }
    Write-Host ("native mutation rejected: " + $mutation.name)
}
