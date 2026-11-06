import { expect, it, vi } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';
import type { MotionOptions, Playback } from '../src/motion/types.js';

const linear = { duration: 1000, ease: 'linear' } as const;
const own = Run.prototype._own;

it('sequence publishes a completed first segment before its following gap', async () => {
  const h = harness();
  const samples: Array<{ key: string; value: number[]; velocity: number[] }> = [];
  const ownership = vi.spyOn(Run.prototype, '_own').mockImplementation(function (this: Run, track, reduced) {
    expect(track._owner).toBeUndefined();
    expect(track._group._tracks.has(track._program._key)).toBe(false);
    expect(track._program._duration).toBe(1200);
    expect(track._program._segments[0]!._end).toBe(0);
    expect(track._program._segments[1]!._at).toBe(200);
    expect(track._value.length).toBe(track._program._final.length);
    expect(track._velocity.length).toBe(track._value.length);
    for (let i = 0; i < track._value.length; i++) {
      expect(Number.isFinite(track._value[i])).toBe(true);
      expect(Number.isFinite(track._velocity[i])).toBe(true);
    }
    samples.push({ key: track._program._key, value: [...track._value], velocity: [...track._velocity] });
    own.call(this, track, reduced);
  });
  let run: Playback | undefined;
  try {
    run = h.runtime.sequence([
      [h.element, { x: [20, 40], color: ['#000', '#fff'] }, { at: 0, duration: 0, ease: 'linear' }],
      [h.element, { x: [40, 100], color: ['#fff', '#000'] }, { at: 200, ...linear }],
    ]);
    expect(ownership.mock.calls).toHaveLength(2);
    expect(samples).toEqual([
      { key: 'x', value: [40], velocity: [0] },
      { key: 'color', value: [65025, 65025, 65025, 1], velocity: [0, 0, 0, 0] },
    ]);
    expect(h.x()).toBe(40); expect(h.values.get('color')).toBe('rgba(255,255,255,1)');
    run.seek(100);
    expect(h.x()).toBe(40); expect(h.values.get('color')).toBe('rgba(255,255,255,1)');
    const finished = run.finished;
    run.seek(1200);
    expect(await finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100); expect(h.values.get('color')).toBe('rgba(0,0,0,1)');
    expect(h.effects).toHaveLength(0);
    expect(h.updates.size + h.renders.size).toBe(0);
    for (const [track] of ownership.mock.calls) {
      expect(track._owner).toBeUndefined(); expect(track._group._tracks.size).toBe(0);
    }
  } finally { run?.stop(); ownership.mockRestore(); }
});

for (const native of [false, true]) {
  for (const mode of ['normal', 'delayed', 'reduced', 'instant'] as const) {
    it(`startup samples every coordinate before ownership: native=${native}, mode=${mode}`, async () => {
      const h = harness(native);
      const samples: Array<{ key: string; value: number[]; velocity: number[] }> = [];
      const ownership = vi.spyOn(Run.prototype, '_own').mockImplementation(function (this: Run, track, reduced) {
        // Observe the real publication boundary without replacing sampling or ownership.
        expect(track._owner).toBeUndefined();
        expect(track._value.length).toBe(track._program._final.length);
        expect(track._velocity.length).toBe(track._value.length);
        for (let i = 0; i < track._value.length; i++) {
          expect(Number.isFinite(track._value[i])).toBe(true);
          expect(Number.isFinite(track._velocity[i])).toBe(true);
        }
        samples.push({ key: track._program._key, value: [...track._value], velocity: [...track._velocity] });
        own.call(this, track, reduced);
      });
      let run: Playback | undefined;
      try {
        const options: MotionOptions = mode === 'instant' ? { ...linear, duration: 0 }
          : mode === 'reduced' ? { ...linear, reducedMotion: 'always' }
          : mode === 'delayed' ? { ...linear, delay: 200 } : linear;
        run = h.runtime.animate(h.element, { x: [20, 100], color: ['#000', '#fff'] }, options);
        const terminal = mode === 'instant' || mode === 'reduced';
        expect(samples).toEqual([
          { key: 'x', value: [terminal ? 100 : 20], velocity: [0] },
          { key: 'color', value: terminal ? [65025, 65025, 65025, 1] : [0, 0, 0, 1], velocity: [0, 0, 0, 0] },
        ]);
        expect(h.x()).toBe(terminal ? 100 : 20);
        expect(h.values.get('color')).toBe(terminal ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)');
        if (!terminal) {
          if (mode === 'delayed') {
            run.seek(100);
            expect(h.x()).toBe(20); expect(h.values.get('color')).toBe('rgba(0,0,0,1)');
          }
          run.seek(mode === 'delayed' ? 700 : 500);
          expect(h.x()).toBe(60);
          const rgba = h.values.get('color')!.slice(5, -1).split(',').map(Number);
          for (let i = 0; i < 3; i++) expect(rgba[i]).toBeCloseTo(255 / Math.sqrt(2), 8);
          expect(rgba[3]).toBe(1);
        }
        const finished = run.finished;
        run.finish();
        expect(await finished).toEqual({ status: 'finished' });
        expect(h.x()).toBe(100); expect(h.values.get('color')).toBe('rgba(255,255,255,1)');
        expect(h.effects.every(effect => effect.cancelled)).toBe(true);
        expect(h.updates.size + h.renders.size).toBe(0);
        for (const [track] of ownership.mock.calls) {
          expect(track._owner).toBeUndefined(); expect(track._group._tracks.size).toBe(0);
        }
      } finally { run?.stop(); ownership.mockRestore(); }
    });
  }

  it(`interrupted spring publishes its inherited velocity: native=${native}`, async () => {
    const h = harness(native);
    const options = { spring: { mass: 1, stiffness: 100, damping: 20 } } as const;
    const samples: Array<{ value: number; velocity: number }> = [];
    const ownership = vi.spyOn(Run.prototype, '_own').mockImplementation(function (this: Run, track, reduced) {
      expect(track._owner).toBeUndefined();
      for (let i = 0; i < track._value.length; i++) {
        expect(Number.isFinite(track._value[i])).toBe(true);
        expect(Number.isFinite(track._velocity[i])).toBe(true);
      }
      samples.push({ value: track._value[0]!, velocity: track._velocity[0]! });
      own.call(this, track, reduced);
    });
    let first: Playback | undefined, successor: Playback | undefined;
    try {
      first = h.runtime.animate(h.element, { x: 100 }, options);
      first.seek(100);
      const previous = ownership.mock.calls[0]![0];
      const value = previous._value[0]!, velocity = previous._velocity[0]!;
      expect(velocity).toBeGreaterThan(0);
      const stopped = first.finished;
      successor = h.runtime.animate(h.element, { x: 200 }, options);
      expect(samples).toHaveLength(2);
      expect(samples[1]!.value).toBeCloseTo(value, 8);
      expect(samples[1]!.velocity).toBeCloseTo(velocity, 8);
      expect(h.x()).toBeCloseTo(value, 8);
      expect(await stopped).toEqual({ status: 'stopped' });
      successor.seek(1); expect(h.x()).toBeGreaterThan(value);
      const finished = successor.finished;
      successor.finish();
      expect(await finished).toEqual({ status: 'finished' });
      expect(h.x()).toBe(200);
      expect(h.effects.every(effect => effect.cancelled)).toBe(true);
      expect(h.updates.size + h.renders.size).toBe(0);
      for (const [track] of ownership.mock.calls) {
        expect(track._owner).toBeUndefined(); expect(track._group._tracks.size).toBe(0);
      }
    } finally { first?.stop(); successor?.stop(); ownership.mockRestore(); }
  });
}
