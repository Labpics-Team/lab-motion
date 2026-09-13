import { describe, expect, it, vi } from 'vitest';
import * as bindings from '../src/bindings/index.js';
import { MotionParamError } from '../src/errors.js';

const create: typeof bindings.createMotionBinding = (...args) => {
  expect(bindings).toHaveProperty('createMotionBinding');
  return bindings.createMotionBinding(...args);
};
const handle = () => ({ cancel: vi.fn() });

describe('семантическая привязка движения', () => {
  it('обновляет только изменившиеся визуальные роли, не копирует app model', () => {
    const surface = vi.fn(handle), progress = vi.fn(handle);
    const project = (s: { pressed: boolean; progress: number }) => ({
      surface: { scale: s.pressed ? 0.96 : 1 }, progress: { scaleX: s.progress },
    });
    const view = create(project, { surface, progress });
    const model = { pressed: false, progress: 0 };
    view.update(model);
    for (let i = 1; i <= 1000; i++) { model.progress = i / 1000; view.update(model); }
    expect(surface).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(1001);
    model.pressed = true; view.update(model);
    expect(surface).toHaveBeenCalledTimes(2); expect(progress).toHaveBeenCalledTimes(1001);
    expect(model).toEqual({ pressed: true, progress: 1 });
    view.destroy();
  });

  it('неизменённый результат не перезапускает проигрывание даже при новых данных', () => {
    const write = vi.fn(handle);
    const view = create((n: number) => ({ meter: { scaleX: Math.min(1, n) } }), { meter: write });
    view.update(1); const running = write.mock.results[0]!.value;
    for (let i = 0; i < 1000; i++) view.update(2 + i);
    expect(write).toHaveBeenCalledOnce(); expect(running.cancel).not.toHaveBeenCalled();
    view.destroy(); expect(running.cancel).toHaveBeenCalledOnce();
  });

  it('снимает неизменяемые цели до первой записи и не сохраняет чужой mutable объект', () => {
    const a = { x: 0 }, b = { x: 0 }, seen: number[] = [];
    const view = create(() => ({ a, b }), {
      a: goal => { expect(Object.isFrozen(goal)).toBe(true); b.x = 77; },
      b: goal => { seen.push(goal.x); },
    });
    view.update(undefined); expect(seen).toEqual([0]);
    view.update(undefined); expect(seen).toEqual([0, 77]);
    view.destroy();
  });

  it('полностью проверяет результат до эффектов и оставляет старый прогон при ошибке projection', () => {
    const old = handle(), a = vi.fn(() => old), b = vi.fn(handle);
    const view = create((n: number) => ({ a: { x: n }, b: { x: n === 2 ? NaN : n } }), { a, b });
    view.update(1);
    expect(() => view.update(2)).toThrow(MotionParamError);
    expect(a).toHaveBeenCalledOnce(); expect(old.cancel).not.toHaveBeenCalled();
    view.update(3); expect(a).toHaveBeenCalledTimes(2);
    view.destroy();
  });

  it('стабильные роли и свойства не исчезают молча при смене рецепта', () => {
    const write = vi.fn(handle);
    const view = create((n: number) => n ? { panel: { opacity: 1 } } : { panel: { x: 0 } }, { panel: write });
    view.update(1); expect(() => view.update(0)).toThrow(MotionParamError);
    expect(write).toHaveBeenCalledOnce(); view.destroy();
  });

  it('начинает преемников до отмены прежних исполнителей', () => {
    const events: string[] = [], old = { cancel() { events.push('cancel old'); } };
    const view = create((n: number) => ({ panel: { x: n } }), {
      panel: goal => { events.push('start ' + goal.x); return goal.x === 1 ? old : handle(); },
    });
    view.update(1); view.update(2);
    expect(events).toEqual(['start 1', 'start 2', 'cancel old']); view.destroy();
  });

  it('переданный в следующий результат тот же handle не отменяется', () => {
    const owned = handle();
    const view = create((n: number) => ({ a: { x: n }, b: { x: n } }), { a: () => owned, b: () => owned });
    view.update(1); view.update(2); expect(owned.cancel).not.toHaveBeenCalled();
    view.destroy(); expect(owned.cancel).toHaveBeenCalledOnce();
  });

  it('вложенные updates не перемешивают общую цель и не рекурсируют по портам', () => {
    const seen: string[] = [];
    let view: bindings.MotionBindingControls<number>;
    view = create((n: number) => ({ a: { x: n }, b: { x: n } }), {
      a: goal => { seen.push('a' + goal.x); if (goal.x < 1000) view.update(goal.x + 1); },
      b: goal => { seen.push('b' + goal.x); },
    });
    view.update(0);
    expect(seen).toHaveLength(2002);
    for (let i = 0; i <= 1000; i++) expect(seen.slice(i * 2, i * 2 + 2)).toEqual(['a' + i, 'b' + i]);
    view.destroy();
  });

  it('очищает старых и новых исполнителей при отказе одного порта; ошибка не теряется', () => {
    const oldA = handle(), oldB = handle(), newA = handle(); const error = new Error('apply');
    const view = create((n: number) => ({ a: { x: n }, b: { x: n } }), {
      a: goal => goal.x === 1 ? oldA : newA,
      b: goal => { if (goal.x === 2) throw error; return oldB; },
    });
    view.update(1); expect(() => view.update(2)).toThrow(error);
    for (const h of [oldA, oldB, newA]) expect(h.cancel).toHaveBeenCalledOnce();
    expect(view.state).toBe('failed'); view.update(3); view.destroy();
    for (const h of [oldA, oldB, newA]) expect(h.cancel).toHaveBeenCalledOnce();
  });

  it('destroy отменяет всё несмотря на исключение, не возобновляется от позднего update', () => {
    const a = handle(), b = handle(); a.cancel.mockImplementation(() => { throw undefined; });
    const project = vi.fn((n: number) => ({ a: { x: n }, b: { x: n } }));
    const view = create(project, { a: () => a, b: () => b }); view.update(1);
    let threw = false; try { view.destroy(); } catch (error) { threw = true; expect(error).toBeUndefined(); }
    expect(threw).toBe(true); expect(b.cancel).toHaveBeenCalledOnce();
    view.update(2); view.destroy(); expect(project).toHaveBeenCalledOnce(); expect(view.state).toBe('destroyed');
  });

  it('destroy из apply отзывает поздно вернувшийся ресурс и следующие записи', () => {
    const a = handle(), b = vi.fn(handle); let view: bindings.MotionBindingControls<number>;
    view = create((n: number) => ({ a: { x: n }, b: { x: n } }), {
      a: () => { view.destroy(); return a; }, b,
    });
    view.update(1); expect(a.cancel).toHaveBeenCalledOnce(); expect(b).not.toHaveBeenCalled();
  });

  it('проекция не может рекурсивно записывать новую модель', () => {
    let view: bindings.MotionBindingControls<number>;
    const write = vi.fn(handle);
    view = create((n: number) => { if (n === 1) view.update(2); return { a: { x: n } }; }, { a: write });
    expect(() => view.update(1)).toThrow(MotionParamError);
    expect(write).not.toHaveBeenCalled(); expect(view.state).toBe('active'); view.update(0); view.destroy();
  });

  it('не прячет исходную ошибку за несколькими ошибками cleanup', () => {
    const a = { cancel() { throw 'a'; } }, b = { cancel() { throw undefined; } };
    const view = create((n: number) => ({ a: { x: n }, b: { x: n } }), {
      a: goal => { if (goal.x === 2) throw 'apply'; return a; }, b: () => b,
    });
    view.update(1);
    try { view.update(2); expect.fail('ожидается отказ'); }
    catch (error) { expect((error as AggregateError).errors).toEqual(['apply', 'a', undefined]); }
    expect(view.state).toBe('failed');
  });

  it('разные рецепты обслуживают неизменный смысл модели', () => {
    type Model = { pressed: boolean; completed: boolean };
    const a = vi.fn(), b = vi.fn();
    const restrained = create((s: Model) => ({ icon: { opacity: s.completed ? 1 : 0.4, scale: s.pressed ? 0.98 : 1 } }), { icon: a });
    const expressive = create((s: Model) => ({ icon: { rotate: s.completed ? 360 : 0, scale: s.pressed ? 0.92 : 1 } }), { icon: b });
    const model = Object.freeze({ pressed: true, completed: true });
    restrained.update(model); expressive.update(model);
    expect(a).toHaveBeenLastCalledWith({ opacity: 1, scale: 0.98 });
    expect(b).toHaveBeenLastCalledWith({ rotate: 360, scale: 0.92 });
    restrained.destroy(); expressive.destroy();
  });
});

it('update из отмены приходит после всей текущей транзакции', () => {
  const seen: number[] = []; let view: bindings.MotionBindingControls<number>;
  const old = { cancel() { view.update(3); } };
  view = create((n: number) => ({ a: { x: n } }), { a: goal => { seen.push(goal.x); return goal.x === 1 ? old : handle(); } });
  view.update(1); view.update(2); expect(seen).toEqual([1, 2, 3]); view.destroy();
});

it('destroy из cancel не оставляет новый ресурс и не вызывает cancel дважды', () => {
  const next = handle(); let view: bindings.MotionBindingControls<number>;
  const old = { cancel: vi.fn(() => view.destroy()) };
  view = create((n: number) => ({ a: { x: n } }), { a: goal => goal.x === 1 ? old : next });
  view.update(1); view.update(2);
  expect(next.cancel).toHaveBeenCalledOnce(); expect(old.cancel).toHaveBeenCalledOnce();
  expect(view.state).toBe('destroyed');
});

it('handle возвращён после destroy, но уже был отменён как прежний владелец', () => {
  const same = handle(); let view: bindings.MotionBindingControls<number>;
  view = create((n: number) => ({ a: { x: n } }), { a: goal => { if (goal.x === 2) view.destroy(); return same; } });
  view.update(1); view.update(2); expect(same.cancel).toHaveBeenCalledOnce();
});

it('ошибка после destroy не перезаписывает терминальное уничтожение', () => {
  let view: bindings.MotionBindingControls<number>;
  view = create((n: number) => ({ a: { x: n } }), { a: () => { view.destroy(); throw 'after destroy'; } });
  expect(() => view.update(1)).toThrow('after destroy'); expect(view.state).toBe('destroyed');
});

it('getter cancel может уничтожить привязку; его ресурс всё равно освобождается', () => {
  const cancel = vi.fn(); let view: bindings.MotionBindingControls<number>;
  view = create((n: number) => ({ a: { x: n } }), {
    a: () => ({ get cancel() { view.destroy(); return cancel; } }),
  });
  view.update(1); expect(cancel).toHaveBeenCalledOnce(); expect(view.state).toBe('destroyed');
});

it('снимок передаваемой цели не принимает изменения из queued-model после update', () => {
  let view: bindings.MotionBindingControls<{ x: number }>; const values: number[] = [];
  const mutable = { x: 2 };
  view = create((s: { x: number }) => ({ a: { x: s.x } }), { a: goal => {
    values.push(goal.x); if (goal.x === 1) { view.update(mutable); mutable.x = 99; }
  } });
  view.update({ x: 1 }); expect(values).toEqual([1, 2]); view.destroy();
});

it('свойства с особенными именами остаются собственными данными', () => {
  const write = vi.fn();
  const view = create((n: number) => ({ ['__proto__']: { ['__proto__']: n, constructor: 'x' } }), { ['__proto__']: write });
  view.update(-0); view.update(0);
  expect(write).toHaveBeenCalledTimes(2);
  expect(Object.getPrototypeOf(write.mock.calls[0]![0])).toBe(null);
  expect(Object.is(write.mock.calls[0]![0].__proto__, -0)).toBe(true); view.destroy();
});

it.each([null, [], { a: { x: NaN } }, { a: { x: Infinity } }, { a: { x: {} } }, { wrong: { x: 1 } }])(
  'ошибочный снимок не вызывает порты: %j', value => {
    const write = vi.fn();
    const view = create(() => value as unknown as { a: { x: number } }, { a: write });
    expect(() => view.update(undefined)).toThrow(MotionParamError); expect(write).not.toHaveBeenCalled();
    view.destroy();
  },
);

it('модельный oracle: разные входы с теми же целями не отличаются для renderer', () => {
  type Model = { pressed: boolean; status: number; progress: number };
  let seed = 123;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const events: Array<[string, number]> = [];
  const view = create((s: Model) => ({
    surface: { scale: s.pressed ? 0.97 : 1 },
    meter: { scaleX: Math.max(0, Math.min(1, s.progress)) },
    glyph: { opacity: s.status === 2 ? 1 : 0 },
  }), {
    surface: p => { events.push(['surface', p.scale]); },
    meter: p => { events.push(['meter', p.scaleX]); },
    glyph: p => { events.push(['glyph', p.opacity]); },
  });
  let previous: number[] | undefined;
  for (let i = 0; i < 4096; i++) {
    const state = { pressed: !!(random() & 4), status: random() % 3, progress: (random() % 150) / 100 };
    const expected = [state.pressed ? 0.97 : 1, state.progress > 1 ? 1 : state.progress, state.status === 2 ? 1 : 0];
    const before = events.length; view.update(state);
    expect(events.slice(before)).toEqual(expected.flatMap((n, j) => !previous || n !== previous[j] ? [[['surface', 'meter', 'glyph'][j], n]] : []));
    previous = expected;
  }
  view.destroy();
});

it('destroy из getter снимка прекращает чтение следующих ролей и не запускает порты', () => {
  let view: bindings.MotionBindingControls<number>;
  const late = vi.fn(() => 1), write = vi.fn();
  view = create(() => ({
    a: { get x() { view.destroy(); return 0; }, get y() { return late(); } },
    b: { get x() { return late(); } },
  }), { a: write, b: write });
  view.update(0);
  expect(late).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  expect(view.state).toBe('destroyed');
});

it('предел общего снимка проверяется до чтения значений переполненной роли', () => {
  const goal: Record<string, number> = {}; const getter = vi.fn(() => 0);
  for (let i = 0; i < 10_000; i++) Object.defineProperty(goal, i, { enumerable: true, get: getter });
  const write = vi.fn(); const view = create(() => ({ a: goal }), { a: write });
  expect(() => view.update(undefined)).toThrowError(expect.objectContaining({ code: 'LM174' }));
  expect(getter).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  view.destroy();
});
