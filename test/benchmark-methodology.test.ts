import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  startClock,
  TIMER_ORIGIN_MS,
  timerEvidence,
} from './benchmark-clock-fixture.js';
import {
  assertBalancedRunBlocks,
  assertFreezeMatrix,
  assertStartSemanticEvidence,
  assertWarmStartMeasurement,
  applyHolmCorrection,
  createFreezeEvidence,
  deriveCdpStartClock,
  deriveFirstPresentedElapsedMs,
  deriveFirstPresentedUncertaintyMs,
  deriveRealmClockUncertainty,
  deriveRealmTimerStep,
  deriveWarmStartCalibration,
  deriveTimerStep,
  evaluateStartSemanticEvidence,
  evaluatePerformanceClaim,
  evaluateSizeClaim,
  makeRoundRobinOrders,
  movementStats,
  pairedClusterBootstrap,
  parseBenchCount,
  PRODUCTION_ADAPTER_PROFILE,
  START_SCENARIO_MANIFEST,
  scoreAgainstBaseline,
  summarizeSamples,
  WARM_TIMER_CALIBRATION_POLICY,
} from '../bench/compare/methodology.mjs';

describe('benchmark methodology fail-closed contracts', () => {
  it('rejects publish warm measurements below the calibrated timer floor', () => {
    expect(() => assertWarmStartMeasurement(
      'lab.s1 run 1',
      [0.399 / 40],
      [0.399],
      40,
      timerEvidence(),
      TIMER_ORIGIN_MS,
    )).toThrow(/lab\.s1.*ниже.*0\.4/i);

    expect(() => assertWarmStartMeasurement(
      'lab.s1 run 1',
      [0.01],
      [0.399],
      40,
      timerEvidence(),
      TIMER_ORIGIN_MS,
    )).toThrow(/не пересчитывается|batch/i);
  });

  it('uses one production-minified adapter profile for every runtime participant', () => {
    expect(PRODUCTION_ADAPTER_PROFILE).toMatchObject({
      bundle: true,
      minify: true,
      platform: 'browser',
      target: 'es2022',
      legalComments: 'none',
    });
    expect(Object.isFrozen(PRODUCTION_ADAPTER_PROFILE)).toBe(true);
  });

  it('accepts only bounded positive integer BENCH counts', () => {
    expect(parseBenchCount('BENCH_RUNS', undefined, 20, { min: 20, max: 60 })).toBe(20);
    expect(parseBenchCount('BENCH_RUNS', '40', 20, { min: 20, max: 60 })).toBe(40);
    for (const raw of ['garbage', 'Infinity', '1.5', '0', '19', '61', '-3']) {
      expect(
        () => parseBenchCount('BENCH_RUNS', raw, 20, { min: 20, max: 60 }),
        raw,
      ).toThrow(/BENCH_RUNS/);
    }
  });

  it('builds a deterministic balanced round-robin instead of a fixed library order', () => {
    const ids = ['lab', 'motion', 'gsap', 'anime'];
    const orders = makeRoundRobinOrders(ids, 8, 0x51f15e);
    expect(orders).toEqual(makeRoundRobinOrders(ids, 8, 0x51f15e));
    expect(orders).not.toEqual(Array.from({ length: 8 }, () => ids));
    for (const order of orders) expect([...order].sort()).toEqual([...ids].sort());
    for (let position = 0; position < ids.length; position++) {
      const counts = new Map(ids.map((id) => [id, 0]));
      for (const order of orders) counts.set(order[position]!, counts.get(order[position]!)! + 1);
      expect(new Set(counts.values())).toEqual(new Set([2]));
    }
  });

  it('re-seeds complete position-balanced blocks and rejects an incomplete publish block', () => {
    const ids = Array.from({ length: 9 }, (_, index) => `lib-${index}`);
    const orders = makeRoundRobinOrders(ids, 18, 0x51f15e);
    expect(orders).toEqual(makeRoundRobinOrders(ids, 18, 0x51f15e));
    expect(orders.slice(9)).not.toEqual(orders.slice(0, 9));
    for (let block = 0; block < 2; block++) {
      const blockOrders = orders.slice(block * ids.length, (block + 1) * ids.length);
      for (let position = 0; position < ids.length; position++) {
        expect(new Set(blockOrders.map((order) => order[position]))).toEqual(new Set(ids));
      }
    }
    expect(() => assertBalancedRunBlocks('BENCH_FREEZE_RUNS', orders, ids)).not.toThrow();
    expect(() => assertBalancedRunBlocks('BENCH_FREEZE_RUNS', 8, ids.length)).toThrow(/BENCH_FREEZE_RUNS/);
    expect(() => assertBalancedRunBlocks('BENCH_FREEZE_RUNS', 10, ids.length)).toThrow(/BENCH_FREEZE_RUNS/);

    const duplicate = structuredClone(orders);
    duplicate[1] = [...duplicate[0]];
    expect(() => assertBalancedRunBlocks('BENCH_RUNS', duplicate, ids)).toThrow(/BENCH_RUNS/);

    const missing = structuredClone(orders);
    missing[0][0] = missing[0][1];
    expect(() => assertBalancedRunBlocks('BENCH_RUNS', missing, ids)).toThrow(/run 1/i);
  });

  it('uses fail-closed nearest-rank quantiles shared with report verification', () => {
    expect(summarizeSamples([4, 1, 3, 2])).toEqual({ samples: 4, p50: 2.5, p95: 4, p99: 4 });
    expect(summarizeSamples([1, Number.NaN, 3])).toEqual({ samples: 2, p50: 2, p95: 3, p99: 3 });
    expect(summarizeSamples([1, Number.NaN, 3], { strict: true })).toBeNull();
  });

  it('derives the absolute floor from recorded performance.now deltas', () => {
    const deltas = Array.from({ length: 16 }, () => 0.1);
    expect(deriveTimerStep(deltas)).toBe(0.1);
    expect(() => deriveTimerStep(deltas.slice(1))).toThrow(/16/);
    const sparse = Array<number>(16);
    for (let index = 0; index < 12; index++) sparse[index] = 0.1;
    expect(() => deriveTimerStep(sparse)).toThrow(/положительных|плотн|dense/i);
    expect(() => deriveTimerStep([...deltas.slice(0, 15), 0])).toThrow(/положительных/);
    expect(() => deriveTimerStep(Array.from({ length: 16 }, () => Number.MAX_VALUE)))
      .toThrow(/конечной|finite|арифмет/i);
    expect(deriveTimerStep([1e-12, ...Array.from({ length: 15 }, () => 0.1)]))
      .toBe(0.1);
    expect(deriveTimerStep([
      ...Array.from({ length: 8 }, () => 0.099),
      ...Array.from({ length: 8 }, () => 0.101),
    ])).toBe(0.101);
    expect(() => deriveTimerStep([
      ...Array.from({ length: 8 }, () => 0.1),
      ...Array.from({ length: 8 }, () => 0.3),
    ])).toThrow(/концентрац/i);
    expect(() => deriveTimerStep([
      ...Array.from({ length: 48 }, () => 0.005),
      ...Array.from({ length: 16 }, () => 0.006),
    ])).toThrow(/multi-tick|гармоник/i);
    const outwardRounded = deriveTimerStep([
      ...Array.from({ length: 15 }, () => 0.1),
      0.20000000000000004,
    ]);
    expect(outwardRounded).toBeGreaterThan(0.20000000000000004 / 2);
    expect(() => deriveTimerStep([
      ...Array.from({ length: 15 }, () => 0.1),
      0.200000000000001,
    ])).toThrow(/multi-tick|гармоник/i);
    expect(() => deriveTimerStep([
      ...Array.from({ length: 15 }, () => 0.1),
      Number.MAX_VALUE,
    ])).toThrow(/multi-tick|гармоник/i);
    expect(() => deriveTimerStep([
      ...Array.from({ length: 16 }, () => 8e307),
      Number.MAX_VALUE,
    ])).toThrow(/multi-tick|гармоник/i);
  });

  it('binds conservative before/after timer evidence to one realm', () => {
    const changedGrid = timerEvidence(0.1);
    changedGrid.probes[1].performanceNowDeltasMs.fill(0.2);
    expect(deriveRealmTimerStep('publish', changedGrid)).toBe(0.2);
    expect(deriveRealmClockUncertainty('publish', changedGrid)).toBe(0.2);

    const delayedRead = timerEvidence(0.1);
    delayedRead.probes[0].performanceNowDeltasMs[0] = 0.2;
    expect(deriveRealmTimerStep('publish', delayedRead)).toBe(0.1);
    expect(deriveRealmClockUncertainty('publish', delayedRead)).toBe(0.2);
    const otherRealm = timerEvidence();
    otherRealm.probes[1].timeOriginMs += 1;
    expect(() => deriveRealmClockUncertainty('publish', otherRealm)).toThrow(/разным realm/i);
    const unstable = timerEvidence();
    unstable.probes[0].performanceNowDeltasMs = [
      ...Array.from({ length: 8 }, () => 0.1),
      ...Array.from({ length: 8 }, () => 0.3),
    ];
    expect(() => deriveRealmClockUncertainty('publish', unstable)).toThrow(/концентрац/i);
    expect(() => deriveRealmClockUncertainty('publish', {
      ...timerEvidence(),
      probes: timerEvidence().probes.slice(0, 1),
    })).toThrow(/before\/after/i);
  });

  it('does not misclassify a delayed probe iteration as timer resolution', () => {
    const delayedProbe = timerEvidence(0.005);
    delayedProbe.probes[0].performanceNowDeltasMs[0] = 0.04;

    expect(deriveRealmTimerStep('publish', delayedProbe)).toBe(0.005);
    expect(deriveRealmClockUncertainty('publish', delayedProbe)).toBe(0.04);
    expect(() => assertWarmStartMeasurement(
      'gsap.s1 run 6',
      [0.14 / 80],
      [0.14],
      80,
      delayedProbe,
      TIMER_ORIGIN_MS,
    )).not.toThrow();
  });

  it('derives first presented movement only from screencast frame timestamps', () => {
    const clock = startClock();
    const startedAtSeconds = clock.cdpRuntimeTimestampMs / 1000;
    const evidence = {
      startedAtSeconds,
      timerEvidence: timerEvidence(),
      startClock: clock,
      movementThresholdPx: 0.5,
      rawFrames: 4,
      frames: [
        { timestampSeconds: startedAtSeconds - 0.01, x: 0 },
        { timestampSeconds: startedAtSeconds + 0.01, x: 0 },
        { timestampSeconds: startedAtSeconds + 0.02, x: 1 },
        { timestampSeconds: startedAtSeconds + 0.03, x: 2 },
      ],
    };
    expect(deriveFirstPresentedElapsedMs(evidence, 0.5)).toBeCloseTo(20, 3);
    expect(deriveFirstPresentedUncertaintyMs(evidence, 0.5)).toBeGreaterThan(0.1);
    expect(deriveCdpStartClock(
      'first presented',
      evidence.startClock,
      evidence.timerEvidence,
    ).markerToApiUpperMs).toBeGreaterThan(0.1);
    expect(deriveFirstPresentedElapsedMs({
      ...evidence,
      frames: evidence.frames.map((frame) => ({ ...frame, x: 0 })),
    }, 0.5)).toBeNull();
    expect(() => deriveFirstPresentedElapsedMs({
      ...evidence,
      frames: evidence.frames.slice(1),
    }, 0.5)).toThrow(/baseline|старт/i);
    expect(() => deriveFirstPresentedElapsedMs({
      ...evidence,
      movementThresholdPx: 0.1,
    }, 0.5)).toThrow(/threshold|порог/i);
    expect(() => deriveFirstPresentedElapsedMs({
      ...evidence,
      frames: [evidence.frames[0], evidence.frames[2], evidence.frames[1]],
    }, 0.5)).toThrow(/поряд|timestamp/i);
    expect(() => deriveFirstPresentedElapsedMs({
      ...evidence,
      startClock: { ...evidence.startClock, cdpToken: 'other' },
    }, 0.5)).toThrow(/start clock|token|cdp/i);
    expect(() => deriveFirstPresentedElapsedMs({
      ...evidence,
      startClock: {
        ...evidence.startClock,
        cdpRuntimeTimestampMs: evidence.startClock.cdpRuntimeTimestampMs + 100,
      },
    }, 0.5)).toThrow(/page epoch|runtime marker/i);
  });

  it('derives one minimal warm call count per scenario from every participant', () => {
    const participants = ['lab', 'motion', 'gsap', 'anime'];
    const measurements = (value: number, samples: number) => Object.fromEntries(
      participants.map((id) => [
        id,
        Array.from({ length: WARM_TIMER_CALIBRATION_POLICY.pilotClusters }, () => (
          {
            batchElapsedMs: Array.from({ length: samples }, () => value),
            timerEvidence: timerEvidence(),
            measurementTimeOriginMs: TIMER_ORIGIN_MS,
          }
        )),
      ]),
    );
    const thresholdMs = 0.1 * WARM_TIMER_CALIBRATION_POLICY.minimumElapsedQuanta;
    const pilots = Object.fromEntries(Object.entries(START_SCENARIO_MANIFEST).map(([id, config]) => [
      id,
      id === 's1'
        ? [
          {
            calls: config.warmCalls,
            measurements: {
              ...measurements(thresholdMs + 1, config.warmSamples),
              gsap: measurements(0, config.warmSamples).gsap,
            },
          },
          {
            calls: config.warmCalls * 2,
            measurements: measurements(thresholdMs, config.warmSamples),
          },
        ]
        : [{
          calls: config.warmCalls,
          measurements: measurements(thresholdMs, config.warmSamples),
        }],
    ]));

    const calibrated = deriveWarmStartCalibration(pilots, participants);
    expect(calibrated.effectiveWarmCalls).toEqual({ s1: 80, s2: 5, s3: 3, s4: 1 });
    expect(calibrated.scenarioManifest.s1.warmCalls).toBe(80);
    expect(calibrated.scenarioManifest.s2).toEqual(START_SCENARIO_MANIFEST.s2);
    expect(WARM_TIMER_CALIBRATION_POLICY.intervalObservedBoundsPerParticipant).toBe(1);
  });

  it('rejects forged warm calibration paths, per-library drift and cap overflow', () => {
    const participants = ['lab', 'motion', 'gsap', 'anime'];
    const thresholdMs = 0.1 * WARM_TIMER_CALIBRATION_POLICY.minimumElapsedQuanta;
    const measurements = (value: number, samples: number) => Object.fromEntries(
      participants.map((id) => [
        id,
        Array.from({ length: WARM_TIMER_CALIBRATION_POLICY.pilotClusters }, () => (
          {
            batchElapsedMs: Array.from({ length: samples }, () => value),
            timerEvidence: timerEvidence(),
            measurementTimeOriginMs: TIMER_ORIGIN_MS,
          }
        )),
      ]),
    );
    const valid = Object.fromEntries(Object.entries(START_SCENARIO_MANIFEST).map(([id, config]) => [
      id,
      [{ calls: config.warmCalls, measurements: measurements(thresholdMs, config.warmSamples) }],
    ]));

    const skippedDoubling = structuredClone(valid);
    const s1Measurements = measurements(thresholdMs, START_SCENARIO_MANIFEST.s1.warmSamples);
    skippedDoubling.s1 = [
      {
        calls: 40,
        measurements: {
          ...s1Measurements,
          gsap: s1Measurements.gsap.map((cluster) => ({
            ...cluster,
            batchElapsedMs: cluster.batchElapsedMs.map(() => 0),
          })),
        },
      },
      { calls: 160, measurements: s1Measurements },
    ];
    expect(() => deriveWarmStartCalibration(skippedDoubling, participants))
      .toThrow(/s1.*calls|удво/i);

    const perLibraryCalls = structuredClone(valid);
    perLibraryCalls.s1[0].measurements.gsap = { calls: 80, elapsedMs: thresholdMs };
    expect(() => deriveWarmStartCalibration(perLibraryCalls, participants))
      .toThrow(/gsap|measurements/i);

    const extraAfterPass = structuredClone(valid);
    extraAfterPass.s1.push({ calls: 80, measurements: s1Measurements });
    expect(() => deriveWarmStartCalibration(extraAfterPass, participants))
      .toThrow(/s1.*минималь|после/i);

    const overflow = structuredClone(valid);
    const rounds = [];
    for (let calls = START_SCENARIO_MANIFEST.s1.warmCalls;
      calls <= WARM_TIMER_CALIBRATION_POLICY.maximumTargetsPerPilot;
      calls *= 2) {
      rounds.push({
        calls,
        measurements: Object.fromEntries(participants.map((id) => [
          id,
          Array.from({ length: WARM_TIMER_CALIBRATION_POLICY.pilotClusters }, () => (
            {
              batchElapsedMs: Array.from({ length: START_SCENARIO_MANIFEST.s1.warmSamples }, () => 0),
              timerEvidence: timerEvidence(),
              measurementTimeOriginMs: TIMER_ORIGIN_MS,
            }
          )),
        ])),
      });
    }
    overflow.s1 = rounds;
    expect(() => deriveWarmStartCalibration(overflow, participants))
      .toThrow(/s1.*лимит|предел|сход/i);
  });

  it('recomputes exact concurrent and stagger topology from raw semantic checkpoints', () => {
    const evidence = (scenario: keyof typeof START_SCENARIO_MANIFEST, calls: number) => {
      const config = START_SCENARIO_MANIFEST[scenario];
      const callStartedAtMs = Array.from({ length: calls }, () => 0);
      const checkpointTimes = config.staggerGapMs > 0
        ? [0.2, 0.5, 0.8].map((fraction) => config.staggerGapMs * (config.targetsPerCall - 1) * fraction)
        : [config.durationMs * 0.25];
      const checkpoints = checkpointTimes.map((elapsedMs) => ({
        groups: Array.from({ length: calls }, () => ({
          readStartedMs: elapsedMs,
          readEndedMs: elapsedMs,
          positions: Array.from({ length: config.targetsPerCall }, (_, target) => {
            const progress = config.staggerGapMs === 0
              ? elapsedMs / config.durationMs
              : (elapsedMs - target * config.staggerGapMs) / config.durationMs;
            return config.toPx * Math.max(0, Math.min(1, progress));
          }),
        })),
      }));
      const raw = {
        topology: {
          calls,
          targetsPerCall: config.targetsPerCall,
          staggerGapMs: config.staggerGapMs,
          durationMs: config.durationMs,
          toPx: config.toPx,
        },
        callStartedAtMs,
        checkpoints,
        terminal: Array.from({ length: calls }, () => (
          Array.from({ length: config.targetsPerCall }, () => config.toPx)
        )),
      };
      return { ...raw, valid: evaluateStartSemanticEvidence(raw, config, calls) };
    };

    const s1 = evidence('s1', START_SCENARIO_MANIFEST.s1.warmCalls);
    expect(s1.valid).toBe(true);
    expect(evaluateStartSemanticEvidence({
      ...s1,
      topology: { ...s1.topology, calls: 1 },
    }, START_SCENARIO_MANIFEST.s1, START_SCENARIO_MANIFEST.s1.warmCalls)).toBe(false);
    const snapped = structuredClone(s1);
    snapped.checkpoints[0].groups.forEach((group: any) => group.positions.fill(300));
    expect(evaluateStartSemanticEvidence(
      snapped,
      START_SCENARIO_MANIFEST.s1,
      START_SCENARIO_MANIFEST.s1.warmCalls,
    )).toBe(false);

    const s3 = evidence('s3', START_SCENARIO_MANIFEST.s3.warmCalls);
    expect(s3.valid).toBe(true);
    const ignoredStagger = structuredClone(s3);
    ignoredStagger.checkpoints[0].groups.forEach((group: any) => group.positions.fill(30));
    expect(evaluateStartSemanticEvidence(
      ignoredStagger,
      START_SCENARIO_MANIFEST.s3,
      START_SCENARIO_MANIFEST.s3.warmCalls,
    )).toBe(false);
    const survivor = structuredClone(s3);
    survivor.checkpoints.forEach((checkpoint: any) => checkpoint.groups.forEach((group: any) => {
      group.positions.fill(0);
      group.positions[0] = 30;
    }));
    expect(evaluateStartSemanticEvidence(
      survivor,
      START_SCENARIO_MANIFEST.s3,
      START_SCENARIO_MANIFEST.s3.warmCalls,
    )).toBe(false);

    const phaseShifted = structuredClone(s3);
    phaseShifted.checkpoints.forEach((checkpoint: any) => {
      checkpoint.groups.forEach((group: any) => {
        const sampledAtMs = group.readStartedMs + 8;
        group.positions = group.positions.map((_: number, target: number) => {
          const progress = (
            sampledAtMs - target * START_SCENARIO_MANIFEST.s3.staggerGapMs
          ) / START_SCENARIO_MANIFEST.s3.durationMs;
          return START_SCENARIO_MANIFEST.s3.toPx * Math.max(0, Math.min(1, progress));
        });
      });
    });
    expect(evaluateStartSemanticEvidence(
      phaseShifted,
      START_SCENARIO_MANIFEST.s3,
      START_SCENARIO_MANIFEST.s3.warmCalls,
    )).toBe(true);

    const wrongRelativeProfile = structuredClone(s3);
    wrongRelativeProfile.checkpoints[0].groups[0].positions[5] += 0.75;
    expect(evaluateStartSemanticEvidence(
      wrongRelativeProfile,
      START_SCENARIO_MANIFEST.s3,
      START_SCENARIO_MANIFEST.s3.warmCalls,
    )).toBe(false);
    expect(() => assertStartSemanticEvidence('anime.s3 run 1', {
      ...phaseShifted,
      valid: false,
    })).toThrow(/anime\.s3 run 1.*semantic/i);
  });

  it('bootstraps paired independent run clusters reproducibly without flattening rounds', () => {
    const clusters = (base: number) => Array.from({ length: 12 }, (_, run) => ({
      run,
      samples: [base + run * 0.01, base + 0.1 + run * 0.01, base + 0.2 + run * 0.01],
      semantic: true,
    }));
    const lab = clusters(4);
    const competitor = clusters(8);
    const options = { seed: 0x51f15e, iterations: 2_000 };

    const first = pairedClusterBootstrap(lab, competitor, options);
    const second = pairedClusterBootstrap(lab, competitor, options);

    expect(first).toEqual(second);
    expect(first.clusters).toBe(12);
    expect(first.observations).toBe(36);
    expect(first.p50.ratio).toBeLessThan(0.55);
    expect(first.p50.high).toBeLessThan(1);
    expect(first.p95.high).toBeLessThan(1);
    expect(first.pValue).toBeLessThan(0.05);

    expect(() => pairedClusterBootstrap(lab, competitor.slice(1), options)).toThrow(/paired|пар/i);
    expect(() => pairedClusterBootstrap(
      lab,
      competitor.map((cluster, index) => ({ ...cluster, run: index + 1 })),
      options,
    )).toThrow(/run/i);
    expect(() => pairedClusterBootstrap(
      lab,
      competitor.map((cluster, index) => index === 2
        ? { ...cluster, samples: [Number.NaN] }
        : cluster),
      options,
    )).toThrow(/competitor.*cluster 3.*sample 1.*NaN/i);
    expect(() => pairedClusterBootstrap(
      lab,
      competitor.map((cluster, index) => index === 4
        ? { ...cluster, samples: [...cluster.samples, 9] }
        : cluster),
      options,
    )).toThrow(/shape|форм/i);
  });

  it('applies Holm step-down correction across the whole scoped claim family', () => {
    const adjusted = applyHolmCorrection([
      { id: 'b', pValue: 0.03 },
      { id: 'a', pValue: 0.01 },
      { id: 'c', pValue: 0.04 },
    ]);

    expect(adjusted).toEqual([
      { id: 'b', pValue: 0.03, adjustedPValue: 0.06, accepted: false },
      { id: 'a', pValue: 0.01, adjustedPValue: 0.03, accepted: true },
      { id: 'c', pValue: 0.04, adjustedPValue: 0.06, accepted: false },
    ]);
    expect(() => applyHolmCorrection([{ id: 'bad', pValue: -0.1 }])).toThrow(/pValue/);
  });

  it('declares a speed win only when statistical, practical, semantic and tail gates agree', () => {
    const evidence = {
      p50: { ratio: 0.8, low: 0.76, high: 0.84, lab: 8, competitor: 10 },
      p95: { ratio: 1, low: 0.96, high: 1.04, lab: 12, competitor: 12 },
      pValue: 0.001,
      semantic: true,
    };
    const gates = { relativeThreshold: 0.05, absoluteThreshold: 1, holmAccepted: true };

    const winning = evaluatePerformanceClaim(evidence, gates);
    expect(winning).toMatchObject({
      verdict: 'win',
      absoluteGain: 2,
    });
    expect(winning.relativeGain).toBeCloseTo(0.2, 12);
    expect(evaluatePerformanceClaim({ ...evidence, p50: { ...evidence.p50, high: 1 } }, gates).verdict)
      .toBe('inconclusive');
    expect(evaluatePerformanceClaim({
      ...evidence,
      p50: { ratio: 0.96, low: 0.94, high: 0.98, lab: 9.6, competitor: 10 },
    }, gates).verdict).toBe('inconclusive');
    expect(evaluatePerformanceClaim(evidence, { ...gates, absoluteThreshold: 3 }).verdict)
      .toBe('inconclusive');
    expect(evaluatePerformanceClaim({ ...evidence, semantic: false }, gates).verdict)
      .toBe('inconclusive');
    expect(evaluatePerformanceClaim(evidence, { ...gates, holmAccepted: false }).verdict)
      .toBe('inconclusive');
    expect(evaluatePerformanceClaim({
      ...evidence,
      p95: { ratio: 1.2, low: 1.1, high: 1.3, lab: 13.2, competitor: 11 },
    }, gates).verdict).toBe('inconclusive');
    expect(evaluatePerformanceClaim({
      ...evidence,
      p95: { ratio: 1.02, low: 0.98, high: 1.06, lab: 12.2, competitor: 12 },
    }, gates).verdict).toBe('inconclusive');
    expect(evaluatePerformanceClaim({
      ...evidence,
      p50: {
        ratio: 0.95000000000001,
        low: 0.94,
        high: 0.96,
        lab: 9.5000000000001,
        competitor: 10,
      },
    }, { ...gates, absoluteThreshold: 0 })).toMatchObject({
      verdict: 'inconclusive',
      gates: { practicalRelative: false },
    });
    expect(evaluatePerformanceClaim({
      ...evidence,
      p50: { ...evidence.p50, lab: 8.00000000000001, competitor: 10 },
    }, { ...gates, absoluteThreshold: 2 })).toMatchObject({
      verdict: 'inconclusive',
      gates: { clockResolved: false },
    });
    expect(evaluatePerformanceClaim(evidence, { ...gates, absoluteThreshold: 2 })).toMatchObject({
      verdict: 'inconclusive',
      gates: { clockResolved: false },
    });
  });

  it('declares a size win only inside one exact capability group and in both codecs', () => {
    const lab = { capabilityGroup: 'full-animation', gzip: 4_000, brotli: 3_500 };
    expect(evaluateSizeClaim(lab, {
      capabilityGroup: 'full-animation', gzip: 4_100, brotli: 3_600,
    }).verdict).toBe('win');
    expect(evaluateSizeClaim(lab, {
      capabilityGroup: 'full-animation', gzip: 4_100, brotli: 3_400,
    }).verdict).toBe('inconclusive');
    expect(evaluateSizeClaim(lab, {
      capabilityGroup: 'mini-waapi', gzip: 10_000, brotli: 9_000,
    }).verdict).toBe('incomparable');
  });

  it('routes comparative gzip through the root deterministic codec SSOT', () => {
    const source = readFileSync('bench/compare/bench.mjs', 'utf8');
    expect(source).not.toContain("from 'node:zlib'");
    expect(source).not.toContain('gzipSync');
    expect(source).toContain('gz: canonicalGzip(raw).byteLength');
    expect(source).toContain('br: observationalBrotli(raw).byteLength');
    expect(source).toContain("['root/scripts/compression-policy.mjs'");
    expect(source).toContain("['root/scripts/compression-oracle.mjs'");
    expect(source).toContain('assertInstalledPackageTreesUnchanged(ROOT');
  });

  it('mass ceiling хранит 120 paired lifecycle clusters с 60-frame и semantic evidence', () => {
    const source = readFileSync('scripts/bench-ceiling.mjs', 'utf8');
    expect(source).toContain('const MASS_LIFECYCLE_RUNS = 120');
    expect(source).toContain('runMassLifecycleSample');
    expect(source).toContain("for (const motion of ['tween', 'spring'])");
    expect(source).toContain('MASS_LIFECYCLE_PROFILE.counts');
    expect(source).toContain('frames60Ns');
    expect(source).toContain('semantic.traceHashes');
    expect(source).toContain('raw paired clusters:');
    expect(source).toContain('checksum mass=');
    expect(source).toContain('provenance.distRuntime.sha256');
    expect(source.indexOf('process.stdout.write')).toBeGreaterThan(
      source.lastIndexOf('assertCheckoutUnchanged'),
    );
    expect(source).not.toMatch(/p95\s*[<>]=?\s*\d|p99\s*[<>]=?\s*\d/);
  });

  it('comparative start matrix keeps S1–S3 and adds an independent N=1000 S4 cluster', () => {
    const source = readFileSync('bench/compare/bench.mjs', 'utf8');
    expect(Object.keys(START_SCENARIO_MANIFEST)).toEqual(['s1', 's2', 's3', 's4']);
    expect(source).toContain('START_SCENARIO_MANIFEST');
    expect(source).not.toContain('{ calls: 40, targets: 1');
    expect(source).toContain('Object.fromEntries(coldScenarioIds.map');
    expect(source).toContain('semanticEvidence = await runSemanticStartCheck');
    expect(source).toContain('batchElapsedMs: measurement.batchElapsedMs');
    expect(source).toContain('timerEvidence: measurement.timerEvidence');
    expect(source).toContain('page.evaluate(() => globalThis.crossOriginIsolated)');
    expect(source).not.toContain('timerEvidence: { crossOriginIsolated: true');
    expect(source).not.toContain('semantic: true');
    expect(source.match(/assertStartSemanticEvidence\(/g)).toHaveLength(3);
    expect(source).toContain("const rawJson = JSON.stringify(rawPayload) + '\\n';");
    expect(source).not.toContain('JSON.stringify(rawPayload, null, 2)');
  });

  it('captures a decodable pre-start pixel before the freeze trajectory begins', () => {
    const source = readFileSync('bench/compare/bench.mjs', 'utf8');
    const baselineWait = source.slice(
      source.indexOf('async function waitForBaselineFrame'),
      source.indexOf('let cdpStartSequence'),
    );
    const capture = source.slice(
      source.indexOf('async function captureTrajectory'),
      source.indexOf('async function runFreezePair'),
    );
    const screencastStarted = capture.indexOf("await cdp.send('Page.startScreencast'");
    const baselinePresented = capture.indexOf('await waitForBaselineFrame(frames)');
    const animationStarted = capture.indexOf('const startedAt = await page.evaluate');
    const cleanup = capture.indexOf('} finally {', baselinePresented);
    const screencastStopped = capture.indexOf('await stopScreencast()', cleanup);
    const contextClosed = capture.indexOf('await context.close()', cleanup);

    expect(baselineWait).toContain('Number.isFinite(frame.ts)');
    expect(baselineWait).toContain("redLeftEdge(Buffer.from(frame.data, 'base64'))");
    expect(screencastStarted).toBeGreaterThan(-1);
    expect(baselinePresented).toBeGreaterThan(screencastStarted);
    expect(animationStarted).toBeGreaterThan(baselinePresented);
    expect(cleanup).toBeGreaterThan(animationStarted);
    expect(screencastStopped).toBeGreaterThan(cleanup);
    expect(contextClosed).toBeGreaterThan(cleanup);
  });

  it('scores against the same library unblocked trajectory and penalizes both lag and lead', () => {
    const baseline = [
      { t: 0.3, x: 435 },
      { t: 0.5, x: 620 },
      { t: 0.8, x: 631 },
      { t: 1.1, x: 600 },
    ];
    const exact = scoreAgainstBaseline(baseline, baseline, [0.3, 0.5, 0.8, 1.1]);
    const frozenAhead = scoreAgainstBaseline(
      [{ t: 0.3, x: 435 }],
      baseline,
      [0.3, 0.5, 0.8, 1.1],
    );
    const overshot = scoreAgainstBaseline(
      baseline.map((p) => ({ ...p, x: p.x + 100 })),
      baseline,
      [0.3, 0.5, 0.8, 1.1],
    );
    expect(exact.score).toBe(100);
    expect(frozenAhead.score).toBeLessThan(80);
    expect(overshot.score).toBeLessThan(100);
    expect(frozenAhead.samples).toBe(4);
  });

  it('preserves JSON-safe raw trajectories sufficient to independently recompute S5', () => {
    const blocked = [{ t: 0.3, x: 10 }, { t: 0.5, x: 30 }];
    const baseline = [{ t: 0.3, x: 10 }, { t: 0.5, x: 50 }];
    const grid = [0.3, 0.4, 0.5];
    const evidence = createFreezeEvidence(blocked, baseline, grid);
    const expected = scoreAgainstBaseline(blocked, baseline, grid);

    blocked[0]!.x = 999;
    baseline[0]!.x = 999;
    grid[0] = 999;
    expect(scoreAgainstBaseline(evidence.blocked, evidence.baseline, evidence.grid)).toEqual(expected);
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });

  it('distinguishes duplicate screencast frames from visible advancement', () => {
    expect(movementStats([
      { t: 0, x: 10 },
      { t: 0.1, x: 10 },
      { t: 0.2, x: 10 },
    ])).toEqual({ frames: 3, distinctPositions: 1, netAdvancement: 0, totalAdvancement: 0 });
    expect(movementStats([
      { t: 0, x: 10 },
      { t: 0.1, x: 15 },
      { t: 0.2, x: 13 },
    ])).toEqual({ frames: 3, distinctPositions: 3, netAdvancement: 3, totalAdvancement: 7 });
  });

  it('rejects every invalid run and a non-advancing WAAPI control', () => {
    const valid = (overrides = {}) => ({
      valid: true,
      score: 90,
      samples: 8,
      movement: { frames: 20, distinctPositions: 18, netAdvancement: 100, totalAdvancement: 100 },
      baselineMovement: { frames: 20, distinctPositions: 18, netAdvancement: 100, totalAdvancement: 100 },
      finalX: 600,
      baselineFinalX: 600,
      blockStart: 0.3,
      blockEnd: 1.2,
      rawFrames: { baseline: 24, blocked: 24 },
      ...overrides,
    });
    const matrix = {
      lab: [valid(), valid()],
      'waapi-ctl': [valid(), valid()],
    };
    expect(() => assertFreezeMatrix(matrix, 'waapi-ctl')).not.toThrow();
    expect(() => assertFreezeMatrix({ ...matrix, lab: [valid(), valid({ valid: false })] }, 'waapi-ctl'))
      .toThrow(/lab.*run 2.*valid=false.*score=90.*samples=8.*baselineDistinct=18.*baselineTotal=100/i);
    expect(() => assertFreezeMatrix({
      ...matrix,
      'waapi-ctl': [valid({ movement: movementStats([{ t: 0, x: 10 }]) })],
    }, 'waapi-ctl')).toThrow(/waapi-ctl.*движ/i);
  });
});
