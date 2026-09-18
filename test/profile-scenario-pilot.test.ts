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

function rawScene(id: string) {
  return {
    id,
    batchCalls: 2,
    raw: {
      aa: { a: clusters(20), b: clusters(20) },
      deliberate2x: { single: clusters(20), doubled: clusters(40) },
    },
  };
}

describe('PROFILE-01 scenario null/control harness', () => {
  it('calibrates the real repeated workload until the aggregate timing region clears the floor', async () => {
    const measure = vi.fn(async (copies: number) => copies * 6);
    await expect(chooseBatchCalls(measure, { floorMs: 20, maxCalls: 16 })).resolves.toBe(4);
    expect(measure.mock.calls.map(([copies]) => copies)).toEqual([1, 2, 4]);
  });

  it('fails closed when real scene copies cannot resolve above the timing floor', async () => {
    const measure = vi.fn(async () => 0);
    await expect(chooseBatchCalls(measure, { floorMs: 20, maxCalls: 8 })).rejects.toThrow(/does not resolve above 20ms/);
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
