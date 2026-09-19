import { describe, expect, it, vi } from 'vitest';
import { CROSSOVER_PREREGISTRATION as DESIGN, validateCrossoverPreregistration } from '../bench/profile/crossover-preregistration.mjs';
import {
  CrossoverResolutionFailure,
  acquireCrossoverObservation,
  acquireSymmetricCrossoverControls,
  buildCrossoverPilotReceipt,
  finalizeCrossoverPilotReceipt,
} from '../bench/profile/crossover-pilot-core.mjs';
import { deriveCrossoverPoweredDesign } from '../bench/profile/crossover-power-design.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
type Request = { sceneId: string; logicalUnits: number; workMultiplier: 1 | 2 };

function driftingPacket() {
  let call = 0;
  return vi.fn(async ({ logicalUnits, workMultiplier }: Request) => {
    const unitCost = 0.1 * Math.exp(0.001 * call++);
    const ownerMs = unitCost * logicalUnits * workMultiplier;
    return { ownerMs, enclosingWallMs: ownerMs + 1, logicalUnits, physicalExecutions: logicalUnits * workMultiplier, workMultiplier, semantic: true };
  });
}

function positions(pattern: string, arm: string) {
  return [...pattern].map((value, index) => value === arm ? index : -1).filter((index) => index >= 0);
}

function cluster(sceneId: string, run: number, pattern: string, arm: string, workMultiplier: 1 | 2, unitCost: number) {
  const logicalUnits = DESIGN.measurement.logicalUnitsByScene[sceneId as keyof typeof DESIGN.measurement.logicalUnitsByScene];
  const ps = positions(pattern, arm);
  const components = ps.map((position) => {
    const ownerMs = unitCost * logicalUnits * workMultiplier;
    return { position, arm, ownerMs, enclosingWallMs: ownerMs + 1, logicalUnits, physicalExecutions: logicalUnits * workMultiplier, workMultiplier, costPerLogicalUnitMs: unitCost * workMultiplier, semantic: true };
  });
  return { run, samples: [unitCost * workMultiplier], positions: ps, components, ownerMs: components.reduce((sum, entry) => sum + entry.ownerMs, 0), enclosingWallMs: components.reduce((sum, entry) => sum + entry.enclosingWallMs, 0), workMultiplier, semantic: true };
}

function rawScene(id: string) {
  const base = id === 'collection-reorder-100' ? 50 : 0.1;
  const aaPatterns = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'BAAB' : 'ABBA');
  const deliberatePatterns = Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => run % 2 ? 'DSSD' : 'SDDS');
  return {
    id,
    raw: {
      aa: {
        patterns: aaPatterns,
        a: aaPatterns.map((pattern, run) => cluster(id, run, pattern, 'A', 1, base * Math.exp((run % 2 ? 1 : -1) * 0.005))),
        b: aaPatterns.map((pattern, run) => cluster(id, run, pattern, 'B', 1, base * Math.exp((run % 2 ? -1 : 1) * 0.005))),
      },
      deliberate2x: {
        patterns: deliberatePatterns,
        single: deliberatePatterns.map((pattern, run) => cluster(id, run, pattern, 'S', 1, base)),
        doubled: deliberatePatterns.map((pattern, run) => cluster(id, run, pattern, 'D', 2, base)),
      },
    },
  };
}

function pilot() {
  const inventory = { exact: 'fixture' };
  const receipt = buildCrossoverPilotReceipt({
    inventory,
    preregRevision: '1'.repeat(40),
    harnessRevision: '2'.repeat(40),
    generatedAt: '2026-09-19T01:00:00.000Z',
    cells: engines.map((engine) => ({ id: `desktop-${engine}`, engine, browserVersion: 'fixture', scenes: DESIGN.sceneIds.map(rawScene) })),
  });
  return { inventory, receipt };
}

describe('PROFILE-01 symmetric crossover timing family', () => {
  it('freezes a premise-changing symmetric estimator before candidate data', () => {
    expect(() => validateCrossoverPreregistration()).not.toThrow();
    expect(DESIGN.id).toBe('symmetric-crossover-owner-v1');
    expect(DESIGN.candidateSamples).toBe(0);
    expect(DESIGN.crossover.aaPatterns).toEqual(['ABBA', 'BAAB']);
    expect(DESIGN.measurement.logicalUnitsByScene).toEqual({ 'collection-reorder-100': 1, 'direct-manipulation-sheet': 512 });
  });

  it('executes one exact fixed packet and fails closed below the unchanged timing floor', async () => {
    const measure = driftingPacket();
    const result = await acquireCrossoverObservation(measure, 'direct-manipulation-sheet', 1);
    expect(result.logicalUnits).toBe(512);
    const unresolved = vi.fn(async ({ logicalUnits, workMultiplier }: Request) => ({ ownerMs: 39, enclosingWallMs: 40, logicalUnits, physicalExecutions: logicalUnits * workMultiplier, workMultiplier, semantic: true }));
    await expect(acquireCrossoverObservation(unresolved, 'direct-manipulation-sheet', 1)).rejects.toBeInstanceOf(CrossoverResolutionFailure);
  });

  it('cancels first-order log-cost phase drift without inflating independent N', async () => {
    const measure = driftingPacket();
    const raw = await acquireSymmetricCrossoverControls(measure, 'direct-manipulation-sheet', { runBlocks: 3, orderSeed: 7 });
    expect(measure).toHaveBeenCalledTimes(24);
    for (let run = 0; run < 3; run++) {
      expect(raw.aa.a[run].positions.reduce((a, b) => a + b, 0)).toBe(3);
      expect(raw.aa.b[run].positions.reduce((a, b) => a + b, 0)).toBe(3);
      expect(raw.aa.a[run].samples[0] / raw.aa.b[run].samples[0]).toBeCloseTo(1, 12);
      expect(raw.deliberate2x.doubled[run].samples[0] / raw.deliberate2x.single[run].samples[0]).toBeCloseTo(2, 12);
    }
  });

  it('retains both component observations but exposes one sample per independent run-block', () => {
    const { receipt } = pilot();
    const accepted = finalizeCrossoverPilotReceipt(receipt);
    expect(accepted.candidateSamples).toBe(0);
    expect(accepted.cells[0].scenes[0].raw.aa.a[0].components).toHaveLength(2);
    expect(accepted.cells[0].scenes[0].raw.aa.a[0].samples).toHaveLength(1);
    expect(accepted.cells[0].scenes[0].aa.lower95).toBeGreaterThanOrEqual(0.95);
    expect(accepted.cells[0].scenes[0].aa.upper95).toBeLessThanOrEqual(1.05);
    expect(accepted.cells[0].scenes[0].deliberate2x.lower95).toBeGreaterThanOrEqual(1.5);
  });

  it('rejects a crossover whose arm positions no longer balance first-order drift', () => {
    const { receipt } = pilot();
    receipt.cells[0].scenes[0].raw.aa.a[0].positions = [0, 2];
    expect(() => finalizeCrossoverPilotReceipt(receipt)).toThrow(/symmetric positions drifted|first-order drift balance broken/);
  });

  it('derives a content-addressed powered design without observing candidate samples', () => {
    const { inventory, receipt } = pilot();
    const calibration = { profileId: 'r11-profile-20260915-v1', baselineRevision: DESIGN.baselineRevision, status: 'PASS' };
    const design = deriveCrossoverPoweredDesign(receipt, inventory, calibration, '2026-09-19T01:01:00.000Z');
    expect(design.candidateSamples).toBe(0);
    expect(design.cells.every((cell) => cell.status === 'powered')).toBe(true);
    expect(design.cells.every((cell) => cell.chosenIndependentBlocks >= 20 && cell.chosenIndependentBlocks <= 60)).toBe(true);
  }, 15_000);
});
