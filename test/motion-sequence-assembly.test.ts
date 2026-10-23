import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

const linear = { duration: 100, ease: 'linear' } as const;

it('общий первый шаг сохраняет разные продолжения целей и обратную перемотку', async () => {
  const a = harness(), b = harness();
  const run = a.runtime.sequence([
    [[a.element, b.element], { x: 100 }, linear],
    [a.element, { x: 200 }, { ...linear, at: 200 }],
    [b.element, { x: 300 }, { ...linear, at: 100 }],
    [b.element, { y: 50 }, { ...linear, at: 300 }],
  ]);
  try {
    expect(run.duration).toBe(400);
    run.seek(50); expect(a.x()).toBe(50); expect(b.x()).toBe(50);
    run.seek(150); expect(a.x()).toBe(100); expect(b.x()).toBe(200);
    run.seek(250); expect(a.x()).toBe(150); expect(b.x()).toBe(300);
    run.seek(350); expect(a.x()).toBe(200); expect(b.x()).toBe(300); expect(b.y()).toBe(25);
    run.seek(50); expect(a.x()).toBe(50); expect(b.x()).toBe(50); expect(b.y()).toBe(0);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(a.x()).toBe(200); expect(b.x()).toBe(300); expect(b.y()).toBe(50);
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { run.stop(); }
});

it('финализация sequence не продлевает уже работающую соседнюю цель', async () => {
  const a = harness(), b = harness();
  const previous = a.runtime.animate([a.element, b.element], { x: 100 }, linear);
  let run: Playback | undefined;
  try {
    run = a.runtime.sequence([
      [a.element, { x: 100 }, linear],
      [a.element, { y: 50 }, { ...linear, at: 200 }],
    ]);
    expect(run.duration).toBe(300);
    expect(previous.state).toBe('running');
    a.step(150);
    expect(b.x()).toBe(100);
    expect(previous.state).toBe('stopped');
    expect(await previous.finished).toEqual({ status: 'stopped' });
    expect(run.state).toBe('running');
    run.seek(50); expect(a.x()).toBe(50); expect(b.x()).toBe(100);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  } finally { previous.stop(); run?.stop(); }
});
