import { describe, expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { MotionOptions, SequenceOptions } from '../src/motion/types.js';

describe('повтор авторской траектории', () => {
  it('исполняет конечные итерации одним Playback', async () => {
    const h = harness();
    const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 100, repeat: 2, repeatDelay: 20 } as MotionOptions);
    expect(run.duration).toBe(340);
    run.seek(50); expect(h.x()).toBe(50);
    run.seek(110); expect(h.x()).toBe(100);
    run.seek(120); expect(h.x()).toBe(0);
    run.seek(170); expect(h.x()).toBe(50);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100);
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('повторяет общую шкалу sequence вместе с промежутками', async () => {
    const h = harness();
    const run = h.runtime.sequence([
      [h.element, { x: [0, 100] }, { duration: 100 }],
      [h.element, { x: [100, 200] }, { at: 200, duration: 100 }],
    ], { delay: 10, repeat: 1, repeatDelay: 20 } as SequenceOptions);
    expect(run.duration).toBe(630);
    run.seek(160); expect(h.x()).toBe(100);
    run.seek(330); expect(h.x()).toBe(0);
    run.seek(580); expect(h.x()).toBe(150);
    run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
  });
});
