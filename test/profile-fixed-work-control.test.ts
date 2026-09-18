import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_WORK_PREREGISTRATION as DESIGN,
  validateFixedWorkPreregistration,
} from '../bench/profile/fixed-work-preregistration.mjs';
import {
  FixedWorkResolutionFailure,
  acquireFixedWorkControls,
  acquireFixedWorkObservation,
  buildFixedWorkPilotReceipt,
  finalizeFixedWorkPilotReceipt,
} from '../bench/profile/fixed-work-pilot-core.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;

type PacketRequest = { sceneId: string; logicalUnits: number; workMultiplier: 1 | 2 };

function packet(ownerPerLogicalUnit = 0.2) {
  return vi.fn(async ({ logicalUnits, workMultiplier }: PacketRequest) => {
    const ownerMs = ownerPerLogicalUnit * logicalUnits * workMultiplier;
    return {
      ownerMs,
      enclosingWallMs: ownerMs + 5,
      logicalUnits,
      physicalExecutions: logicalUnits * workMultiplier,
      workMultiplier,
      semantic: true,
    };
  });
}

function cluster(sceneId: string, run: number, workMultiplier: 1 | 2, unitCost: number) {
  const logicalUnits = DESIGN.measurement.logicalUnitsByScene[sceneId as keyof typeof DESIGN.measurement.logicalUnitsByScene];
  const ownerMs = unitCost * logicalUnits;
  return {
    run,
    samples: [unitCost],
    ownerMs,
    enclosingWallMs: ownerMs + 5,
    logicalUnits,
    physicalExecutions: logicalUnits * workMultiplier,
    workMultiplier,
    semantic: true,
  };
}

function clusters(sceneId: string, workMultiplier: 1 | 2, unitCost: number) {
  return Array.from({ length: DESIGN.controls.runBlocks }, (_, run) => cluster(sceneId, run, workMultiplier, unitCost));
}

function rawScene(id: string) {
  const baseCost = id === 'collection-reorder-100' ? 100 : 0.1;
  return {
    id,
    raw: {
      aa: { a: clusters(id, 1, baseCost), b: clusters(id, 1, baseCost) },
      deliberate2x: { single: clusters(id, 1, baseCost), doubled: clusters(id, 2, baseCost * 2) },
    },
  };
}

describe('PROFILE-01 fixed-work timing family', () => {
  it('freezes a premise-changing work schedule before fresh pilot data', () => {
    expect(() => validateFixedWorkPreregistration()).not.toThrow();
    expect(DESIGN.id).toBe('fixed-work-phase-owner-v1');
    expect(DESIGN.candidateSamples).toBe(0);
    expect(DESIGN.measurement.logicalUnitsByScene).toEqual({
      'collection-reorder-100': 1,
      'direct-manipulation-sheet': 512,
    });
    expect(DESIGN.measurement.workRule).toMatch(/exactly/);
    expect(DESIGN.measurement.workRule).toMatch(/no timer-driven stop/);
  });

  it('executes one exact fixed packet instead of stopping on elapsed owner time', async () => {
    const measure = packet(0.2);
    const result = await acquireFixedWorkObservation(measure, 'direct-manipulation-sheet', 1);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith({
      sceneId: 'direct-manipulation-sheet',
      logicalUnits: 512,
      workMultiplier: 1,
    });
    expect(result.logicalUnits).toBe(512);
    expect(result.physicalExecutions).toBe(512);
    expect(result.costPerLogicalUnitMs).toBeCloseTo(0.2, 12);
  });

  it('positive control doubles physical semantic work without changing the denominator', async () => {
    const measure = packet(0.2);
    const single = await acquireFixedWorkObservation(measure, 'direct-manipulation-sheet', 1);
    const doubled = await acquireFixedWorkObservation(measure, 'direct-manipulation-sheet', 2);
    expect(single.logicalUnits).toBe(doubled.logicalUnits);
    expect(doubled.physicalExecutions).toBe(single.physicalExecutions * 2);
    expect(doubled.costPerLogicalUnitMs / single.costPerLogicalUnitMs).toBeCloseTo(2, 12);
  });

  it('fails closed when the preregistered work cannot resolve the frozen timing floor', async () => {
    const measure = vi.fn(async ({ logicalUnits, workMultiplier }: PacketRequest) => ({
      ownerMs: 39,
      enclosingWallMs: 45,
      logicalUnits,
      physicalExecutions: logicalUnits * workMultiplier,
      workMultiplier,
      semantic: true,
    }));
    await expect(acquireFixedWorkObservation(measure, 'direct-manipulation-sheet', 1)).rejects.toBeInstanceOf(FixedWorkResolutionFailure);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('rejects fixed-work count mutation instead of silently normalizing it', async () => {
    const measure = vi.fn(async ({ logicalUnits, workMultiplier }: PacketRequest) => ({
      ownerMs: 100,
      enclosingWallMs: 110,
      logicalUnits: logicalUnits - 1,
      physicalExecutions: (logicalUnits - 1) * workMultiplier,
      workMultiplier,
      semantic: true,
    }));
    await expect(acquireFixedWorkObservation(measure, 'direct-manipulation-sheet', 1)).rejects.toThrow(/fixed logical-unit count drifted/);
  });

  it('keeps paired run-block identity while counterbalancing A/A and deliberate-2x', async () => {
    const measure = packet(0.2);
    const raw = await acquireFixedWorkControls(measure, 'direct-manipulation-sheet', { runBlocks: 3, orderSeed: 7 });
    expect(raw.aa.a.map((entry) => entry.run)).toEqual([0, 1, 2]);
    expect(raw.aa.b.map((entry) => entry.run)).toEqual([0, 1, 2]);
    expect(raw.deliberate2x.single).toHaveLength(3);
    expect(raw.deliberate2x.doubled.every((entry) => entry.physicalExecutions === 1024)).toBe(true);
    expect(measure).toHaveBeenCalledTimes(12);
  });

  it('content-addresses only a complete resolving three-engine null/control matrix', () => {
    const raw = buildFixedWorkPilotReceipt({
      inventory: { exact: 'fixture' },
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      generatedAt: '2026-09-19T00:00:00.000Z',
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: DESIGN.sceneIds.map(rawScene),
      })),
    });
    expect(raw.candidateSamples).toBe(0);
    const receipt = finalizeFixedWorkPilotReceipt(raw);
    expect(receipt.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(receipt.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
    expect(receipt.cells[0].scenes[1].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
  });
});
