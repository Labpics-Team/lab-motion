import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { animate as full } from '../src/animate/index.js';
import { animate as mini } from '../src/animate/mini/index.js';
import { buildTransform } from '../src/value/index.js';
import {
  checksumTransformOutputs,
  createBenchClock,
  createMassTargetHarness,
  expectedMassValue,
  createSeededTransformStates,
  createSeededUnitInputs,
  interiorUnit,
  materializeTransformOutputs,
  MASS_LIFECYCLE_PROFILE,
  MASS_LIFECYCLE_GOLDEN,
  reconstructedPartsBuildTransform,
  runMassLifecycleSample,
  summarizeMassTargetEvidence,
  summarizeDistribution,
  TRANSFORM_FORMATTER_BENCH_PROFILE,
} from '../scripts/bench-support.mjs';

describe('benchmark support contracts', () => {
  it('distinguishes a queued drain callback from a recurring idle request', () => {
    const clock = createBenchClock();
    clock.requestFrame(() => {});
    expect(clock.requests).toBe(1);
    expect(clock.executions).toBe(0);
    clock.step(16);
    expect(clock.executions).toBe(1);
    expect(clock.requests).toBe(1);
  });

  it('generates deterministic interior interpolation probes, not source-grid stops', () => {
    const values = Array.from({ length: 100 }, (_, i) => interiorUnit(i + 1));
    expect(values.every((x) => x > 0 && x < 1)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    expect(values.some((x) => Number.isInteger(x * 999))).toBe(false);
  });

  it('reproduces seeded interior inputs and rejects ambiguous benchmark parameters', () => {
    const first = Array.from(createSeededUnitInputs(64, 0x5eed));
    const replay = Array.from(createSeededUnitInputs(64, 0x5eed));
    const anotherSeed = Array.from(createSeededUnitInputs(64, 0x5eee));
    expect(first).toEqual(replay);
    expect(first).not.toEqual(anotherSeed);
    expect(first.every((value) => value > 0 && value < 1)).toBe(true);
    expect(() => createSeededUnitInputs(0, 1)).toThrow(/count/);
    expect(() => createSeededUnitInputs(1, Number.MAX_VALUE)).toThrow(/seed/);
  });

  it('summarizes p50/p95/p99 by nearest rank without reordering raw samples', () => {
    const raw = [9, 1, 7, 3, 5];
    expect(summarizeDistribution(raw)).toEqual({ p50: 5, p95: 9, p99: 9 });
    expect(raw).toEqual([9, 1, 7, 3, 5]);
    expect(() => summarizeDistribution([1, NaN])).toThrow(/конечные/);
  });

  it('mass lifecycle доказывает start + один 60-frame sample + teardown для tween и spring', async () => {
    expect(MASS_LIFECYCLE_PROFILE).toEqual({
      counts: [1, 100, 1_000],
      frames: 60,
      frameStepMs: 1_000 / 60,
      fromPx: 0,
      toPx: 240,
      tweenDurationMs: 1_000_000,
      spring: { mass: 1, stiffness: 170, damping: 10 },
    });
    MASS_LIFECYCLE_GOLDEN.frames.forEach((frame, index) => {
      expect(expectedMassValue('tween', frame)).toBeCloseTo(MASS_LIFECYCLE_GOLDEN.tween[index]!, 12);
      expect(expectedMassValue('spring', frame)).toBeCloseTo(MASS_LIFECYCLE_GOLDEN.spring[index]!, 9);
    });
    expect(Object.isFrozen(MASS_LIFECYCLE_PROFILE)).toBe(true);
    expect(MASS_LIFECYCLE_GOLDEN).toEqual({
      frames: [0, 1, 15, 30, 59],
      tween: [0, 0.004, 0.06, 0.12, 0.236],
      spring: [
        0,
        5.3437036392972725,
        304.4351941052021,
        223.0957079426227,
        239.16918037485095,
      ],
      tolerance: 1e-9,
    });

    for (const animate of [full, mini]) {
      for (const motion of ['tween', 'spring'] as const) {
        for (const count of MASS_LIFECYCLE_PROFILE.counts) {
          let now = 0n;
          const sample = await runMassLifecycleSample({
            animate,
            count,
            motion,
            nowNs: () => ++now,
          });
          expect(sample).toMatchObject({
            startNs: 1,
            frames60Ns: 1,
            teardownNs: 1,
            semantic: {
              valid: true,
              targets: count,
              frames: 60,
              totalWrites: count * 60,
              requests: 61,
              executions: 61,
              onCompleteCalls: 0,
              finished: true,
            },
          });
          expect(sample.semantic.writes).toHaveLength(count);
          expect(sample.semantic.traceHashes).toHaveLength(count);
          expect(sample.semantic.checkpoints).toHaveLength(count);
          sample.semantic.checkpoints[0].forEach((value: number, index: number) => {
            expect(value).toBeCloseTo(MASS_LIFECYCLE_GOLDEN[motion][index]!, 9);
          });
          expect(new Set(sample.semantic.writes)).toEqual(new Set([60]));
          expect(sample.semantic.lastValueHash).toMatch(/^[0-9a-f]{8}$/);
        }
      }
    }
  });

  it('mass evidence fail-closed ловит пропущенный target и подмену terminal строки', () => {
    const harness = createMassTargetHarness(3);
    for (let frame = 0; frame < 60; frame++) {
      harness.setFrame(frame);
      for (const target of harness.targets) {
        const value = frame * 0.004;
        target.style.setProperty('transform', value === 0 ? 'none' : `translateX(${value}px)`);
      }
    }
    const valid = summarizeMassTargetEvidence(harness.slots, 60, 'tween');
    expect(valid.totalWrites).toBe(180);

    harness.slots[1].writes--;
    expect(() => summarizeMassTargetEvidence(harness.slots, 60, 'tween')).toThrow(/target 2.*writes/i);
    harness.slots[1].writes++;
    summarizeMassTargetEvidence(harness.slots, 60, 'tween');
    harness.slots[2].lastValue = 'translateX(999px)';
    expect(() => summarizeMassTargetEvidence(harness.slots, 60, 'tween')).toThrow(/terminal/i);
  });

  it('independent trajectory oracle rejects snap-all, same-string and wrong spring physics', () => {
    const fill = (valueAt: (frame: number) => number) => {
      const harness = createMassTargetHarness(2);
      for (let frame = 0; frame < 60; frame++) {
        harness.setFrame(frame);
        const value = valueAt(frame);
        for (const target of harness.targets) {
          target.style.setProperty('transform', value === 0 ? 'none' : `translateX(${value}px)`);
        }
      }
      return harness;
    };
    const snap = fill(() => 240);
    expect(() => summarizeMassTargetEvidence(snap.slots, 60, 'tween')).toThrow(/frame 0/i);
    const repeated = fill(() => 10);
    expect(() => summarizeMassTargetEvidence(repeated.slots, 60, 'tween')).toThrow(/frame 0/i);
    const wrongPhysics = fill((frame) => frame * 0.004);
    expect(() => summarizeMassTargetEvidence(wrongPhysics.slots, 60, 'spring')).toThrow(/frame 1/i);
    const oneBrokenInteriorFrame = fill((frame) => (
      frame === 2 ? expectedMassValue('tween', frame) + 1 : expectedMassValue('tween', frame)
    ));
    expect(() => summarizeMassTargetEvidence(oneBrokenInteriorFrame.slots, 60, 'tween'))
      .toThrow(/frame 2/i);
  });

  it('воспроизводит смешанную transform-выборку и сильный checksum паритета', () => {
    expect(TRANSFORM_FORMATTER_BENCH_PROFILE).toEqual({
      seed: 0x7a6f726d,
      inputs: 16_384,
      repetitions: 16,
      warmupRounds: 6,
      rounds: 22,
    });
    expect(Object.isFrozen(TRANSFORM_FORMATTER_BENCH_PROFILE)).toBe(true);
    const first = createSeededTransformStates(256, 0x7a6f726d);
    const replay = createSeededTransformStates(256, 0x7a6f726d);
    const another = createSeededTransformStates(256, 0x7a6f726e);
    expect(first).toEqual(replay);
    expect(first).not.toEqual(another);
    expect(first.some((state) => state.scale !== undefined)).toBe(true);
    expect(first.some((state) => state.scaleX !== undefined)).toBe(true);
    expect(first.some((state) => state.x === 0 && state.y === 0)).toBe(true);
    expect(first.some((state) => state.x !== 0 && state.y !== 0)).toBe(true);

    for (const state of first) {
      expect(reconstructedPartsBuildTransform(state)).toBe(buildTransform(state));
    }
    const reconstruction = checksumTransformOutputs(reconstructedPartsBuildTransform, first);
    const current = checksumTransformOutputs(buildTransform, first);
    expect(reconstruction).toBe(current);
    expect(checksumTransformOutputs(buildTransform, another)).not.toBe(current);
    expect(materializeTransformOutputs(buildTransform, first, 2))
      .toBe(materializeTransformOutputs(reconstructedPartsBuildTransform, first, 2));
    expect(() => createSeededTransformStates(0, 1)).toThrow(/count/);
  });

  it('materialization читает каждый символ, а benchmark печатает только после provenance', () => {
    const reads: number[] = [];
    const stringLike = {
      length: 4,
      charCodeAt(index: number) {
        reads.push(index);
        return 65 + index;
      },
    };
    const checksum = materializeTransformOutputs(() => stringLike, [{}], 2);
    expect(reads).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(Number.isInteger(checksum)).toBe(true);

    const script = readFileSync('scripts/bench.mjs', 'utf8');
    const fixture = script.slice(
      script.indexOf('function measureTransformFormatterPair()'),
      script.indexOf('const SPRING'),
    );
    expect(fixture).toContain('materializeTransformOutputs(formatter, states, repetitions)');
    expect(fixture).not.toMatch(/formatter\([^)]*\)\.length/);
    expect(script).not.toContain('console.log');
    expect(script.indexOf('process.stdout.write')).toBeGreaterThan(
      script.lastIndexOf('assertCheckoutUnchanged'),
    );
  });

  it('one package-level frame batches separate full and mini source calls', () => {
    const clock = createBenchClock();
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = clock.requestFrame;
    const target = () => ({ style: { getPropertyValue: () => '', setProperty: () => {} } });
    try {
      const a = full(target(), { x: [0, 10] }, { duration: 1000, ease: (t: number) => t });
      const b = mini(target(), { x: [0, 10] }, { duration: 1000, ease: (t: number) => t });
      expect(clock.requests).toBe(1);
      clock.step(16);
      expect(clock.requests).toBe(2);
      a.cancel();
      b.cancel();
      const executions = clock.executions;
      clock.step(32);
      expect(clock.executions).toBe(executions + 1);
      expect(clock.requests).toBe(2);
    } finally {
      if (previous === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = previous;
    }
  });
});
