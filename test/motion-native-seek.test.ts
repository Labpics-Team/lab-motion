import { expect, it, vi } from 'vitest';
import { playhead } from '../src/motion/playhead.js';
import { harness } from './fixtures/motion-runtime.js';

it('whole-surface seek retains one native effect and one finished subscription', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100], y: [0, 200] }, { duration: 1000, delay: 100, ease: 'linear' }));
  const effect = h.effects[0]!;
  const subscription = vi.spyOn(effect.finished, 'then');
  for (const time of [50, 300, 900, 200]) {
    run.seek(time);
    expect(h.effects).toHaveLength(1);
    expect(effect.cancelled).toBe(false);
    expect(effect.currentTime).toBe(time);
    expect(run.time).toBe(time);
    expect(h.x()).toBeCloseTo(Math.max(0, time - 100) / 10);
    expect(h.y()).toBeCloseTo(Math.max(0, time - 100) / 5);
    expect(h.updates.size + h.renders.size).toBe(0);
  }
  expect(subscription).not.toHaveBeenCalled();
  effect.complete();
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.x()).toBe(100);
  expect(h.y()).toBe(200);
  expect(effect.cancelled).toBe(true);
});

it('partial seek detaches the shared effect without seeking its other owner', async () => {
  const h = harness(true);
  const old = playhead(h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' }));
  const effect = h.effects[0]!;
  effect.currentTime = 200;
  const x = playhead(h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' }));
  x.seek(500);
  expect(effect.cancelled).toBe(true);
  expect(h.x()).toBe(50);
  expect(h.y()).toBe(40);
  effect.complete();
  h.step(100);
  expect(h.x()).toBeCloseTo(60);
  expect(h.y()).toBeCloseTo(60);
  old.stop(); x.finish();
  expect(await old.finished).toEqual({ status: 'stopped' });
  expect(await x.finished).toEqual({ status: 'finished' });
});

it('native phase is absolute even after a sample beyond the duration', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' }));
  const effect = h.effects[0]!;
  effect.currentTime = 1200;
  const successor = playhead(h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' }));
  expect(await run.finished).toEqual({ status: 'stopped' });
  effect.currentTime = 900;
  expect(successor.time).toBe(900);
  successor.pause();
  expect(h.x()).toBeCloseTo(90);
  successor.finish();
  expect(await successor.finished).toEqual({ status: 'finished' });
});

it('terminal seek commits and removes the native effect', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000, ease: 'linear' }));
  run.seek(1000);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.x()).toBe(100);
  expect(h.effects).toHaveLength(1);
  expect(h.effects[0]!.cancelled).toBe(true);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('seek hands off mismatched rate and externally paused effects; reverse remains JS', () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000, ease: 'linear' }));
  const effect = h.effects[0]!;
  effect.playbackRate = 2;
  run.seek(250);
  expect(effect.cancelled).toBe(true);
  expect(h.x()).toBe(25);
  const next = h.effects[1]!;
  next.pause();
  run.seek(500);
  expect(next.cancelled).toBe(true);
  expect(h.x()).toBe(50);
  run.reverse();
  run.seek(750);
  expect(h.x()).toBe(75);
  expect(h.effects.every(effect => effect.cancelled)).toBe(true);
  run.stop();
});

it('renewed native finished promise cannot settle a rewound run', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000, ease: 'linear' }));
  const effect = h.effects[0]!;
  const old = effect.finished;
  effect.complete();
  effect.currentTime = 100;
  run.seek(200);
  await old;
  expect(effect.cancelled).toBe(true);
  expect(h.x()).toBe(20);
  h.effects[1]!.complete();
  expect(await run.finished).toEqual({ status: 'finished' });
});
