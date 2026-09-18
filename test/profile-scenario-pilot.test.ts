import { describe, expect, it, vi } from 'vitest';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import { finalizePilotReceipt, validatePilotReceipt } from '../bench/profile/power-design.mjs';
import {
  acquireSceneControls,
  buildPilotReceipt,
  chooseBatchCalls,
} from '../bench/profile/pilot-desktop.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;
const hash = '0'.repeat(64);

function inventory() {
  return {
    schemaVersion: 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    generatedAt: '2026-09-18T06:00:00.000Z',
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

function clusters(value: number) {
  return Array.from({ length: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks }, (_, run) => ({
    run,
    samples: [value],
    semantic: true,
  }));
}


function selector(batchCalls = 2) {
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
    batchCalls: 2,
    selector: selector(2),
    raw: {
      aa: { a: clusters(20), b: clusters(20) },
      deliberate2x: { single: clusters(20), doubled: clusters(40) },
    },
  };
}

describe('PROFILE-01 scenario null/control harness', () => {
  it('selects a real repeated workload with independent discovery and holdout evidence', async () => {
    const measure = vi.fn(async (copies: number) => copies * 12);
    const selected = await chooseBatchCalls(measure, {
      formalFloorMs: 20,
      selectionFloorMs: 40,
      maxCalls: 16,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
    });
    expect(selected.batchCalls).toBe(4);
    expect(selected.selector.discovery).toEqual([48, 48]);
    expect(selected.selector.holdout).toEqual([48, 48, 48]);
    expect(measure.mock.calls.map(([copies]) => copies)).toEqual([1, 1, 2, 2, 4, 4, 4, 4, 4]);
  });

  it('fails closed when discovery cannot resolve above the selection floor', async () => {
    const measure = vi.fn(async () => 0);
    await expect(chooseBatchCalls(measure, {
      formalFloorMs: 20,
      selectionFloorMs: 40,
      maxCalls: 8,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
    })).rejects.toThrow(/discovery does not resolve above 40ms/);
  });

  it('does not escalate the batch after a holdout falsifier', async () => {
    const observedCopies: number[] = [];
    let callsAtFour = 0;
    const measure = vi.fn(async (copies: number) => {
      observedCopies.push(copies);
      if (copies < 4) return copies * 10;
      callsAtFour++;
      return callsAtFour === 5 ? 39 : 48;
    });
    await expect(chooseBatchCalls(measure, {
      formalFloorMs: 20,
      selectionFloorMs: 40,
      maxCalls: 16,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
    })).rejects.toThrow(/same-pilot batch escalation is forbidden/);
    expect(observedCopies).not.toContain(8);
  });

  it('rejects the xorshift zero state instead of silently losing pair-order randomization', async () => {
    const measure = vi.fn(async (copies: number) => copies * 20);
    await expect(acquireSceneControls(measure, 1, { runBlocks: 3, floorMs: 20, orderSeed: 0 })).rejects.toThrow(/orderSeed must be a non-zero 32-bit value/);
  });

  it('executes actual doubled workload for the positive control instead of scaling a returned number', async () => {
    const calls: number[] = [];
    const measure = vi.fn(async (copies: number) => {
      calls.push(copies);
      return copies * 10;
    });
    const raw = await acquireSceneControls(measure, 2, { runBlocks: 3, floorMs: 20, orderSeed: 7 });
    expect(raw.aa.a).toHaveLength(3);
    expect(raw.deliberate2x.doubled).toHaveLength(3);
    expect(calls.filter((copies) => copies === 4)).toHaveLength(3);
    expect(calls).not.toContain(1);
  });

  it('rejects a forged selector holdout even when formal samples are above their floor', () => {
    const inv = inventory();
    const rawReceipt = buildPilotReceipt({
      inventory: inv,
      harnessRevision: '1'.repeat(40),
      generatedAt: '2026-09-18T06:01:00.000Z',
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: [rawScene('collection-reorder-100'), rawScene('direct-manipulation-sheet')],
      })),
    });
    rawReceipt.cells[0].scenes[0].selector.holdout[0] = 39;
    expect(() => finalizePilotReceipt(rawReceipt)).toThrow(/selector holdout escaped 40ms/);
  });

  it('emits the canonical content-addressable pilot shape accepted by the independent validator', () => {
    const inv = inventory();
    const rawReceipt = buildPilotReceipt({
      inventory: inv,
      harnessRevision: '1'.repeat(40),
      generatedAt: '2026-09-18T06:01:00.000Z',
      cells: engines.map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: [rawScene('collection-reorder-100'), rawScene('direct-manipulation-sheet')],
      })),
    });
    expect(rawReceipt.candidateSamples).toBe(0);
    expect(rawReceipt.cells[0].scenes.map(({ id }) => id)).toEqual(PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds);
    const receipt = finalizePilotReceipt(rawReceipt);
    expect(() => validatePilotReceipt(receipt)).not.toThrow();
  });
});
