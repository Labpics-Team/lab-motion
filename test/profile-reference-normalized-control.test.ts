import { describe, expect, it, vi } from 'vitest';
import { finalizeCalibrationReceipt } from '../bench/profile/calibrate-desktop.mjs';
import { pairedLogReceiptSha256 } from '../bench/profile/paired-log-pilot-core.mjs';
import {
  REFERENCE_NORMALIZED_PREREGISTRATION as DESIGN,
  validateReferenceNormalizedPreregistration,
} from '../bench/profile/reference-normalized-preregistration.mjs';
import {
  ReferenceNormalizedResolutionFailure,
  acquireReferenceNormalizedControls,
  acquireReferenceNormalizedObservation,
  buildReferenceNormalizedPilotReceipt,
  finalizeReferenceNormalizedPilotReceipt,
} from '../bench/profile/reference-normalized-pilot-core.mjs';
import { deriveReferenceNormalizedPoweredDesign } from '../bench/profile/reference-normalized-power-design.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
type Request = { sceneId: string; logicalUnits: number; workMultiplier: 1 | 2 };
const referenceBinding = { iterationsPerCopy: 5_000_000, batchCopies: 1, anchorMs: 50 };

function calibrationCluster(run: number, value: number) {
  return { run, samples: [value, value, value], semantic: true };
}

function calibration(inventory: object) {
  const cells = engines.map((engine) => ({
    engine,
    batchCopies: referenceBinding.batchCopies,
    aa: { ratio: 1, lower95: 1, upper95: 1 },
    deliberate2x: { ratio: 2, lower95: 2, upper95: 2 },
    raw: {
      aa: {
        a: Array.from({ length: 20 }, (_, run) => calibrationCluster(run, 50)),
        b: Array.from({ length: 20 }, (_, run) => calibrationCluster(run, 50)),
      },
      deliberate2x: {
        single: Array.from({ length: 20 }, (_, run) => calibrationCluster(run, 50)),
        doubled: Array.from({ length: 20 }, (_, run) => calibrationCluster(run, 100)),
      },
    },
  }));
  return finalizeCalibrationReceipt(cells, '2026-09-19T03:30:00.000Z', {
    inventoryArtifactSha256: pairedLogReceiptSha256(inventory),
    calibrationId: 'reference-normalized-test-calibration',
  });
}

function packetForSample(sceneId: string, workMultiplier: 1 | 2, sample: number) {
  const logicalUnits = DESIGN.measurement.logicalUnitsByScene[sceneId as keyof typeof DESIGN.measurement.logicalUnitsByScene];
  const ownerMs = sample * logicalUnits;
  return {
    ownerMs,
    enclosingWallMs: ownerMs + 201,
    referenceBeforeMs: 50,
    referenceAfterMs: 50,
    referenceAnchorMs: referenceBinding.anchorMs,
    referenceCopies: referenceBinding.batchCopies,
    referenceIterationsPerCopy: referenceBinding.iterationsPerCopy,
    logicalUnits,
    physicalExecutions: logicalUnits * workMultiplier,
    batchCalls: DESIGN.measurement.liveBatchCallsByScene[sceneId as keyof typeof DESIGN.measurement.liveBatchCallsByScene],
    workMultiplier,
    rawCostPerLogicalUnitMs: ownerMs / logicalUnits,
    standardizedCostMs: sample,
    semantic: true,
    samples: [sample],
  };
}

function rawScene(id: string) {
  const aaOrders = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'BA' : 'AB');
  const deliberateOrders = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'DS' : 'SD');
  const signed = (run: number) => (run % 2 ? 1 : -1) * 0.004;
  return {
    id,
    raw: {
      aa: {
        orders: aaOrders,
        a: aaOrders.map((_, run) => ({ run, ...packetForSample(id, 1, 50 * Math.exp(signed(run))) })),
        b: aaOrders.map((_, run) => ({ run, ...packetForSample(id, 1, 50 * Math.exp(-signed(run))) })),
      },
      deliberate2x: {
        orders: deliberateOrders,
        single: deliberateOrders.map((_, run) => ({ run, ...packetForSample(id, 1, 50 * Math.exp(signed(run) / 2)) })),
        doubled: deliberateOrders.map((_, run) => ({ run, ...packetForSample(id, 2, 100 * Math.exp(-signed(run) / 2)) })),
      },
    },
  };
}

function pilot() {
  const inventory = { exact: 'fixture' };
  const cal = calibration(inventory);
  const receipt = buildReferenceNormalizedPilotReceipt({
    inventory,
    calibration: cal,
    preregRevision: '1'.repeat(40),
    harnessRevision: '2'.repeat(40),
    generatedAt: '2026-09-19T03:31:00.000Z',
    pilotEnclosingWallMs: 1_000,
    cells: engines.map((engine) => ({
      id: `desktop-${engine}`,
      engine,
      browserVersion: 'fixture',
      referenceBinding,
      scenes: DESIGN.sceneIds.map(rawScene),
    })),
  });
  return { inventory, calibration: cal, receipt };
}

describe('PROFILE-01 calibration-bracket standardized-ms timing family', () => {
  it('freezes a premise-changing representation without candidate data', () => {
    expect(() => validateReferenceNormalizedPreregistration()).not.toThrow();
    expect(DESIGN.id).toBe('calibration-bracket-standardized-owner-ms-v2');
    expect(DESIGN.candidateSamples).toBe(0);
    expect(DESIGN.measurement.liveBatchCallsByScene).toEqual({ 'collection-reorder-100': 32, 'direct-manipulation-sheet': 128 });
    expect(DESIGN.measurement.logicalUnitsByScene).toEqual({ 'collection-reorder-100': 1, 'direct-manipulation-sheet': 512 });
    expect(DESIGN.controls.aaBand).toEqual([0.95, 1.05]);
  });

  it('normalizes multiplicative speed drift while preserving the 2x positive control', async () => {
    let call = 0;
    const measure = vi.fn(async ({ sceneId, logicalUnits, workMultiplier }: Request) => {
      const scale = 1 + ((call++ % 7) - 3) * 0.01;
      const ownerMs = 50 * logicalUnits * workMultiplier * scale;
      const referenceMs = 100 * scale;
      return {
        ownerMs,
        enclosingWallMs: ownerMs + 2 * referenceMs + 1,
        referenceBeforeMs: referenceMs,
        referenceAfterMs: referenceMs,
        referenceAnchorMs: 100,
        referenceCopies: 1,
        referenceIterationsPerCopy: 5_000_000,
        logicalUnits,
        physicalExecutions: logicalUnits * workMultiplier,
        batchCalls: DESIGN.measurement.liveBatchCallsByScene[sceneId as keyof typeof DESIGN.measurement.liveBatchCallsByScene],
        workMultiplier,
        semantic: true,
      };
    });
    const raw = await acquireReferenceNormalizedControls(measure, 'direct-manipulation-sheet', { runBlocks: 3, orderSeed: 7 });
    expect(measure).toHaveBeenCalledTimes(12);
    for (let run = 0; run < 3; run++) {
      expect(raw.aa.a[run].samples[0]).toBeCloseTo(50, 12);
      expect(raw.aa.b[run].samples[0]).toBeCloseTo(50, 12);
      expect(raw.deliberate2x.doubled[run].samples[0] / raw.deliberate2x.single[run].samples[0]).toBeCloseTo(2, 12);
    }
  });

  it('fails closed when either raw owner work or the bracketing reference is unresolved', async () => {
    const unresolvedReference = vi.fn(async ({ sceneId, logicalUnits, workMultiplier }: Request) => ({
      ownerMs: 50,
      enclosingWallMs: 90,
      referenceBeforeMs: 39,
      referenceAfterMs: 41,
      referenceAnchorMs: 50,
      referenceCopies: 1,
      referenceIterationsPerCopy: 5_000_000,
      logicalUnits,
      physicalExecutions: logicalUnits * workMultiplier,
      batchCalls: DESIGN.measurement.liveBatchCallsByScene[sceneId as keyof typeof DESIGN.measurement.liveBatchCallsByScene],
      workMultiplier,
      semantic: true,
    }));
    await expect(acquireReferenceNormalizedObservation(unresolvedReference, 'collection-reorder-100', 1)).rejects.toBeInstanceOf(ReferenceNormalizedResolutionFailure);
  });

  it('retains raw timings while exposing exactly one normalized sample per run-block', () => {
    const { receipt } = pilot();
    const accepted = finalizeReferenceNormalizedPilotReceipt(receipt);
    const first = accepted.cells[0].scenes[0].raw.aa.a[0];
    expect(first.samples).toHaveLength(1);
    expect(first.ownerMs).toBeGreaterThanOrEqual(40);
    expect(first.referenceBeforeMs).toBe(50);
    expect(first.referenceAfterMs).toBe(50);
    expect(first.samples[0]).toBe(first.standardizedCostMs);
    expect(accepted.cells[0].scenes[0].aa.lower95).toBeGreaterThanOrEqual(0.95);
    expect(accepted.cells[0].scenes[0].aa.upper95).toBeLessThanOrEqual(1.05);
    expect(accepted.cells[0].scenes[0].deliberate2x.lower95).toBeGreaterThanOrEqual(1.5);
  });

  it('rejects a receipt whose reference binding changes inside a paired block', () => {
    const { receipt } = pilot();
    receipt.cells[0].scenes[0].raw.aa.b[0].referenceCopies = 2;
    expect(() => finalizeReferenceNormalizedPilotReceipt(receipt)).toThrow(/reference binding changed within pair|reference copies differ from cell binding/);
  });

  it('derives the smallest deterministic powered N from the accepted normalized A/A noise', () => {
    const { inventory, calibration: cal, receipt } = pilot();
    const design = deriveReferenceNormalizedPoweredDesign(receipt, inventory, cal, '2026-09-19T03:32:00.000Z');
    expect(design.candidateSamples).toBe(0);
    expect(design.cells.every((cell) => cell.status === 'powered')).toBe(true);
    expect(design.cells.every((cell) => cell.chosenIndependentBlocks >= 20 && cell.chosenIndependentBlocks <= 60)).toBe(true);
    for (const cell of design.cells) {
      if (cell.previousIndependentBlocks !== null) expect(cell.previousEstimatedPower).toBeLessThan(0.8);
    }
  }, 15_000);
});
