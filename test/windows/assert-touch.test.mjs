import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyTouchTrace, verifyTouch } from './assert-touch.mjs';

const names = ['y-down', 'y-up'];
const renumber = events => events.map((event, index) => ({ ...event, sequence: index + 1 }));

function fixture(name = 'y-down', scale = 1) {
  const [axis, directionName] = name.split('-');
  const direction = directionName === 'down' ? 1 : -1;
  const target = direction > 0 ? 1 : 0;
  const start = { x: 240, y: 160 - 40 * direction };
  const end = { x: 240, y: 160 + 40 * direction };
  const scenario = { schema: 2, coordinates: 'native', name, axis, direction, gesture: 'swipe', durationMs: 300,
    coordinateSpace: 'viewport-dip', start, end, viewport: { width: 480, height: 320, scale },
    injection: { coordinateSpace: 'screen-pixel', start: { x: 400, y: 300 },
      end: { x: 400, y: 300 + 80 * direction * scale }, exitCode: 0 } };
  const position = q => ({ x: 0, y: -q * 320, z: 0 });
  const motion = (seconds, phase, progress, requestId = 0, velocity = null) => ({ seconds, kind: 'motion', data: {
    phase, requestId, origin: requestId === 0 ? 'Input' : 'Initial', position: position(progress), readbackPosition: position(progress), progress, readbackProgress: progress,
    positionOrigin: phase === 'value' ? 'event' : 'readback',
    nativeVelocity: velocity === null ? null : position(velocity), progressVelocity: velocity,
  } });
  const events = [
    { seconds: 0, kind: 'metadata', data: { axis, direction, coordinates: 'native', width: 480, height: 320, scale, unitsPerProgress: -320,
      minimum: -640, maximum: 320, initial: -160, target: -target * 320, responseMilliseconds: 350,
      bounce: 0, positionYSourceMode: 'EnabledWithInertia', consumer: 'ScalarMotion', initialReleaseTarget: -160 } },
    motion(.01, 'value', .5, 1),
    motion(.02, 'idle', .5, 1),
    { seconds: .03, kind: 'ready', data: { requestId: 1, position: position(.5), progress: .5,
      width: 480, height: 320, scale, unitsPerProgress: -320 } },
    { seconds: .04, kind: 'input', data: { event: 'pointerPressed', device: 'Touch', pointerId: 7,
      ...start, pointerTimestamp: 40000, ready: true } },
    { seconds: .05, kind: 'redirect', data: { pointerId: 7, result: 'returned' } },
    motion(.06, 'interacting', .5),
    { seconds: .07, kind: 'targetChanged', data: { target: -target * 320, phase: 'interacting', origin: 'Input' } },
    motion(.1, 'value', .5 + .05 * direction),
    motion(.2, 'value', .5 + .15 * direction),
    motion(.35, 'value', .5 + .25 * direction),
    motion(.36, 'inertia', .5 + .25 * direction, 0, direction * 5 / 6),
    motion(.37, 'value', .5 + .27 * direction),
    motion(.6, 'value', .5 + .45 * direction),
    motion(.9, 'value', target),
    motion(1, 'idle', target),
  ];
  return { scenario, events: renumber(events), position };
}

function change(f, predicate, mutate) {
  const event = f.events.find(predicate);
  assert.ok(event, 'Синтетический witness должен существовать.');
  mutate(event);
}
const phase = name => event => event.kind === 'motion' && event.data.phase === name && event.data.requestId === 0;
const verdict = f => verifyTouchTrace(f.events, f.scenario);
const rejected = (f, reason) => {
  const result = verdict(f);
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, reason);
};

test('локальная цель должна быть установлена через публичный канал во время drag', () => {
  const f = fixture();
  f.events = renumber(f.events.filter(event => event.kind !== 'targetChanged'));
  rejected(f, /смены release target/);
});

test('смена release target после отпускания не подтверждает намерение во время drag', () => {
  const f = fixture();
  const intent = f.events.find(event => event.kind === 'targetChanged');
  f.events = f.events.filter(event => event !== intent);
  const at = f.events.findIndex(phase('inertia'));
  f.events.splice(at + 1, 0, { ...intent, seconds: .365 });
  f.events = renumber(f.events);
  rejected(f, /вне native drag/);
});

test('callback с request 0 не подменяет происхождение Input', () => {
  const f = fixture();
  change(f, phase('inertia'), event => { event.data.origin = 'Animation'; });
  rejected(f, /не принадлежат вводу/);
});

test('начальная готовность требует происхождение Initial', () => {
  const f = fixture();
  change(f, event => event.kind === 'motion' && event.data.phase === 'value' && event.data.requestId === 1,
    event => { event.data.origin = 'Snap'; });
  rejected(f, /Нет начального native ValuesChanged/);
});

test('самостоятельный tracker в обход публичного канала не квалифицирует consumer', () => {
  const f = fixture();
  f.events[0].data.consumer = 'InteractionTracker';
  rejected(f, /публичный канал/);
});

for (const name of names) {
  for (const scale of [1, 1.5, 2]) {
    test(`доставленный ${name}, DPI ${scale}: движение, release и Idle`, () => {
      const result = verdict(fixture(name, scale));
      assert.equal(result.status, 'PASS', result.reason);
      assert.equal(result.velocityNominalRatio, 1);
      assert.equal(result.dragValues, 3);
    });
  }
}

test('нет touch при готовом приложении: INCOMPLETE, а не PASS', () => {
  const f = fixture();
  f.events = f.events.slice(0, 4);
  assert.equal(verdict(f).status, 'INCOMPLETE');
});

test('mouse и успешный CLI не заменяют Touch PointerPressed', () => {
  const f = fixture();
  change(f, event => event.kind === 'input', event => { event.data.device = 'Mouse'; });
  assert.equal(verdict(f).status, 'INCOMPLETE');
});

test('TryUpdatePosition из Idle подтверждается value без повторного Idle callback', () => {
  const f = fixture();
  f.events = renumber(f.events.filter(event => !(event.kind === 'motion' && event.data.phase === 'idle' && event.data.requestId === 1)));
  assert.equal(verdict(f).status, 'PASS');
});

test('нулевая native release velocity обнаруживается при правильном финале', () => {
  for (const name of names) {
    const f = fixture(name);
    change(f, phase('inertia'), event => { event.data.nativeVelocity = f.position(0); event.data.progressVelocity = 0; });
    rejected(f, /Release velocity/);
  }
});

test('неверный знак и крупная ошибка масштаба velocity обнаруживаются', () => {
  for (const name of names) {
    for (const multiplier of [-1, .1, 4]) {
      const f = fixture(name);
      change(f, phase('inertia'), event => {
        event.data.progressVelocity *= multiplier;
        event.data.nativeVelocity = f.position(event.data.progressVelocity);
      });
      rejected(f, /Release velocity/);
    }
  }
});

test('velocity в X не выдаётся за движение native Y', () => {
  const f = fixture();
  change(f, phase('inertia'), event => {
    event.data.nativeVelocity = { x: -267, y: 0, z: 0 };
    event.data.progressVelocity = 0;
  });
  rejected(f, /неактивной оси/);
});

test('самостоятельная summary velocity не заменяет native vector', () => {
  const f = fixture();
  change(f, phase('inertia'), event => { event.data.nativeVelocity = f.position(0); });
  rejected(f, /native release velocity/);
});

test('программный motion после touch не считается системным жестом', () => {
  const f = fixture();
  for (const event of f.events) if (event.kind === 'motion' && event.data.requestId === 0) event.data.requestId = 2;
  rejected(f, /программный requestId/);
});

test('фильтрация requestId 0 лишает опыт обязательных наблюдений', () => {
  const f = fixture();
  f.events = renumber(f.events.filter(event => !(event.kind === 'motion' && event.data.requestId === 0)));
  rejected(f, /Interacting/);
});

test('потеря или чужой pointerId redirect обнаруживаются', () => {
  for (const remove of [false, true]) {
    const f = fixture();
    if (remove) f.events = renumber(f.events.filter(event => event.kind !== 'redirect'));
    else change(f, event => event.kind === 'redirect', event => { event.data.pointerId = 8; });
    rejected(f, /TryRedirectForManipulation/);
  }
});

test('неверная физическая дистанция не проходит как другая DPI', () => {
  const f = fixture('y-down', 2);
  f.scenario.injection.end.y = 380;
  rejected(f, /расстояние или DPI/);
});

test('нажатие вне заданного начала не подтверждает intended gesture', () => {
  const f = fixture();
  change(f, event => event.kind === 'input', event => { event.data.y += 10; });
  rejected(f, /началу сценария/);
});

test('неверный масштаб или знак drag не скрывается дальнейшим settle', () => {
  for (const name of names) {
    for (const delta of [0, -.25, .1]) {
      const f = fixture(name);
      const lastDrag = f.events.find(event => event.seconds === .35);
      const progress = .5 + delta * f.scenario.direction;
      Object.assign(lastDrag.data, { position: f.position(progress), readbackPosition: f.position(progress),
        progress, readbackProgress: progress });
      rejected(f, /Drag/);
    }
  }
});

test('геометрический leak обнаруживается независимо от summary progress', () => {
  const f = fixture();
  change(f, event => event.seconds === .2, event => { event.data.position.x = 2; });
  rejected(f, /неактивную ось/);
});

test('Ready без начального native ValuesChanged недостаточен', () => {
  const f = fixture();
  f.events = renumber(f.events.filter(event => !(event.kind === 'motion' && event.data.phase === 'value' && event.data.requestId === 1)));
  rejected(f, /native ValuesChanged с readback до Ready/);
});

test('совпадение цели в summary при неверном readback не считается покоем', () => {
  const f = fixture();
  change(f, phase('idle'), event => {
    event.data.readbackPosition = f.position(.9);
    event.data.readbackProgress = .9;
  });
  rejected(f, /Idle и readback/);
});

test('время завершения и отсутствие Idle проверяются отдельно от позиции', () => {
  const late = fixture();
  change(late, phase('idle'), event => { event.seconds = 7; });
  rejected(late, /пяти секунд/);
  const absent = fixture();
  absent.events = renumber(absent.events.filter(event => !phase('idle')(event)));
  rejected(absent, /Idle и readback/);
});

test('первое изменение после release обязано продолжать направление', () => {
  for (const name of names) {
    const f = fixture(name);
    const progress = .5 + .2 * f.scenario.direction;
    change(f, event => event.seconds === .37, event => {
      Object.assign(event.data, { position: f.position(progress), readbackPosition: f.position(progress), progress, readbackProgress: progress });
    });
    rejected(f, /не продолжило/);
  }
});

test('дублированная позиция на release допускается до первого изменения', () => {
  const f = fixture();
  const duplicate = structuredClone(f.events.find(event => event.seconds === .35));
  duplicate.seconds = .365;
  f.events.splice(f.events.findIndex(phase('inertia')) + 1, 0, duplicate);
  f.events = renumber(f.events);
  assert.equal(verdict(f).status, 'PASS');
});

test('опережающий Inertia readback не инвертирует порядок native event positions', () => {
  const f = fixture();
  change(f, phase('inertia'), event => {
    Object.assign(event.data, { position: f.position(.8), readbackPosition: f.position(.8), progress: .8, readbackProgress: .8 });
  });
  assert.equal(verdict(f).status, 'PASS');
});

test('обрезка, нечисловая координата и переставленные timestamps не проходят', () => {
  const truncated = fixture();
  truncated.events.push({ sequence: truncated.events.length + 1, seconds: 2, kind: 'truncated', data: {} });
  rejected(truncated, /truncated/);
  const nonfinite = fixture();
  change(nonfinite, phase('inertia'), event => { event.data.nativeVelocity.x = NaN; });
  rejected(nonfinite, /native release velocity/);
  const reordered = fixture();
  reordered.events[10].seconds = .1;
  rejected(reordered, /последовательность/);
});

test('полный каталог обязателен; обе недоставки сохраняют INCOMPLETE', () => {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'lab-motion-touch-oracle-'));
  try {
    assert.equal(verifyTouch(directory).status, 'INCOMPLETE');
    for (const name of names) {
      const f = fixture(name);
      mkdirSync(join(directory, name));
      writeFileSync(join(directory, name, 'scenario.json'), JSON.stringify(f.scenario));
      writeFileSync(join(directory, name, 'trace.jsonl'), f.events.slice(0, 4).map(JSON.stringify).join('\n'));
    }
    assert.equal(verifyTouch(directory).status, 'INCOMPLETE');
    for (const name of names) {
      writeFileSync(join(directory, name, 'trace.jsonl'), fixture(name).events.map(JSON.stringify).join('\n'));
    }
    const result = verifyTouch(directory);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.scenarios.map(value => value.name), names);
  } finally {
    assert.equal(dirname(directory), temporaryRoot);
    rmSync(directory, { recursive: true });
  }
});
