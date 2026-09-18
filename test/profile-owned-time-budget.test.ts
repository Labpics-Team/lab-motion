import { describe, expect, it, vi } from 'vitest';
import {
  OWNED_TIME_BUDGET_PREREGISTRATION as DESIGN,
  validateOwnedTimeBudgetPreregistration,
} from '../bench/profile/budget-preregistration.mjs';
import {
  OwnedTimeBudgetFailure,
  acquireOwnedTimeControls,
  acquireOwnedTimeObservation,
  buildOwnedTimePilotReceipt,
  finalizeOwnedTimePilotReceipt,
} from '../bench/profile/budget-pilot-core.mjs';
import { BUDGET_HARNESS_KIND } from '../bench/profile/budget-pilot-desktop.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;

function physical(ownerMs = 10, enclosingWallMs = 12) {
  return vi.fn(async () => ({ ownerMs, enclosingWallMs }));
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

describe('PROFILE-01 owned-time budget family', () => {
  it('freezes a timing representation with no discovery-to-holdout selector', () => {
    expect(() => validateOwnedTimeBudgetPreregistration()).not.toThrow();
    expect(BUDGET_HARNESS_KIND).toBe('owned-time-budget-desktop-v1');
    expect(DESIGN.supersedesTimingFamily).toBe('whole-scene-enclosing-wall-v1');
    expect(DESIGN.measurement.targetOwnedMs).toBeGreaterThanOrEqual(5 * 40);
    expect(DESIGN.measurement.timingResolutionRule).toMatch(/no discovery-to-holdout/);
  });

  it('self-resolves each formal observation on the frozen owner-time budget', async () => {
    const measure = physical(10, 12);
    const sample = await acquireOwnedTimeObservation(measure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    expect(sample.ownerMs).toBe(50);
    expect(sample.enclosingWallMs).toBe(60);
    expect(sample.logicalUnits).toBe(5);
    expect(sample.physicalExecutions).toBe(5);
    expect(sample.costPerLogicalUnitMs).toBe(10);
    expect(measure).toHaveBeenCalledTimes(5);
  });

  it('positive control executes real doubled semantic work and preserves per-logical-unit normalization', async () => {
    const singleMeasure = physical(10, 12);
    const single = await acquireOwnedTimeObservation(singleMeasure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    const doubledMeasure = physical(10, 12);
    const doubled = await acquireOwnedTimeObservation(doubledMeasure, 2, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 8,
      maximumEnclosingWallMs: 100,
    });
    expect(single.costPerLogicalUnitMs).toBe(10);
    expect(doubled.costPerLogicalUnitMs).toBe(20);
    expect(doubled.physicalExecutions).toBe(doubled.logicalUnits * 2);
    expect(doubledMeasure).toHaveBeenCalledTimes(6);
  });

  it('fails closed instead of retuning when the frozen logical-unit bound cannot reach the budget', async () => {
    const measure = physical(1, 2);
    await expect(acquireOwnedTimeObservation(measure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 4,
      maximumEnclosingWallMs: 100,
    })).rejects.toBeInstanceOf(OwnedTimeBudgetFailure);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  it('fails closed when wall cost escapes the frozen finite-work bound', async () => {
    const measure = physical(1, 30);
    await expect(acquireOwnedTimeObservation(measure, 1, {
      targetOwnedMs: 50,
      maximumLogicalUnits: 100,
      maximumEnclosingWallMs: 60,
    })).rejects.toThrow(/enclosing wall-time bound/);
  });

  it('counterbalances null and doubled-work controls without changing the fixed run-block count', async () => {
    const measure = physical(250, 255);
    const raw = await acquireOwnedTimeControls(measure, {
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
    expect(measure).toHaveBeenCalledTimes(15);
  });

  it('finalizes a content-addressable null/control receipt only when A/A and factor-2 controls resolve', () => {
    const inventory = { exact: 'fixture' };
    const raw = buildOwnedTimePilotReceipt({
      inventory,
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      generatedAt: '2026-09-18T18:00:00.000Z',
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: DESIGN.sceneIds.map(rawScene),
      })),
    });
    expect(raw.candidateSamples).toBe(0);
    const receipt = finalizeOwnedTimePilotReceipt(raw);
    expect(receipt.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(receipt.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });

  it('rejects a forged sub-budget observation even if its normalized number looks valid', () => {
    const inventory = { exact: 'fixture' };
    const raw = buildOwnedTimePilotReceipt({
      inventory,
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: DESIGN.sceneIds.map(rawScene),
      })),
    });
    raw.cells[0].scenes[0].raw.aa.a[0].ownerMs = 249;
    raw.cells[0].scenes[0].raw.aa.a[0].samples[0] = 249 / 25;
    expect(() => finalizeOwnedTimePilotReceipt(raw)).toThrow(/owner-time target escaped/);
  });
});
