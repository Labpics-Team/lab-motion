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
