import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyTrace, verifyCaptureWindow } from './assert-input.mjs';

function normalizeSourceText(source) { return source.replace(/\r\n/g, '\n'); }
function readSource(url) { return normalizeSourceText(readFileSync(url, 'utf8')); }

// Это синтетические свидетели oracle, не результаты нативного ввода или отрисовки.
function fixture() {
  const blocks = [];
  let operation = 0;
  for (const name of ['mouse-hold', 'mouse-interrupt', 'pointer-out', 'keyboard', 'disable-animation', 'reduced-motion', 'system-disable-animation', 'system-reduced-motion', 'system-restored-motion']) {
    const events = [];
    const add = (kind, data) => events.push({ kind, data });
    const input = event => add('input', name === 'keyboard' ? { event, device: 'Keyboard', key: 'Space' } : { event, device: 'Mouse', pointerId: 1 });
    const intent = (pressed, trigger = 'pressed', localAnimation = name !== 'reduced-motion', systemAnimation = name !== 'system-reduced-motion') => {
      const id = ++operation;
      add('intent', { operation: id, trigger, pressed, enabled: true, localAnimation,
        systemAnimation, target: Number(pressed) });
      return id;
    };
    const motion = (id, phase, position) => add('motion', { pageOperation: id, nativeOperation: id, phase, position, readbackPosition: position, nativeSeconds: events.length / 100 });
    const snap = (id, target) => {
      add('snapRequested', { operation: id, target });
      add('snapReadback', { operation: id, target, position: target });
    };
    const complete = (id, target) => {
      motion(id, 'idle', target);
      add('completed', { operation: id, nativeOperation: id, end: 'Finished', reason: 'settled', isCurrent: true });
    };
    if (name === 'disable-animation' || name === 'system-disable-animation') {
      input('pointerPressed');
      const down = intent(true);
      motion(down, 'requested', 0);
      input('pointerReleased');
      const up = intent(false);
      motion(up, 'requested', .8);
      motion(up, 'value', .4);
      add('completed', { operation: down, nativeOperation: down, end: 'Stopped', reason: 'replaced', isCurrent: false });
      const system = name === 'system-disable-animation';
      const id = intent(false, system ? 'systemPreference' : 'localPreference', system, !system);
      snap(id, 0);
      add('completed', { operation: up, nativeOperation: up, end: 'Stopped', reason: 'snap', isCurrent: false });
    } else {
      input(name === 'keyboard' ? 'keyDown' : 'pointerPressed');
      const down = intent(true);
      if (name.endsWith('reduced-motion')) snap(down, 1);
      else {
        motion(down, 'requested', 0);
        for (const value of [.2, .5, .8]) motion(down, 'value', value);
        if (name === 'mouse-hold') complete(down, 1);
      }
      if (name === 'pointer-out') input('pointerExited');
      input(name === 'keyboard' ? 'keyUp' : 'pointerReleased');
      const up = intent(false);
      if (name.endsWith('reduced-motion')) snap(up, 0);
      else {
        motion(up, 'requested', .8);
        motion(up, 'value', .4);
        if (name !== 'mouse-hold') add('completed', { operation: down, nativeOperation: down, end: 'Stopped', reason: 'replaced', isCurrent: false });
        complete(up, 0);
      }
    }
    blocks.push({ name, events });
  }
  return blocks;
}

function verify(blocks) {
  const events = [{ sequence: 1, seconds: 0, kind: 'attached', data: { scale: 1 } }];
  const scenarios = blocks.map(block => {
    const after = events.length;
    for (const event of block.events) events.push({ ...event, sequence: events.length + 1, seconds: events.length / 100 });
    return { name: block.name, after, through: events.length };
  });
  return verifyTrace(events, scenarios);
}

test('полный синтетический witness допускается; pointer-out не навязывает порядок IsPressed/release', () => {
  const result = verify(fixture());
  assert.equal(result.length, 9);
  assert.equal(result.find(r => r.name === 'pointer-out').unpressedBeforeRelease, false);
});

for (const [name, mutate, expected] of [
  ['пропущен реальный Mouse down', block => { block.events = block.events.filter(e => e.data.event !== 'pointerPressed'); }, /нет Mouse pointerPressed/],
  ['движение вообще не наблюдалось', block => { block.events = block.events.filter(e => e.kind !== 'motion'); }, /нет покоя у цели/],
  ['нет промежуточных значений', block => { block.events = block.events.filter(e => e.data.phase !== 'value'); }, /нет трёх промежуточных/],
  ['трасса обрезана', block => { block.events.push({ kind: 'truncated', data: {} }); }, /содержит truncated/],
]) test(name, () => {
  const blocks = fixture();
  mutate(blocks[0]);
  assert.throws(() => verify(blocks), expected);
});

test('CLI hold0 без фактического interruption не принимается', () => {
  const blocks = fixture();
  blocks[1].events.find(e => e.data.reason === 'replaced').data.end = 'Finished';
  assert.throws(() => verify(blocks), /не было прервано/);
});

test('замена ожидающего request не подменяет прерывание движения', () => {
  const blocks = fixture();
  blocks[1].events = blocks[1].events.filter(e => e.data.phase !== 'value');
  assert.throws(() => verify(blocks), /движение не началось/);
});

test('reduced motion отклоняет настоящий запрос анимации', () => {
  const blocks = fixture();
  const id = blocks[5].events.find(e => e.kind === 'intent').data.operation;
  blocks[5].events.push({ kind: 'motion', data: { pageOperation: id, nativeOperation: id, phase: 'requested', position: 0, readbackPosition: 0, nativeSeconds: 0 } });
  assert.throws(() => verify(blocks), /анимация при отключённом/);
});

test('system reduced motion требует local=true/system=false и отклоняет игнорирование системного запрета', () => {
  const healthy = fixture();
  assert.equal(verify(healthy).find(result => result.name === 'system-reduced-motion').passed, true);
  const block = healthy.find(b => b.name === 'system-reduced-motion');
  const id = block.events.find(event => event.kind === 'intent').data.operation;
  block.events.push({ kind: 'motion', data: { pageOperation: id, nativeOperation: id,
    phase: 'requested', position: 0, readbackPosition: 0, nativeSeconds: 0 } });
  assert.throws(() => verify(healthy), /движение после системного/);
  for (const key of ['localAnimation', 'systemAnimation']) {
    const wrongState = fixture();
    wrongState.find(b => b.name === 'system-reduced-motion').events.find(event => event.kind === 'intent').data[key] = key === 'systemAnimation';
    assert.throws(() => verify(wrongState), /локальная.*системная/);
  }
});

test('состояния различают настоящий PressPage guard и named mutant без systemAnimation', () => {
  const source = readSource(new URL('../../examples/windows/PressPage.xaml.cs', import.meta.url));
  const condition = source.match(/if \((!localAnimation \|\| !systemAnimation)\)/)?.[1];
  assert(condition, 'проверяется условие настоящего PressPage, а не копия правила');
  // Только проекция ветки C# над наблюдаемыми bool; это не нативный запуск страницы.
  const branch = new Function('localAnimation', 'systemAnimation', `return ${condition}`);
  const mutant = new Function('localAnimation', 'systemAnimation', 'return !localAnimation');
  const intents = fixture().flatMap(block => block.events).filter(event => event.kind === 'intent');
  assert(intents.every(event => branch(event.data.localAnimation, event.data.systemAnimation)
    === (!event.data.localAnimation || !event.data.systemAnimation)));
  const discriminators = intents.filter(event => branch(event.data.localAnimation, event.data.systemAnimation)
    !== mutant(event.data.localAnimation, event.data.systemAnimation));
  assert.equal(discriminators.length, 3);
  assert(discriminators.every(event => event.data.localAnimation && !event.data.systemAnimation));
});

function processCleanupViolations(source) {
  const cleanup = source.slice(source.lastIndexOf('} finally {'));
  return [
    ['own handle validated before identity', !/\$handle = \$process\.Handle\s+if \(\$null -eq \$handle -or \$handle -eq \[IntPtr\]::Zero\) \{\s+throw '[^']+'\s+\}\s+\$started = \$process\.StartTime/.test(source)],
    ['start time validated before identity', !/\$started = \$process\.StartTime\s+if \(\$started -isnot \[DateTime\]\) \{\s+throw '[^']+'\s+\}\s+\$identity =/.test(source)],
    ['own process disposal', !source.includes('$process.Dispose()')],
    ['own process termination', !source.includes('$process.Kill()')],
    ['original failure retained', !source.includes('$primaryFailure = $_')],
    ['environment restored finally', !cleanup.includes('$env:LAB_MOTION_PROBE_OUTPUT = $previousOutput')],
    ['real process witness wired', !source.includes("'process-cleanup.test.ps1'")],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

function assertProcessCleanupSource(source) {
  assert.deepEqual(processCleanupViolations(source), []);
  for (const [before, after, expected] of [
    ['$handle = $process.Handle', '$handle = $null', 'own handle validated before identity'],
    ['$null -eq $handle -or $handle -eq [IntPtr]::Zero', '$false', 'own handle validated before identity'],
    ['$null -eq $handle -or ', '', 'own handle validated before identity'],
    [' -or $handle -eq [IntPtr]::Zero', '', 'own handle validated before identity'],
    ['$started -isnot [DateTime]', '$false', 'start time validated before identity'],
    ['$started -isnot [DateTime]', '$started -is [DateTime]', 'start time validated before identity'],
    ['$process.Dispose()', '$null', 'own process disposal'],
    ['$process.Kill()', '$null', 'own process termination'],
    ['$primaryFailure = $_', '$primaryFailure = $null', 'original failure retained'],
    ['$env:LAB_MOTION_PROBE_OUTPUT = $previousOutput', '$null', 'environment restored finally'],
    ['process-cleanup.test.ps1', 'missing-process-test.ps1', 'real process witness wired'],
  ]) assert(processCleanupViolations(source.replace(before, after)).includes(expected), expected);
}

test('post-start lifetime source contract retains cleanup, original error and the actual PowerShell witness', () => {
  assertProcessCleanupSource(readSource(new URL('./verify.ps1', import.meta.url)));
});

test('process witness retains getter faults, invalid identity and a non-effect .NET getter control', () => {
  const source = readSource(new URL('./process-cleanup.test.ps1', import.meta.url));
  for (const fault of ['handle', 'start-time', 'handle-null', 'handle-zero', 'start-time-null', 'start-time-invalid']) {
    assert(source.includes(`'${fault}'`), fault);
  }
  assert(source.includes('Add-Member ScriptProperty $property'));
  assert(source.includes("throw [InvalidOperationException]::new('primary-identity')"));
  assert(source.includes('$script:killed -ne $needsKill'));
  assert(source.includes('$script:waitReached -ne $expectsWait'));
  assert(source.includes('$unassociated = [Diagnostics.Process]::new()'));
  assert(source.includes('$unassociatedHandle = $unassociated.Handle'));
  assert(source.includes('finally { $unassociated.Dispose() }'));
  assert(!source.includes('$unassociated.Start('));
});

test('правильный SnapTo request с неверным положением не проходит', () => {
  const blocks = fixture();
  blocks[5].events.find(e => e.kind === 'snapReadback').data.position = .5;
  assert.throws(() => verify(blocks), /нет readback у цели/);
});

test('статическое выключение анимации не подменяет прерывание', () => {
  const blocks = fixture();
  blocks[4].events = blocks[4].events.filter(e => e.data.reason !== 'snap');
  assert.throws(() => verify(blocks), /не прервала движение/);
});

test('отмена ожидающего release не подменяет выключение во время движения', () => {
  const blocks = fixture();
  blocks[4].events = blocks[4].events.filter(e => e.data.phase !== 'value');
  assert.throws(() => verify(blocks), /отпускание не двигалось/);
});

for (const [name, mutate, expected] of [
  ['не тот источник предпочтения', events => { events.find(e => e.data.trigger === 'systemPreference').data.trigger = 'localPreference'; }, /не наблюдалось выключение/],
  ['нет прерывания', events => { events.splice(events.findIndex(e => e.data.reason === 'snap'), 1); }, /не прервала движение/],
  ['нет snap readback', events => { events.splice(events.findIndex(e => e.kind === 'snapReadback'), 1); }, /нет readback/],
  ['нет промежуточного движения', events => { events.splice(events.findIndex(e => e.data.phase === 'value'), 1); }, /отпускание не двигалось/],
  ['операция уже завершилась', events => {
    const up = events.filter(e => e.kind === 'intent' && e.data.trigger === 'pressed').at(-1).data.operation;
    events.splice(events.findIndex(e => e.data.trigger === 'systemPreference'), 0,
      { kind: 'completed', data: { operation: up, nativeOperation: up, end: 'Finished', reason: 'settled', isCurrent: true } });
  }, /операция завершилась до/],
  ['late current value', events => {
    const preference = events.find(e => e.data.trigger === 'systemPreference').data.operation;
    events.push({ kind: 'motion', data: { pageOperation: preference, nativeOperation: preference - 1, phase: 'value', position: .3, readbackPosition: .3, nativeSeconds: 1 } });
  }, /движение после системного/],
  ['late requested', events => {
    const up = events.filter(e => e.kind === 'intent' && e.data.trigger === 'pressed').at(-1).data.operation;
    events.push({ kind: 'motion', data: { pageOperation: up, nativeOperation: up, phase: 'requested', position: .3, readbackPosition: .3, nativeSeconds: 1 } });
  }, /движение после системного/],
]) test(`системное выключение: ${name}`, () => {
  const blocks = fixture();
  mutate(blocks.find(block => block.name === 'system-disable-animation').events);
  assert.throws(() => verify(blocks), expected);
});

test('системный запрет отклоняет late current value за границей самого interruption-сценария', () => {
  const blocks = fixture();
  const block = blocks.find(b => b.name === 'system-reduced-motion');
  const id = block.events.find(e => e.kind === 'intent').data.operation;
  block.events.push({ kind: 'motion', data: { pageOperation: id, nativeOperation: id - 1, phase: 'value', position: .3, readbackPosition: .3, nativeSeconds: 1 } });
  assert.throws(() => verify(blocks), /движение после системного/);
});

test('возвращённые bool без здорового движения не подменяют animated restoration', () => {
  const blocks = fixture();
  const block = blocks.find(b => b.name === 'system-restored-motion');
  block.events = block.events.filter(e => e.data.phase !== 'value');
  assert.throws(() => verify(blocks), /восстановленное движение/);
});

function inputCleanupViolations(source) {
  return [
    ['completion bool validated before use', !/\$exited = \$Process\.HasExited\s+if \(\$exited -isnot \[bool\]\)/.test(source)],
    ['exit code int validated before use', !/\$exitCode = \$Process\.ExitCode\s+if \(\$exitCode -isnot \[int\]\)/.test(source)],
    ['only qualified completion getters', (source.match(/\.HasExited\b/g) ?? []).length !== 1 || (source.match(/\.ExitCode\b/g) ?? []).length !== 1],
    ['post-refresh qualified evidence', !/\$process\.Refresh\(\)\s+\$exited = Read-ProcessHasExited \$process\s+if \(!\$exited\) \{ throw '[^']+' \}\s+\$exitCode = Read-ProcessExitCode \$process/.test(source)
      || !source.includes('@{ exited = $exited; forced = $forced; exitCode = $exitCode }')],
    ['first completion failure retained through stop failure', (source.match(/catch \{ \$completionReadFailed = \$true; Save-CleanupFailure \$_ \(\[ref\]\$cleanupFailure\) \}/g) ?? []).length !== 2
      || (source.match(/catch \{ \$stopFailed = \$true; Save-CleanupFailure \$_ \(\[ref\]\$cleanupFailure\) \}/g) ?? []).length !== 2],
    ['primary captured before evidence', !/\$primaryFailure = \$_\s+try \{ \$primaryFailure \| Out-String \| Set-Content/.test(source)],
    ['application disposal encloses process boundary', !/if \(\$process\) \{\s+try \{\s+\$forced = \$false/.test(source)],
    ['cleanup retains primary', !/if \(\$null -eq \$primaryFailure\) \{ throw \$cleanupFailure \}/.test(source)],
    ['fixed observable warning', !source.includes("Write-Warning 'Очистка после ошибки не завершена.' -WarningAction Continue")],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

function assertInputCleanupSource(source) {
  assert.deepEqual(inputCleanupViolations(source), []);
  for (const [before, after, expected] of [
    ['$exited -isnot [bool]', '$false', 'completion bool validated before use'],
    ['$exitCode -isnot [int]', '$false', 'exit code int validated before use'],
    ['$needsClose = !(Read-ProcessHasExited $process)', '$needsClose = !$process.HasExited', 'only qualified completion getters'],
    ['$exited = Read-ProcessHasExited $process', '$exited = $true', 'post-refresh qualified evidence'],
    ['$completionReadFailed = $true; Save-CleanupFailure $_ ([ref]$cleanupFailure)', 'throw', 'first completion failure retained through stop failure'],
    ['$primaryFailure = $_', '$primaryFailure = $null', 'primary captured before evidence'],
    ['try {\n            $forced = $false', '$forced = $false', 'application disposal encloses process boundary'],
    ['if ($null -eq $primaryFailure) { throw $cleanupFailure }', 'throw $cleanupFailure', 'cleanup retains primary'],
    ["Write-Warning 'Очистка после ошибки не завершена.' -WarningAction Continue", '$null', 'fixed observable warning'],
  ]) assert(inputCleanupViolations(source.replaceAll(before, after)).includes(expected), expected);
}

test('input source captures primary before evidence and disposes across process boundaries', () => {
  assertInputCleanupSource(readSource(new URL('./verify-input.ps1', import.meta.url)));
});

test('input witness preserves getter negatives, late reads and actual helper loading', () => {
  const source = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const fault of ['has-exited', 'has-null', 'has-invalid', 'has-exited-late', 'has-null-late', 'has-invalid-late',
    'exit-code', 'exit-code-null', 'exit-code-invalid', 'post-refresh-running', 'record-healthy',
    'record-has-exited', 'record-has-null', 'record-has-invalid', 'record-has-exited-late', 'record-has-null-late', 'record-has-invalid-late']) {
    assert(source.includes(`'${fault}'`), fault);
  }
  assert(source.includes('FunctionDefinitionAst'));
  assert(source.includes('. $completionReaders'));
  assert(source.includes('!$script:closeReached -or !$script:closeWaitReached -or $script:exitCodeReached'));
  assert(source.includes('!$script:recorderKillReached -or !$script:recorderWaitReached'));
  assert(source.includes('$unassociated.HasExited'));
  assert(source.includes('finally { $unassociated.Dispose() }'));
  assert(!source.includes('$unassociated.Start('));
});

test('input witness requires first completion error and observable secondary termination failures', () => {
  const source = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const fault of ['has-null-close-main', 'has-null-close-wait', 'has-null-kill', 'has-null-kill-wait', 'record-has-null-kill']) {
    assert(source.includes(`'${fault}'`), fault);
  }
  assert(source.includes("$observed.Exception.Message -notmatch 'bool HasExited'"));
  assert(source.includes('[regex]::Escape($secondary)'));
  assert(source.includes('$script:killWaitReached -ne'));
});

function cleanupArbitrationViolations(source) {
  return [
    ['typed first-error arbitration', !/function Save-CleanupFailure\(\[Management\.Automation\.ErrorRecord\]\$Failure, \[ref\]\$FirstFailure\)/.test(source)
      || !/if \(\$null -eq \$FirstFailure.Value\) \{ \$FirstFailure.Value = \$Failure \}/.test(source)],
    ['secondary failures observable', !source.includes("Write-Warning ('Вторичная ошибка очистки: ' + $Failure.Exception.Message) -WarningAction Continue")],
    ['cleanup throw independent of passed', !/if \(\$null -ne \$cleanupFailure\) \{\s+if \(\$null -eq \$primaryFailure\) \{ throw \$cleanupFailure \}/.test(source)],
    ['close outcome preserves input primary', !source.includes('if ($null -eq $primaryFailure -and $passed -and !$closed)')],
    ['both disposals arbitrated', !source.includes('try { $recording.process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$cleanupFailure) }')
      || !source.includes('try { $process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$cleanupFailure) }')],
    ['environment restoration per value', !/foreach \(\$name in \$saved.Keys\) \{\s+try \{ \[Environment\]::SetEnvironmentVariable\(\$name, \$saved\[\$name\]\) \}\s+catch \{ Save-CleanupFailure \$_ \(\[ref\]\$cleanupFailure\) \}/.test(source)],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

function assertCleanupArbitrationSource(source) {
  assert.deepEqual(cleanupArbitrationViolations(source), []);
  for (const [before, after, expected] of [
    ['$FirstFailure.Value = $Failure', '$null', 'typed first-error arbitration'],
    ['$null -eq $FirstFailure.Value', '$true', 'typed first-error arbitration'],
    ['-WarningAction Continue', '-WarningAction Stop', 'secondary failures observable'],
    ['throw $cleanupFailure', 'throw', 'cleanup throw independent of passed'],
    ['$null -eq $primaryFailure -and $passed -and !$closed', '$passed -and !$closed', 'close outcome preserves input primary'],
    ['try { $process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$cleanupFailure) }', '$process.Dispose()', 'both disposals arbitrated'],
  ]) assert(cleanupArbitrationViolations(source.replaceAll(before, after)).includes(expected), expected);
}

test('input cleanup retains the first error across Dispose, app cleanup and restoration', () => {
  assertCleanupArbitrationSource(readSource(new URL('./verify-input.ps1', import.meta.url)));
  const witness = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const fault of ['has-null-dispose', 'record-has-null-app-close', 'record-has-null-dispose', 'has-null-restore-read', 'has-null-restore-env']) {
    assert(witness.includes(`'${fault}'`), fault);
  }
  assert(witness.includes("'Save-CleanupFailure'"));
  assert(witness.includes("$saved['LAB_MOTION_INVALID=NAME']"));
  assert(witness.includes('!$passed -or !$observed'));
  assert(witness.includes('[object]::ReferenceEquals($first, $firstControl)'));
});

test('LF and in-memory Windows CRLF retain healthy source and the same mutation sensitivity', () => {
  const processSource = readSource(new URL('./verify.ps1', import.meta.url));
  const inputSource = readSource(new URL('./verify-input.ps1', import.meta.url));
  for (const [source, check] of [[processSource, assertProcessCleanupSource], [inputSource, assertInputCleanupSource],
    [inputSource, assertCleanupArbitrationSource]]) {
    const windowsSource = source.replaceAll('\n', '\r\n');
    assert.equal(normalizeSourceText(windowsSource), source);
    check(normalizeSourceText(source));
    check(normalizeSourceText(windowsSource));
  }
});

test('input application has one independent forced-stop attempt after graceful failure', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  const application = source.slice(source.lastIndexOf('if ($process) {'), source.lastIndexOf('try { $commands'));
  assert(application.includes('$forceStop = !$process.WaitForExit(5000)'));
  assert(application.includes('$stopFailed = $true; $forceStop = $true; Save-CleanupFailure'));
  assert.match(application, /if \(\$forceStop\) \{\s+\$forced = \$true\s+try \{ \$process.Kill\(\$true\); \$process.WaitForExit\(\) \}/);
  assert.equal((application.match(/\$process.Kill\(\$true\)/g) ?? []).length, 1);
});

test('unowned healthy cleanup resets the injected invalid environment map', () => {
  const source = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  const control = source.slice(source.indexOf('# Без разрешённого изменения'), source.indexOf('# Здоровые типы'));
  assert.match(control, /\$saved = @\{ LAB_MOTION_PRESS_TRACE = 'previous-trace' \}[\s\S]*& \$cleanup/);
});

function systemReleaseViolations(source) {
  const scenario = source.slice(source.indexOf('function Scenario('), source.indexOf('\ntry {\n    if (!$ConfigureHostedAnimations)'));
  const dispatch = scenario.slice(0, scenario.indexOf('    Wait-Rest $before'));
  return [
    ['system-only asynchronous release', !dispatch.includes("if ($Name -eq 'system-disable-animation') {")
      || !dispatch.includes("$releaseTool = Start-Tool $Name (@('ui') + $Arguments + @('-w', $script:window, '--json'))")
      || !/\} else \{\s+Invoke-Ui \$Name \$Arguments\s+\}/.test(dispatch)
      || dispatch.indexOf('Invoke-Ui $Name $Arguments') < dispatch.indexOf("if ($Name -eq 'system-disable-animation')")],
    ['original absolute tool cap', !dispatch.includes('$releaseClock = [Diagnostics.Stopwatch]::StartNew()')
      || !dispatch.includes('30000 - $releaseClock.ElapsedMilliseconds')
      || !dispatch.includes('$releaseClock.ElapsedMilliseconds -ge 30000')],
    ['active request before setter', !dispatch.includes('$deadline = [DateTime]::UtcNow.AddSeconds(8)')
      || !dispatch.includes("if ($completed.Count) { throw 'Операция завершилась до системного запрета.' }")
      || !dispatch.includes("if ($requested.Count) { $active = $true; break }")
      || dispatch.indexOf('[ClientAreaAnimation]::Write($false)') > dispatch.indexOf('Finish-Tool $releaseTool')
      || /\$_.data.phase -eq 'value'/.test(dispatch)],
    ['one finally owner and first primary', !/catch \{ \$releaseFailure = \$_ \}\s+finally \{/.test(dispatch)
      || !dispatch.includes('if ($null -ne $releaseTool)')
      || (dispatch.match(/Finish-Tool \$releaseTool/g) ?? []).length !== 1
      || !dispatch.includes('catch { Save-CleanupFailure $_ ([ref]$releaseFailure) }')
      || !dispatch.includes('if ($null -ne $releaseFailure) { throw $releaseFailure }')
      || /\.Kill\(|\.Dispose\(|Get-Process/.test(dispatch)],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('system release observes app request before delayed CLI exit and finishes the same child once', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  assert.deepEqual(systemReleaseViolations(source), []);
  for (const [before, after, name] of [
    ["$releaseTool = Start-Tool $Name", "$releaseTool = Invoke-Ui $Name", 'system-only asynchronous release'],
    ['30000 - $releaseClock.ElapsedMilliseconds', '30000', 'original absolute tool cap'],
    ["if ($completed.Count) { throw 'Операция завершилась до системного запрета.' }", '', 'active request before setter'],
    ['catch { Save-CleanupFailure $_ ([ref]$releaseFailure) }', 'catch { throw }', 'one finally owner and first primary'],
  ]) assert(systemReleaseViolations(source.replaceAll(before, after)).includes(name), name);
});

test('system release keeps actual intermediate and settled-race rejection in the unchanged final oracle', () => {
  const healthy = fixture();
  assert.equal(verify(healthy).find(row => row.name === 'system-disable-animation').passed, true);
  const beforeSetter = fixture();
  const system = beforeSetter.find(row => row.name === 'system-disable-animation');
  const preference = system.events.findIndex(row => row.kind === 'intent' && row.data.trigger === 'systemPreference');
  const up = system.events.find(row => row.kind === 'intent' && row.data.trigger === 'pressed' && !row.data.pressed);
  system.events.splice(preference, 0, {kind:'completed', data:{operation:up.data.operation, nativeOperation:up.data.operation,
    end:'Finished', reason:'settled', isCurrent:true}});
  assert.throws(() => verify(beforeSetter), /операция завершилась до системного запрета/);
  const noIntermediate = fixture();
  const block = noIntermediate.find(row => row.name === 'system-disable-animation');
  block.events = block.events.filter(row => row.kind !== 'motion' || row.data.phase !== 'value');
  assert.throws(() => verify(noIntermediate), /отпускание не двигалось/);
});

test('system release witness loads actual Scenario and Invoke-Ui and retains delayed/settled/fault controls', () => {
  const source = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  const witness = source.slice(source.indexOf('$releaseDefinitions ='), source.indexOf('# Настоящая проекция и failure-ветка'));
  assert(witness.includes("$_.Name -in @('Scenario', 'Invoke-Ui')"));
  assert(witness.includes('. $releaseFunctions'));
  assert(witness.includes("Scenario $name @('drag', 'Press', 'Press', '--hold-ms', '0')"));
  for (const name of ['healthy', 'delayed-exit', 'settled', 'race', 'read', 'setter', 'readback',
    'read-finish', 'setter-finish', 'finish', 'start', 'budget', 'local']) assert(witness.includes(`'${name}'`), name);
  for (const text of ['$script:releaseProbeWaits.Count -ne $waits', '$script:releaseProbeDisposes -ne 1',
    '$script:releaseProbeWaits[0] -gt 29980', 'release-secondary-observable-control',
    'release-delayed-observation-control', 'release-arguments-control']) assert(witness.includes(text), text);
  assert(witness.includes('[object]::ReferenceEquals($this, $script:releaseProbeTool.process)'));
});

function finishToolViolations(source) {
  const finish = source.slice(source.indexOf('function Finish-Tool'), source.indexOf('function Invoke-Ui')).replace(/\/\/[^\n]*/g, '');
  return [
    ['wait fault retains primary before fallback', !/catch \{ \$finishFailure = \$_ \}\s+finally/.test(finish)],
    ['independent once-only kill before disposal', !/if \(!\$waitCompleted -and !\$killAttempted\) \{\s+\$killAttempted = \$true\s+try \{ \$Tool.process.Kill\(\$true\) \}/.test(finish)
      || (finish.match(/\$Tool.process.Kill\(\$true\)/g) ?? []).length !== 1],
    ['bounded original wait budget', !finish.includes('$Tool.process.WaitForExit($remaining)')
      || !finish.includes('$Timeout - $toolClock.ElapsedMilliseconds') || finish.includes('$Tool.process.WaitForExit()')],
    ['dispose cannot replace primary', !finish.includes('try { $Tool.process.Dispose() } catch { Save-CleanupFailure $_ ([ref]$finishFailure) }')
      || !finish.includes('if ($null -ne $finishFailure) { throw $finishFailure }')],
    ['actual AST Finish-Tool controls', !readSource(new URL('./cleanup.test.ps1', import.meta.url)).includes("'Finish-Tool'")],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('Finish-Tool WaitForExit exception retains one independent bounded Kill before ended/Dispose', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  assert.deepEqual(finishToolViolations(source), []);
  for (const [before, after, named] of [
    ['$finishFailure = $_', '$finishFailure = $null', 'wait fault retains primary before fallback'],
    ['if (!$waitCompleted -and !$killAttempted)', 'if ($false)', 'independent once-only kill before disposal'],
    ['$killAttempted = $true', '$killAttempted = $false', 'independent once-only kill before disposal'],
    ['$Tool.process.WaitForExit($remaining)', '$Tool.process.WaitForExit()', 'bounded original wait budget'],
    ['throw $finishFailure', 'throw', 'dispose cannot replace primary'],
  ]) assert(finishToolViolations(source.replaceAll(before, after)).includes(named), named);
  const controls = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const name of ['tool-finish-healthy-control', 'tool-finish-primary-control', 'tool-finish-before-dispose-control',
    'tool-finish-once-only-control', 'tool-finish-original-budget-control', 'tool-finish-secondary-control']) {
    assert(controls.includes(name), name);
  }
});

test('PowerShell wildcard primary oracle selects one matching arm', () => {
  const source = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  const selection = source.slice(source.indexOf('$expectedPrimary = switch -Wildcard'), source.indexOf('if (!$toolObserved'));
  // PowerShell продолжает проверять patterns: точные wait-null/invalid также подходят wait*.
  const isSingleMatch = text => ['wait-null', 'wait-invalid', 'wait*', 'timeout', 'exhausted', 'stdout*', 'stderr*', 'exit*', 'dispose']
    .every(pattern => text.includes(`'${pattern}' {`) && text.split(`'${pattern}' {`)[1].split('}')[0].trimEnd().endsWith('; break'));
  assert(isSingleMatch(selection), 'каждая найденная ветка обязана завершать switch, не добавлять второй primary');
  assert(!isSingleMatch(selection.replace("'wait-null' { 'bool после ожидания'; break }", "'wait-null' { 'bool после ожидания' }")));
  assert(!isSingleMatch(selection.replace("'wait-invalid' { 'bool после ожидания'; break }", "'wait-invalid' { 'bool после ожидания' }")));
});

function inputPhaseDiagnosticViolations(source) {
  const guard = source.slice(source.indexOf("if ($Name -in @('disable-animation', 'system-disable-animation'))"), source.indexOf('$after = @(Read-Trace)[-1].sequence'));
  return [
    ['named snap failure', !guard.includes("'InputSnapNotObserved'") || !guard.includes('[scenario={0}]')],
    ['failure captured before phase projection', !/\$failure = \[Management\.Automation\.ErrorRecord\]::new[\s\S]*try \{[\s\S]*Get-InputPhaseSummary/.test(guard)],
    ['bounded snapshot reused', !guard.includes('$events = @(Read-Trace)') || !guard.includes('-Events $events')
      || (guard.match(/Read-Trace/g) ?? []).length !== 1],
    ['diagnostic cannot replace primary', !/catch \{ \}\s+\}\s+throw \$failure/.test(guard)],
    ['fixed phase summary bound', !source.includes('$rows.Count -gt 12') || !source.includes('$summary.Length -le 1800')],
    ['real projection controls', !readSource(new URL('./cleanup.test.ps1', import.meta.url)).includes("'Get-InputPhaseSummary'")],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

function systemNotificationSourceViolations(source) {
  const callback = source.slice(source.indexOf('private void SystemPreferenceChanged'), source.indexOf('private void Observe(MotionObservation'));
  return [
    ['no-trace callback unchanged', !/if \(trace is null\)\s*\{\s*DispatcherQueue.TryEnqueue\(\(\) => Update\("systemPreference"\)\);\s*return;\s*\}/.test(callback)],
    ['genuine callback identity and receipt', !callback.includes('Interlocked.Increment(ref systemNotification)')
      || !callback.includes('ObserveSystemNotification(notification, SystemNotificationPhase.Received)')],
    ['actual enqueue result and delegate', !/var queued = DispatcherQueue.TryEnqueue\(\(\) =>\s*\{\s*ObserveSystemNotification\(notification, SystemNotificationPhase.Delegate\);\s*Update\("systemPreference"\);\s*\}\);/.test(callback)
      || !callback.includes('ObserveSystemNotification(notification, SystemNotificationPhase.Queued, queued, flush: true)')],
    ['typed bounded diagnostic fields', !source.includes('enum SystemNotificationPhase { Received, Queued, Delegate }')
      || !callback.includes('notification > 0 && notification <= 9007199254740991')
      || !callback.includes('notification = validIdentity ? (long?)notification : null')
      || !callback.includes('phase = phase.ToString()') || !callback.includes('diagnosticFailed = Volatile.Read(ref notificationDiagnosticFailed) != 0')],
    ['diagnostic errors isolated and observable', !/catch\s*\{\s*Interlocked.Exchange\(ref notificationDiagnosticFailed, 1\);\s*\}/.test(callback.replace(/\/\/[^\n]*/g, ''))
      || !callback.includes('if (flush) trace.Flush();')],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('настоящий callback сохраняет no-trace поведение, queue bool и ограниченные диагностические фазы', () => {
  const source = readSource(new URL('../../examples/windows/PressPage.xaml.cs', import.meta.url));
  assert.deepEqual(systemNotificationSourceViolations(source), []);
  const callback = source.slice(source.indexOf('private void SystemPreferenceChanged'), source.indexOf('private void ObserveSystemNotification'));
  const observation = source.slice(source.indexOf('private void ObserveSystemNotification'), source.indexOf('private void Observe(MotionObservation')).replace(/\/\/[^\n]*/g, '');
  assert(!callback.includes('catch'), 'ошибка настоящего enqueue не перехватывается диагностикой');
  assert(!/Press\.|Animation\.|motion\.|sender\.|args\.|AnimationsEnabled|State\./.test(observation), 'фоновая диагностика не читает XAML или preference getter');
  assert.equal((observation.match(/trace\.Flush\(\)/g) ?? []).length, 1);
  assert(!observation.includes('error.Message'));
  for (const [before, after, name] of [
    ['if (trace is null)', 'if (false)', 'no-trace callback unchanged'],
    ['SystemNotificationPhase.Received)', 'SystemNotificationPhase.Queued)', 'genuine callback identity and receipt'],
    ['var queued = DispatcherQueue.TryEnqueue', 'var queued = true; DispatcherQueue.TryEnqueue', 'actual enqueue result and delegate'],
    ['SystemNotificationPhase.Delegate);', 'SystemNotificationPhase.Received);', 'actual enqueue result and delegate'],
    ['notification <= 9007199254740991', 'true', 'typed bounded diagnostic fields'],
    ['Interlocked.Exchange(ref notificationDiagnosticFailed, 1);', 'return;', 'diagnostic errors isolated and observable'],
  ]) assert(systemNotificationSourceViolations(source.replaceAll(before, after)).includes(name), name);
});

test('callback/queue/delegate проецируются настоящим helper отдельно от systemPreference intent', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  const projection = source.slice(source.indexOf('function Read-InputPhaseField'), source.indexOf('function Scenario'));
  assert(projection.includes("'systemNotification'"), 'b13 отбрасывает receipt/queue/delegate целиком');
  for (const [raw, phase] of [['Received', 'systemCallback'], ['Queued', 'systemQueued'], ['Delegate', 'systemDelegate']]) {
    assert(projection.includes(`'${raw}' { $phase = '${phase}' }`));
  }
  for (const [field, type] of [['notification', 'number'], ['queued', 'bool'], ['diagnosticFailed', 'bool']]) {
    assert(projection.includes(`Read-InputPhaseField $data '${field}' '${type}'`));
  }
  assert(projection.includes('schema = 2'));
  const controls = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const name of ['phase-notification-received-only-control', 'phase-notification-queue-rejected-control',
    'phase-notification-accepted-control', 'phase-notification-delegate-before-result-control',
    'phase-notification-diagnostic-failed-control', 'phase-notification-malformed-control', 'phase-notification-bounded-control']) {
    assert(controls.includes(name), name);
  }
});

test('notification диагностика не заменяет system preference или snap и не создаёт input GREEN', () => {
  const healthy = fixture();
  const system = healthy.find(block => block.name === 'system-disable-animation');
  const notifications = ['Received', 'Queued', 'Delegate'].map(phase => ({ kind: 'systemNotification',
    data: { phase, notification: 1, queued: phase === 'Queued' ? false : null, diagnosticFailed: true } }));
  system.events.unshift(...notifications);
  assert.equal(verify(healthy).find(result => result.name === 'system-disable-animation').passed, true);
  system.events = system.events.filter(event => event.data.trigger !== 'systemPreference');
  assert.throws(() => verify(healthy), /не наблюдалось выключение/);
});

test('отказ snap называет сценарий и сохраняет порядок фаз без нового чтения trace', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  assert.deepEqual(inputPhaseDiagnosticViolations(source), []);
  for (const [before, after, namedError] of [
    ["'InputSnapNotObserved'", "'unnamed'", 'named snap failure'],
    ['-Events $events', '-Events @(Read-Trace)', 'bounded snapshot reused'],
    ['throw $failure', 'throw', 'diagnostic cannot replace primary'],
    ['$summary.Length -le 1800', '$true', 'fixed phase summary bound'],
  ]) assert(inputPhaseDiagnosticViolations(source.replace(before, after)).includes(namedError), namedError);
});

test('диагностика фаз проецирует enum/bool/number и сохраняет missing/malformed проверки настоящего helper', () => {
  const source = readSource(new URL('./verify-input.ps1', import.meta.url));
  const projection = source.slice(source.indexOf('function Read-InputPhaseField'), source.indexOf('function Scenario'));
  assert.match(projection, /\$value -is \[int\] -or \$value -is \[long\]/);
  assert(projection.includes('$value -ge 0 -and $value -le 9007199254740991'));
  assert(projection.includes('$value -is [bool]'));
  assert(projection.includes("@('settled', 'snap', 'replaced', 'stopped', 'disposed', 'interaction')"));
  assert(projection.includes("@('Finished', 'Stopped')"));
  assert(projection.includes("'pageOperation' } else { 'operation'"));
  assert(projection.includes('$sequence -le $After'));
  assert(projection.includes('rows = @($rows.ToArray())'));
  assert(!/\$Events\s*\|\s*ConvertTo-Json|\$data\s*\|\s*ConvertTo-Json/.test(projection));
  const witness = readSource(new URL('./cleanup.test.ps1', import.meta.url));
  for (const control of ['phase-healthy-order-or-operation-control', 'phase-no-preference-control',
    'phase-preference-without-snap-control', 'phase-snap-without-readback-control', 'phase-missing-control', 'phase-malformed-redaction-control',
    'phase-bounded-first-last-control', 'phase-named-failure-control', 'phase-primary-preserved-control']) {
    assert(witness.includes(control), control);
  }
  assert(witness.includes('$text -match \'secret|::error::|arbitrary\''));
  assert(witness.includes('$phaseFailure = [scriptblock]::Create($failureAst.Clauses[0].Item2.Extent.Text'));
});

test('повреждённый JSON даёт exit1 и отрицательный result.json', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-motion-input-oracle-'));
  try {
    writeFileSync(join(directory, 'press.jsonl'), '{');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./assert-input.mjs', import.meta.url)), directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')).passed, false);
  } finally { rmSync(directory, { recursive: true }); }
});

test('полная запись покоя до начала ввода не проходит', () => {
  const frames = [{ elapsedMs: 0 }, { elapsedMs: 4900 }];
  assert.doesNotThrow(() => verifyCaptureWindow({ inputStartedMs: 400, inputCompletedMs: 3000 }, frames));
  assert.throws(() => verifyCaptureWindow({ inputStartedMs: 6000, inputCompletedMs: 7500 }, frames), /не охватила/);
});
