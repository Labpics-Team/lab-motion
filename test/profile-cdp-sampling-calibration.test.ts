import { describe, expect, it } from 'vitest';
import {
  CDP_SAMPLING_CALIBRATION,
  chooseSceneRepeats,
  evaluateFormalControls,
  resolutionPass,
  summarizeCpuProfile,
  validateCdpSamplingContract,
} from '../bench/profile/calibrate-cdp-sampling.mjs';

const copy = <T>(value: T): T => structuredClone(value);

const resolved = (attributableUs = 50_000) => ({
  totalUs: attributableUs + 5_000,
  attributableUs,
  attributableSamples: 400,
  unattributedUs: 5_000,
  unattributedShare: 5_000 / (attributableUs + 5_000),
  observedUrls: ['http://127.0.0.1/dist/projection/index.js'],
  sink: 1,
});

const clusters = (value: number) => Array.from({ length: 20 }, (_, run) => ({
  run,
  samples: [value],
  semantic: true,
}));

const summaries = (value = 50_000) => Array.from({ length: 20 }, () => resolved(value));

describe('PROFILE-01 CDP sampling calibration contract', () => {
  it('pins the premise-changing representation before acquisition', () => {
    const contract = validateCdpSamplingContract();
    expect(contract.sceneIds).toEqual(['collection-reorder-100', 'direct-manipulation-sheet']);
    expect(contract.samplingIntervalUs).toBe(100);
    expect(contract.resolution).toMatchObject({
      minimumAttributableUs: 40_000,
      minimumAttributableSamples: 200,
      maximumUnattributedShare: 0.5,
      discoveryProbeCount: 2,
      maximumSceneRepeats: 4096,
    });
    expect(contract.controls).toMatchObject({
      independentBlocks: 20,
      aaBand: [0.95, 1.05],
      deliberateMultiplier: 2,
      deliberateLower95Min: 1.5,
    });
    expect(contract.candidateSamples).toBe(0);
  });

  it('fails closed if attribution, resolution or repeat bounds drift', () => {
    const mutations = [
      (contract: any) => { contract.scriptUrlSuffixes['collection-reorder-100'] = ['/dist/index.js']; },
      (contract: any) => { contract.resolution.minimumAttributableUs = 20_000; },
      (contract: any) => { contract.resolution.minimumAttributableSamples = 1; },
      (contract: any) => { contract.resolution.maximumUnattributedShare = 0.9; },
      (contract: any) => { contract.resolution.maximumSceneRepeats = 8192; },
      (contract: any) => { contract.controls.aaBand = [0.9, 1.1]; },
      (contract: any) => { contract.controls.deliberateLower95Min = 1.1; },
      (contract: any) => { contract.candidateSamples = 1; },
    ];
    for (const mutate of mutations) {
      const contract = copy(CDP_SAMPLING_CALIBRATION) as any;
      mutate(contract);
      expect(() => validateCdpSamplingContract(contract)).toThrow(/PROFILE-01 CDP calibration/);
    }
  });

  it('attributes only frozen production script URLs and reports unknown share', () => {
    const profile = {
      samples: [1, 2, 1, 3],
      timeDeltas: [100, 200, 300, 400],
      nodes: [
        { id: 1, callFrame: { url: 'http://127.0.0.1:6180/dist/projection/index.js' } },
        { id: 2, callFrame: { url: 'http://127.0.0.1:6180/site/dist/index.js' } },
        { id: 3, callFrame: { url: '' } },
      ],
    };
    expect(summarizeCpuProfile(profile, ['/dist/projection/index.js'])).toMatchObject({
      totalUs: 1000,
      attributableUs: 400,
      attributableSamples: 2,
      unattributedUs: 600,
      unattributedShare: 0.6,
    });
  });

  it('selects the first power-of-two repeat count only after every frozen probe resolves', async () => {
    const calls: number[] = [];
    const result = await chooseSceneRepeats(async (repeats) => {
      calls.push(repeats);
      return repeats >= 4 ? resolved() : resolved(10_000);
    });
    expect(result.status).toBe('PASS');
    expect(result.selectedRepeats).toBe(4);
    expect(calls).toEqual([1, 1, 2, 2, 4, 4]);
  });

  it('does not call an under-resolved sample admissible', () => {
    expect(resolutionPass(resolved())).toBe(true);
    expect(resolutionPass({ ...resolved(), attributableUs: 39_999 })).toBe(false);
    expect(resolutionPass({ ...resolved(), attributableSamples: 199 })).toBe(false);
    expect(resolutionPass({ ...resolved(), unattributedShare: 0.500001 })).toBe(false);
  });

  it('derives A/A and deliberate-2x verdicts from independent run-block clusters', () => {
    const raw = {
      aa: {
        a: clusters(10),
        b: clusters(10),
        aSummaries: summaries(),
        bSummaries: summaries(),
      },
      deliberate2x: {
        single: clusters(10),
        doubled: clusters(20),
        singleSummaries: summaries(),
        doubledSummaries: summaries(100_000),
      },
    };
    const verdict = evaluateFormalControls(raw);
    expect(verdict.status).toBe('PASS');
    expect(verdict.aa).toEqual({ ratio: 1, lower95: 1, upper95: 1 });
    expect(verdict.deliberate2x).toEqual({ ratio: 2, lower95: 2, upper95: 2 });

    raw.deliberate2x.doubled = clusters(14);
    expect(evaluateFormalControls(raw).status).toBe('FAIL');
  });
});
