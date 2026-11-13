import { describe, expect, it } from 'vitest';
import { timing } from '../src/motion/model.js';
import { program } from '../src/motion/program.js';
import { compileTranslationPath } from '../src/motion/translation-path.js';

const spring = { mass: 1, stiffness: 100, damping: 20 };
const clock = timing({ spring });
function axis(key: 'x' | 'y', from: number, to: number, velocity: number) {
  return program(key, { _coordinates: [from], _unit: '' }, [to], false, clock, [velocity]);
}

// Interpolate the actual CSS submitted to WAAPI, independently of its runtime sampler.
function coordinate(frame: Keyframe): readonly [number, number] {
  const parts = /^translate\(\s*([^, ]+)px,\s*([^, )]+)px\s*\)$/.exec(String(frame.transform));
  if (!parts) throw new Error(`Unexpected keyframe: ${String(frame.transform)}`);
  return [Number(parts[1]), Number(parts[2])];
}

describe('native translation with transverse momentum', () => {
  it.each([-800, 800])('follows the critical impulse in pixels at velocity %i', velocity => {
    const x = axis('x', 35, 35, velocity), y = axis('y', 50, -80, 0);
    const path = compileTranslationPath(x, y);
    expect(path).toBeDefined();
    const { frames, duration } = path!;
    expect(duration).toBe(Math.max(x._duration, y._duration));
    expect(frames[0]!.offset).toBe(0);
    expect(frames.at(-1)!.offset).toBe(1);
    expect(coordinate(frames.at(-1)!)).toEqual([35, -80]);
    let peak = 0, worstX = 0, worstY = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      const t0 = Number(a.offset) * duration, t1 = Number(b.offset) * duration;
      expect(t1).toBeGreaterThanOrEqual(t0);
      const p = coordinate(a), q = coordinate(b);
      for (const fraction of [0.17, 0.51, 0.83]) {
        const timestamp = t0 + (t1 - t0) * fraction, seconds = timestamp / 1000;
        const decay = Math.exp(-10 * seconds);
        // Critical oscillator with zero displacement: x = x0 + v t exp(-ωt).
        const expectedX = timestamp >= x._duration ? 35 : 35 + velocity * seconds * decay;
        const expectedY = timestamp >= y._duration ? -80 : -80 + 130 * (1 + 10 * seconds) * decay;
        const actualX = p[0] + (q[0] - p[0]) * fraction;
        worstX = Math.max(worstX, Math.abs(actualX - expectedX));
        worstY = Math.max(worstY, Math.abs(p[1] + (q[1] - p[1]) * fraction - expectedY));
        peak = Math.max(peak, (actualX - 35) * Math.sign(velocity));
      }
    }
    expect(peak).toBeGreaterThan(29);
    expect(worstX).toBeLessThanOrEqual(0.05);
    // The other coordinate follows the root's previously serialized spring.
    expect(worstY).toBeLessThan(0.1);
  });
});
