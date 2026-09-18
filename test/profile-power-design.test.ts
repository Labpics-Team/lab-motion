import { describe, expect, it } from 'vitest';
import { createCalibrationReceipt } from '../bench/profile/calibrate-desktop.mjs';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import {
  derivePoweredDesign,
  finalizePilotReceipt,
  receiptSha256,
  validatePilotReceipt,
} from '../bench/profile/power-design.mjs';
import { eligibleDesktopCells } from '../bench/profile/validate.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
const hash = '0'.repeat(64);

function clusters(value: number) {
  return Array.from({ length: 20 }, (_, run) => ({
    run,
    samples: [value],
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

function rawScene(id: string) {
  return {
    id,
    batchCalls: 1,
    raw: {
      aa: { a: clusters(10), b: clusters(10) },
      deliberate2x: { single: clusters(10), doubled: clusters(20) },
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
      kind: 'scenario-null-control-v1',
      harnessRevision: '1'.repeat(40),
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      independentUnit: 'run-block',
      runBlocks: 20,
      samplesPerCluster: 1,
      orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
      batchFloorMs: 20,
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
  it('admits only cells whose N is recomputed from the bound null/control pilot', () => {
    const inv = inventory();
    const calibration = calibrationFor(inv);
    const pilot = pilotFor(inv);
    const design = derivePoweredDesign(pilot, inv, calibration, '2026-09-18T03:03:00.000Z');
    expect(design.cells.every((cell) => cell.chosenIndependentBlocks === 20)).toBe(true);
    expect(design.cells.every((cell) => cell.estimatedPower === 1 && cell.status === 'powered')).toBe(true);
    expect(eligibleDesktopCells(inv, calibration, design, pilot)).toEqual([
      'desktop-chromium',
      'desktop-firefox',
      'desktop-webkit',
    ]);
  });

  it('rejects a self-declared power change even when all hashes remain syntactically valid', () => {
    const inv = inventory();
    const calibration = calibrationFor(inv);
    const pilot = pilotFor(inv);
    const design = derivePoweredDesign(pilot, inv, calibration, '2026-09-18T03:03:00.000Z');
    design.cells[0].estimatedPower = 0.999;
    expect(() => eligibleDesktopCells(inv, calibration, design, pilot)).toThrow(/deterministically derived/);
  });

  it('rejects evidence substitution across every content-addressed edge', () => {
    const inv = inventory();
    const calibration = calibrationFor(inv);
    const pilot = pilotFor(inv);
    const design = derivePoweredDesign(pilot, inv, calibration, '2026-09-18T03:03:00.000Z');
    const changedPilot = structuredClone(pilot);
    changedPilot.cells[0].scenes[0].raw.aa.a[0].samples[0] = 10.1;
    expect(() => eligibleDesktopCells(inv, calibration, design, changedPilot)).toThrow(/pilot|raw evidence/);
  });

  it('fails closed when scenario control evidence is unresolved', () => {
    const inv = inventory();
    const pilot = pilotFor(inv);
    const broken = structuredClone(pilot);
    broken.cells[1].scenes[1].raw.deliberate2x.doubled = clusters(14);
    expect(() => validatePilotReceipt(broken)).toThrow(/raw evidence|positive control unresolved/);
  });
});
