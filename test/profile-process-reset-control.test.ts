import { describe, expect, it, vi } from 'vitest';
import { finalizeCalibrationReceipt } from '../bench/profile/calibrate-desktop.mjs';
import { pairedLogReceiptSha256 } from '../bench/profile/paired-log-pilot-core.mjs';
import {
  PROCESS_RESET_PREREGISTRATION as DESIGN,
  validateProcessResetPreregistration,
} from '../bench/profile/process-reset-preregistration.mjs';
import {
  ProcessResetResolutionFailure,
  acquireProcessResetControls,
  acquireProcessResetObservation,
  buildProcessResetPilotReceipt,
  finalizeProcessResetPilotReceipt,
} from '../bench/profile/process-reset-pilot-core.mjs';
import { deriveProcessResetPoweredDesign } from '../bench/profile/process-reset-power-design.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
type Request = {
  sceneId: string;
  logicalUnits: number;
  batchCalls: number;
  warmupLogicalUnits: number;
  workMultiplier: 1 | 2;
};

function calibrationCluster(run: number, value: number) {
  return { run, samples: [value, value, value], semantic: true };
}

function calibration(inventory: object) {
  const cells = engines.map((engine) => ({
    engine,
    batchCopies: 1,
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
  return finalizeCalibrationReceipt(cells, '2026-09-19T04:55:00.000Z', {
    inventoryArtifactSha256: pairedLogReceiptSha256(inventory),
    calibrationId: 'process-reset-test-calibration',
  });
}

function observationFor(sceneId: string, workMultiplier: 1 | 2, sample: number, token: string, launchOrdinal: number) {
  const logicalUnits = DESIGN.measurement.logicalUnitsByScene[sceneId as keyof typeof DESIGN.measurement.logicalUnitsByScene];
  const batchCalls = DESIGN.measurement.liveBatchCallsByScene[sceneId as keyof typeof DESIGN.measurement.liveBatchCallsByScene];
  const warmupLogicalUnits = DESIGN.measurement.warmupLogicalUnitsByScene[sceneId as keyof typeof DESIGN.measurement.warmupLogicalUnitsByScene];
  const ownerMs = sample * logicalUnits;
  return {
    ownerMs,
    enclosingWallMs: ownerMs + 1,
    launchSetupWallMs: 2,
    warmupWallMs: 3,
    closeWallMs: 1,
    logicalUnits,
    physicalExecutions: logicalUnits * workMultiplier,
    batchCalls,
    warmupLogicalUnits,
    warmupPhysicalExecutions: warmupLogicalUnits,
    workMultiplier,
    costPerLogicalUnitMs: sample,
    processLifecycle: 'launch-warmup-measure-close',
    isolationToken: token,
    launchOrdinal,
    browserVersion: 'fixture',
    semantic: true,
    samples: [sample],
  };
}

function rawScene(id: string, tokenPrefix: string, ordinal: { value: number }) {
  const aaOrders = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'BA' : 'AB');
  const deliberateOrders = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'DS' : 'SD');
  const signed = (run: number) => (run % 2 ? 1 : -1) * 0.004;
  const next = (multiplier: 1 | 2, sample: number) => {
    ordinal.value++;
    return observationFor(id, multiplier, sample, `${tokenPrefix}-${String(ordinal.value).padStart(6, '0')}`, ordinal.value);
  };
  return {
    id,
    raw: {
      aa: {
        orders: aaOrders,
        a: aaOrders.map((_, run) => ({ run, ...next(1, 50 * Math.exp(signed(run))) })),
        b: aaOrders.map((_, run) => ({ run, ...next(1, 50 * Math.exp(-signed(run))) })),
      },
      deliberate2x: {
        orders: deliberateOrders,
        single: deliberateOrders.map((_, run) => ({ run, ...next(1, 50 * Math.exp(signed(run) / 2)) })),
        doubled: deliberateOrders.map((_, run) => ({ run, ...next(2, 100 * Math.exp(-signed(run) / 2)) })),
      },
    },
  };
}

function pilot() {
  const inventory = { exact: 'fixture' };
  const cal = calibration(inventory);
  const ordinal = { value: 0 };
  const receipt = buildProcessResetPilotReceipt({
    inventory,
    calibration: cal,
    preregRevision: '1'.repeat(40),
    harnessRevision: '2'.repeat(40),
    generatedAt: '2026-09-19T04:56:00.000Z',
    pilotEnclosingWallMs: 1_000,
    cells: engines.map((engine) => ({
      id: `desktop-${engine}`,
      engine,
      browserVersion: 'fixture',
      launches: DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 4,
      scenes: DESIGN.sceneIds.map((id) => rawScene(id, `process-${engine}`, ordinal)),
    })),
  });
  return { inventory, calibration: cal, receipt };
}

describe('PROFILE-01 fresh-process timing family', () => {
  it('freezes a premise-changing reset boundary without candidate data', () => {
    expect(() => validateProcessResetPreregistration()).not.toThrow();
    expect(DESIGN.id).toBe('fresh-process-owner-ms-v1');
    expect(DESIGN.candidateSamples).toBe(0);
    expect(DESIGN.controls.aaBand).toEqual([0.95, 1.05]);
    expect(DESIGN.measurement.processRule).toContain('browserType.launch exactly once');
  });

  it('acquires every arm through a distinct fresh-process callback and keeps process cost outside ownerMs', async () => {
    let launch = 0;
    const measure = vi.fn(async ({ sceneId, logicalUnits, batchCalls, warmupLogicalUnits, workMultiplier }: Request) => {
      launch++;
      const ownerMs = 50 * logicalUnits * workMultiplier;
      return {
        ownerMs,
        enclosingWallMs: ownerMs + 1,
        launchSetupWallMs: 500,
        warmupWallMs: 100,
        closeWallMs: 50,
        logicalUnits,
        physicalExecutions: logicalUnits * workMultiplier,
        batchCalls,
        warmupLogicalUnits,
        warmupPhysicalExecutions: warmupLogicalUnits,
        workMultiplier,
        processLifecycle: 'launch-warmup-measure-close',
        isolationToken: `fresh-process-token-${launch}`,
        launchOrdinal: launch,
        browserVersion: 'fixture',
        semantic: true,
      };
    });
    const raw = await acquireProcessResetControls(measure, 'collection-reorder-100', { runBlocks: 3, orderSeed: 7 });
    expect(measure).toHaveBeenCalledTimes(12);
    expect(new Set([
      ...raw.aa.a,
      ...raw.aa.b,
      ...raw.deliberate2x.single,
      ...raw.deliberate2x.doubled,
    ].map((entry) => entry.isolationToken)).size).toBe(12);
    expect(raw.aa.a[0].samples[0]).toBeCloseTo(50, 12);
    expect(raw.deliberate2x.doubled[0].samples[0] / raw.deliberate2x.single[0].samples[0]).toBeCloseTo(2, 12);
  });

  it('fails closed when fixed owner work does not clear the unchanged timing floor', async () => {
    const unresolved = vi.fn(async ({ sceneId, logicalUnits, batchCalls, warmupLogicalUnits, workMultiplier }: Request) => ({
      ownerMs: 39,
      enclosingWallMs: 40,
      launchSetupWallMs: 1,
      warmupWallMs: 1,
      closeWallMs: 1,
      logicalUnits,
      physicalExecutions: logicalUnits * workMultiplier,
      batchCalls,
      warmupLogicalUnits,
      warmupPhysicalExecutions: warmupLogicalUnits,
      workMultiplier,
      processLifecycle: 'launch-warmup-measure-close',
      isolationToken: `unresolved-${sceneId}`,
      launchOrdinal: 1,
      browserVersion: 'fixture',
      semantic: true,
    }));
    await expect(acquireProcessResetObservation(unresolved, 'collection-reorder-100', 1)).rejects.toBeInstanceOf(ProcessResetResolutionFailure);
  });

  it('rejects any repeated formal-arm isolation token', () => {
    const { receipt } = pilot();
    receipt.cells[0].scenes[0].raw.aa.b[0].isolationToken = receipt.cells[0].scenes[0].raw.aa.a[0].isolationToken;
    expect(() => finalizeProcessResetPilotReceipt(receipt)).toThrow(/isolation token reused/);
  });

  it('accepts distinct-arm controls and derives the smallest deterministic powered N', () => {
    const { inventory, calibration: cal, receipt } = pilot();
    const accepted = finalizeProcessResetPilotReceipt(receipt);
    expect(accepted.processIsolation).toEqual({
      kind: 'fresh-browser-process-per-formal-arm',
      uniqueFormalArmTokens: 480,
    });
    expect(accepted.cells[0].scenes[0].aa.lower95).toBeGreaterThanOrEqual(0.95);
    expect(accepted.cells[0].scenes[0].aa.upper95).toBeLessThanOrEqual(1.05);
    expect(accepted.cells[0].scenes[0].deliberate2x.lower95).toBeGreaterThanOrEqual(1.5);

    const powered = deriveProcessResetPoweredDesign(receipt, inventory, cal, '2026-09-19T04:57:00.000Z');
    expect(powered.candidateSamples).toBe(0);
    expect(powered.processIsolation.uniqueFormalArmTokens).toBe(480);
    expect(powered.cells.every((cell) => cell.status === 'powered')).toBe(true);
    for (const cell of powered.cells) {
      expect(cell.chosenIndependentBlocks).toBeGreaterThanOrEqual(20);
      expect(cell.chosenIndependentBlocks).toBeLessThanOrEqual(60);
      if (cell.previousIndependentBlocks !== null) expect(cell.previousEstimatedPower).toBeLessThan(0.8);
    }
  }, 15_000);
});
