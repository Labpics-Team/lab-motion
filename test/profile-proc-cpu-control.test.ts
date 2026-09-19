import { describe, expect, it, vi } from 'vitest';
import {
  PROC_CPU_PREREGISTRATION as DESIGN,
  validateProcCpuPreregistration,
} from '../bench/profile/proc-cpu-preregistration.mjs';
import {
  ProcCpuFailure,
  acquireProcCpuBlock,
  acquireProcCpuControls,
  buildProcCpuPilotReceipt,
  finalizeProcCpuPilotReceipt,
} from '../bench/profile/proc-cpu-pilot-core.mjs';

function pairMeasure(browserVersion = 'fixture') {
  let pairOrdinal = 0;
  return vi.fn(async (request: any) => {
    pairOrdinal++;
    const isolationToken = `${browserVersion}-pair-${pairOrdinal.toString().padStart(6, '0')}`;
    const baseCpuMs = request.sceneId === 'collection-reorder-100' ? 50 : 51.2;
    return {
      processLifecycle: 'launch-server-paired-arms-close',
      isolationToken,
      pairOrdinal,
      browserVersion,
      cgroupId: `lab-motion-profile-fixture-${browserVersion}-${pairOrdinal}`,
      pairEnclosingWallMs: 200,
      semantic: true,
      observations: request.arms.map((arm: any, position: number) => ({
        key: arm.key,
        browserCgroupCpuMs: baseCpuMs * arm.workMultiplier,
        browserCgroupCpuUs: String(Math.round(baseCpuMs * arm.workMultiplier * 1e3)),
        cgroupId: `lab-motion-profile-fixture-${browserVersion}-${pairOrdinal}`,
        rootPid: 1000 + pairOrdinal,
        cgroupMembersAtLaunch: [1000 + pairOrdinal],
        cgroupMembersBefore: [1000 + pairOrdinal],
        cgroupMembersAfter: [1000 + pairOrdinal],
        enclosingWallMs: baseCpuMs * arm.workMultiplier + 5,
        warmupWallMs: 1,
        logicalUnits: request.logicalUnits,
        physicalExecutions: request.logicalUnits * arm.workMultiplier,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        processLifecycle: 'launch-server-paired-arms-close',
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
      const raw = await acquireProcCpuControls(measure, id, {
        orderSeed: DESIGN.controls.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b),
      });
      scenes.push({ id, raw });
    }
    cells.push({ id: `desktop-${engine}`, engine, browserVersion: `fixture-${engine}`, scenes });
  }
  return cells;
}

describe('PROFILE-01 Linux browser-cgroup CPU control family', () => {
  it('freezes the kernel CPU representation without weakening controls', () => {
    expect(() => validateProcCpuPreregistration()).not.toThrow();
    expect(DESIGN.measurement.kind).toBe('linux-cgroup-v2-browser-cpu-usage-us-v3');
    expect(DESIGN.measurement.independentUnit).toBe('fresh-process-paired-run-block');
    expect(DESIGN.measurement.processRule).toMatch(/before exec/);
    expect(DESIGN.measurement.treeRule).toMatch(/birth and exit/);
    expect(DESIGN.measurement.attributionBoundary).toMatch(/no performance\.now owner timing contributes/);
    expect(DESIGN.controls.aaBand).toEqual([0.95, 1.05]);
    expect(DESIGN.controls.deliberate2xLower95Min).toBe(1.5);
    expect(DESIGN.candidateSamples).toBe(0);
  });

  it('shares nuisance within a pair but never reuses the pair process across blocks', async () => {
    const measure = pairMeasure();
    const raw = await acquireProcCpuControls(measure, 'direct-manipulation-sheet', { runBlocks: 3, orderSeed: 7 });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.aa.a.every((entry, index) => entry.isolationToken === raw.aa.b[index].isolationToken)).toBe(true);
    expect(raw.deliberate2x.single.every((entry, index) => entry.isolationToken === raw.deliberate2x.doubled[index].isolationToken)).toBe(true);
    const tokens = [...raw.aa.pairTokens, ...raw.deliberate2x.pairTokens];
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('positive control performs real doubled semantic work inside the same pair process', async () => {
    const measure = pairMeasure();
    const pair = await acquireProcCpuBlock(measure, 'direct-manipulation-sheet', 0, 'deliberate2x', 'SD');
    expect(pair.observations.single.isolationToken).toBe(pair.observations.doubled.isolationToken);
    expect(pair.observations.doubled.physicalExecutions).toBe(pair.observations.single.physicalExecutions * 2);
    expect(pair.observations.doubled.samples[0]).toBeCloseTo(pair.observations.single.samples[0] * 2, 12);
  });

  it('rejects a forged cgroup ms/us total', async () => {
    const measure = pairMeasure();
    measure.mockImplementationOnce(async (request: any) => ({
      processLifecycle: 'launch-server-paired-arms-close',
      isolationToken: 'fixture-sum-mismatch',
      pairOrdinal: 1,
      browserVersion: 'fixture',
      cgroupId: 'lab-motion-profile-fixture-mismatch',
      pairEnclosingWallMs: 100,
      semantic: true,
      observations: request.arms.map((arm: any, position: number) => ({
        key: arm.key,
        browserCgroupCpuMs: 50,
        browserCgroupCpuUs: '49000',
        cgroupId: 'lab-motion-profile-fixture-mismatch',
        rootPid: 111,
        cgroupMembersAtLaunch: [111],
        cgroupMembersBefore: [111],
        cgroupMembersAfter: [111],
        enclosingWallMs: 55,
        warmupWallMs: 1,
        logicalUnits: request.logicalUnits,
        physicalExecutions: request.logicalUnits * arm.workMultiplier,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        processLifecycle: 'launch-server-paired-arms-close',
        isolationToken: 'fixture-sum-mismatch',
        pairOrdinal: 1,
        position,
        browserVersion: 'fixture',
        semantic: true,
      })),
    }));
    await expect(acquireProcCpuBlock(measure, 'direct-manipulation-sheet', 0, 'aa', 'AB'))
      .rejects.toThrow(/CPU ms\/us mismatch/);
  });

  it('fails closed when an arm does not clear the frozen cgroup-CPU floor', async () => {
    const measure = pairMeasure();
    measure.mockImplementationOnce(async (request: any) => ({
      processLifecycle: 'launch-server-paired-arms-close',
      isolationToken: 'fixture-floor-failure',
      pairOrdinal: 1,
      browserVersion: 'fixture',
      cgroupId: 'lab-motion-profile-fixture-floor',
      pairEnclosingWallMs: 100,
      semantic: true,
      observations: request.arms.map((arm: any, position: number) => ({
        key: arm.key,
        browserCgroupCpuMs: 1,
        browserCgroupCpuUs: '1000',
        cgroupId: 'lab-motion-profile-fixture-floor',
        rootPid: 111,
        cgroupMembersAtLaunch: [111],
        cgroupMembersBefore: [111],
        cgroupMembersAfter: [111],
        enclosingWallMs: 2,
        warmupWallMs: 1,
        logicalUnits: request.logicalUnits,
        physicalExecutions: request.logicalUnits * arm.workMultiplier,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        processLifecycle: 'launch-server-paired-arms-close',
        isolationToken: 'fixture-floor-failure',
        pairOrdinal: 1,
        position,
        browserVersion: 'fixture',
        semantic: true,
      })),
    }));
    await expect(acquireProcCpuBlock(measure, 'direct-manipulation-sheet', 0, 'aa', 'AB')).rejects.toBeInstanceOf(ProcCpuFailure);
  });

  it('admits a receipt only when pair identity, null and deliberate controls all resolve', async () => {
    const cells = await fixtureCells();
    const raw = buildProcCpuPilotReceipt({
      inventory: { exact: 'inventory' },
      calibration: { exact: 'calibration' },
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      cells,
      pilotEnclosingWallMs: 1_000,
      generatedAt: '2026-09-19T06:00:00.000Z',
    });
    const accepted = finalizeProcCpuPilotReceipt(raw);
    expect(accepted.processIsolation.uniquePairTokens).toBe(3 * 2 * 20 * 2);
    expect(accepted.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(accepted.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
  });
});
