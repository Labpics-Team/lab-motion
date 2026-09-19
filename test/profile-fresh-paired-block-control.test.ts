import { describe, expect, it, vi } from 'vitest';
import {
  FRESH_PAIRED_BLOCK_PREREGISTRATION as DESIGN,
  validateFreshPairedBlockPreregistration,
} from '../bench/profile/fresh-paired-block-preregistration.mjs';
import {
  FreshPairedBlockFailure,
  acquireFreshPairedBlock,
  acquireFreshPairedControls,
  buildFreshPairedPilotReceipt,
  finalizeFreshPairedPilotReceipt,
} from '../bench/profile/fresh-paired-block-pilot-core.mjs';

function pairMeasure(browserVersion = 'fixture') {
  let pairOrdinal = 0;
  return vi.fn(async (request: any) => {
    pairOrdinal++;
    const isolationToken = `${browserVersion}-pair-${pairOrdinal.toString().padStart(6, '0')}`;
    const baseOwnerMs = request.sceneId === 'collection-reorder-100' ? 50 : 51.2;
    return {
      processLifecycle: 'launch-paired-arms-close',
      isolationToken,
      pairOrdinal,
      browserVersion,
      pairEnclosingWallMs: 200,
      semantic: true,
      observations: request.arms.map((arm: any, position: number) => ({
        key: arm.key,
        ownerMs: baseOwnerMs * arm.workMultiplier,
        enclosingWallMs: baseOwnerMs * arm.workMultiplier + 5,
        warmupWallMs: 1,
        logicalUnits: request.logicalUnits,
        physicalExecutions: request.logicalUnits * arm.workMultiplier,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        processLifecycle: 'launch-paired-arms-close',
        isolationToken,
        pairOrdinal,
        position,
        browserVersion,
        semantic: true,
      })),
    };
  });
}

async function fixtureCells() {
  const cells = [];
  for (const engine of DESIGN.engines) {
    const measure = pairMeasure(`fixture-${engine}`);
    const scenes = [];
    for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
      const id = DESIGN.sceneIds[sceneIndex];
      const raw = await acquireFreshPairedControls(measure, id, {
        orderSeed: DESIGN.controls.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b),
      });
      scenes.push({ id, raw });
    }
    cells.push({ id: `desktop-${engine}`, engine, browserVersion: `fixture-${engine}`, scenes });
  }
  return cells;
}

describe('PROFILE-01 fresh paired process-block control family', () => {
  it('freezes a premise-changing paired process boundary without weakening controls', () => {
    expect(() => validateFreshPairedBlockPreregistration()).not.toThrow();
    expect(DESIGN.measurement.independentUnit).toBe('fresh-process-paired-run-block');
    expect(DESIGN.controls.aaBand).toEqual([0.95, 1.05]);
    expect(DESIGN.controls.deliberate2xLower95Min).toBe(1.5);
    expect(DESIGN.candidateSamples).toBe(0);
  });

  it('shares nuisance within a pair but never reuses the pair process across blocks', async () => {
    const measure = pairMeasure();
    const raw = await acquireFreshPairedControls(measure, 'direct-manipulation-sheet', { runBlocks: 3, orderSeed: 7 });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.aa.a.every((entry, index) => entry.isolationToken === raw.aa.b[index].isolationToken)).toBe(true);
    expect(raw.deliberate2x.single.every((entry, index) => entry.isolationToken === raw.deliberate2x.doubled[index].isolationToken)).toBe(true);
    const tokens = [...raw.aa.pairTokens, ...raw.deliberate2x.pairTokens];
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('positive control performs real doubled semantic work inside the same pair process', async () => {
    const measure = pairMeasure();
    const pair = await acquireFreshPairedBlock(measure, 'direct-manipulation-sheet', 0, 'deliberate2x', 'SD');
    expect(pair.observations.single.isolationToken).toBe(pair.observations.doubled.isolationToken);
    expect(pair.observations.doubled.physicalExecutions).toBe(pair.observations.single.physicalExecutions * 2);
    expect(pair.observations.doubled.samples[0]).toBeCloseTo(pair.observations.single.samples[0] * 2, 12);
  });

  it('fails closed when an arm does not clear the frozen owner floor', async () => {
    const measure = pairMeasure();
    measure.mockImplementationOnce(async (request: any) => ({
      processLifecycle: 'launch-paired-arms-close',
      isolationToken: 'fixture-floor-failure',
      pairOrdinal: 1,
      browserVersion: 'fixture',
      pairEnclosingWallMs: 100,
      semantic: true,
      observations: request.arms.map((arm: any, position: number) => ({
        key: arm.key,
        ownerMs: 1,
        enclosingWallMs: 2,
        warmupWallMs: 1,
        logicalUnits: request.logicalUnits,
        physicalExecutions: request.logicalUnits * arm.workMultiplier,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        processLifecycle: 'launch-paired-arms-close',
        isolationToken: 'fixture-floor-failure',
        pairOrdinal: 1,
        position,
        browserVersion: 'fixture',
        semantic: true,
      })),
    }));
    await expect(acquireFreshPairedBlock(measure, 'direct-manipulation-sheet', 0, 'aa', 'AB')).rejects.toBeInstanceOf(FreshPairedBlockFailure);
  });

  it('admits a receipt only when pair identity, null and deliberate controls all resolve', async () => {
    const cells = await fixtureCells();
    const raw = buildFreshPairedPilotReceipt({
      inventory: { exact: 'inventory' },
      calibration: { exact: 'calibration' },
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      cells,
      pilotEnclosingWallMs: 1_000,
      generatedAt: '2026-09-19T06:00:00.000Z',
    });
    const accepted = finalizeFreshPairedPilotReceipt(raw);
    expect(accepted.processIsolation.uniquePairTokens).toBe(3 * 2 * 20 * 2);
    expect(accepted.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(accepted.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });
});
