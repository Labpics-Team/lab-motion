/**
 * test/keyframes.test.ts — S4 keyframes(): differential oracle + core behavior.
 * Класс: А (unit) + В (differential oracle, property).
 *
 * ── DIFFERENTIAL ORACLE ──────────────────────────────────────────────────────
 * `oracleSample()` ниже — НЕЗАВИСИМАЯ ручная реализация multi-keyframe
 * интерполяции (обычный for-loop, без переиспользования кода из
 * src/keyframes/index.ts). Она эталонно кодирует ту же математику, что и
 * WAAPI/CSS `@keyframes` percentage-offset semantics: найти охватывающий
 * сегмент по offsets, линейно интерполировать локальную долю, применить easing.
 * Если `sampleKeyframes()` и `oracleSample()` расходятся — баг в реализации,
 * а не в оракуле (оракул тривиален и проверяем на глаз).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * До реализации src/keyframes/index.ts модуль не существовал → импорт падал
 * (RED). После реализации — GREEN. Для регрессии: заменить `raw` формулу
 * `v0 + range * eased` на `v0 + range * localT` (забыть применить easing)
 * в sampleKeyframes → oracle-diff тест с нелинейным easing (quadIn) обязан
 * разойтись → RED.
 */

import { describe, expect, it } from 'vitest';
import { keyframes, sampleKeyframes, type EasingFn } from '../src/keyframes/index.js';
import { MotionParamError } from '../src/errors.js';

// ─── Независимый oracle (НЕ импортирует sampleKeyframes) ─────────────────────

function oracleSample(
  values: readonly number[],
  times: readonly number[],
  easings: readonly EasingFn[],
  p: number,
): number {
  const n = values.length;
  if (p <= times[0]!) return values[0]!;
  if (p >= times[n - 1]!) return values[n - 1]!;
  for (let i = 0; i < n - 1; i++) {
    const t0 = times[i]!;
    const t1 = times[i + 1]!;
    if (p >= t0 && p <= t1) {
      if (t1 === t0) return values[i + 1]!;
      const localT = (p - t0) / (t1 - t0);
      const eased = easings[i]!(localT);
      return values[i]! + (values[i + 1]! - values[i]!) * eased;
    }
  }
  return values[n - 1]!;
}

const linear: EasingFn = (t) => t;
const quadIn: EasingFn = (t) => t * t;

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

// ─── Differential oracle: dense sample sweep ─────────────────────────────────

describe('keyframes — differential oracle vs manual reference', () => {
  it('3 keyframes, auto times, linear easing — matches oracle over dense sweep', () => {
    const values = [0, 100, 50];
    const times = [0, 0.3, 1];
    const easings = [linear, linear];
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const got = sampleKeyframes(values, times, easings, p);
      const want = oracleSample(values, times, easings, p);
      expect(got).toBeCloseTo(want, 10);
    }
  });

  it('per-segment easing (quadIn on first segment, linear on second)', () => {
    const values = [0, 200, 100];
    const times = [0, 0.5, 1];
    const easings = [quadIn, linear];
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      const got = sampleKeyframes(values, times, easings, p);
      const want = oracleSample(values, times, easings, p);
      expect(got).toBeCloseTo(want, 10);
    }
  });

  it('5 keyframes non-uniform explicit times', () => {
    const values = [0, 50, -30, 80, 0];
    const times = [0, 0.1, 0.4, 0.6, 1];
    const easings = [linear, quadIn, linear, quadIn];
    for (let i = 0; i <= 500; i++) {
      const p = i / 500;
      const got = sampleKeyframes(values, times, easings, p);
      const want = oracleSample(values, times, easings, p);
      expect(got).toBeCloseTo(want, 9);
    }
  });

  it('endpoints exact: p<=0 → values[0], p>=1 → values[last]', () => {
    const values = [10, 20, 30];
    const times = [0, 0.5, 1];
    const easings = [linear, linear];
    expect(sampleKeyframes(values, times, easings, -5)).toBe(10);
    expect(sampleKeyframes(values, times, easings, 0)).toBe(10);
    expect(sampleKeyframes(values, times, easings, 1)).toBe(30);
    expect(sampleKeyframes(values, times, easings, 5)).toBe(30);
  });

  it('duplicate times (zero-width segment) → instant jump, no NaN', () => {
    const values = [0, 50, 100];
    const times = [0, 0.5, 0.5]; // last two collapse
    const easings = [linear, linear];
    expect(sampleKeyframes(values, times, easings, 0.5)).toBe(100);
    expect(Number.isFinite(sampleKeyframes(values, times, easings, 0.4))).toBe(true);
  });
});

// ─── Validation / MotionParamError ────────────────────────────────────────────

describe('keyframes — validation throws MotionParamError', () => {
  it('values.length < 2 → throws', () => {
    expect(() => keyframes({ values: [1], requestFrame: noRaf() })).toThrow(MotionParamError);
  });

  it('non-finite value → throws', () => {
    expect(() => keyframes({ values: [0, NaN, 100], requestFrame: noRaf() })).toThrow(MotionParamError);
  });

  it('times.length mismatch → throws', () => {
    expect(() => keyframes({ values: [0, 100], times: [0, 0.5, 1], requestFrame: noRaf() })).toThrow(
      MotionParamError,
    );
  });

  it('times not starting at 0 → throws', () => {
    expect(() =>
      keyframes({ values: [0, 50, 100], times: [0.1, 0.5, 1], requestFrame: noRaf() }),
    ).toThrow(MotionParamError);
  });

  it('times not ending at 1 → throws', () => {
    expect(() =>
      keyframes({ values: [0, 50, 100], times: [0, 0.5, 0.9], requestFrame: noRaf() }),
    ).toThrow(MotionParamError);
  });

  it('non-ascending times → throws', () => {
    expect(() =>
      keyframes({ values: [0, 50, 100], times: [0, 0.6, 0.4], requestFrame: noRaf() }),
    ).toThrow(MotionParamError);
  });

  it('easing[] length mismatch (segments = values.length-1) → throws', () => {
    expect(() =>
      keyframes({ values: [0, 50, 100], easing: [linear], requestFrame: noRaf() }),
    ).toThrow(MotionParamError);
  });

  it('duration <= 0 → throws', () => {
    expect(() => keyframes({ values: [0, 100], duration: 0, requestFrame: noRaf() })).toThrow(
      MotionParamError,
    );
  });

  it('repeat negative → throws', () => {
    expect(() => keyframes({ values: [0, 100], repeat: -1, requestFrame: noRaf() })).toThrow(
      MotionParamError,
    );
  });

  it('repeat non-integer → throws', () => {
    expect(() => keyframes({ values: [0, 100], repeat: 1.5, requestFrame: noRaf() })).toThrow(
      MotionParamError,
    );
  });

  it('repeat = Infinity is VALID (no throw)', () => {
    const c = keyframes({ values: [0, 100], repeat: Infinity, requestFrame: noRaf() });
    c.cancel();
    expect(true).toBe(true);
  });

  it('invalid repeatType → throws', () => {
    expect(() =>
      keyframes({ values: [0, 100], repeatType: 'bogus' as never, requestFrame: noRaf() }),
    ).toThrow(MotionParamError);
  });

  it('repeatDelay negative → throws', () => {
    expect(() => keyframes({ values: [0, 100], repeatDelay: -1, requestFrame: noRaf() })).toThrow(
      MotionParamError,
    );
  });
});

// ─── seek() / progression via virtual-time seam ──────────────────────────────

describe('keyframes — virtual-time seam via injectable requestFrame', () => {
  it('seek(0) → first value; seek(duration) → last value', () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 2,
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(0);
    expect(steps[steps.length - 1]).toBe(0);
    c.seek(2);
    expect(steps[steps.length - 1]).toBe(100);
    c.cancel();
  });

  it('seek(duration/2) with linear easing, 2 keyframes → midpoint', () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 2,
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(1);
    expect(steps[steps.length - 1]).toBeCloseTo(50, 9);
    c.cancel();
  });

  it('seek(NaN) → no-op (does not emit / does not throw)', () => {
    const c = keyframes({ values: [0, 100], duration: 1, requestFrame: noRaf() });
    expect(() => c.seek(NaN)).not.toThrow();
    c.cancel();
  });

  it('seek(Infinity) → complete() semantics (snap to last value)', async () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(Infinity);
    await c;
    expect(steps[steps.length - 1]).toBe(100);
  });

  it('complete() snaps synchronously to last value and resolves promise', async () => {
    const c = keyframes({ values: [0, 50, 100], duration: 1, requestFrame: noRaf() });
    let resolved = false;
    const p = c.then(() => {
      resolved = true;
    });
    c.complete();
    await p;
    expect(resolved).toBe(true);
  });

  it('cancel() resolves promise without snapping to last value', async () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 10,
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(1); // vt=1 of 10 → value=10
    c.cancel();
    await c;
    expect(steps[steps.length - 1]).toBeCloseTo(10, 9);
  });
});

// ─── repeat / repeatType semantics ────────────────────────────────────────────

describe('keyframes — repeat + repeatType (loop vs reverse/mirror yoyo)', () => {
  it('totalDuration: repeat=2, duration=1, repeatDelay=0 → 3', () => {
    const c = keyframes({ values: [0, 100], duration: 1, repeat: 2, requestFrame: noRaf() });
    expect(c.totalDuration).toBeCloseTo(3, 9);
    c.cancel();
  });

  it('totalDuration: repeat=2, duration=1, repeatDelay=0.5 → 1*3 + 0.5*2 = 4', () => {
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 2,
      repeatDelay: 0.5,
      requestFrame: noRaf(),
    });
    expect(c.totalDuration).toBeCloseTo(4, 9);
    c.cancel();
  });

  it('totalDuration: repeat=Infinity → Infinity', () => {
    const c = keyframes({ values: [0, 100], repeat: Infinity, requestFrame: noRaf() });
    expect(c.totalDuration).toBe(Infinity);
    c.cancel();
  });

  it("repeatType='loop': second cycle restarts forward from values[0]", () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 1,
      repeatType: 'loop',
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(1.0001); // just after first cycle boundary → second cycle, near start
    expect(steps[steps.length - 1]).toBeLessThan(5);
    c.cancel();
  });

  it("repeatType='reverse' (yoyo): second cycle plays BACKWARD from values[last]", () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 1,
      repeatType: 'reverse',
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(1.0001); // start of 2nd (odd, backward) cycle → near values[last]=100
    expect(steps[steps.length - 1]).toBeGreaterThan(95);
    c.seek(2); // end of 2nd cycle (backward complete) → values[0]=0
    expect(steps[steps.length - 1]).toBeCloseTo(0, 6);
    c.cancel();
  });

  it("repeatType='mirror' is accepted as alias of 'reverse'", () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 1,
      repeatType: 'mirror',
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(2); // end of 2nd (mirrored/backward) cycle → values[0]=0
    expect(steps[steps.length - 1]).toBeCloseTo(0, 6);
    c.cancel();
  });

  it('repeatDelay holds the end-of-cycle value during the pause window', () => {
    const steps: number[] = [];
    const c = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 1,
      repeatDelay: 1,
      requestFrame: noRaf(),
      onStep: (v) => steps.push(v),
    });
    c.seek(1.5); // inside repeatDelay window after cycle 0 completed
    expect(steps[steps.length - 1]).toBe(100);
    c.cancel();
  });
});
