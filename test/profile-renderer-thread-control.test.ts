import { describe, expect, it } from 'vitest';
import {
  RENDERER_THREAD_PREREGISTRATION as DESIGN,
  validateRendererThreadPreregistration,
} from '../bench/profile/renderer-thread-preregistration.mjs';
import {
  RendererThreadFailure,
  acquireRendererThreadControls,
  buildRendererThreadPilotReceipt,
  finalizeRendererThreadPilotReceipt,
  selectExecutionThread,
} from '../bench/profile/renderer-thread-pilot-core.mjs';

function task(pid: number, tid: number, cpuMs: number, starttime = '100') {
  return { pid, tid, starttime, cpuNs: BigInt(Math.round(cpuMs * 1e6)), comm: `t-${tid}`, cmd: `p-${pid}` };
}

function snapshots(selectedMs = 240, runnerUpMs = 20) {
  const before = new Map([
    ['10:10', task(10, 10, 100)],
    ['20:20', task(20, 20, 100)],
    ['20:21', task(20, 21, 100)],
  ]);
  const after = new Map([
    ['10:10', task(10, 10, 900)],
    ['20:20', task(20, 20, 100 + selectedMs)],
    ['20:21', task(20, 21, 100 + runnerUpMs)],
  ]);
  return { before, after };
}

function fakePairMeasure(prefix = 'fixture') {
  let pairOrdinal = 0;
  return async (request: any) => {
    pairOrdinal++;
    const token = `${prefix}-token-${pairOrdinal.toString().padStart(4, '0')}`;
    const thread = {
      pid: 1000 + pairOrdinal,
      tid: 2000 + pairOrdinal,
      starttime: String(3000 + pairOrdinal),
      comm: 'fixture-page-main',
      cmd: 'fixture-content-process',
      sentinelCpuMs: 240,
      sentinelRunnerUpCpuMs: 20,
      sentinelDominanceRatio: 12,
    };
    const observations = request.arms.map((arm: any, position: number) => {
      const control = 80 * arm.workMultiplier;
      const motion = 160 * arm.workMultiplier;
      return {
        key: arm.key,
        motionThreadCpuMs: motion,
        controlThreadCpuMs: control,
        differentialCpuMs: motion - control,
        motionPhysicalExecutions: request.logicalUnits * arm.workMultiplier,
        controlPhysicalExecutions: request.logicalUnits * arm.workMultiplier,
        logicalUnits: request.logicalUnits,
        batchCalls: request.batchCalls,
        warmupLogicalUnits: request.warmupLogicalUnits,
        workMultiplier: arm.workMultiplier,
        subarmOrder: arm.subarmOrder,
        enclosingWallMs: 100,
        processLifecycle: 'fresh-browser-server-bound-page-thread-paired-arms-close',
        isolationToken: token,
        pairOrdinal,
        position,
        browserVersion: 'fixture-browser',
        thread,
        semantic: true,
      };
    });
    return {
      processLifecycle: 'fresh-browser-server-bound-page-thread-paired-arms-close',
      isolationToken: token,
      pairOrdinal,
      browserVersion: 'fixture-browser',
      thread,
      observations,
      pairEnclosingWallMs: 250,
      semantic: true,
    };
  };
}

describe('PROFILE-01 renderer-thread CPU differential family', () => {
  it('freezes a premise-changing page-main scheduler-CPU representation', () => {
    expect(() => validateRendererThreadPreregistration()).not.toThrow();
    expect(DESIGN.predecessor.outcome).toBe('NO-GO');
    expect(DESIGN.measurement.kind).toBe('linux-page-main-thread-schedstat-differential-v1');
    expect(DESIGN.measurement.attributionBoundary).toMatch(/same prebound page execution thread/);
    expect(DESIGN.premiseChange.forbiddenReopen).toMatch(/whole-browser CPU fallback/);
    expect(DESIGN.candidateSamples).toBe(0);
  });

  it('binds the dominant non-root descendant rather than browser-root CPU', () => {
    const { before, after } = snapshots();
    const selected = selectExecutionThread(before, after, 10);
    expect(selected.pid).toBe(20);
    expect(selected.tid).toBe(20);
    expect(selected.sentinelCpuMs).toBe(240);
    expect(selected.sentinelDominanceRatio).toBe(12);
  });

  it('fails closed when the page execution thread is not dominant', () => {
    const { before, after } = snapshots(120, 60);
    expect(() => selectExecutionThread(before, after, 10)).toThrow(RendererThreadFailure);
  });

  it('counterbalances A/A, 2x and motion/control subarms without changing work counts', async () => {
    const measure = fakePairMeasure();
    const raw = await acquireRendererThreadControls(measure, 'collection-reorder-100', { runBlocks: 3, orderSeed: 7 });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.aa.b).toHaveLength(3);
    expect(raw.deliberate2x.single).toHaveLength(3);
    expect(raw.deliberate2x.doubled).toHaveLength(3);
    expect(raw.deliberate2x.doubled.every((entry) => entry.workMultiplier === 2)).toBe(true);
    expect(new Set([...raw.aa.a, ...raw.aa.b].map((entry) => entry.subarmOrder))).toEqual(new Set(['motion-control', 'control-motion']));
  });

  it('rejects a differential below the frozen resolution floor instead of clamping it', async () => {
    const bad = async (request: any) => {
      const base = await fakePairMeasure()(request);
      for (const observation of base.observations) {
        observation.motionThreadCpuMs = 100;
        observation.controlThreadCpuMs = 80;
        observation.differentialCpuMs = 20;
      }
      return base;
    };
    await expect(acquireRendererThreadControls(bad, 'collection-reorder-100', { runBlocks: 2, orderSeed: 7 })).rejects.toBeInstanceOf(RendererThreadFailure);
  });

  it('finalizes only a complete all-engine/all-scene null/control receipt', async () => {
    const cells = [];
    for (const engine of DESIGN.engines) {
      const scenes = [];
      for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
        const id = DESIGN.sceneIds[sceneIndex];
        scenes.push({ id, raw: await acquireRendererThreadControls(fakePairMeasure(`${engine}-${id}`), id, { orderSeed: DESIGN.controls.orderSeed ^ sceneIndex }) });
      }
      cells.push({ id: `desktop-${engine}`, engine, browserVersion: 'fixture-browser', scenes });
    }
    const receipt = buildRendererThreadPilotReceipt({
      inventory: { exact: 'inventory' },
      calibration: { exact: 'calibration' },
      preregRevision: '1'.repeat(40),
      harnessRevision: '2'.repeat(40),
      cells,
      pilotEnclosingWallMs: 1000,
      generatedAt: '2026-09-19T09:00:00.000Z',
    });
    const accepted = finalizeRendererThreadPilotReceipt(receipt);
    expect(accepted.candidateSamples).toBe(0);
    expect(accepted.cells[0].scenes[0].aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(accepted.cells[0].scenes[0].deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });
    expect(accepted.processIsolation.uniquePairTokens).toBe(DESIGN.engines.length * DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 2);
  });
});
