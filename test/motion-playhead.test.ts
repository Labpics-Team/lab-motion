import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

type TemporalPlayback = Playback & { readonly time: number | undefined; timeScale: number; reverse(): void };

it('изменяет скорость и направление одного исполняемого animate без скачка', async () => {
  const h = harness();
  const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }) as TemporalPlayback;
  h.step(200); expect(run.time).toBe(200);
  run.timeScale = 2;
  expect(h.x()).toBe(20);
  h.step(300); expect(h.x()).toBe(40); expect(run.time).toBe(400);
  run.reverse(); expect(h.x()).toBe(40);
  h.step(500); expect(h.x()).toBe(0);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('sequence обращает всю действующую шкалу, включая промежутки', async () => {
  const h = harness();
  const run = h.runtime.sequence([
    [h.element, { x: [0, 100] }, { duration: 100 }],
    [h.element, { x: [100, 200] }, { at: 200, duration: 100 }],
  ]) as TemporalPlayback;
  run.seek(250); run.pause(); run.timeScale = -.5;
  expect(run.state).toBe('paused'); expect(run.time).toBe(250);
  run.play(); h.step(400); expect(h.x()).toBe(50);
  h.step(500); expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.x()).toBe(0);
});
