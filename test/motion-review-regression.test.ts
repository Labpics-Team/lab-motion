import { afterEach, expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import { value } from '../src/motion/value.js';
import { frame, createFrameLoop } from '../src/frame/index.js';
import type { Playback } from '../src/motion/types.js';

const linear = { duration: 100, ease: 'linear' } as const;
afterEach(() => { frame.cancelAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('последовательные CSS-шаги получают разрешённый конец предшественника', async () => {
  for (const goal of ['100%', 'var(--goal)', '+=50%']) {
    const h = harness(); h.values.set('width', '240px'); h.values.set('--goal', '100%');
    let run: Playback | undefined;
    try {
      run = h.runtime.sequence([[h.element, { width: ['0%', '50%'] }, linear], [h.element, { width: goal }, linear]]);
      expect(run.duration).toBe(200); run.seek(150); expect(h.values.get('width')).toBe('75%');
      run.seek(50); expect(h.values.get('width')).toBe('25%');
      run.finish(); expect(await run.finished).toEqual({ status: 'finished' }); expect(h.values.get('width')).toBe('100%');
    } finally { run?.stop(); }
  }
});

it('sequence сохраняет ранний канал для обратной перемотки и не наследует обычный timeline', async () => {
  const h = harness(); const first = h.runtime.animate(h.element, { x: 100 }, linear);
  let run: Playback | undefined;
  try {
    run = h.runtime.sequence([[h.element, { x: 100 }, linear], [h.element, { y: 100 }, { ...linear, at: 200 }]]);
    expect(await first.finished).toEqual({ status: 'stopped' }); expect(run.duration).toBe(300);
    run.seek(150); expect(h.x()).toBe(100); run.seek(50); expect(h.x()).toBe(50);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  } finally { first.stop(); run?.stop(); }
});

it('пустой шаг не расходует общую задержку', () => {
  const h = harness();
  const run = h.runtime.sequence([[[], { x: 100 }, linear], [h.element, { x: [0, 100] }, linear]], { delay: 100 });
  try { expect(run.duration).toBe(200); run.seek(50); expect(h.x()).toBe(0); run.seek(150); expect(h.x()).toBe(50); }
  finally { run.stop(); }
});

for (const native of [false, true]) it(`повторная цель сохраняет паузу и умеет продолжиться, native=${native}`, async () => {
  const h = harness(native), first = h.runtime.animate(h.element, { x: 100 }, linear);
  first.seek(25); first.pause(); const second = h.runtime.animate(h.element, { x: 100 }, linear);
  try {
    expect(await first.finished).toEqual({ status: 'stopped' }); expect(second.state).toBe('paused');
    h.step(20); expect(h.x()).toBe(25); second.play(); expect(second.state).toBe('running');
    second.seek(75); expect(h.x()).toBe(75); second.finish(); expect(await second.finished).toEqual({ status: 'finished' });
  } finally { first.stop(); second.stop(); }
});

for (const sequence of [false, true]) it(`соседний массив сохраняет пружину скалярной цели, sequence=${sequence}`, () => {
  const a = harness(), b = harness();
  const one = a.runtime.animate(a.element, { x: 100 });
  const mixed = sequence ? b.runtime.sequence([[b.element, { x: 100, opacity: [0, 1] }]]) : b.runtime.animate(b.element, { x: 100, opacity: [0, 1] });
  try { for (const t of [30, 100, 150]) { one.seek(t); mixed.seek(t); expect(b.x()).toBeCloseTo(a.x(), 9); } }
  finally { one.stop(); mixed.stop(); }
});

for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'start-start', 'start-end', 'end-start', 'end-end']) {
  for (const authored of [false, true]) it(`радиус ${corner} получает px, authored=${authored}`, () => {
    const h = harness(), key = `border-${corner}-radius`; h.values.set(key, '0px');
    let run: Playback | undefined;
    try { run = h.runtime.animate(h.element, { [key]: authored ? [0, 12] : 12 }, linear); run.seek(50); expect(h.values.get(key)).toBe('6px'); run.finish(); expect(h.values.get(key)).toBe('12px'); }
    finally { run?.stop(); }
  });
}

it('ошибка native cancellation не оставляет прежних подписчиков', () => {
  const queue: FrameRequestCallback[] = [];
  const error = new Error('cancel failed');
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { throw error; });
  const loop = createFrameLoop(), old = vi.fn(), teardown = vi.fn(), fresh = vi.fn();
  loop.read(old, { onTeardown: teardown }); loop.render(old, { onTeardown: teardown });
  expect(() => loop.cancelAll()).toThrow(error); expect(teardown).toHaveBeenCalledTimes(2);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  loop.update(fresh, { once: true }); for (const fire of queue.splice(0)) fire(1);
  expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledTimes(1); loop.cancelAll();
});

it('вложенный set принимает значение синхронно и доставляет снимки FIFO', () => {
  const v = value(0), seen: number[] = []; let immediate = -1;
  v.subscribe(n => { if (n === 1) { v.set(2); immediate = v.get(); } }); v.subscribe(n => seen.push(n));
  try { v.set(1); expect(immediate).toBe(2); expect(v.get()).toBe(2); expect(seen).toEqual([1, 2]); }
  finally { v.dispose(); }
});

it('dispose из начального уведомления отзывает ещё не возвращённый Playback', async () => {
  const v = value(0); v.subscribe(n => { if (n === 1) v.dispose(); });
  const run = v.animate([1, 100], { duration: 1000, ease: 'linear' });
  try { expect(run.state).toBe('stopped'); expect(await run.finished).toEqual({ status: 'stopped' }); }
  finally { v.dispose(); run.stop(); }
});

for (const terminal of [false, true]) it(`ошибка подписчика отклоняет его Playback и сохраняет соседний, terminal=${terminal}`, async () => {
  let now = 0, id = 0; const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
  const v = value(0), healthy = value(0), error = new Error('subscriber failed'), listener = vi.fn();
  v.subscribe(n => { if (n >= (terminal ? 1 : .5)) throw error; }); v.subscribe(listener);
  const run = v.animate(1, { duration: 1000, ease: 'linear' }), other = healthy.animate(2, { duration: 1000, ease: 'linear' });
  try {
    now = terminal ? 1000 : 500; const jobs = [...queue.values()]; queue.clear(); jobs.forEach(cb => cb(now));
    expect(listener).toHaveBeenCalled(); expect(run.state).toBe('failed'); await expect(run.finished).rejects.toBe(error);
    expect(healthy.get()).toBe(terminal ? 2 : 1); other.finish(); expect(await other.finished).toEqual({ status: 'finished' });
  } finally { v.dispose(); healthy.dispose(); run.stop(); other.stop(); }
});
