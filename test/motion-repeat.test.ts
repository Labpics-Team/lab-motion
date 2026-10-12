import { describe, expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import { repeat, type RepeatOptions } from '../src/motion/repeat.js';
import type { MotionOptions, SequenceOptions } from '../src/motion/types.js';

// Табличные случаи хранят плоские данные; публичный конструктор проверяет их.
function repeating(input: object): MotionOptions {
  const { repeat: count = 0, repeatType: type, repeatDelay: delay, ...options } = input as Record<string, unknown>;
  return { ...options, ...repeat(count as number, { type: type as RepeatOptions['type'], delay: delay as number }) };
}

describe('повтор авторской траектории', () => {
  it('исполняет конечные итерации одним Playback', async () => {
    const h = harness();
    const run = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, repeat: 2, repeatDelay: 20 } as MotionOptions));
    expect(run.duration).toBe(340);
    run.seek(50); expect(h.x()).toBe(50);
    run.seek(110); expect(h.x()).toBe(100);
    run.seek(120); expect(h.x()).toBe(0);
    run.seek(170); expect(h.x()).toBe(50);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100);
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('повторяет общую шкалу sequence вместе с промежутками', async () => {
    const h = harness();
    const run = h.runtime.sequence([
      [h.element, { x: [0, 100] }, { duration: 100 }],
      [h.element, { x: [100, 200] }, { at: 200, duration: 100 }],
    ], repeating({ delay: 10, repeat: 1, repeatDelay: 20 } as SequenceOptions));
    expect(run.duration).toBe(630);
    run.seek(160); expect(h.x()).toBe(100);
    run.seek(330); expect(h.x()).toBe(0);
    run.seek(580); expect(h.x()).toBe(150);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  });
});

for (const native of [false, true]) for (const repeatType of ['loop', 'reverse', 'mirror'] as const) {
  it('controls и конечная чётность: ' + repeatType + ', native=' + native, async () => {
    const h = harness(native);
    const run = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, repeat: 1, repeatType }));
    run.pause(); run.seek(125);
    expect(h.x()).toBe(repeatType === 'loop' ? 25 : 75);
    expect(run.state).toBe('paused');
    run.play(); expect(run.state).toBe('running');
    run.finish();
    expect(h.x()).toBe(repeatType === 'loop' ? 100 : 0);
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.effects.every(effect => effect.cancelled)).toBe(true);
    expect(h.updates.size + h.renders.size).toBe(0);
  });
}

it('отличает reverse от mirror на асимметричном easing', () => {
  for (const repeatType of ['reverse', 'mirror'] as const) {
    const h = harness();
    const run = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, ease: p => p * p, repeat: 1, repeatType }));
    run.seek(125);
    expect(h.x()).toBeCloseTo(repeatType === 'reverse' ? 56.25 : 93.75, 8);
    run.stop();
  }
});

it('обращает значения N-keyframes без перестановки times и easing', () => {
  const h = harness();
  const run = h.runtime.animate(h.element, { x: [0, 10, 100] }, repeating({ duration: 100, times: [0, .2, 1], repeat: 1, repeatType: 'mirror' }));
  run.seek(110); expect(h.x()).toBeCloseTo(55, 8);
  run.seek(160); expect(h.x()).toBeCloseTo(5, 8);
  run.finish(); expect(h.x()).toBe(0);
});

it('сохраняет расписание N-keyframes в детерминированном корпусе', () => {
  let seed = 0x5eeda11;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 96; scenario++) {
    const duration = 40 + Math.floor(random() * 160), delay = Math.floor(random() * 30);
    const gap = Math.floor(random() * 25), count = 1 + Math.floor(random() * 8);
    const values = Array.from({ length: 3 + Math.floor(random() * 5) }, () => Math.floor(random() * 500) - 250);
    const times = values.map((_, i) => i / (values.length - 1));
    const type = (['loop', 'reverse', 'mirror'] as const)[scenario % 3]!;
    const h = harness();
    const run = h.runtime.animate(h.element, { x: values }, repeating({ duration, delay, times, repeat: count, repeatDelay: gap, repeatType: type }));
    const intervals = Array.from({ length: count + 1 }, (_, i) => ({ start: delay + i * (duration + gap), odd: i % 2 === 1 }));
    for (let sample = 0; sample < 24; sample++) {
      const t = Math.floor(random() * run.duration * 100) / 100;
      const interval = intervals.filter(entry => entry.start <= t).at(-1);
      let p = interval ? Math.min(1, (t - interval.start) / duration) : 0;
      const mirrored = type === 'mirror' && interval?.odd;
      if (type === 'reverse' && interval?.odd) p = 1 - p;
      const authored = mirrored ? [...values].reverse() : values;
      const position = p * (values.length - 1), index = Math.min(values.length - 2, Math.floor(position));
      const expected = authored[index]! + (authored[index + 1]! - authored[index]!) * (position - index);
      run.seek(t); expect(h.x()).toBeCloseTo(expected, 7);
    }
    run.finish();
    expect(h.updates.size + h.renders.size).toBe(0);
  }
});

it('отклоняет неисполняемый повтор до записи и сохраняет прежний owner', () => {
  for (const options of [
    { repeat: -1 }, { repeat: .5 }, { repeat: NaN }, { repeat: 2 ** 31 },
    { repeat: null }, { repeat: 1, repeatDelay: -1 }, { repeat: 1, repeatDelay: Infinity },
    { repeat: 1, repeatType: 'sideways' }, { repeat: Infinity, duration: 0 },
    { repeat: 2, duration: Number.MAX_VALUE }, { repeat: 1, delay: 2 ** 53, duration: 1 },
    { repeat: 1, spring: { response: 100 } },
  ]) {
    const h = harness(true);
    const old = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 });
    const writes = h.writes.length;
    expect(() => h.runtime.animate(h.element, { x: [0, 200] }, repeating(options as MotionOptions))).toThrow();
    expect(h.writes).toHaveLength(writes);
    expect(h.effects).toHaveLength(1); expect(h.effects[0]!.cancelled).toBe(false);
    old.finish();
  }
});

it('повтор требует authored arrays, а repeat:0 сохраняет обычную пружину', () => {
  const h = harness();
  expect(() => h.runtime.animate(h.element, { x: 100 }, repeating({ repeat: 1 }))).toThrow(/массив/);
  const run = h.runtime.animate(h.element, { x: 100 }, repeating({ repeat: 0, repeatDelay: Number.MAX_VALUE }));
  run.finish(); expect(h.x()).toBe(100);
});

for (const repeatType of ['loop', 'reverse', 'mirror'] as const) it('бесконечный ' + repeatType + ': завершение и reduced-motion', async () => {
  for (const reducedMotion of [undefined, 'always'] as const) {
    const h = harness(true);
    const run = h.runtime.animate(h.element, { x: [10, 100] }, repeating({ duration: 100, repeat: Infinity, repeatType, reducedMotion }));
    if (!reducedMotion) {
      expect(run.duration).toBe(Infinity);
      if (repeatType === 'loop') {
        expect(h.effects).toHaveLength(0); expect(h.updates.size).toBe(1);
      } else {
        expect(h.effects).toHaveLength(1); expect(h.effects[0]!.timing.iterations).toBe(Infinity);
        expect(h.updates.size + h.renders.size).toBe(0);
      }
      run.seek(125); expect(h.x()).toBe(repeatType === 'loop' ? 32.5 : 77.5);
      expect(() => run.seek(Infinity)).toThrow();
      run.finish();
    } else {
      expect(run.duration).toBe(0); expect(h.effects).toHaveLength(0);
    }
    expect(h.x()).toBe(100);
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.effects.every(effect => effect.cancelled)).toBe(true);
  }
});

it('сохраняет мгновенные итерации и отклоняет выход за точный infinite horizon', async () => {
  for (const repeatType of ['loop', 'reverse', 'mirror'] as const) {
    const h = harness();
    const run = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 0, repeat: 1, repeatDelay: 20, repeatType }));
    expect(run.duration).toBe(20); expect(h.x()).toBe(100);
    run.finish(); expect(h.x()).toBe(repeatType === 'loop' ? 100 : 0);
  }
  const h = harness();
  const infinite = h.runtime.animate(h.element, { x: [0, 1] }, repeating({ duration: 1, repeat: Infinity }));
  expect(() => infinite.seek(2 ** 53)).toThrow();
  await expect(infinite.finished).rejects.toThrow();
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('pause в промежутке и запоздалый native completion не возвращают старого владельца', async () => {
  const h = harness(true);
  const old = h.runtime.animate(h.element, { x: [0, 100], opacity: [0, 1] }, repeating({ duration: 100, repeat: Infinity, repeatType: 'reverse' }));
  const effects = [...h.effects];
  expect(effects).toHaveLength(2);
  const next = h.runtime.animate(h.element, { x: [100, 200] }, repeating({ duration: 100, repeat: 2, repeatType: 'reverse' }));
  old.stop(); effects.forEach(effect => effect.complete()); await Promise.resolve();
  expect(next.state).toBe('running'); next.finish(); expect(h.x()).toBe(200);
  expect(await old.finished).toEqual({ status: 'stopped' });
  const gap = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, repeat: 1, repeatDelay: 50 }));
  gap.seek(125); gap.pause(); h.step(400); expect(h.x()).toBe(100);
  gap.seek(175); expect(h.x()).toBe(25); expect(gap.state).toBe('paused'); gap.stop();
});

it('разные расписания осей не объединяются в один native effect', () => {
  const h = harness(true);
  const x = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, repeat: 1, repeatType: 'reverse' }));
  expect(h.effects).toHaveLength(1);
  const y = h.runtime.animate(h.element, { y: [0, 100] }, repeating({ duration: 50, repeat: 3, repeatType: 'reverse' }));
  expect(h.effects.every(effect => effect.cancelled)).toBe(true);
  h.step(125); expect(h.x()).toBe(75); expect(h.y()).toBe(50);
  x.stop(); y.stop(); expect(h.updates.size + h.renders.size).toBe(0);
});

it('initial delay применяется один раз, а пропущенные кадры не запускают итерации заново', () => {
  const h = harness();
  const run = h.runtime.animate(h.element, { x: [0, 100] }, repeating({ duration: 100, delay: 20, repeat: 10000 }));
  const update = [...h.updates][0], render = [...h.renders][0];
  h.step(10); expect(h.x()).toBe(0);
  h.step(1000045); expect(h.x()).toBe(25);
  expect([...h.updates]).toEqual([update]); expect([...h.renders]).toEqual([render]);
  run.finish(); expect(h.updates.size + h.renders.size).toBe(0);
});

it('исключение easing освобождает все повторяющиеся каналы', async () => {
  const h = harness(); const error = new Error('broken easing');
  const run = h.runtime.animate(h.element, { x: [0, 100], opacity: [0, 1] }, repeating({ duration: 100, repeat: Infinity, ease(p) { if (p > .4) throw error; return p; } }));
  h.step(50); await expect(run.finished).rejects.toBe(error);
  expect(run.state).toBe('failed'); expect(h.updates.size + h.renders.size).toBe(0);
});

it('общая шкала отклоняет опции траектории и вложенные повторения до host writes', () => {
  const h = harness();
  const step = [h.element, { x: [0, 100] }, { duration: 100 }] as const;
  for (const options of [{ duration: 100 }, { spring: { response: 100 } }, { stagger: 10 }, { times: [0, 1] }]) {
    expect(() => h.runtime.sequence([step], repeating(options as SequenceOptions))).toThrow();
  }
  expect(() => h.runtime.sequence([[h.element, { x: [0, 100] }, { duration: 100, repeat: 1 } as MotionOptions]])).toThrow();
  expect(h.writes).toHaveLength(0);
});

it('положительная длительность не исчезает при большом абсолютном delay', () => {
  const h = harness();
  expect(() => h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1, delay: 2 ** 53 })).toThrow(/длительность/);
  expect(h.writes).toHaveLength(0);
});

it('публичный repeat подключает один primitive, а произвольная функция им не становится', async () => {
  const h = harness();
  expect(() => h.runtime.animate(h.element, { x: [0, 100] }, { repeat: (() => null) as unknown as MotionOptions['repeat'] })).toThrow(/repeat/);
  expect(h.writes).toHaveLength(0);
  const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 100, ...repeat(1, { type: 'reverse' }) });
  run.seek(125); expect(h.x()).toBe(75); run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
});

it('native loop допускается при совпадающих endpoints', () => {
  const h = harness(true);
  const run = h.runtime.animate(h.element, { x: [20, 20] }, { duration: 100, ...repeat(Infinity) });
  expect(h.effects).toHaveLength(1); expect(h.updates.size + h.renders.size).toBe(0);
  run.stop(); expect(h.x()).toBe(20);
});

it('мгновенный первый шаг выполнен и на старте следующей итерации sequence', async () => {
  const h = harness();
  const run = h.runtime.sequence([
    [h.element, { x: [0, 100] }, { duration: 0 }],
    [h.element, { x: [100, 200] }, { at: 100, duration: 100 }],
  ], { ...repeat(1) });
  expect(h.x()).toBe(100);
  run.pause(); run.seek(0); expect(h.x()).toBe(100);
  run.seek(200); expect(h.x()).toBe(100);
  run.seek(250); expect(h.x()).toBe(100);
  run.finish(); expect(h.x()).toBe(200);
  expect(await run.finished).toEqual({ status: 'finished' });
});

it('вложенный повтор запрещён также для настоящего repeat() primitive', () => {
  const h = harness();
  expect(() => h.runtime.sequence([
    [h.element, { x: [0, 100] }, { duration: 100, ...repeat(2) }],
  ], { ...repeat(1) })).toThrow(/опция/);
  expect(h.writes).toHaveLength(0);
});

it('переполнение таймлайна после seek завершает бесконечный повтор ошибкой', async () => {
  const h = harness();
  const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1e308, ...repeat(Infinity) });
  run.seek(1e308);
  h.step(Number.MAX_VALUE);
  await expect(run.finished).rejects.toThrow(/горизонт/);
  expect(run.state).toBe('failed');
  expect(h.updates.size + h.renders.size).toBe(0);
});
