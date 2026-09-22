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

function selector(serialRepeats = 1) {
  const contract = PROFILE_PREREGISTRATION.scenarioSelector;
  return {
    kind: contract.kind,
    unitBatchCalls: contract.unitBatchCalls,
    serialRepeats,
    formalFloorMs: contract.formalFloorMs,
    selectionFloorMs: contract.selectionFloorMs,
    maximumSerialRepeats: contract.maximumSerialRepeats,
    discoveryProbeCount: contract.discoveryProbeCount,
    holdoutProbeCount: contract.holdoutProbeCount,
    holdoutCoverage: contract.holdoutCoverage,
    holdoutConfidence: contract.holdoutConfidence,
    aggregationRule: contract.aggregationRule,
    positiveControlRule: contract.positiveControlRule,
    discoveryHistory: [{
      serialRepeats,
      samples: Array(contract.discoveryProbeCount).fill(contract.selectionFloorMs),
    }],
    discovery: Array(contract.discoveryProbeCount).fill(contract.selectionFloorMs),
    holdout: Array(contract.holdoutProbeCount).fill(contract.selectionFloorMs),
  };
}

function rawScene(id: string) {
  return {
    id,
    sceneContractSha256: receiptSha256(PROFILE_PREREGISTRATION.scenes.find((scene) => scene.id === id)!),
    unitBatchCalls: PROFILE_PREREGISTRATION.scenarioSelector.unitBatchCalls,
    serialRepeats: 1,
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
      kind: 'scenario-null-control-v3',
      harnessRevision: '1'.repeat(40),
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      independentUnit: 'run-block',
      runBlocks: 20,
      samplesPerCluster: 1,
      orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
      aggregateFloorMs: PROFILE_PREREGISTRATION.scenarioSelector.formalFloorMs,
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

// These receipts are pure deterministic fixtures. Building them separately in
// every test repeated the same 10k-iteration bootstrap many times and made CI
// wall time, rather than the contract, decide whether the suite passed. Build
// the canonical values once; each test gets an isolated clone before mutation.
const fixtureInventory = inventory();
const fixtureCalibration = calibrationFor(fixtureInventory);
const fixturePilot = pilotFor(fixtureInventory);

function fixture() {
  return {
    inv: structuredClone(fixtureInventory),
    calibration: structuredClone(fixtureCalibration),
    pilot: structuredClone(fixturePilot),
  };
}

describe('PROFILE-01 content-addressed powered design', () => {
  it('derives N from non-degenerate null/control noise but keeps admission closed until the pilot is immutably registered', () => {
    const { inv, calibration, pilot } = fixture();
    const design = derivePoweredDesign(pilot, inv, calibration, '2026-09-18T03:03:00.000Z');
    expect(design.cells.every((cell) => cell.estimatedPower >= PROFILE_PREREGISTRATION.statistics.targetPower)).toBe(true);
    expect(design.cells.every((cell) => cell.status === 'powered')).toBe(true);
    expect(() => validatePilotRegistration(pilot)).toThrow(/no trusted immutable registration/);
    expect(() => eligibleDesktopCells(inv, calibration, design, pilot)).toThrow(/no trusted immutable registration/);
  });

  it('rejects degenerate zero-noise A/A evidence instead of converting sigma=0 into power=1', () => {
    const { inv, calibration, pilot } = fixture();
    for (const cell of pilot.cells) {
      for (const scene of cell.scenes) {
        scene.raw.aa.a = clusters(40, 0);
        scene.raw.aa.b = clusters(40, 0);
      }
    }
    const finalized = finalizePilotReceipt(pilot);
    expect(() => derivePoweredDesign(finalized, inv, calibration, '2026-09-18T03:03:00.000Z')).toThrow(/degenerate A\/A noise/);
  });

  it('rejects aggregate-changing substitution against the raw-backed pilot summaries', () => {
    const { pilot } = fixture();
    const changedPilot = structuredClone(pilot);
    for (const block of changedPilot.cells[0].scenes[0].raw.aa.a) block.samples[0] += 0.1;
    expect(() => validatePilotReceipt(changedPilot)).toThrow(/drifted from raw evidence/);
  });

  it('content addressing rejects even a raw substitution that leaves aggregate summaries unchanged', () => {
    const { pilot } = fixture();
    const registration = {
      schemaVersion: 1,
      profileId: PROFILE_PREREGISTRATION.profileId,
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      status: 'REGISTERED',
      pilotId: pilot.pilotId,
      pilotArtifactSha256: receiptSha256(pilot),
      harnessRevision: pilot.harness.harnessRevision,
      evidencePath: 'fixture://immutable-pilot',
    };
    expect(() => validatePilotRegistration(pilot, registration)).not.toThrow();

    const changedPilot = structuredClone(pilot);
    changedPilot.cells[0].scenes[0].raw.aa.a[0].samples[0] += 0.1;
    expect(() => validatePilotReceipt(changedPilot)).not.toThrow();
    expect(() => validatePilotRegistration(changedPilot, registration)).toThrow(/pilot digest does not match trusted registration/);
  }, 15_000);

  it('rejects a pilot sample below the preregistered formal timing floor', () => {
    const { pilot } = fixture();
    const broken = structuredClone(pilot);
    broken.cells[0].scenes[0].raw.aa.a[0].samples[0] = 19;
    expect(() => validatePilotReceipt(broken)).toThrow(/below 20ms timing floor/);
  });

  it('fails closed when scenario positive-control evidence is unresolved', () => {
    const { pilot } = fixture();
    const broken = structuredClone(pilot);
    broken.cells[1].scenes[1].raw.deliberate2x.doubled = clusters(40, 0);
    expect(() => validatePilotReceipt(broken)).toThrow(/raw evidence|positive control unresolved/);
  });
});
