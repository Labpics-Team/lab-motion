import { expect, it } from 'vitest';
import { playhead } from '../src/motion/playhead.js';
import { harness } from './fixtures/motion-runtime.js';

const spring = { mass: 1, stiffness: 100, damping: 20 };

function launch() {
  const h = harness(true);
  h.runtime.animate(h.element, { x: [0, 1000] }, { duration: 1000, ease: 'linear' });
  h.effects[0]!.currentTime = 250;
  return h;
}

function turn() {
  const x = launch(), y = harness(true);
  const xEnd = x.runtime.animate(x.element, { x: 250 }, { spring }).duration;
  const yEnd = y.runtime.animate(y.element, { y: 100 }, { spring }).duration;
  expect(Math.abs(xEnd-yEnd)).toBeGreaterThan(1);
  const h = launch();
  const run = playhead(h.runtime.animate(h.element, { x: 250, y: 100 }, { spring }));
  const effect = h.effects.at(-1)!;
  expect(effect.keys.length).toBeGreaterThan(2);
  return { h, run, effect, target: xEnd < yEnd ? { x: 250 } : { y: 100 }, shortEnd: Math.min(xEnd,yEnd) };
}

it('retires the shorter native axis before an observer can take its owner', async () => {
  const {h, run, effect, target, shortEnd} = turn();
  const afterShort = (shortEnd + run.duration)/2;
  effect.currentTime = afterShort;
  expect(run.time).toBeCloseTo(afterShort,7);
  const successor = h.runtime.animate(h.element, target, { spring });
  run.finish();
  await expect(run.finished).resolves.toEqual({status:'finished'});
  successor.finish();
});

it('a separately adopted axis settles at its own deadline', async () => {
  const {h, run, effect, target, shortEnd} = turn();
  effect.currentTime = 10;
  const adopted = h.runtime.animate(h.element, target, { spring });
  h.step(shortEnd);
  expect(adopted.state).toBe('finished');
  expect(run.state).toBe('running');
  await expect(adopted.finished).resolves.toEqual({status:'finished'});
  run.finish();
  await expect(run.finished).resolves.toEqual({status:'stopped'});
});
