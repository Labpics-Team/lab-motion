import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

const spring = { mass: 1, stiffness: 100, damping: 20 };

it('a late native completion cannot take back a retargeted translation', async () => {
  const h = harness(true);
  const previous = h.runtime.animate(h.element, { x: [0, 1000] }, { duration: 1000, ease: 'linear' });
  const launch = h.effects[0]!;
  launch.currentTime = 250;
  const turn = h.runtime.animate(h.element, { x: 250, y: 100 }, { spring });
  const path = h.effects.at(-1)!;
  expect(path).not.toBe(launch);
  expect(path.keys.length).toBeGreaterThan(2);
  expect(h.updates.size + h.renders.size).toBe(0);

  launch.complete();
  await expect(previous.finished).resolves.toEqual({ status: 'stopped' });
  expect(turn.state).toBe('running');
  path.currentTime = 100;
  turn.pause();
  // For the chosen critical oscillator, horizontal momentum peaks at t = 0.1 s.
  expect(h.x()).toBeCloseTo(250 + 100 / Math.E, 0);
  const heldY = h.y();
  h.step(800);
  expect(h.y()).toBe(heldY);

  const successor = h.runtime.animate(h.element, { x: 0, y: 0 }, { spring, reducedMotion: 'always' });
  path.complete();
  await expect(successor.finished).resolves.toEqual({ status: 'finished' });
  await expect(turn.finished).resolves.toEqual({ status: 'stopped' });
  expect(h.x()).toBe(0);
  expect(h.y()).toBe(0);
  expect(h.effects.every(effect => effect.cancelled)).toBe(true);
});

it('an authored rotation survives a curved translation', () => {
  const h = harness(true);
  h.element.style.setProperty('transform', 'rotate(23deg)');
  h.runtime.animate(h.element, { x: [0, 1000] }, { duration: 1000, ease: 'linear' });
  h.effects[0]!.currentTime = 250;
  const turn = h.runtime.animate(h.element, { x: 250, y: 100 }, { spring });
  turn.seek(100);
  expect(h.values.get('transform')).toContain('rotate(23deg)');
  expect(h.x()).toBeGreaterThan(275);
  turn.finish();
});
