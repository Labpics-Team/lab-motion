param([string]$Harness = (Join-Path $PSScriptRoot 'verify-input.ps1'))
$ErrorActionPreference = 'Stop'
class ClientAreaAnimation {
    static [bool] $Current = $true
    static [void] Write([bool]$value) { [ClientAreaAnimation]::Current = $value }
    static [bool] Read() { return [ClientAreaAnimation]::Current }
}
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($Harness), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid harness syntax' }
$outer = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[-1]
$cleanup = [scriptblock]::Create($outer.Finally.Extent.Text.Substring(1, $outer.Finally.Extent.Text.Length - 2))

# Выполняется настоящий finally, но процессы, настройки и запись подменены.
foreach ($fault in @('none', 'commands', 'close', 'record')) {
    [ClientAreaAnimation]::Current = $true
    $animationBefore = $false
    $saved = @{}
    $passed = $false
    $evidence = [IO.Path]::GetTempPath()
    $commands = @(@{ name = 'example' })
    $script:disposed = $false
    $process = [pscustomobject]@{ HasExited = $true; ExitCode = 0 }
    $process | Add-Member ScriptMethod Refresh { }
    $process | Add-Member ScriptMethod Dispose { $script:disposed = $true }
    $recording = $null
    if ($fault -eq 'record') {
        $recorder = [pscustomobject]@{ HasExited = $false }
        $recorder | Add-Member ScriptMethod Kill { throw [IO.IOException]::new('injected recorder failure') }
        $recording = @{ ended = $false; process = $recorder }
    }
    function Set-Content {
        param([Parameter(Position = 0)][string]$Path, [Parameter(ValueFromPipeline = $true)]$InputObject)
        process {
            if ([IO.Path]::GetFileName($Path) -eq "$fault.json") {
                throw [IO.IOException]::new('injected evidence failure')
            }
        }
    }
    $failed = $false
    try { & $cleanup } catch { $failed = $true }
    if ([ClientAreaAnimation]::Current -or !$script:disposed -or $failed -ne ($fault -ne 'none')) {
        throw "Cleanup contract failed: $fault"
    }
}
'cleanup: 4 PASS'
