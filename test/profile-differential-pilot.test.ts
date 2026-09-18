import { describe, expect, it, vi } from 'vitest';
import { DIFFERENTIAL_TIMING_PREREGISTRATION as DESIGN } from '../bench/profile/differential-preregistration.mjs';
import {
  acquireDifferentialControls,
  chooseCoarseArmRepeats,
  pairedMedianRatioInterval,
} from '../bench/profile/differential-pilot-desktop.mjs';

describe('PROFILE-01 coarse differential timing design', () => {
  it('selects the smallest repeat count whose two directly-clocked arms clear the floor', async () => {
    const measure = vi.fn(async (repeats: number) => ({
      motionWallMs: repeats * 30,
      controlWallMs: repeats * 24,
      estimateMs: repeats * 6,
    }));
    const selected = await chooseCoarseArmRepeats(measure, {
      candidates: [1, 2, 4],
      floorMs: 40,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
    });
    expect(selected.repeats).toBe(2);
    expect(selected.discovery).toHaveLength(2);
    expect(selected.holdout).toHaveLength(3);
    expect(measure.mock.calls.map(([repeats]) => repeats)).toEqual([1, 1, 2, 2, 2, 2, 2]);
  });

  it('treats a holdout floor failure as a falsifier instead of escalating repeats', async () => {
    const seen: number[] = [];
    let atTwo = 0;
    const measure = vi.fn(async (repeats: number) => {
      seen.push(repeats);
      if (repeats === 1) return { motionWallMs: 20, controlWallMs: 20, estimateMs: 1 };
      atTwo++;
      const controlWallMs = atTwo === 4 ? 39 : 48;
      return { motionWallMs: 50, controlWallMs, estimateMs: 2 };
    });
    await expect(chooseCoarseArmRepeats(measure, {
      candidates: [1, 2, 4],
      floorMs: 40,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
    })).rejects.toThrow(/same-pilot escalation is forbidden/);
    expect(seen).not.toContain(4);
  });

  it('preserves every discovery probe when the preregistered selector is exhausted', async () => {
    const measure = vi.fn(async (repeats: number) => ({
      motionWallMs: repeats * 50, controlWallMs: repeats * 0.5, estimateMs: repeats * 49.5,
    }));
    const error = await chooseCoarseArmRepeats(measure, {
      candidates: [1, 2, 4], floorMs: 40, discoveryProbeCount: 2, holdoutProbeCount: 3,
    }).catch((caught) => caught);
    expect(error.name).toBe('DifferentialPilotFailure');
    expect(error.evidence).toMatchObject({ stage: 'selector-exhausted', floorMs: 40, candidates: [1, 2, 4] });
    expect(error.evidence.attempts.map((attempt: { repeats: number }) => attempt.repeats)).toEqual([1, 2, 4]);
    expect(error.evidence.attempts.every((attempt: { discovery: unknown[] }) => attempt.discovery.length === 2)).toBe(true);
  });

  it('doubles both arms for the positive control so application work stays differenced out', async () => {
    const factors: number[] = [];
    const measure = vi.fn(async (repeats: number, factor: number) => {
      factors.push(factor);
      const controlWallMs = repeats * factor * 50;
      return {
        controlWallMs,
        motionWallMs: controlWallMs + repeats * factor * 10,
        estimateMs: repeats * factor * 10,
      };
    });
    const raw = await acquireDifferentialControls(measure, 1, { runBlocks: 3, floorMs: 40, orderSeed: 7 });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.deliberate2x.doubled.map((cluster) => cluster.samples[0])).toEqual([20, 20, 20]);
    expect(factors.filter((factor) => factor === 2)).toHaveLength(3);
    expect(factors.filter((factor) => factor === 1)).toHaveLength(9);
  });

  it('rejects a differential estimator that is unresolved even when both arm clocks are coarse enough', async () => {
    const measure = vi.fn(async () => ({ motionWallMs: 50, controlWallMs: 51, estimateMs: -1 }));
    await expect(acquireDifferentialControls(measure, 1, { runBlocks: 3, floorMs: 40, orderSeed: 7 }))
      .rejects.toThrow(/differential is not positive/);
  });

  it('keeps the bootstrap calibration paired and deterministic', () => {
    const left = Array.from({ length: 20 }, (_, run) => ({ run, samples: [20], semantic: true }));
    const right = Array.from({ length: 20 }, (_, run) => ({ run, samples: [10], semantic: true }));
    expect(pairedMedianRatioInterval(left, right, 123, 500)).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });

  it('binds the premise change to the exhausted family without observing candidate data', () => {
    expect(DESIGN.supersedesTimingFamily).toBe('bounded-serial-own-work-v1');
    expect(DESIGN.candidateSamplesObservedAtRegistration).toBe(false);
    expect(DESIGN.estimator.representation).toBe('paired-difference-of-coarse-contiguous-arm-wall-times');
    expect(1 - DESIGN.holdoutCoverage ** DESIGN.holdoutProbeCount).toBeGreaterThanOrEqual(DESIGN.holdoutConfidence);
  });
});
