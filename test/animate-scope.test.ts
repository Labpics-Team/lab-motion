import { describe, expect, it, vi } from 'vitest';
import * as entry from '../src/animate/index.js';
import type { AnimateControls, AnimateOptions, AnimateProps, AnimateTarget } from '../src/animate/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

// До реализации namespace-import позволяет получить предметный RED отсутствия
// capability, а не ошибку загрузки модуля. Оракул использует только public API.
type Root = { querySelectorAll(selector: string): ArrayLike<unknown> };
type Scope = { animate(target: AnimateTarget, props: AnimateProps, options?: AnimateOptions): AnimateControls; destroy(): void };
function scope(root: Root): Scope {
  const factory = (entry as unknown as { createAnimateScope?: (root: Root) => Scope }).createAnimateScope;
  expect(factory, 'публичная область компонентов отсутствует').toBeTypeOf('function');
  return factory!(root);
}
const emptyRoot: Root = { querySelectorAll: () => [] };
const linear = (t: number): number => t;

function setup() {
  const a = fakeEl();
  const b = fakeEl();
  const clock = makeClock();
  const roots = { a: { querySelectorAll: vi.fn(() => [a.el]) }, b: { querySelectorAll: vi.fn(() => [b.el]) } };
  return { a, b, clock, roots, options: { duration: 100, ease: linear, requestFrame: clock.requestFrame } };
}

describe('область animate — локальный query и общий lifecycle', () => {
  it('factory валидирует query-host, но не исполняет query или движение', () => {
    for (const value of [null, undefined, {}, { querySelectorAll: 1 }]) {
      expect(() => scope(value as Root)).toThrow(TypeError);
    }
    const querySelectorAll = vi.fn(() => []); const s = scope({ querySelectorAll });
    expect(querySelectorAll).not.toHaveBeenCalled(); s.destroy();
  });

  it('ошибка финального cleanup сообщается host-у, сломанный reporter не мешает уборке', async () => {
    const { a, options } = setup(); const s = scope(emptyRoot);
    const c = s.animate(a.el, { opacity: [0, 1] }, options); const cancel = c.cancel; const error = new Error('cleanup');
    c.cancel = () => { cancel(); throw error; };
    const report = vi.fn(() => { throw new Error('reporter'); }); vi.stubGlobal('reportError', report);
    try {
      expect(() => s.destroy()).toThrow(error);
      await c.finished;
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
    } finally { vi.unstubAllGlobals(); }
  });

  it('две копии компонента не анимируют одноимённые чужие цели', () => {
    const { a, b, clock, roots, options } = setup();
    const s = scope(roots.a);
    s.animate('.item', { opacity: [0, 1] }, options);
    clock.drain();
    expect(roots.a.querySelectorAll).toHaveBeenCalledExactlyOnceWith('.item');
    expect(a.writes.at(-1)?.value).toBe('1');
    expect(b.writes).toEqual([]);
    s.destroy();
  });

  it('query получает свой this и свежие потомки на каждом вызове', () => {
    const { a, b, options, clock } = setup();
    const root = { nodes: [a.el], querySelectorAll() { expect(this).toBe(root); return this.nodes; } };
    const s = scope(root);
    s.animate('.item', { opacity: [0, 1] }, options); clock.drain();
    root.nodes = [b.el];
    s.animate('.item', { opacity: [0, .5] }, options); clock.drain();
    expect(a.writes.at(-1)?.value).toBe('1'); expect(b.writes.at(-1)?.value).toBe('0.5');
    s.destroy();
  });

  it('явная цель не требует query и может быть вне root', () => {
    const { b, options, clock } = setup();
    const querySelectorAll = vi.fn(() => { throw new Error('query не нужен'); });
    const s = scope({ querySelectorAll });
    const c = s.animate(b.el, { opacity: [0, 1] }, options); clock.drain();
    expect(b.writes.at(-1)?.value).toBe('1'); expect(querySelectorAll).not.toHaveBeenCalled();
    expect(c.stop).toBe(c.cancel); s.destroy();
  });

  it('destroy прекращает active, paused и delayed и завершает все promises', async () => {
    const { a, b, options, clock } = setup(); const d = fakeEl(); const s = scope(emptyRoot);
    const complete = vi.fn();
    const controls = [a, b, d].map((el, i) => s.animate(el.el, { opacity: [0, 1] }, { ...options, delay: i === 2 ? 1000 : 0, onComplete: complete }));
    clock.step(0); clock.step(20); controls[1]!.pause();
    expect(a.writes.length).toBeGreaterThan(0);
    s.destroy(); const lengths = [a, b, d].map(x => x.writes.length);
    s.destroy(); clock.drain();
    expect([a, b, d].map(x => x.writes.length)).toEqual(lengths);
    await Promise.all(controls.map(x => x.finished)); expect(complete).not.toHaveBeenCalled();
  });

  it('отмена scope не отменяет чужой successor той же property', async () => {
    const { a, options, clock } = setup(); const s = scope(emptyRoot);
    const old = s.animate(a.el, { opacity: [0, 1] }, options); clock.step(0); clock.step(20);
    const next = entry.animate(a.el, { opacity: .7 }, options);
    s.destroy(); clock.drain(); await Promise.all([old.finished, next.finished]);
    expect(a.writes.at(-1)?.value).toBe('0.7');
  });

  it('cleanup старого mount не отключает новый scope', async () => {
    const { a, options, clock } = setup(); const first = scope(emptyRoot);
    first.animate(a.el, { opacity: [0, 1] }, options); first.destroy();
    const second = scope(emptyRoot); const c = second.animate(a.el, { opacity: [0, .8] }, options);
    first.destroy(); clock.drain(); await c.finished; expect(a.writes.at(-1)?.value).toBe('0.8'); second.destroy();
  });

  it('поздний handler после destroy не читает ни один вход и возвращает no-op controls', async () => {
    const querySelectorAll = vi.fn(() => []); const s = scope({ querySelectorAll }); s.destroy(); querySelectorAll.mockClear();
    const poison = new Proxy({}, { get() { throw new Error('прочитан поздний вход'); } });
    const c = s.animate(poison as AnimateTarget, poison as AnimateProps, poison as AnimateOptions);
    const selected = s.animate('.item', poison as AnimateProps, poison as AnimateOptions);
    c.play(); c.pause(); c.seek(10); c.cancel(); c.stop(); await c.finished; await selected.finished;
    expect(querySelectorAll).not.toHaveBeenCalled(); expect(c.stop).toBe(c.cancel);
  });

  it('естественно завершённые controls удаляются из учёта', async () => {
    const { a, options, clock } = setup(); const s = scope(emptyRoot); const complete = vi.fn();
    const c = s.animate(a.el, { opacity: [0, 1] }, { ...options, onComplete: complete });
    const cancel = vi.spyOn(c, 'cancel'); clock.drain(); await c.finished;
    s.destroy(); expect(cancel).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledOnce();
  });

  it('ручная отмена удаляет controls после finished и не повторяется при destroy', async () => {
    const { a, options } = setup(); const s = scope(emptyRoot); const c = s.animate(a.el, { opacity: [0, 1] }, options);
    c.cancel(); await c.finished; const cancel = vi.spyOn(c, 'cancel'); s.destroy(); expect(cancel).not.toHaveBeenCalled();
  });

  it('пустой selector естественно завершается', async () => {
    const s = scope(emptyRoot); const complete = vi.fn(); const c = s.animate('.absent', { opacity: 1 }, { onComplete: complete });
    await c.finished; expect(complete).toHaveBeenCalledOnce(); s.destroy();
  });

  it('invalid query и invalid animation не портят scope и не создают owner', () => {
    const { a, clock, options } = setup(); const error = new SyntaxError('selector');
    const s = scope({ querySelectorAll: () => { throw error; } });
    expect(() => s.animate('[', { opacity: 1 })).toThrow(error);
    expect(() => s.animate(a.el, { opacity: NaN }, options)).toThrow();
    expect(a.writes).toHaveLength(0); s.animate(a.el, { opacity: [0, 1] }, options); clock.drain();
    expect(a.writes.at(-1)?.value).toBe('1'); s.destroy();
  });

  it('ошибка/неэлемент query-выхода остаётся ошибкой full runtime', () => {
    const s = scope({ querySelectorAll: () => [null] });
    expect(() => s.animate('.item', { opacity: 1 })).toThrow(/LM147/); s.destroy();
  });

  it('destroy из query не разрешает начать анимацию после отзыва', async () => {
    const { a, clock, options } = setup(); let s: Scope;
    s = scope({ querySelectorAll() { s.destroy(); return [a.el]; } });
    const c = s.animate('.item', { opacity: [0, 1] }, options); await c.finished; clock.drain(); expect(a.writes).toHaveLength(0);
  });

  it('destroy из options getter не оставляет поздно созданные controls активными', async () => {
    const { a, clock, options } = setup(); const s = scope(emptyRoot);
    const c = s.animate(a.el, { opacity: [0, 1] }, { ...options, get duration() { s.destroy(); return 100; } });
    const count = a.writes.length; clock.drain(); await c.finished; expect(a.writes.length).toBe(count);
  });

  it('destroy из синхронного onComplete сохраняет его порядок и exactly-once', async () => {
    const { a } = setup(); const s = scope(emptyRoot); const events: string[] = [];
    const c = s.animate(a.el, { opacity: 1 }, { matchMedia: () => ({ matches: true }), onComplete() { events.push('complete'); s.destroy(); } });
    events.push('return'); await c.finished; events.push('finished'); expect(events).toEqual(['complete', 'return', 'finished']);
    expect(a.writes.at(-1)?.value).toBe('1'); s.destroy();
  });

  it('host setup reentry отзывает и поздно возвращённый WAAPI run', async () => {
    const native = fakeEl({}, true); const s = scope(emptyRoot); const start = native.el.animate!;
    native.el.animate = (frames, timing) => { s.destroy(); return start(frames, timing); };
    const c = s.animate(native.el, { opacity: [0, 1] }, { now: () => 0, setTimer: () => () => {} });
    await c.finished; expect(native.animateCalls).toHaveLength(1); expect(native.cancels).toBe(1);
  });

  it('destroy сначала отзывает scope, потом вызывает cleanup, даже при reentry', async () => {
    const { a, b, options, clock } = setup(); const s = scope(emptyRoot); const c = s.animate(a.el, { opacity: [0, 1] }, options);
    const cancel = c.cancel; let late: AnimateControls | undefined;
    c.cancel = () => { s.destroy(); late = s.animate(b.el, { opacity: [0, 1] }, options); cancel(); };
    s.destroy(); await c.finished; await late!.finished; clock.drain(); expect(b.writes).toHaveLength(0);
  });

  it('одна cleanup ошибка (даже undefined) не теряется и не мешает остальным', async () => {
    const { a, b, options, clock } = setup(); const s = scope(emptyRoot);
    const first = s.animate(a.el, { opacity: [0, 1] }, options); const second = s.animate(b.el, { opacity: [0, 1] }, options);
    const cancel = first.cancel; first.cancel = () => { cancel(); throw undefined; };
    let threw = false; try { s.destroy(); } catch (error) { threw = true; expect(error).toBeUndefined(); }
    expect(threw).toBe(true); await Promise.all([first.finished, second.finished]);
    const counts = [a.writes.length, b.writes.length]; s.destroy(); clock.drain(); expect([a.writes.length, b.writes.length]).toEqual(counts);
  });

  it('несколько cleanup ошибок сохраняются в AggregateError в порядке вызовов', () => {
    const { a, b, options } = setup(); const s = scope(emptyRoot); const errors = [new Error('a'), new Error('b')];
    for (const [i, el] of [a, b].entries()) { const c = s.animate(el.el, { opacity: [0, 1] }, options); const cancel = c.cancel; c.cancel = () => { cancel(); throw errors[i]; }; }
    try { s.destroy(); expect.unreachable('обязана быть ошибка'); } catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual(errors); }
    s.destroy();
  });

  it('destroy внутри WAAPI pause не теряется за reservation и завершает paused run', async () => {
    const native = fakeEl({}, true); const s = scope(emptyRoot);
    const c = s.animate(native.el, { opacity: [0, 1] }, { now: () => 0, setTimer: () => () => {} });
    const write = native.el.style.setProperty;
    native.el.style.setProperty = (key, value) => { s.destroy(); write(key, value); };
    let complete = false; void c.finished.then(() => { complete = true; });
    c.pause(); // Host write идёт под WAAPI reservation: вложенный cancel сейчас no-op.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(complete, 'destroy потерян внутри host-транзакции').toBe(true);
    const count = native.animateCalls.length; c.play();
    expect(native.animateCalls).toHaveLength(count);
  });

  it('случайные mount/cancel/pause/finish истории не создают stale записи после destroy', async () => {
    let seed = 0x376; const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let run = 0; run < 128; run++) {
      const clock = makeClock(); const s = scope(emptyRoot); const els = Array.from({ length: 8 }, () => fakeEl()); const controls: AnimateControls[] = [];
      for (const el of els) {
        const c = s.animate(el.el, { opacity: [0, 1] }, { duration: 40, ease: linear, requestFrame: clock.requestFrame, delay: random() % 60 }); controls.push(c);
        if (random() % 3 === 0) c.pause(); if (random() % 5 === 0) c.cancel(); clock.step(random() % 20);
      }
      s.destroy(); const snapshots = els.map(el => el.writes.length); clock.drain(); await Promise.all(controls.map(c => c.finished));
      expect(els.map(el => el.writes.length)).toEqual(snapshots);
    }
  });
});
