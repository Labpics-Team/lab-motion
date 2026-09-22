import { describe, expect, it } from 'vitest';
import { chooseScenarioSerialRepeats } from '../bench/profile/acquire-pilot.mjs';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import { finalizePilotReceipt, receiptSha256, validatePilotReceipt } from '../bench/profile/power-design.mjs';

function tinyContract() {
  return {
    ...PROFILE_PREREGISTRATION.scenarioSelector,
    selectionFloorMs: 40,
    maximumSerialRepeats: 8,
    discoveryProbeCount: 2,
    holdoutProbeCount: 3,
  };
}

describe('PROFILE-01: выбор масштаба pilot acquisition', () => {
  it('выбирает первый разрешающий размер и сохраняет все отвергнутые предыдущие размеры', async () => {
    const calls: number[] = [];
    const selected = await chooseScenarioSerialRepeats(async (repeats) => {
      calls.push(repeats);
      return repeats * 12;
    }, tinyContract());
    expect(selected.serialRepeats).toBe(4);
    expect(selected.discoveryHistory.map(({ serialRepeats }) => serialRepeats)).toEqual([1, 2, 4]);
    expect(selected.discoveryHistory[0].samples).toEqual([12, 12]);
    expect(selected.discoveryHistory[1].samples).toEqual([24, 24]);
    expect(selected.discovery).toEqual([48, 48]);
    expect(selected.holdout).toEqual([48, 48, 48]);
    expect(calls).toEqual([1, 1, 2, 2, 4, 4, 4, 4, 4]);
  });

  it('fail-closed останавливается при провале свежего holdout и не увеличивает число повторов', async () => {
    let atFour = 0;
    const attempted: number[] = [];
    await expect(chooseScenarioSerialRepeats(async (repeats) => {
      attempted.push(repeats);
      if (repeats < 4) return repeats * 10;
      atFour++;
      return atFour <= 2 ? 50 : 39;
    }, tinyContract())).rejects.toThrow(/holdout failed at selected serialRepeats=4/);
    expect(attempted.includes(8)).toBe(false);
  });

  it('отвергает подложный selector, скрывающий более раннее допустимое число повторов', () => {
    const profile = structuredClone(PROFILE_PREREGISTRATION);
    profile.scenarioSelector.discoveryProbeCount = 2;
    profile.scenarioSelector.holdoutProbeCount = 3;
    profile.scenarioSelector.holdoutCoverage = 0.5;
    profile.scenarioSelector.holdoutConfidence = 0.8;
    // Здесь проверяется именно валидатор pilot receipt, а не preregistration.
    const selector = {
      kind: profile.scenarioSelector.kind,
      unitBatchCalls: profile.scenarioSelector.unitBatchCalls,
      serialRepeats: 4,
      formalFloorMs: profile.scenarioSelector.formalFloorMs,
      selectionFloorMs: profile.scenarioSelector.selectionFloorMs,
      maximumSerialRepeats: profile.scenarioSelector.maximumSerialRepeats,
      discoveryProbeCount: 2,
      holdoutProbeCount: 3,
      holdoutCoverage: 0.5,
      holdoutConfidence: 0.8,
      aggregationRule: profile.scenarioSelector.aggregationRule,
      positiveControlRule: profile.scenarioSelector.positiveControlRule,
      discoveryHistory: [
        { serialRepeats: 1, samples: [20, 20] },
        { serialRepeats: 2, samples: [45, 45] },
        { serialRepeats: 4, samples: [50, 50] },
      ],
      discovery: [50, 50],
      holdout: [50, 50, 50],
    };
    const clusters = (value: number) => Array.from({ length: 20 }, (_, run) => ({ run, samples: [value], semantic: true }));
    const scene = (id: string) => ({
      id,
      sceneContractSha256: receiptSha256(profile.scenes.find((candidate) => candidate.id === id)!),
      unitBatchCalls: profile.scenarioSelector.unitBatchCalls,
      serialRepeats: 4,
      selector,
      raw: {
        aa: { a: clusters(40), b: clusters(40.1) },
        deliberate2x: { single: clusters(40), doubled: clusters(80) },
      },
    });
    const pilot = {
      schemaVersion: 1,
      profileId: profile.profileId,
      baselineRevision: profile.baseline.revision,
      pilotId: 'forged-minimality',
      generatedAt: '2026-09-21T00:00:00.000Z',
      candidateSamples: 0,
      inventoryArtifactSha256: '0'.repeat(64),
      methodologyBlob: profile.baseline.methodologyBlob,
      harness: {
        kind: 'scenario-null-control-v3',
        harnessRevision: '1'.repeat(40),
        baselineRevision: profile.baseline.revision,
        independentUnit: profile.statistics.independentUnit,
        runBlocks: 20,
        samplesPerCluster: 1,
        orderSeed: profile.statistics.orderSeed,
        aggregateFloorMs: profile.scenarioSelector.formalFloorMs,
        selectorKind: profile.scenarioSelector.kind,
      },
      cells: ['chromium', 'firefox', 'webkit'].map((engine) => ({
        id: `desktop-${engine}`,
        engine,
        browserVersion: 'fixture',
        scenes: [scene('collection-reorder-100'), scene('direct-manipulation-sheet')],
      })),
    };
    // finalize заполняет интервалы, но скрытый допустимый predecessor всё равно обязан дать отказ.
    expect(() => finalizePilotReceipt(pilot, profile)).toThrow(/skipped an earlier admissible serial repeat count/);
    expect(() => validatePilotReceipt(pilot, profile)).toThrow();
  });
});
