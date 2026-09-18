import { describe, expect, it, vi } from 'vitest';
import { ASYMMETRIC_TIMING_PREREGISTRATION as DESIGN } from '../bench/profile/asymmetric-preregistration.mjs';
import {
  acquireAsymmetricControls,
  chooseArmRepeats,
  pairedMedianRatioInterval,
} from '../bench/profile/asymmetric-pilot-desktop.mjs';

describe('PROFILE-01 independent-arm normalized timing design', () => {
  it('selects each arm from its own directly-clocked wall-time', async () => {
    const motion = vi.fn(async (repeats: number) => repeats * 30);
    const control = vi.fn(async (repeats: number) => repeats * 10);
    const options = { candidates: [1, 2, 4], floorMs: 40, discoveryProbeCount: 2, holdoutProbeCount: 3 };
    const motionSelected = await chooseArmRepeats(motion, 'motion', options);
    const controlSelected = await chooseArmRepeats(control, 'control', options);
    expect(motionSelected.repeats).toBe(2);
    expect(controlSelected.repeats).toBe(4);
    expect(motionSelected.holdout).toHaveLength(3);
    expect(controlSelected.holdout).toHaveLength(3);
  });

  it('treats an arm holdout failure as a falsifier instead of escalating', async () => {
    const seen: number[] = [];
    let atTwo = 0;
    const measure = vi.fn(async (repeats: number) => {
      seen.push(repeats);
      if (repeats === 1) return 20;
      atTwo++;
      return atTwo === 4 ? 39 : 48;
    });
    await expect(chooseArmRepeats(measure, 'control', {
      candidates: [1, 2, 4], floorMs: 40, discoveryProbeCount: 2, holdoutProbeCount: 3,
    })).rejects.toThrow(/same-pilot escalation is forbidden/);
    expect(seen).not.toContain(4);
  });

  it('preserves every discovery probe when one arm exhausts the roster', async () => {
    const measure = vi.fn(async (repeats: number) => repeats * 2);
    const error = await chooseArmRepeats(measure, 'control', {
      candidates: [1, 2, 4], floorMs: 40, discoveryProbeCount: 2, holdoutProbeCount: 3,
    }).catch((caught) => caught);
    expect(error.name).toBe('AsymmetricPilotFailure');
    expect(error.evidence).toMatchObject({ stage: 'selector-exhausted', arm: 'control', candidates: [1, 2, 4] });
    expect(error.evidence.attempts.map((attempt: { repeats: number }) => attempt.repeats)).toEqual([1, 2, 4]);
  });

  it('normalizes independently resolved arms back to one semantic scene', async () => {
    const factors: number[] = [];
    const measure = vi.fn(async (selected: { motion: number; control: number }, factor: number) => {
      factors.push(factor);
      const motionWallMs = selected.motion * factor * 12;
      const controlWallMs = selected.control * factor * 3;
      return {
        motionWallMs,
        controlWallMs,
        motionRepeats: selected.motion,
        controlRepeats: selected.control,
        estimateMs: motionWallMs / selected.motion - controlWallMs / selected.control,
        factor,
      };
    });
    const selected = { motion: 4, control: 16 };
    const raw = await acquireAsymmetricControls(measure, selected, { runBlocks: 3, floorMs: 40, orderSeed: 7 });
    expect(raw.aa.a.map((cluster) => cluster.samples[0])).toEqual([9, 9, 9]);
    expect(raw.deliberate2x.doubled.map((cluster) => cluster.samples[0])).toEqual([18, 18, 18]);
    expect(factors.filter((factor) => factor === 2)).toHaveLength(3);
    expect(factors.filter((factor) => factor === 1)).toHaveLength(9);
  });

  it('rejects an unresolved normalized owner cost even when both clocks clear the floor', async () => {
    const measure = vi.fn(async (selected: { motion: number; control: number }) => ({
      motionWallMs: 50,
      controlWallMs: 80,
      motionRepeats: selected.motion,
      controlRepeats: selected.control,
      estimateMs: -1,
      factor: 1,
    }));
    await expect(acquireAsymmetricControls(measure, { motion: 1, control: 1 }, {
      runBlocks: 3, floorMs: 40, orderSeed: 7,
    })).rejects.toThrow(/normalized differential is not positive/);
  });

  it('keeps bootstrap calibration paired and deterministic', () => {
    const left = Array.from({ length: 20 }, (_, run) => ({ run, samples: [20], semantic: true }));
    const right = Array.from({ length: 20 }, (_, run) => ({ run, samples: [10], semantic: true }));
    expect(pairedMedianRatioInterval(left, right, 123, 500)).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });

  it('binds the premise change to the exact falsified family with zero candidate samples', () => {
    expect(DESIGN.supersedesTimingFamily).toBe('paired-coarse-arm-difference-v1');
    expect(DESIGN.candidateSamplesObservedAtRegistration).toBe(false);
    expect(DESIGN.estimator.representation).toBe('difference-of-independently-resolved-arm-normalized-wall-times');
    expect(1 - DESIGN.holdoutCoverage ** DESIGN.holdoutProbeCount).toBeGreaterThanOrEqual(DESIGN.holdoutConfidence);
  });
});
