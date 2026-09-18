import { describe, expect, it, vi } from 'vitest';
import {
  PAIRED_LOG_PREREGISTRATION as DESIGN,
  validatePairedLogPreregistration,
} from '../bench/profile/paired-log-preregistration.mjs';
import {
  PairedLogBudgetFailure,
  acquirePairedLogControls,
  acquirePairedLogObservation,
  buildPairedLogPilotReceipt,
  finalizePairedLogPilotReceipt,
  pairedLogRatioInterval,
} from '../bench/profile/paired-log-pilot-core.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;

function physical(ownerMs = 10, enclosingWallMs = 12) {
  return vi.fn(async () => ({ ownerMs, enclosingWallMs }));
}

function plainClusters(values: number[]) {
  return values.map((value, run) => ({ run, samples: [value], semantic: true }));
}

function cluster(run: number, workMultiplier: 1 | 2, cost: number) {
  const logicalUnits = 25;
  const ownerMs = cost * logicalUnits;
  return {
    run,
    samples: [cost],
    ownerMs,
    enclosingWallMs: ownerMs + 10,
    logicalUnits,
    physicalExecutions: logicalUnits * workMultiplier,
    workMultiplier,
    semantic: true,
  };
}

function clusters(workMultiplier: 1 | 2, cost: number) {
  return Array.from({ length: DESIGN.runBlocks }, (_, run) => cluster(run, workMultiplier, cost));
}

function rawScene(id: string) {
  return {
    id,
    raw: {
      aa: { a: clusters(1, 10), b: clusters(1, 10) },
      deliberate2x: { single: clusters(1, 10), doubled: clusters(2, 20) },
    },
  };
}

describe('PROFILE-01 paired-log control family', () => {
  it('freezes the same paired log-ratio representation used by the power contract', () => {
    expect(() => validatePairedLogPreregistration()).not.toThrow();
    expect(DESIGN.controls.statisticId).toBe('paired-run-block-log-ratio-median-v1');
    expect(DESIGN.controls.aaRule).toMatch(/log\(a\/b\)/);
    expect(DESIGN.controls.aaRule).toMatch(/paired block log-ratios/);
    expect(DESIGN.controls.candidateSamples).toBe(0);
  });

  it('detects pair-identity mutation that ratio-of-marginal-medians cannot observe', () => {
    const left = plainClusters([1, 2, 3, 10, 100]);
    const aligned = plainClusters([1, 2, 3, 10, 100]);
    const permutedValues = [1, 3, 10, 100, 2];
    const permuted = plainClusters(permutedValues);

    const marginalRatio = (a: number[], b: number[]) => {
      const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
      return median(a) / median(b);
    };
    expect(marginalRatio([1, 2, 3, 10, 100], [1, 2, 3, 10, 100])).toBe(1);
    expect(marginalRatio([1, 2, 3, 10, 100], permutedValues)).toBe(1);

    const alignedResult = pairedLogRatioInterval(left, aligned, 7, 2_000);
    const permutedResult = pairedLogRatioInterval(left, permuted, 7, 2_000);
    expect(alignedResult.ratio).toBeCloseTo(1, 12);
    expect(permutedResult.ratio).toBeCloseTo(2 / 3, 12);
  });

  it('self-resolves each formal observation without discovery-to-holdout transfer', async () => {
    const measure = physical(10, 12);
    const sample = await acquirePairedLogObservation(measure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    expect(sample.ownerMs).toBe(50);
    expect(sample.logicalUnits).toBe(5);
    expect(sample.costPerLogicalUnitMs).toBe(10);
    expect(measure).toHaveBeenCalledTimes(5);
  });

  it('positive control performs real doubled semantic work', async () => {
    const singleMeasure = physical(10, 12);
    const single = await acquirePairedLogObservation(singleMeasure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    const doubledMeasure = physical(10, 12);
    const doubled = await acquirePairedLogObservation(doubledMeasure, 2, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    expect(single.costPerLogicalUnitMs).toBe(10);
    expect(doubled.costPerLogicalUnitMs).toBe(20);
    expect(doubled.physicalExecutions).toBe(doubled.logicalUnits * 2);
  });

  it('fails closed instead of retuning a bounded observation', async () => {
    const measure = physical(1, 2);
    await expect(acquirePairedLogObservation(measure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 4,
      maximumEnclosingWallMs: 100,
    })).rejects.toBeInstanceOf(PairedLogBudgetFailure);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  it('keeps paired run-block count fixed while counterbalancing controls', async () => {
    const measure = physical(250, 255);
    const raw = await acquirePairedLogControls(measure, {
      runBlocks: 3,
      orderSeed: 7,
      maximumLogicalUnits: 4,
      maximumEnclosingWallMs: 1000,
    });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.aa.b).toHaveLength(3);
    expect(raw.deliberate2x.single).toHaveLength(3);
    expect(raw.deliberate2x.doubled).toHaveLength(3);
    expect(raw.deliberate2x.doubled.every((entry) => entry.workMultiplier === 2)).toBe(true);
  });

  it('finalizes a content-addressable receipt only when paired null/control evidence resolves', () => {
    const inventory = { exact: 'fixture' };
    const raw = buildPairedLogPilotReceipt({
      inventory,
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      generatedAt: '2026-09-18T19:00:00.000Z',
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: DESIGN.sceneIds.map(rawScene),
      })),
    });
    expect(raw.candidateSamples).toBe(0);
    const receipt = finalizePairedLogPilotReceipt(raw);
    expect(receipt.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(receipt.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });
});
