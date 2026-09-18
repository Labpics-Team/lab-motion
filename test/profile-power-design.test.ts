import { describe, expect, it } from 'vitest';
import { createCalibrationReceipt } from '../bench/profile/calibrate-desktop.mjs';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import {
  derivePoweredDesign,
  finalizePilotReceipt,
  receiptSha256,
  validatePilotReceipt,
} from '../bench/profile/power-design.mjs';
import { eligibleDesktopCells, validatePilotRegistration } from '../bench/profile/validate.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
const hash = '0'.repeat(64);

function clusters(value: number, phase = 0) {
  return Array.from({ length: 20 }, (_, run) => ({
    run,
    samples: [value * (1 + ((((run + phase) % 5) - 2) * 0.001))],
    semantic: true,
  }));
}

function calibrationClusters(value: number) {
  return Array.from({ length: 20 }, (_, run) => ({
    run,
    samples: [value, value, value],
    semantic: true,
  }));
}
function inventory() {
  return {
    schemaVersion: 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    generatedAt: '2026-09-18T03:00:00.000Z',
    host: { platform: 'linux', release: 'fixture', arch: 'x64', node: 'v24.0.0' },
    browsers: engines.map((engine) => ({
      engine,
      version: 'fixture',
      playwrightVersion: '1.61.1',
      executableSha256: hash,
      launchMode: 'headless',
      refreshTargetHz: 60,
      userAgent: `fixture-${engine}`,
      platform: 'Linux x86_64',
      devicePixelRatio: 2,
      viewport: { width: 390, height: 844 },
    })),
  };
}

function calibrationCell(engine: typeof engines[number]) {
  return {
    engine,
    browserVersion: 'fixture',
    aa: { ratio: 1, lower95: 1, upper95: 1 },
    deliberate2x: { ratio: 2, lower95: 2, upper95: 2 },
    raw: {
      aa: { a: calibrationClusters(50), b: calibrationClusters(50) },
      deliberate2x: { single: calibrationClusters(50), doubled: calibrationClusters(100) },
    },
  };
}

function calibrationFor(inv: ReturnType<typeof inventory>) {
  return createCalibrationReceipt(
    engines.map(calibrationCell),
    '2026-09-18T03:01:00.000Z',
    {
      inventoryArtifactSha256: receiptSha256(inv),
      calibrationId: 'fixture-calibration-v2',
    },
  );
}


function selector(batchCalls = 1) {
  const contract = PROFILE_PREREGISTRATION.scenarioSelector;
  return {
    kind: contract.kind,
    batchCalls,
    formalFloorMs: contract.formalFloorMs,
    selectionFloorMs: contract.selectionFloorMs,
    maximumBatchCalls: contract.maximumBatchCalls,
    discoveryProbeCount: contract.discoveryProbeCount,
    holdoutProbeCount: contract.holdoutProbeCount,
    holdoutCoverage: contract.holdoutCoverage,
    holdoutConfidence: contract.holdoutConfidence,
    discovery: Array(contract.discoveryProbeCount).fill(contract.selectionFloorMs),
    holdout: Array(contract.holdoutProbeCount).fill(contract.selectionFloorMs),
  };
}

function rawScene(id: string) {
  return {
    id,
    batchCalls: 1,
    selector: selector(1),
    raw: {
      aa: { a: clusters(40, 0), b: clusters(40, 1) },
      deliberate2x: { single: clusters(40, 0), doubled: clusters(80, 0) },
    },
  };
}

function pilotFor(inv: ReturnType<typeof inventory>) {
  return finalizePilotReceipt({
    schemaVersion: 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    pilotId: 'fixture-null-control-v1',
    generatedAt: '2026-09-18T03:02:00.000Z',
    candidateSamples: 0,
    inventoryArtifactSha256: receiptSha256(inv),
    methodologyBlob: PROFILE_PREREGISTRATION.baseline.methodologyBlob,
    harness: {
      kind: 'scenario-null-control-v2',
      harnessRevision: '1'.repeat(40),
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      independentUnit: 'run-block',
      runBlocks: 20,
      samplesPerCluster: 1,
      orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
      batchFloorMs: PROFILE_PREREGISTRATION.scenarioSelector.formalFloorMs,
      selectorKind: PROFILE_PREREGISTRATION.scenarioSelector.kind,
    },
    cells: engines.map((engine) => ({
      id: `desktop-${engine}`,
      engine,
      browserVersion: 'fixture',
      scenes: [rawScene('collection-reorder-100'), rawScene('direct-manipulation-sheet')],
    })),
  });
}

describe('PROFILE-01 content-addressed powered design', () => {
  it('derives N from non-degenerate null/control noise but keeps admission closed until the pilot is immutably registered', () => {
    const inv = inventory();
    const calibration = calibrationFor(inv);
    const pilot = pilotFor(inv);
    const design = derivePoweredDesign(pilot, inv, calibration, '2026-09-18T03:03:00.000Z');
    expect(design.cells.every((cell) => cell.estimatedPower >= PROFILE_PREREGISTRATION.statistics.targetPower)).toBe(true);
    expect(design.cells.every((cell) => cell.status === 'powered')).toBe(true);
    expect(() => validatePilotRegistration(pilot)).toThrow(/no trusted immutable registration/);
    expect(() => eligibleDesktopCells(inv, calibration, design, pilot)).toThrow(/no trusted immutable registration/);
  });

  it('rejects degenerate zero-noise A/A evidence instead of converting sigma=0 into power=1', () => {
    const inv = inventory();
    const calibration = calibrationFor(inv);
    const pilot = pilotFor(inv);
    for (const cell of pilot.cells) {
      for (const scene of cell.scenes) {
        scene.raw.aa.a = clusters(40, 0);
        scene.raw.aa.b = clusters(40, 0);
      }
    }
    const finalized = finalizePilotReceipt(pilot);
    expect(() => derivePoweredDesign(finalized, inv, calibration, '2026-09-18T03:03:00.000Z')).toThrow(/degenerate A\/A noise/);
  });

  it('rejects evidence substitution against the raw-backed pilot summaries', () => {
    const inv = inventory();
    const pilot = pilotFor(inv);
    const changedPilot = structuredClone(pilot);
    changedPilot.cells[0].scenes[0].raw.aa.a[0].samples[0] += 0.1;
    expect(() => validatePilotReceipt(changedPilot)).toThrow(/drifted from raw evidence/);
  });

  it('rejects a pilot sample below the preregistered formal timing floor', () => {
    const inv = inventory();
    const pilot = pilotFor(inv);
    const broken = structuredClone(pilot);
    broken.cells[0].scenes[0].raw.aa.a[0].samples[0] = 19;
    expect(() => validatePilotReceipt(broken)).toThrow(/below 20ms timing floor/);
  });

  it('fails closed when scenario positive-control evidence is unresolved', () => {
    const inv = inventory();
    const pilot = pilotFor(inv);
    const broken = structuredClone(pilot);
    broken.cells[1].scenes[1].raw.deliberate2x.doubled = clusters(40, 0);
    expect(() => validatePilotReceipt(broken)).toThrow(/raw evidence|positive control unresolved/);
  });
});
