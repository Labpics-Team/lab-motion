import { describe, expect, it, vi } from 'vitest';
// Новый порт сначала пуст; RED должен быть предметным, не ошибкой resolver.
import * as api from '../src/behaviors/reorder/index.js';
import type { ReorderItem, ReorderProposal } from '../src/behaviors/reorder/index.js';

const rect = (x: number, y = 0) => ({ x, y, width: 20, height: 20 });
const row = (keys = ['a', 'b', 'c']): ReorderItem<string>[] => keys.map((key, i) => ({ key, rect: rect(i * 40) }));
const grid = (): ReorderItem<string>[] => ['a', 'b', 'c', 'd'].map((key, i) => ({ key, rect: rect(i % 2 * 40, Math.floor(i / 2) * 40) }));

describe('управляемая перестановка, не вторая модель данных', () => {
  it('экспортирует только factory, делает предложение и ждёт commit приложения', () => {
    expect(Object.keys(api)).toEqual(['createReorder']);
    const items = row(); const onReorder = vi.fn();
    const state = api.createReorder({ items, onReorder });
    const drag = state.start('a')!;
    drag.move({ x: 90, y: 10 });
    const [next, proposal] = onReorder.mock.calls[0]!;
    expect(next).toEqual(['b', 'c', 'a']);
    expect(items.map(x => x.key)).toEqual(['a', 'b', 'c']);
    expect(proposal).toMatchObject({ key: 'a', over: 'c', from: 0, to: 2 });
    expect(state.isCurrent(proposal)).toBe(true);
    expect(Object.isFrozen(next)).toBe(true); expect(Object.isFrozen(proposal)).toBe(true);
    drag.move({ x: 90, y: 10 }); expect(onReorder).toHaveBeenCalledTimes(1);
    // Consumer отказал: возврат к исходному slot отзывает прежний proposal.
    drag.move({ x: 10, y: 10 }); expect(state.isCurrent(proposal)).toBe(false);
    drag.move({ x: 90, y: 10 }); expect(onReorder).toHaveBeenCalledTimes(2);
  });
  it('повторный ввод после принятия идёт от фактического порядка по stable key', () => {
    let items = row(); const result: string[][] = [];
    const state = api.createReorder({ items, onReorder(next) { result.push([...next]); items = row([...next]); state.update(items); } });
    const drag = state.start('a')!; drag.move({ x: 90, y: 10 }); drag.step('previous');
    expect(result).toEqual([['b', 'c', 'a'], ['b', 'a', 'c']]);
    expect(drag.active).toBe(true); expect(state.activeKey).toBe('a');
  });
  it('сетка, неполный ряд и перенос всей geometry сохраняют выбор', () => {
    for (const offset of [0, 1024, -2048]) {
      const onReorder = vi.fn();
      const items = grid().slice(0, 3).map(item => ({ key: item.key, rect: rect(item.rect!.x + offset, item.rect!.y + offset) }));
      const state = api.createReorder({ items, onReorder });
      expect(state.axis).toBe('both'); state.start('a')!.move({ x: 11 + offset, y: 51 + offset });
      expect(onReorder.mock.calls[0]?.[0]).toEqual(['b', 'c', 'a']);
    }
  });
  it('axis auto: строка, колонка, grid; tie предпочитает текущий slot', () => {
    const onReorder = vi.fn(); const horizontal = api.createReorder({ items: row(), onReorder });
    expect(horizontal.axis).toBe('x'); horizontal.start('b')!.move({ x: 30, y: 500 }); expect(onReorder).not.toHaveBeenCalled();
    const vertical = api.createReorder({ items: row().map((x, i) => ({ key: x.key, rect: rect(0, i * 40) })), onReorder });
    expect(vertical.axis).toBe('y'); expect(api.createReorder({ items: grid(), onReorder }).axis).toBe('both');
  });
  it('keyboard и pointer имеют один закон вставки; RTL меняет logical horizontal order', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const keys = direction === 'rtl' ? ['c', 'b', 'a'] : ['a', 'b', 'c'];
      const items = keys.map(key => ({ key, rect: rect(['a', 'b', 'c'].indexOf(key) * 40) }));
      const pointer = vi.fn(); const keyboard = vi.fn();
      api.createReorder({ items, direction, onReorder: pointer }).start('b')!.move({ x: 90, y: 10 });
      api.createReorder({ items, direction, onReorder: keyboard }).start('b')!.step('right');
      expect(keyboard.mock.calls[0]![0]).toEqual(pointer.mock.calls[0]![0]);
      expect(keyboard.mock.calls[0]![1].to).toBe(direction === 'rtl' ? 0 : 2);
    }
    const onReorder = vi.fn(); api.createReorder({ items: grid(), onReorder }).start('a')!.step('down');
    expect(onReorder.mock.calls[0]?.[0]).toEqual(['b', 'c', 'a', 'd']);
  });
  it('пустые/невидимые/вырожденные slots не становятся выдуманными drop targets', () => {
    const onReorder = vi.fn();
    const state = api.createReorder({ items: [{ key: 'a', rect: rect(0) }, { key: 'hidden' }, { key: 'zero', rect: { ...rect(80), width: 0 } }, { key: 'c', rect: rect(120) }], onReorder });
    expect(state.start('hidden')).toBeUndefined(); expect(state.start('zero')).toBeUndefined();
    const drag = state.start('a')!; drag.step('next'); expect(onReorder).not.toHaveBeenCalled();
    drag.move({ x: 130, y: 10 }); expect(onReorder.mock.calls[0]?.[0]).toEqual(['hidden', 'zero', 'c', 'a']);
    expect(api.createReorder({ items: [], onReorder }).start('a')).toBeUndefined();
  });
  it('удаление active key отменяет session; старое предложение не проходит async acceptance', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder });
    const drag = state.start('a')!; drag.step('last'); const p = onReorder.mock.calls[0]![1];
    state.update(row(['b', 'a', 'c'])); expect(state.isCurrent(p)).toBe(false); expect(drag.active).toBe(true);
    state.update(row(['b', 'c'])); expect(drag.active).toBe(false); expect(state.activeKey).toBeUndefined();
    drag.step('first'); expect(onReorder).toHaveBeenCalledTimes(1);
  });
  it('успешный новый start отзывает старый, неизвестный key не мешает текущему', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder });
    const a = state.start('a')!; expect(state.start('missing')).toBeUndefined(); expect(a.active).toBe(true);
    const b = state.start('b')!; a.cancel(); a.move(new Proxy({ x: 0, y: 0 }, { get() { throw Error('stale input'); } }));
    expect(b.active).toBe(true); expect(onReorder).not.toHaveBeenCalled();
    b.end(); expect(b.active).toBe(false); state.cancel(); state.destroy(); state.destroy();
    expect(state.start('a')).toBeUndefined();
    expect(() => state.update(new Proxy([], { get() { throw Error('late input'); } }))).not.toThrow();
  });
  it('callback exception не маскируется и не убивает созданную им новую session', () => {
    const failure = {}; let next: ReturnType<ReturnType<typeof api.createReorder<string>>['start']>;
    const state = api.createReorder({ items: row(), onReorder() { next = state.start('b'); throw failure; } });
    const first = state.start('a')!; expect(() => first.step('last')).toThrow(failure);
    expect(first.active).toBe(false); expect(next!.active).toBe(true);
    const simple = api.createReorder({ items: row(), onReorder() { throw undefined; } });
    const s = simple.start('a')!; let thrown = false; try { s.step('next'); } catch (e) { thrown = true; expect(e).toBeUndefined(); }
    expect(thrown).toBe(true); expect(s.active).toBe(false);
  });
});

describe('атомарные snapshots и hostile/reentrant границы', () => {
  it('input snapshot не меняется через caller alias', () => {
    const items = row(); const onReorder = vi.fn(); const state = api.createReorder({ items, onReorder });
    (items[1]!.rect as { x: number }).x = 400; items.reverse();
    state.start('a')!.step('next'); expect(onReorder.mock.calls[0]?.[0]).toEqual(['b', 'a', 'c']);
  });
  it('отклоняет sparse, duplicate и unsafe geometry до эффекта; отказ сохраняет old snapshot', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder }); const drag = state.start('a')!;
    for (const items of [Array(2), [row()[0], row()[0]], [{ key: 'a', rect: rect(NaN) }], [{ key: NaN }], [{ key: 'b', rect: { ...rect(0), width: -1 } }]]) {
      expect(() => state.update(items as never)).toThrow();
    }
    expect(() => drag.move({ x: Infinity, y: 0 })).toThrow();
    expect(onReorder).not.toHaveBeenCalled(); drag.step('last'); expect(onReorder.mock.calls[0]?.[0]).toEqual(['b', 'c', 'a']);
  });
  it('лимит до индексных getters; getter читается один раз', () => {
    let reads = 0; const huge = new Proxy(new Array(100_001), { get(t, k) { if (k === '0') reads++; return Reflect.get(t, k); } });
    expect(() => api.createReorder({ items: huge, onReorder() {} })).toThrow(); expect(reads).toBe(0);
    const items = row(); const r = items[0]!.rect!; let xs = 0;
    Object.defineProperty(r, 'x', { get() { xs++; return 0; } }); api.createReorder({ items, onReorder() {} }); expect(xs).toBe(1);
  });
  it('успешное вложенное update выигрывает, неуспешное не отзывает внешний commit', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder });
    const outer = row(); Object.defineProperty(outer[0], 'key', { get() { state.update(row(['c', 'b', 'a'])); return 'a'; } });
    state.update(outer); state.start('c')!.step('next'); expect(onReorder.mock.calls.at(-1)?.[0]).toEqual(['b', 'c', 'a']);
    const healthy = row(); Object.defineProperty(healthy[0], 'key', { get() { try { state.update([null] as never); } catch {} return 'a'; } });
    state.update(healthy); state.start('a')!.step('next'); expect(onReorder.mock.calls.at(-1)?.[0]).toEqual(['b', 'a', 'c']);
  });
  it('destroy из input getter и move getter не публикует stale proposal', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder }); const s = state.start('a')!;
    s.move({ get x() { state.destroy(); return 90; }, y: 10 }); expect(onReorder).not.toHaveBeenCalled(); expect(s.active).toBe(false);
    const second = api.createReorder({ items: row(), onReorder }); const items = row(); Object.defineProperty(items[0], 'rect', { get() { second.destroy(); return rect(0); } });
    second.update(items); expect(second.start('a')).toBeUndefined();
  });
  it('reentrant input update отзывает pending move, но не всю session', () => {
    const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder }); const s = state.start('a')!;
    s.move({ get x() { state.update(row(['b', 'c', 'a'])); return 90; }, y: 10 });
    expect(onReorder).not.toHaveBeenCalled(); expect(s.active).toBe(true);
    s.step('first'); expect(onReorder.mock.calls.at(-1)?.[0]).toEqual(['a', 'b', 'c']);
  });
});

it('seeded independent remove/insert oracle: 4096 histories, no dropped/duplicated keys', () => {
  let seed = 0x3172026;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 4096; run++) {
    const n = 2 + rng() % 31; const from = rng() % n; const to = rng() % n; const width = 1 + rng() % 11; const dx = rng() % 10000 - 5000;
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const onReorder = vi.fn(); const state = api.createReorder({ items: keys.map((key, i) => ({ key, rect: { x: dx + i * width * 4, y: -20, width, height: width } })), onReorder });
    state.start(keys[from]!)!.move({ x: dx + to * width * 4 + width / 2, y: -20 + width / 2 });
    const expected = keys.filter((_, i) => i !== from); expected.splice(to, 0, keys[from]!);
    if (from === to) expect(onReorder).not.toHaveBeenCalled();
    else { expect(onReorder.mock.calls[0]?.[0]).toEqual(expected); expect(new Set(onReorder.mock.calls[0]?.[0]).size).toBe(n); }
    state.destroy();
  }
});

it('неизменный pointer intent не материализует permutation; изменение — positive control', () => {
  const onReorder = vi.fn(); const state = api.createReorder({ items: row(), onReorder });
  const s = state.start('a')!; const point = { x: 90, y: 10 };
  s.move(point);
  const map = vi.spyOn(Array.prototype, 'map'); const splice = vi.spyOn(Array.prototype, 'splice');
  try {
    for (let i = 0; i < 10_000; i++) s.move(point);
    const stableMaps = map.mock.calls.length, stableSplices = splice.mock.calls.length;
    s.move({ x: 50, y: 10 });
    const changedMaps = map.mock.calls.length, changedSplices = splice.mock.calls.length;
    expect(stableMaps).toBe(0); expect(stableSplices).toBe(0);
    expect(changedMaps).toBe(1); expect(changedSplices).toBe(2); expect(onReorder).toHaveBeenCalledTimes(2);
  } finally { map.mockRestore(); splice.mockRestore(); state.destroy(); }
});

it('одинаковые центры и масштаб geometry: tie stable и нет ложной перестановки', () => {
  const onReorder = vi.fn(); const state = api.createReorder({ items: ['a', 'b', 'c'].map(key => ({ key, rect: rect(0) })), onReorder });
  state.start('c')!.move({ x: 0, y: 0 }); expect(onReorder).not.toHaveBeenCalled();
  for (const scale of [.25, 1, 8]) {
    const items = grid().map(item => ({ key: item.key, rect: { x: item.rect!.x * scale, y: item.rect!.y * scale, width: 20 * scale, height: 20 * scale } }));
    api.createReorder({ items, onReorder }).start('a')!.move({ x: 50 * scale, y: 50 * scale });
    expect(onReorder.mock.calls.at(-1)?.[0]).toEqual(['b', 'c', 'd', 'a']);
  }
});

it('runtime structural boundaries: keys SameValueZero, shape, count, geometry, keyboard', () => {
  for (const options of [null, {}, { axis: 'z', items: [] }, { direction: 'wrong', items: [] }, { items: [], onReorder: 1 }]) {
    expect(() => api.createReorder(options as never)).toThrow(TypeError);
  }
  expect(() => api.createReorder({ items: [{ key: -0 }, { key: 0 }], onReorder() {} })).toThrow(TypeError);
  for (const length of [NaN, -1, 1.5, '3']) {
    const items = new Proxy([], { get(_t, k) { if (k === 'length') return length; throw Error('indexed getter before cap'); } });
    expect(() => api.createReorder({ items, onReorder() {} })).toThrow(RangeError);
  }
  for (const x of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, -Infinity]) {
    expect(() => api.createReorder({ items: [{ key: 'a', rect: rect(x) }], onReorder() {} })).toThrow(RangeError);
  }
  const state = api.createReorder({ items: row(), onReorder() {} });
  expect(() => state.start('a')!.step('diagonal' as never)).toThrow(TypeError);
});
