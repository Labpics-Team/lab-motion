import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyTrace, verifyCaptureWindow } from './assert-input.mjs';

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
  const source = readFileSync(new URL('../../examples/windows/PressPage.xaml.cs', import.meta.url), 'utf8');
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

test('post-start lifetime source contract retains cleanup, original error and the actual PowerShell witness', () => {
  const source = readFileSync(new URL('./verify.ps1', import.meta.url), 'utf8');
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
});

test('process witness retains getter faults, invalid identity and a non-effect .NET getter control', () => {
  const source = readFileSync(new URL('./process-cleanup.test.ps1', import.meta.url), 'utf8');
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
    ['primary captured before evidence', !/\$primaryFailure = \$_\s+try \{ \$primaryFailure \| Out-String \| Set-Content/.test(source)],
    ['application disposal encloses process boundary', !/if \(\$process\) \{\s+try \{\s+\$forced = \$false/.test(source)],
    ['cleanup retains primary', !/catch \{\s+if \(\$null -eq \$primaryFailure\) \{ throw \}/.test(source)],
    ['fixed observable warning', !source.includes("Write-Warning 'Очистка после ошибки не завершена.' -WarningAction Continue")],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('input source captures primary before evidence and disposes across process boundaries', () => {
  const source = readFileSync(new URL('./verify-input.ps1', import.meta.url), 'utf8');
  assert.deepEqual(inputCleanupViolations(source), []);
  for (const [before, after, expected] of [
    ['$primaryFailure = $_', '$primaryFailure = $null', 'primary captured before evidence'],
    ['try {\n                        $forced = $false', '$forced = $false', 'application disposal encloses process boundary'],
    ['if ($null -eq $primaryFailure) { throw }', 'throw', 'cleanup retains primary'],
    ["Write-Warning 'Очистка после ошибки не завершена.' -WarningAction Continue", '$null', 'fixed observable warning'],
  ]) assert(inputCleanupViolations(source.replaceAll(before, after)).includes(expected), expected);
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
