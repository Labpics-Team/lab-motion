import { describe, expect, it, vi } from 'vitest';
import { ENCLOSING_TIMING_PREREGISTRATION as DESIGN } from '../bench/profile/enclosing-preregistration.mjs';
import { acquireEnclosingControls, chooseArmRepeats, pairedMedianRatioInterval } from '../bench/profile/enclosing-pilot-desktop.mjs';

describe('PROFILE-01 direct enclosing wall timing design', () => {
  it('selects each raw arm from its own directly-clocked wall-time', async () => {
    const motion = vi.fn(async (repeats: number) => repeats * 30);
    const control = vi.fn(async (repeats: number) => repeats * 10);
    const options = { candidates: [1, 2, 4], floorMs: 40, discoveryProbeCount: 2, holdoutProbeCount: 3 };
    const motionSelected = await chooseArmRepeats(motion, 'motion', options);
    const controlSelected = await chooseArmRepeats(control, 'control', options);
    expect(motionSelected.repeats).toBe(2);
    expect(controlSelected.repeats).toBe(4);
  });

  it('measures the primary wall directly and never requires a positive arm subtraction', async () => {
    const factors: number[] = [];
    const measure = vi.fn(async (selected: { motion: number; control: number }, factor: number) => {
      factors.push(factor);
      const motionWallMs = selected.motion * factor * 12;
      const controlWallMs = selected.control * factor * 20;
      return { motionWallMs, controlWallMs, motionRepeats: selected.motion, controlRepeats: selected.control,
        motionNormalizedMs: motionWallMs / selected.motion, controlNormalizedMs: controlWallMs / selected.control, factor };
    });
    const selected = { motion: 4, control: 16 };
    const raw = await acquireEnclosingControls(measure, selected, { runBlocks: 3, floorMs: 40, orderSeed: 7 });
    expect(raw.aa.a.map((cluster) => cluster.samples[0])).toEqual([12, 12, 12]);
    expect(raw.deliberate2x.doubled.map((cluster) => cluster.samples[0])).toEqual([24, 24, 24]);
    expect(raw.aa.a.every((cluster) => cluster.rawControlMs === 20)).toBe(true);
    expect(factors.filter((factor) => factor === 2)).toHaveLength(3);
    expect(factors.filter((factor) => factor === 1)).toHaveLength(9);
  });

  it('rejects unresolved direct clocks without retuning the primary estimator', async () => {
    const measure = vi.fn(async (selected: { motion: number; control: number }) => ({
      motionWallMs: 39, controlWallMs: 80, motionRepeats: selected.motion, controlRepeats: selected.control,
      motionNormalizedMs: 39 / selected.motion, controlNormalizedMs: 80 / selected.control, factor: 1,
    }));
    await expect(acquireEnclosingControls(measure, { motion: 1, control: 1 }, { runBlocks: 3, floorMs: 40, orderSeed: 7 }))
      .rejects.toThrow(/coarse arm escaped 40ms timing floor/);
  });

  it('keeps bootstrap calibration paired and deterministic', () => {
    const left = Array.from({ length: 20 }, (_, run) => ({ run, samples: [20], semantic: true }));
    const right = Array.from({ length: 20 }, (_, run) => ({ run, samples: [10], semantic: true }));
    expect(pairedMedianRatioInterval(left, right, 123, 500)).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });

  it('binds the premise change to the falsified subtraction family before candidate data', () => {
    expect(DESIGN.supersedesTimingFamily).toBe('independent-arm-normalized-difference-v1');
    expect(DESIGN.candidateSamplesObservedAtRegistration).toBe(false);
    expect(DESIGN.estimator.representation).toBe('direct-enclosing-motion-wall-ratio-with-separately-resolved-raw-control');
    expect(DESIGN.estimator.subtractionRule).toMatch(/forbidden/);
    expect(DESIGN.attribution.requiredBeforeCandidateAdmission).toMatch(/trace\/callgraph\/breakdown/);
  });
});
