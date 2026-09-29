import { describe, expect, it } from 'vitest';
import { createStateCascade, type StateCascadePatch } from '../src/behaviors/index.js';
import { MotionValue } from '../src/motion-value.js';
import { makeClock } from './projection-helpers.js';

type Visual = { x: number | undefined; opacity: number };

describe('каскад: одно визуальное намерение из нескольких синхронных изменений', () => {
  it('press → drag не публикует промежуточный base и не нарушает read-your-writes', () => {
    const state = createStateCascade<Visual>();
    state.createLayer({ x: 0, opacity: 1 });
    const press = state.createLayer({ x: 1 });
    const drag = state.createLayer();
    const seen: StateCascadePatch<Visual>[] = [];
    state.subscribe(patch => { seen.push(patch); });
    state.batch(() => {
      expect(press.clear().changed).toEqual({ x: 0 });
      expect(state.get('x')).toBe(0);
      drag.set({ x: 2 });
      expect(state.snapshot()).toEqual({ x: 2, opacity: 1 });
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([{ changed: { x: 2 }, removed: [] }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]!.changed)).toBe(true);
    expect(Object.isFrozen(seen[0]!.removed)).toBe(true);
    state.destroy();
  });

  it('1000 visible updates: настоящий MotionValue получает 1 target вместо 1000', () => {
    const run = (batched: boolean) => {
      const state = createStateCascade<Visual>();
      const layer = state.createLayer({ x: 0 });
      const clock = makeClock();
      const value = new MotionValue({
        initial: 0, spring: { mass: 1, stiffness: 170, damping: 26 }, requestFrame: clock.requestFrame,
      });
      let targets = 0;
      state.subscribe(({ changed }) => {
        if (changed.x !== undefined) { targets++; value.setTarget(changed.x); }
      });
      const update = () => { for (let x = 1; x <= 1000; x++) layer.set({ x }); };
      if (batched) state.batch(update); else update();
      clock.drain();
      const result = { targets, value: value.value };
      state.destroy();
      value.destroy();
      return result;
    };
    expect(run(false)).toEqual({ targets: 1000, value: 1000 });
    expect(run(true)).toEqual({ targets: 1, value: 1000 });
  });

  it('возврат к исходной цели не запускает переход, но сохраняет нового владельца', () => {
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ x: 1 });
    const top = state.createLayer();
    const seen: StateCascadePatch<Visual>[] = [];
    state.subscribe(patch => { seen.push(patch); });
    state.batch(() => { top.set({ x: 9 }); base.set({ x: 7 }); top.set({ x: 1 }); });
    expect(seen).toEqual([]);
    top.clear();
    expect(seen).toEqual([{ changed: { x: 7 }, removed: [] }]);
  });

  it('нетто-delta различает removed, owned undefined, -0 и NaN', () => {
    const state = createStateCascade<Record<string, unknown>>();
    const layer = state.createLayer({ x: 1, opacity: 1, zero: 0, nan: NaN });
    const seen: StateCascadePatch<Record<string, unknown>>[] = [];
    state.subscribe(patch => { seen.push(patch); });
    state.batch(() => {
      layer.clear();
      layer.set({ x: undefined, zero: -0, nan: NaN, ['__proto__']: 'safe' });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changed).toEqual({ x: undefined, zero: -0, ['__proto__']: 'safe' });
    expect(Object.hasOwn(seen[0]!.changed, 'x')).toBe(true);
    expect(Object.is(seen[0]!.changed['zero'], -0)).toBe(true);
    expect(seen[0]!.removed).toEqual(['opacity']);
    expect(Object.getPrototypeOf(state.snapshot())).toBeNull();
  });

  it('вложенные batch публикуют только окончание внешнего, обычные set остаются отдельными', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: unknown[] = [];
    state.subscribe(patch => { seen.push(patch.changed.x); });
    state.batch(() => {
      layer.set({ x: 1 });
      state.batch(() => { layer.set({ x: 2 }); });
      expect(seen).toEqual([]);
      layer.set({ x: 3 });
    });
    layer.set({ x: 4 });
    expect(seen).toEqual([3, 4]);
  });

  it('реентрантный batch использует прежнюю FIFO-доставку и не теряет свой final target', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: unknown[] = [];
    state.subscribe(({ changed }) => {
      if (changed.x === 1) state.batch(() => { layer.set({ x: 2 }); layer.set({ x: 3 }); });
    });
    state.subscribe(patch => { seen.push(patch.changed.x); });
    layer.set({ x: 1 });
    expect(seen).toEqual([1, 3]);
    expect(state.get('x')).toBe(3);
  });

  it('throw callback сохраняется буквально после доставки принятых изменений', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: unknown[] = [];
    state.subscribe(patch => { seen.push(patch.changed.x); });
    let caught = false;
    try {
      state.batch(() => { layer.set({ x: 1 }); throw undefined; });
    } catch (error) { caught = true; expect(error).toBeUndefined(); }
    expect(caught).toBe(true);
    layer.set({ x: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it('callback failure и observer failure не маскируют друг друга', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const inputError = new Error('update failed');
    const observerError = new Error('observer failed');
    const seen: unknown[] = [];
    state.subscribe(() => { throw observerError; });
    state.subscribe(patch => { seen.push(patch.changed.x); });
    let caught: unknown;
    try { state.batch(() => { layer.set({ x: 1 }); throw inputError; }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([inputError, observerError]);
    expect(seen).toEqual([1]);
    expect(state.get('x')).toBe(1);
  });

  it('пойманная ошибка вложенного batch не заканчивает внешний преждевременно', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: unknown[] = [];
    state.subscribe(patch => { seen.push(patch.changed.x); });
    state.batch(() => {
      expect(() => state.batch(() => { layer.set({ x: 2 }); throw new Error('nested'); })).toThrow('nested');
      expect(seen).toEqual([]);
      layer.set({ x: 3 });
    });
    expect(seen).toEqual([3]);
  });

  it('destroy внутри batch терминален, callback нового batch после destroy не вызывается', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 0 });
    let calls = 0;
    state.subscribe(() => { calls++; });
    state.batch(() => { layer.set({ x: 1 }); state.destroy(); layer.set({ x: 2 }); });
    state.batch(() => { calls++; });
    expect(calls).toBe(0);
    expect(state.snapshot()).toEqual({});
    expect(layer.active).toBe(false);
  });

  it('destroy из первого получателя batch пресекает последующих', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    let calls = 0;
    state.subscribe(() => { state.destroy(); });
    state.subscribe(() => { calls++; });
    state.batch(() => { layer.set({ x: 1 }); layer.set({ x: 2 }); });
    expect(calls).toBe(0);
  });

  it('подписчики batch выбираются на выходе; subscription changes не теряют net delta', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: string[] = [];
    const off = state.subscribe(() => { seen.push('old'); });
    state.batch(() => {
      layer.set({ x: 1 });
      off();
      state.subscribe(({ changed }) => { seen.push(`new${changed.x}`); });
      layer.set({ x: 2 });
    });
    expect(seen).toEqual(['new2']);
  });

  it('создание и удаление слоя в одной группе не оставляет phantom target', () => {
    const state = createStateCascade<Visual>();
    const seen: unknown[] = [];
    state.subscribe(patch => { seen.push(patch); });
    state.batch(() => { const layer = state.createLayer({ x: 9 }); layer.destroy(); });
    state.batch(() => {});
    expect(state.snapshot()).toEqual({});
    expect(seen).toEqual([]);
    const base = state.createLayer({ x: 1 });
    state.batch(() => { state.createLayer({ x: 2 }); base.destroy(); });
    expect(state.get('x')).toBe(2);
  });

  it('getter reentry по-прежнему отзывает устаревшую цель, batch публикует актуальную', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 0 });
    const seen: unknown[] = [];
    state.subscribe(patch => { seen.push(patch); });
    state.batch(() => {
      layer.set({ get x() { layer.set({ opacity: 0.5 }); return 9; } });
    });
    expect(state.snapshot()).toEqual({ opacity: 0.5 });
    expect(seen).toEqual([{ changed: { opacity: 0.5 }, removed: ['x'] }]);
  });
});

it('1024 группы × 8 изменений: полная независимая модель и downstream mirror совпадают', () => {
  type Values = Record<string, unknown>;
  const state = createStateCascade<Values>();
  const slots = Array.from({ length: 4 }, () => ({ handle: state.createLayer(), target: undefined as Values | undefined }));
  const mirror: Values = Object.create(null) as Values;
  const keys = ['x', 'opacity', '__proto__', 'constructor'];
  const values = [0, -0, 1, undefined, NaN, 'accent'];
  let seed = 0x5713;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const model = () => Object.assign(Object.create(null) as Values, ...slots.map(slot => slot.target));
  let emissions = 0;
  state.subscribe(({ changed, removed }) => {
    emissions++;
    for (const key of removed) delete mirror[key];
    Object.assign(mirror, changed);
  });
  for (let group = 0; group < 1024; group++) {
    const before = model();
    const count = emissions;
    state.batch(() => {
      for (let step = 0; step < 8; step++) {
        const slot = slots[Math.floor(random() * slots.length)]!;
        const update = () => {
          if (random() < 0.3) {
            slot.target = undefined;
            slot.handle.clear();
          } else {
            slot.target = Object.fromEntries(keys.filter(() => random() < 0.5)
              .map(key => [key, values[Math.floor(random() * values.length)]]));
            slot.handle.set(slot.target);
          }
        };
        if (step % 2) state.batch(update); else update();
        const current = state.snapshot();
        const expected = model();
        expect(Object.keys(current).sort()).toEqual(Object.keys(expected).sort());
        for (const key of keys) expect(Object.is(current[key], expected[key])).toBe(true);
        expect(emissions).toBe(count);
      }
    });
    const after = model();
    const changed = keys.some(key => Object.hasOwn(before, key) !== Object.hasOwn(after, key)
      || !Object.is(before[key], after[key]));
    expect(emissions - count).toBe(changed ? 1 : 0);
    expect(Object.keys(mirror).sort()).toEqual(Object.keys(after).sort());
    for (const key of keys) expect(Object.is(mirror[key], after[key])).toBe(true);
  }
  state.destroy();
});

it('await не расширяет синхронную границу и не задерживает последующие обычные события', async () => {
  const state = createStateCascade<Visual>();
  const layer = state.createLayer();
  const seen: unknown[] = [];
  state.subscribe(({ changed }) => { seen.push(changed.x); });
  let continuation!: Promise<void>;
  state.batch(() => {
    layer.set({ x: 1 });
    continuation = Promise.resolve().then(() => { layer.set({ x: 3 }); });
    layer.set({ x: 2 });
  });
  expect(seen).toEqual([2]);
  await continuation;
  expect(seen).toEqual([2, 3]);
  state.destroy();
});
