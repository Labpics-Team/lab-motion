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
