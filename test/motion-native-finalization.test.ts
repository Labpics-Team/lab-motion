import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

it('завершение записывает конечный CSS один раз до снятия нативного эффекта', async () => {
  const h = harness(true);
  const run = h.runtime.animate(h.element, { opacity: [0, 1] }, { duration: 100, ease: 'linear' });
  const effect = h.effects[0]!;
  let cancelled = 0;
  effect.cancel = () => {
    cancelled++;
    expect(h.values.get('opacity')).toBe('1');
    effect.cancelled = true;
  };
  h.writes.length = 0;
  effect.complete();
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.writes).toEqual([['opacity', '1']]);
  expect(cancelled).toBe(1);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('ошибка фиксации при паузе остаётся причиной, даже когда снятие эффекта тоже отказывает', async () => {
  const h = harness(true);
  const run = h.runtime.animate(h.element, { opacity: [0, 1] }, { duration: 100, ease: 'linear' });
  const writeFailure = new Error('style write failed');
  const cancelFailure = new Error('native cleanup failed');
  let cancellations = 0;
  h.element.style.setProperty = () => { throw writeFailure; };
  h.effects[0]!.cancel = () => { cancellations++; throw cancelFailure; };
  expect(() => run.pause()).toThrow(writeFailure);
  await expect(run.finished).rejects.toBe(writeFailure);
  expect(run.state).toBe('failed');
  expect(cancellations).toBe(1);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('завершение прежнего эффекта не завершает successor, созданный во время cancel', async () => {
  const h = harness(true);
  const old = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 100 });
  const effect = h.effects[0]!, cancel = effect.cancel;
  let successor: ReturnType<typeof h.runtime.animate> | undefined;
  effect.cancel = () => {
    cancel();
    successor = h.runtime.animate(h.element, { x: [100, 200] }, { duration: 1000 });
  };
  effect.complete(); await old.finished;
  expect(successor).toBeDefined(); expect(successor!.state).toBe('running');
  expect(h.effects.at(-1)!.cancelled).toBe(false);
  successor!.seek(500); expect(h.x()).toBe(150);
  successor!.finish(); expect(await successor!.finished).toEqual({ status: 'finished' });
  expect(h.effects.every(item => item.cancelled)).toBe(true);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('explicit native finish publishes only the final pose before cancelling', async () => {
  const h = harness(true);
  const run = h.runtime.animate(h.element, { x: [0, 100], y: [0, 200] }, { duration: 1000, ease: 'linear' });
  const effect = h.effects[0]!, cancel = effect.cancel;
  effect.currentTime = 250;
  effect.cancel = () => {
    expect(h.x()).toBe(100); expect(h.y()).toBe(200);
    cancel();
  };
  h.writes.length = 0;
  run.finish();
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.writes).toHaveLength(1);
  expect(effect.cancelled).toBe(true);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('finishing one native channel publishes its endpoint without advancing a sibling', async () => {
  const h = harness(true);
  const old = h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' });
  const effect = h.effects[0]!, cancel = effect.cancel;
  effect.currentTime = 250;
  const x = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  effect.cancel = () => {
    expect(h.x()).toBe(100); expect(h.y()).toBe(50);
    cancel();
  };
  h.writes.length = 0;
  x.finish();
  expect(await x.finished).toEqual({ status: 'finished' });
  expect(h.writes).toHaveLength(1);
  expect(old.state).toBe('running');
  old.finish();
  expect(h.y()).toBe(200);
  expect(await old.finished).toEqual({ status: 'stopped' });
});

it('a successor accepted during explicit finish cancellation is not settled by the old command', async () => {
  const h = harness(true);
  const old = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  const effect = h.effects[0]!, cancel = effect.cancel;
  let successor: ReturnType<typeof h.runtime.animate> | undefined;
  effect.cancel = () => {
    expect(h.x()).toBe(100);
    cancel();
    successor = h.runtime.animate(h.element, { x: 200 }, { duration: 1000, ease: 'linear' });
  };
  old.finish();
  expect(await old.finished).toEqual({ status: 'stopped' });
  expect(successor?.state).toBe('running');
  successor!.seek(500); expect(h.x()).toBe(150);
  successor!.finish();
  expect(await successor!.finished).toEqual({ status: 'finished' });
});
