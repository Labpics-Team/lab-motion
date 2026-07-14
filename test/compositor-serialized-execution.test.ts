/**
 * Исполняемый SSOT: CSS-токены, WebKit-keyframes и snapshot читают один
 * сериализованный artifact, тогда как публичные diagnostics остаются raw/fresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ builds: 0 }));

vi.mock('../src/compositor/segmenter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compositor/segmenter.js')>();
  return {
    ...actual,
    buildSpringNodes(...args: Parameters<typeof actual.buildSpringNodes>) {
      work.builds++;
      return actual.buildSpringNodes(...args);
    },
    buildSpringNodesWithHorizon(
      ...args: Parameters<typeof actual.buildSpringNodesWithHorizon>
    ) {
      work.builds++;
      return actual.buildSpringNodesWithHorizon(...args);
    },
    buildRestingSpringNodesWithHorizon(
      ...args: Parameters<typeof actual.buildRestingSpringNodesWithHorizon>
    ) {
      work.builds++;
      return actual.buildRestingSpringNodesWithHorizon(...args);
    },
    tryBuildSpringNodes(...args: Parameters<typeof actual.tryBuildSpringNodes>) {
      work.builds++;
      return actual.tryBuildSpringNodes(...args);
    },
  };
});

import {
  compileSpringPlan,
  CompositorSpring,
  readCompositorSpring,
} from '../src/compositor/core.js';
import {
  clearSpringExecutionArtifactCacheUnchecked,
  compileRestingSpringExecutionArtifactTupleUnchecked,
  compileSpringExecutionArtifactTupleUnchecked,
  compileSpringExecutionArtifactUnchecked,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import {
  compileSpringRuntimeExecutionTupleUnchecked,
  compileSpringRuntimeExecutionPlanUnchecked,
} from '../src/compositor/execution.js';
import {
  animationTimeOrFallback,
  sampleSerializedSpring,
  scaleSerializedVelocity,
} from '../src/compositor/sample.js';
import { settleTimeUpperBound } from '../src/spring.js';
import { solveSpring } from '../src/internal/solver.js';

const SPRING = { mass: 1.003, stiffness: 171.007, damping: 13.011 };
const TOLERANCE = 0.0025;

function parse(linear: string): number[] {
  const flat: number[] = [];
  for (const token of linear.slice(7, -1).split(', ')) {
    const [progress, percent] = token.split(' ');
    flat.push(Number(percent!.slice(0, -1)), Number(progress));
  }
  return flat;
}

function stubEngine(vendor: string, userAgent: string): void {
  vi.stubGlobal('navigator', { vendor, userAgent });
  vi.stubGlobal('CSS', { supports: () => true });
  __resetDetectionCache();
}

function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

function firstTargetCrossingMs(
  spring: typeof SPRING,
  tolerance = TOLERANCE,
): number {
  const artifact = compileSpringExecutionArtifactUnchecked(spring, 0, tolerance);
  const samples = artifact.samples;
  const durationMs = settleTimeUpperBound(spring, 0) * 1000;
  for (let i = 0; i + 3 < samples.length; i += 2) {
    const p0 = samples[i + 1]!;
    const p1 = samples[i + 3]!;
    if (p0 < 1 && p1 >= 1) {
      const u = (1 - p0) / (p1 - p0);
      return (samples[i]! + u * (samples[i + 2]! - samples[i]!)) / 100 * durationMs;
    }
  }
  throw new Error('serialized target crossing not found');
}

describe('compositor: unified serialized execution artifact', () => {
  beforeEach(() => {
    work.builds = 0;
    clearSpringExecutionArtifactCacheUnchecked();
    __resetDetectionCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSpringExecutionArtifactCacheUnchecked();
    __resetDetectionCache();
  });

  it('samples бит-в-бит равны реально разобранным CSS-токенам, hit сохраняет identity', () => {
    const first = compileSpringExecutionArtifactUnchecked(SPRING, 1, TOLERANCE);
    const builds = work.builds;
    const second = compileSpringExecutionArtifactUnchecked(SPRING, 1, TOLERANCE);

    expect([...first.samples]).toEqual(parse(first.easing));
    expect(second).toBe(first);
    expect(second.samples).toBe(first.samples);
    expect(work.builds).toBe(builds);
  });

  it('resting capability сохраняет identity на hit без повторной компиляции', () => {
    const first = compileRestingSpringExecutionArtifactTupleUnchecked(SPRING, TOLERANCE);
    const builds = work.builds;

    const second = compileRestingSpringExecutionArtifactTupleUnchecked(SPRING, TOLERANCE);

    expect(second).toBe(first);
    expect(second[1]).toBe(first[1]);
    expect(work.builds).toBe(builds);
  });

  it('resting capability ограничен восемью exact-профилями', () => {
    const springs = Array.from({ length: 9 }, (_, i) => ({
      mass: 1 + i / 100,
      stiffness: 170 + i,
      damping: 26 + i / 10,
    }));
    const resident = springs.slice(0, 8).map((spring) =>
      compileRestingSpringExecutionArtifactTupleUnchecked(spring, TOLERANCE));
    const builds = work.builds;
    for (let i = 0; i < resident.length; i++) {
      expect(compileRestingSpringExecutionArtifactTupleUnchecked(springs[i]!, TOLERANCE))
        .toBe(resident[i]);
    }
    expect(work.builds).toBe(builds);

    compileRestingSpringExecutionArtifactTupleUnchecked(springs[8]!, TOLERANCE);
    const buildsAfterEviction = work.builds;

    const recompiled = compileRestingSpringExecutionArtifactTupleUnchecked(
      springs[0]!,
      TOLERANCE,
    );

    expect(recompiled).not.toBe(resident[0]);
    expect(work.builds).toBe(buildsAfterEviction + 1);
  });

  it('resting capability бит-в-бит равен generic v0=0 на разных режимах', () => {
    let seed = 0x6d2b79f5;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let sample = 0; sample < 32; sample++) {
      const mass = 0.25 + 3.75 * random();
      const stiffness = 40 + 560 * random();
      const criticalDamping = 2 * Math.sqrt(mass * stiffness);
      const spring = {
        mass,
        stiffness,
        damping: criticalDamping * (0.08 + 1.92 * random()),
      };
      const tolerance = 0.0015 + 0.0035 * random();
      const generic = compileSpringExecutionArtifactTupleUnchecked(
        spring,
        0,
        tolerance,
      );
      const resting = compileRestingSpringExecutionArtifactTupleUnchecked(
        spring,
        tolerance,
      );

      expect(resting[0]).toBe(generic[0]);
      expect(resting[2]).toBe(generic[2]);
      expect(resting[1]).toHaveLength(generic[1].length);
      for (let i = 0; i < generic[1].length; i++) {
        expect(resting[1][i]).toBe(generic[1][i]);
      }
    }
  });

  it('общий reset очищает generic и resting capability-кэши', () => {
    const generic = compileSpringExecutionArtifactUnchecked(SPRING, 0.25, TOLERANCE);
    const resting = compileRestingSpringExecutionArtifactTupleUnchecked(SPRING, TOLERANCE);

    clearSpringExecutionArtifactCacheUnchecked();

    expect(compileSpringExecutionArtifactUnchecked(SPRING, 0.25, TOLERANCE))
      .not.toBe(generic);
    expect(compileRestingSpringExecutionArtifactTupleUnchecked(SPRING, TOLERANCE))
      .not.toBe(resting);
  });

  it('public raw diagnostics свежи и их мутация не отравляет artifact', () => {
    const options = {
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      v0: 1,
      tolerance: TOLERANCE,
    } as const;
    const first = compileSpringPlan(options);
    const artifact = compileSpringExecutionArtifactUnchecked(SPRING, 1, TOLERANCE);
    const expected = artifact.samples[3]!;
    (first.nodes[1] as { progress: number }).progress = 999;
    const second = compileSpringPlan(options);

    expect(second.nodes).not.toBe(first.nodes);
    expect(second.nodes[1]!.progress).not.toBe(999);
    expect(artifact.samples[3]).toBe(expected);
  });

  it('public diagnostics — свежий facade exact serialized percent-stops', () => {
    const options = {
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      v0: 1,
      tolerance: TOLERANCE,
    } as const;
    const plan = compileSpringPlan(options);
    const artifact = compileSpringExecutionArtifactUnchecked(SPRING, 1, TOLERANCE);

    expect(plan.nodes).toHaveLength(artifact.samples.length / 2);
    for (let i = 0; i < plan.nodes.length; i++) {
      expect(plan.nodes[i]).toEqual({
        percent: artifact.samples[i * 2],
        progress: artifact.samples[i * 2 + 1],
      });
    }
  });

  it('serialized facade сохраняет доказанный 15/16 tolerance до endpoint-snap', () => {
    const regimes = [
      { mass: 1, stiffness: 170, damping: 13 },
      { mass: 1, stiffness: 170, damping: 2 * Math.sqrt(170) },
      { mass: 1, stiffness: 170, damping: 40 },
      { mass: 0.6, stiffness: 500, damping: 8 },
    ];
    const tolerance = 0.0025;
    for (const spring of regimes) {
      for (const v0 of [-10, -1, 0, 1, 10]) {
        const nodes = compileSpringPlan({
          spring,
          property: 'x',
          from: 0,
          to: 1,
          v0,
          tolerance,
        }).nodes;
        const horizon = settleTimeUpperBound(spring, v0);
        const lastInterior = nodes.at(-2)!.percent / 100;
        let segment = 1;
        let maxError = 0;
        for (let i = 0; i <= 2048; i++) {
          const tau = lastInterior * i / 2048;
          const percent = tau * 100;
          while (percent > nodes[segment]!.percent) segment++;
          const a = nodes[segment - 1]!;
          const b = nodes[segment]!;
          const q = (percent - a.percent) / (b.percent - a.percent);
          const reconstructed = (1 - q) * a.progress + q * b.progress;
          const truth = solveSpring(spring, tau * horizon, v0).value;
          maxError = Math.max(maxError, Math.abs(reconstructed - truth));
        }
        expect(maxError).toBeLessThanOrEqual(tolerance * 15 / 16);
      }
    }
  });

  it('Chromium CSS и WebKit explicit frames используют один samples artifact', () => {
    stubEngine(
      'Google Inc.',
      'Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36',
    );
    const options = {
      spring: SPRING,
      property: 'opacity',
      from: 10,
      to: 110,
      v0: -1,
      tolerance: TOLERANCE,
    } as const;
    const chromium = compileSpringRuntimeExecutionPlanUnchecked(options);
    expect(chromium.keyframes).toHaveLength(2);
    expect([...chromium.samples]).toEqual(parse(chromium.easing));

    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    );
    const webkit = compileSpringRuntimeExecutionPlanUnchecked(options);
    expect(webkit.samples).toBe(chromium.samples);
    expect(webkit.easing).toBe('linear');
    expect(webkit.keyframes).toHaveLength(webkit.samples.length / 2);
    for (let i = 0; i < webkit.keyframes.length; i++) {
      const offset = webkit.samples[i * 2]! / 100;
      const progress = webkit.samples[i * 2 + 1]!;
      expect(webkit.keyframes[i]!['offset']).toBe(offset);
      expect(webkit.keyframes[i]!['opacity']).toBe(
        i === 0 ? 10 : i === webkit.keyframes.length - 1 ? 110 : (1 - progress) * 10 + progress * 110,
      );
    }
  });

  it('positional tuple fast-seam бит-в-бит равен named runtime-плану', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    );
    const options = {
      spring: SPRING,
      property: 'opacity',
      from: 10,
      to: 110,
      v0: -1,
      tolerance: TOLERANCE,
      fill: 'forwards',
      composite: 'add',
      format: (value: number) => `${value}px`,
    } as const;
    const named = compileSpringRuntimeExecutionPlanUnchecked(options);
    const tuple = compileSpringRuntimeExecutionTupleUnchecked(
      options.spring,
      options.property,
      options.from,
      options.to,
      options.v0,
      options.tolerance,
      options.fill,
      options.composite,
      options.format,
    );

    expect(tuple[0]).toEqual(named.keyframes);
    expect(tuple[1]).toBe(named.easing);
    expect(tuple[2]).toBe(named.duration);
    expect(tuple[3]).toBe(named.fill);
    expect(tuple[4]).toBe(named.composite);
    expect(tuple[5]).toBe(named.samples);
  });
});

describe('compositor: exact piecewise sampler', () => {
  // [percent, progress]: kink на 25% меняет slope с +2/s на -1/s.
  const samples = new Float64Array([
    0, 0,
    25, 0.5,
    50, 0.25,
    100, 1,
  ]);

  it('delay/start/kink/end имеют запечатанную правую производную', () => {
    expect(sampleSerializedSpring(samples, 1000, 99, 100)).toEqual({ value: 0, velocity: 0 });
    expect(sampleSerializedSpring(samples, 1000, 100, 100)).toEqual({ value: 0, velocity: 2 });
    expect(sampleSerializedSpring(samples, 1000, 225, 100)).toEqual({ value: 0.25, velocity: 2 });
    expect(sampleSerializedSpring(samples, 1000, 350, 100)).toEqual({ value: 0.5, velocity: -1 });
    expect(sampleSerializedSpring(samples, 1000, 1100, 100)).toEqual({ value: 1, velocity: 0 });
    expect(sampleSerializedSpring(samples, 1000, 5000, 100)).toEqual({ value: 1, velocity: 0 });
  });

  it('binary search на большой сетке совпадает с её локальным сегментом', () => {
    const count = 2049;
    const large = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      large[i * 2] = 100 * i / (count - 1);
      large[i * 2 + 1] = 2 * i / (count - 1);
    }
    const out = { value: 0, velocity: 0 };
    expect(sampleSerializedSpring(large, 2000, 1234.5, 0, out)).toBe(out);
    expect(out.value).toBeCloseTo(1.2345, 14);
    expect(out.velocity).toBeCloseTo(1, 14);
  });

  it('present currentTime:null означает pending pre-start, absent использует now', () => {
    expect(animationTimeOrFallback({ currentTime: null }, 500)).toBe(-1);
    expect(animationTimeOrFallback({}, 500)).toBe(500);
    expect(animationTimeOrFallback({ currentTime: 25 }, 500)).toBe(25);
  });

  it('adjacent MAX endpoints не теряют конечную скорость из-за cancellation', () => {
    const from = nextDown(Number.MAX_VALUE);
    const range = Number.MAX_VALUE - from;
    const progressVelocity = 0.309217;
    const expected = progressVelocity * range;

    expect(Number.isFinite(range)).toBe(true);
    expect(expected).toBeGreaterThan(0);
    expect(
      scaleSerializedVelocity(progressVelocity, from, Number.MAX_VALUE),
    ).toBe(expected);
  });
});

describe('compositor: owner snapshot читает actual WAAPI curve', () => {
  function targetAt(readTime: () => number | null) {
    const calls: Array<{
      keyframes: Record<string, string | number>[];
      timing: Record<string, unknown>;
    }> = [];
    return {
      calls,
      target: {
        animate(
          keyframes: Record<string, string | number>[],
          timing: Record<string, unknown>,
        ) {
          calls.push({ keyframes, timing });
          return {
            get currentTime() { return readTime(); },
            cancel() {},
          };
        },
      },
    };
  }

  it('finite Animation.currentTime побеждает drifted now и переносит actual C0/C1', () => {
    const physics = { mass: 1, stiffness: 170, damping: 26 };
    const currentTime = 372.096622;
    let now = 0;
    const f = targetAt(() => currentTime);
    const cs = new CompositorSpring({
      spring: physics,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.target,
      now: () => now,
    });
    cs.start();
    now = 100_000;
    cs.retarget(2);

    const artifact = compileSpringExecutionArtifactUnchecked(
      physics,
      0,
      TOLERANCE,
    );
    const expected = sampleSerializedSpring(
      artifact.samples,
      settleTimeUpperBound(physics, 0) * 1000,
      currentTime,
    );
    const analytic = readCompositorSpring(physics, { t: currentTime / 1000 });
    const second = f.calls[1]!;
    expect(second.keyframes[0]!['opacity']).toBe(expected.value);
    expect(Math.abs(expected.value - analytic.value)).toBeGreaterThan(0.001);

    const serialized = parse(String(second.timing['easing']));
    const seededV0 = serialized[3]!
      / (serialized[2]! / 100 * Number(second.timing['duration']) / 1000);
    expect(seededV0 * (2 - expected.value)).toBeCloseTo(expected.velocity, 12);
  });

  it('delay и завершение дают точные покойные границы', () => {
    let currentTime = 50;
    const f = targetAt(() => currentTime);
    const physics = { mass: 1, stiffness: 170, damping: 26 };
    const cs = new CompositorSpring({
      spring: physics,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.target,
      delay: 100,
      now: () => 10_000,
    });
    cs.start();
    cs.retarget(2);
    expect(f.calls[1]!.keyframes[0]!['opacity']).toBe(0);
    const before = parse(String(f.calls[1]!.timing['easing']));
    expect(before[3]).toBe(0);

    currentTime = settleTimeUpperBound(physics, 0) * 1000 + 1;
    const done = targetAt(() => currentTime);
    const finished = new CompositorSpring({
      spring: physics,
      property: 'opacity',
      from: 0,
      to: 1,
      target: done.target,
      now: () => 0,
    });
    finished.start();
    finished.retarget(2);
    expect(done.calls[1]!.keyframes[0]!['opacity']).toBe(1);
    const after = parse(String(done.calls[1]!.timing['easing']));
    expect(after[3]).toBe(0);
  });

  it('pending Animation.currentTime=null не убегает вслед за now', () => {
    const f = targetAt(() => null);
    let now = 0;
    const cs = new CompositorSpring({
      spring: { mass: 1, stiffness: 170, damping: 26 },
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.target,
      now: () => now,
    });
    cs.start();
    now = 100_000;
    cs.retarget(2);
    expect(f.calls[1]!.keyframes[0]!['opacity']).toBe(0);
    expect(parse(String(f.calls[1]!.timing['easing']))[3]).toBe(0);
  });

  it('активный owner держит samples после cache eviction', () => {
    const currentTime = 120;
    const physics = { mass: 1.017, stiffness: 173.019, damping: 17.023 };
    const artifact = compileSpringExecutionArtifactUnchecked(
      physics,
      0,
      TOLERANCE,
    );
    const f = targetAt(() => currentTime);
    const cs = new CompositorSpring({
      spring: physics,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.target,
    });
    cs.start();
    for (let i = 0; i < 300; i++) {
      compileSpringExecutionArtifactUnchecked(
        { mass: 1 + i * 1e-5, stiffness: 200, damping: 20 },
        0,
        TOLERANCE,
      );
    }
    const expected = sampleSerializedSpring(
      artifact.samples,
      settleTimeUpperBound(physics, 0) * 1000,
      currentTime,
    );
    cs.retarget(2);
    expect(f.calls[1]!.keyframes[0]!['opacity']).toBe(expected.value);
  });

  it('CompositorSpring переносит adjacent-MAX velocity в новый конечный range', () => {
    const physics = { mass: 1, stiffness: 1, damping: 1 };
    const from = nextDown(Number.MAX_VALUE);
    const crossingMs = firstTargetCrossingMs(physics);
    const artifact = compileSpringExecutionArtifactUnchecked(
      physics,
      0,
      TOLERANCE,
    );
    const sample = sampleSerializedSpring(
      artifact.samples,
      settleTimeUpperBound(physics, 0) * 1000,
      crossingMs,
    );
    const expectedVelocity = scaleSerializedVelocity(
      sample.velocity,
      from,
      Number.MAX_VALUE,
    );
    const f = targetAt(() => crossingMs);
    const cs = new CompositorSpring({
      spring: physics,
      property: 'x',
      from,
      to: Number.MAX_VALUE,
      target: f.target,
      now: () => 0,
    });
    cs.start();
    cs.retarget(from);

    const next = f.calls[1]!;
    expect(next.keyframes[0]!['x']).toBe(Number.MAX_VALUE);
    const serialized = parse(String(next.timing['easing']));
    const seededV0 = serialized[3]!
      / (serialized[2]! / 100 * Number(next.timing['duration']) / 1000);
    const carried = seededV0 * (from - Number.MAX_VALUE);
    expect(Number.isFinite(carried)).toBe(true);
    expect(Math.abs(carried / expectedVelocity - 1)).toBeLessThan(1e-12);
  });
});
