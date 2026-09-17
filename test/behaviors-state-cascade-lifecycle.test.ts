import { describe, expect, it } from 'vitest';
import { createStateCascade } from '../src/behaviors/index.js';

type Visual = { x: number; opacity: number };

describe('каскад: порядок коммитов и границы пользовательского кода', () => {
  it('реентрантный set не доставляет renderer старый patch после нового', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 0 });
    const seen: number[] = [];
    state.subscribe(({ changed }) => {
      if (changed.x === 1) layer.set({ x: 2 });
    });
    state.subscribe(({ changed }) => { seen.push(changed.x!); });
    layer.set({ x: 1 });
    expect(seen).toEqual([1, 2]);
    expect(seen.at(-1)).toBe(state.get('x'));
  });

  it('destroy в первом subscriber пресекает текущую и отложенную доставку', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    let writes = 0;
    state.subscribe(() => { state.destroy(); });
    state.subscribe(() => { writes++; });
    layer.set({ x: 1 });
    expect(writes).toBe(0);
    expect(state.snapshot()).toEqual({});
    expect(layer.active).toBe(false);
  });

  it('ошибка subscriber не оставляет других потребителей с устаревшим значением', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const failure = new Error('renderer failed');
    const seen: number[] = [];
    state.subscribe(({ changed }) => {
      if (changed.x === 1) {
        layer.set({ x: 2 });
        throw failure;
      }
    });
    state.subscribe(({ changed }) => { seen.push(changed.x!); });
    expect(() => layer.set({ x: 1 })).toThrow(failure);
    expect(seen).toEqual([1, 2]);
    expect(state.get('x')).toBe(2);
    layer.set({ x: 3 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('throw undefined тоже доставляется вызывающему, но не обрывает других subscribers', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    let seen = 0;
    state.subscribe(() => { throw undefined; });
    state.subscribe(() => { seen++; });
    let caught = false;
    try { layer.set({ x: 1 }); } catch (error) { caught = true; expect(error).toBeUndefined(); }
    expect(caught).toBe(true);
    expect(seen).toBe(1);
  });

  it('новый set из getter побеждает прерванный set и не оставляет чужой ключ', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 0 });
    const stale = layer.set({ get x() { layer.set({ opacity: 0.5 }); return 9; } });
    expect(state.snapshot()).toEqual({ opacity: 0.5 });
    expect(stale.changed).toEqual({});
    expect(stale.removed).toEqual([]);
  });

  it('clear неактивного слоя из getter отменяет ещё не опубликованный set', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    layer.set({ get x() { layer.clear(); return 9; } });
    expect(layer.active).toBe(false);
    expect(state.snapshot()).toEqual({});
  });

  it('throwing getter не публикует частичную цель и не теряет прежнюю', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 3 });
    const failure = new Error('input failed');
    expect(() => layer.set({ x: 4, get opacity(): number { throw failure; } })).toThrow(failure);
    expect(state.snapshot()).toEqual({ x: 3 });
    layer.set({ opacity: 0.4 });
    expect(state.snapshot()).toEqual({ opacity: 0.4 });
  });

  it('создание initial layer с destroy из getter не оживляет каскад', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ get x() { state.destroy(); return 1; } });
    expect(layer.active).toBe(false);
    expect(state.snapshot()).toEqual({});
    expect(state.createLayer({ x: 2 }).active).toBe(false);
  });

  it('subscribe/unsubscribe меняет следующий emit, не snapshot текущих получателей', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: string[] = [];
    let off = () => {};
    state.subscribe(({ changed }) => {
      seen.push(`a${changed.x}`);
      if (changed.x === 1) {
        off();
        state.subscribe(({ changed: next }) => { seen.push(`c${next.x}`); });
        layer.set({ x: 2 });
      }
    });
    off = state.subscribe(({ changed }) => { seen.push(`b${changed.x}`); });
    layer.set({ x: 1 });
    expect(seen).toEqual(['a1', 'b1', 'a2', 'c2']);
  });

  it('patch неизменяемый: один subscriber не может переписать сообщение следующему', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer({ x: 1, opacity: 1 });
    let last: unknown;
    state.subscribe((patch) => {
      expect(Object.isFrozen(patch)).toBe(true);
      expect(Object.isFrozen(patch.changed)).toBe(true);
      expect(Object.isFrozen(patch.removed)).toBe(true);
    });
    state.subscribe((patch) => { last = patch; });
    const patch = layer.set({ x: 2 });
    expect(last).toBe(patch);
    expect(patch.changed).toEqual({ x: 2 });
    expect(patch.removed).toEqual(['opacity']);
  });
});

describe('каскад: lifetime слоя и полный отказ уведомлений', () => {
  it('destroy отдельного слоя раскрывает нижний target и запрещает resurrection', () => {
    const state = createStateCascade<Visual>();
    const base = state.createLayer({ x: 1, opacity: 1 });
    const top = state.createLayer({ x: 2 });
    expect(top.destroy().changed).toEqual({ x: 1 });
    expect(top.destroy().changed).toEqual({});
    top.set({ x: 7 });
    expect(top.active).toBe(false);
    expect(state.snapshot()).toEqual({ x: 1, opacity: 1 });
    base.set({ x: 3 });
    expect(state.snapshot()).toEqual({ x: 3 });
    expect(state.createLayer({ x: 4 }).active).toBe(true);
    expect(state.get('x')).toBe(4);
  });

  it('destroy слоя из getter отзывает pending set', () => {
    const state = createStateCascade<Visual>();
    state.createLayer({ x: 1 });
    const layer = state.createLayer({ x: 2 });
    layer.set({ get x() { layer.destroy(); return 9; } });
    expect(state.get('x')).toBe(1);
    expect(layer.active).toBe(false);
  });

  it('clear сохраняет приоритет повторно включённого слоя', () => {
    const state = createStateCascade<Visual>();
    const bottom = state.createLayer({ x: 1 });
    const top = state.createLayer({ x: 2 });
    bottom.clear();
    bottom.set({ x: 3 });
    expect(state.get('x')).toBe(2);
    top.clear();
    expect(state.get('x')).toBe(3);
  });

  it('отказ initial constructor не оставляет orphan owner; rollback тоже доставляется', () => {
    const state = createStateCascade<Visual>();
    state.createLayer({ x: 0 });
    const failure = new Error('initial listener');
    const seen: number[] = [];
    state.subscribe(({ changed }) => { if (changed.x === 1) throw failure; });
    state.subscribe(({ changed }) => { seen.push(changed.x!); });
    expect(() => state.createLayer({ x: 1 })).toThrow(failure);
    expect(seen).toEqual([1, 0]);
    expect(state.snapshot()).toEqual({ x: 0 });
  });

  it('ошибки нескольких подписчиков не теряются и сохраняют порядок', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const one = new Error('one');
    const two = new Error('two');
    state.subscribe(() => { throw one; });
    state.subscribe(() => { throw two; });
    let caught: unknown;
    try { layer.set({ x: 1 }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([one, two]);
    expect(state.get('x')).toBe(1);
  });

  it('конечная цепочка 10000 реентрантных коммитов не растит call stack', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    let received = 0;
    let latest = 0;
    state.subscribe(({ changed }) => {
      if (changed.x! < 10000) layer.set({ x: changed.x! + 1 });
    });
    state.subscribe(({ changed }) => {
      received++;
      expect(changed.x).toBe(received);
      latest = changed.x!;
    });
    layer.set({ x: 1 });
    expect(received).toBe(10000);
    expect(latest).toBe(state.get('x'));
    state.destroy();
  });

  it('destroy обрывает накопленную очередь, не только один текущий callback', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    const seen: number[] = [];
    state.subscribe(({ changed }) => {
      if (changed.x === 1) { layer.set({ x: 2 }); layer.set({ x: 3 }); }
      else state.destroy();
    });
    state.subscribe(({ changed }) => { seen.push(changed.x!); });
    layer.set({ x: 1 });
    expect(seen).toEqual([1]);
    expect(state.snapshot()).toEqual({});
  });

  it('inert handles не читают новые входы и не подписывают callbacks', () => {
    const state = createStateCascade<Visual>();
    const layer = state.createLayer();
    state.destroy();
    const bad = { get x(): number { throw new Error('must not read'); } };
    expect(() => layer.set(bad)).not.toThrow();
    const inert = state.createLayer(bad);
    expect(() => inert.set(bad)).not.toThrow();
    expect(inert.clear()).toEqual({ changed: {}, removed: [] });
    expect(inert.destroy()).toEqual({ changed: {}, removed: [] });
    state.subscribe(() => { throw new Error('must not call'); })();
  });
});

it('getter, меняющий другой слой, не отменяет допустимый commit текущего', () => {
  const state = createStateCascade<Visual>();
  const base = state.createLayer({ x: 0 });
  const hover = state.createLayer();
  const patch = hover.set({ get x() { base.set({ opacity: 0.25 }); return 2; } });
  expect(patch.changed).toEqual({ x: 2 });
  expect(state.snapshot()).toEqual({ x: 2, opacity: 0.25 });
});

it('initial snapshot имеет приоритет после слоёв, созданных его getters', () => {
  const state = createStateCascade<Visual>();
  const top = state.createLayer({ get x() { state.createLayer({ x: 1 }); return 2; } });
  expect(state.get('x')).toBe(2);
  top.destroy();
  expect(state.get('x')).toBe(1);
});

it('rollback конструктора не скрывает вторую ошибку и не удерживает недоступный слой', () => {
  const state = createStateCascade<Visual>();
  state.createLayer({ x: 0 });
  const one = new Error('commit');
  const two = new Error('rollback');
  state.subscribe(({ changed }) => { throw changed.x === 1 ? one : two; });
  let caught: unknown;
  try { state.createLayer({ x: 1 }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([one, two]);
  expect(state.get('x')).toBe(0);
});

it('snapshot читает только собственные перечислимые строковые ключи; null не является clear', () => {
  const state = createStateCascade<Visual>();
  const layer = state.createLayer({ x: 1 });
  const target = Object.create({ opacity: 0.2 }) as Partial<Visual>;
  Object.defineProperty(target, Symbol('not a state key'), { enumerable: true, get() { throw new Error('must not read'); } });
  Object.defineProperty(target, 'x', { value: 3, enumerable: true });
  layer.set(target);
  expect(state.snapshot()).toEqual({ x: 3 });
  expect(() => layer.set(null as never)).toThrow(TypeError);
  expect(() => layer.set(undefined as never)).toThrow(TypeError);
  expect(state.snapshot()).toEqual({ x: 3 });
});

it.each([
  ['null', (): null => null],
  ['throwing getter', () => ({ get x(): number { throw new Error('invalid input'); } })],
] as const)('неудачный вложенный set (%s) не отзывает ещё допустимый внешний commit', (_name, badInput) => {
  const state = createStateCascade<Visual>();
  const layer = state.createLayer({ x: 0 });
  layer.set({ get x() {
    expect(() => layer.set(badInput() as never)).toThrow();
    return 9;
  } });
  expect(state.get('x')).toBe(9);
});
