import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const input = read('./verify-input.ps1');
const touch = read('./verify-touch.ps1');
const helper = read('./process-tools.ps1');
const witness = read('./touch-cleanup.test.ps1');
const importOwner = ". (Join-Path $PSScriptRoot 'process-tools.ps1')";

function violations(source, owner) {
  return [
    ['one function-only owner', !source.includes(importOwner) ||
      JSON.stringify([...owner.matchAll(/^function ([\w-]+)\(/gm)].map(match => match[1]).sort()) !==
      JSON.stringify(['Read-ProcessHasExited', 'Read-ProcessExitCode', 'Save-CleanupFailure', 'Finish-Tool', 'Close-OwnedProcess'].sort())],
    ['bounded waits', /\.WaitForExit\(\)/.test(source + owner) || !owner.includes('$Timeout - $closeClock.ElapsedMilliseconds') ||
      !owner.includes('$Timeout - $toolClock.ElapsedMilliseconds')],
    ['bounded redirected streams', !owner.includes('$Tool.stdout.WaitAsync([TimeSpan]::FromMilliseconds($remaining)).GetAwaiter().GetResult()') ||
      !owner.includes('$Tool.stderr.WaitAsync([TimeSpan]::FromMilliseconds($remaining)).GetAwaiter().GetResult()')],
    ['one forced attempt and independent wait', (owner.match(/\$Process.Kill\(\$true\)/g) ?? []).length !== 1 ||
      !owner.includes('$stopped = $Process.WaitForExit($remaining)') || !owner.includes('$stopped -isnot [bool]')],
    ['caller disposal preserves first error', !source.includes('try { $process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$caseFailure) }') ||
      !source.includes('try { $child.Dispose() } catch { Save-CleanupFailure $_ ([ref]$failure) }')],
    ['primary before diagnostic write', !/\$caseFailure = \$_\s+\$failures.Add\(\$name\)\s+try \{ \$caseFailure \| Out-String/.test(source)],
    ['terminal preserves first case failure', !source.includes('Save-CleanupFailure $caseFailure ([ref]$primaryFailure)') ||
      !/\} catch \{\s+Save-CleanupFailure \$_ \(\[ref\]\$primaryFailure\)\s+throw \$primaryFailure/.test(source)],
    ['restoration continues and preserves primary', !source.includes('catch { Save-CleanupFailure $_ ([ref]$restoreFailure) }') ||
      !source.includes('if ($null -eq $primaryFailure) { throw $restoreFailure }')],
    ['actual shared finish and close entry', !source.includes('return Finish-Tool $tool') ||
      !source.includes('$receipt = Close-OwnedProcess $process -Timeout 5000 -Graceful') ||
      !/^\$toolTimeoutMilliseconds = 30000$/m.test(source)],
  ].filter(([, bad]) => bad).map(([name]) => name);
}

test('F1 исходный touch cleanup обнаруживается как неограниченный SOURCE путь', () => {
  // Контрпример из 27b819936c9ad3c058ca8123c40d7fa4bbb0e076; не требует git history shallow runner.
  const baseline = '$child.Kill($true); $child.WaitForExit()\n$process.Kill($true); $process.WaitForExit()';
  assert(violations(baseline, '').includes('bounded waits'));
});

test('input и touch используют один bounded process owner без второго executable harness', () => {
  assert.deepEqual(violations(touch, helper), []);
  assert(input.includes(importOwner));
  assert(input.includes('$null = Close-OwnedProcess $recording.process -Timeout $toolTimeoutMilliseconds'));
  assert(input.includes('$receipt = Close-OwnedProcess $process -Timeout 5000 -Graceful'));
  assert(!/\.WaitForExit\(\)/.test(input));
  assert(!/ParseInput|FunctionDefinitionAst/.test(touch), 'AST используется только witness, не runtime-import');
  assert(!/^function (Finish-Tool|Close-OwnedProcess|Save-CleanupFailure)\(/m.test(input + touch));
  for (const [from, to, wanted] of [
    ['$Process.WaitForExit($remaining)', '$Process.WaitForExit()', 'bounded waits'],
    ['$Timeout - $closeClock.ElapsedMilliseconds', '$Timeout', 'bounded waits'],
    ['$stopped -isnot [bool]', '$false', 'one forced attempt and independent wait'],
    ['$Tool.stdout.WaitAsync([TimeSpan]::FromMilliseconds($remaining))', '$Tool.stdout', 'bounded redirected streams'],
    ['$Tool.stderr.WaitAsync([TimeSpan]::FromMilliseconds($remaining))', '$Tool.stderr', 'bounded redirected streams'],
  ]) assert(violations(touch, helper.replaceAll(from, to)).includes(wanted), wanted);
  for (const [from, to, wanted] of [
    [importOwner, '', 'one function-only owner'],
    ['try { $process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$caseFailure) }', '$process.Dispose()', 'caller disposal preserves first error'],
    ['$caseFailure = $_', '$caseFailure = $null', 'primary before diagnostic write'],
    ['Save-CleanupFailure $caseFailure ([ref]$primaryFailure)', '$null', 'terminal preserves first case failure'],
    ['Save-CleanupFailure $_ ([ref]$primaryFailure)', '$primaryFailure = $_', 'terminal preserves first case failure'],
    ['if ($null -eq $primaryFailure) { throw $restoreFailure }', 'throw $restoreFailure', 'restoration continues and preserves primary'],
  ]) assert(violations(touch.replaceAll(from, to), helper).includes(wanted), wanted);
});

test('реальный PS witness подключён до touch и проверяет функции, case finally и restoration', () => {
  assert(touch.includes("& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'touch-cleanup.test.ps1')"));
  assert(touch.indexOf("'touch-cleanup.test.ps1'") < touch.indexOf('foreach ($direction'));
  assert(touch.includes("(Join-Path $PSScriptRoot 'assert-touch.test.mjs') (Join-Path $PSScriptRoot 'touch-cleanup.test.mjs')"));
  assert(witness.includes(importOwner));
  assert(witness.includes('$caseOwners[0].Finally.Extent.Text'));
  assert(witness.includes('$outer.Finally.Extent.Text'));
  assert(witness.includes('Finish-Tool $tool'));
  assert(witness.includes('[object]::ReferenceEquals($caseFailure, $original)'));
  for (const fault of ['healthy', 'timeout', 'wait', 'wait-null', 'has', 'has-null', 'has-invalid', 'has-late',
    'exit', 'exit-null', 'close', 'kill', 'stop-wait', 'stop-null', 'stop-false', 'dispose', 'wait-kill',
    'wait-kill-dispose', 'has-null-close-kill-dispose', 'evidence']) assert(witness.includes(`'${fault}'`), fault);
  assert(witness.includes('touch-unbounded-wait-control'));
  assert(witness.includes('touch-cleanup-secondary-control'));
  assert(witness.includes('touch-environment-arbitration-control'));
  assert(witness.includes('[Threading.Tasks.TaskCompletionSource[string]]::new()'));
  for (const fault of ['stdout-pending', 'stderr-pending', 'stdout-pending-dispose', 'stderr-pending-dispose',
    'stdout-fault-stderr-pending', 'exhausted']) assert(witness.includes(`'${fault}'`), fault);
  assert(witness.includes('touch-task-deadline-disposal-control'));
  assert(witness.includes('touch-task-timeout-control'));
  assert(witness.includes('touch-task-primary-control'));
  assert(witness.includes('$outer.Body.Statements | Select-Object -Last 2'));
  assert(witness.includes('$outer.CatchClauses[0].Body.Extent.Text'));
  assert(witness.includes('touch-terminal-primary-fallback-control'));
  assert(witness.includes('touch-terminal-both-directions-control'));
  assert(witness.includes("'case-log-oracle-fail'"));
});

test('capture/rest budgets владельца не меняются при выносе process owner', () => {
  assert(/^\$restTimeoutSeconds = 8$/m.test(input));
  assert(/^\$recordReadyTimeoutSeconds = 15$/m.test(input));
  assert(input.includes('$recordInputBudgetMilliseconds = ($recordReadyTimeoutSeconds + 2 * $restTimeoutSeconds) * 1000 + $toolTimeoutMilliseconds'));
  assert(input.includes('$recordDurationSeconds = [int]($recordInputBudgetMilliseconds / 1000) + 1'));
  assert(helper.includes('function Finish-Tool($Tool, [int]$Timeout = $toolTimeoutMilliseconds)'));
  assert(input.includes('$toolTimeoutMilliseconds - $recordCleanupClock.ElapsedMilliseconds'));
  assert(input.includes('$recording.stderr.WaitAsync([TimeSpan]::FromMilliseconds($remaining)).GetAwaiter().GetResult()'));
});
