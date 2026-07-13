import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertBalancedRunBlocks,
  assertFreezeMatrix,
  applyHolmCorrection,
  createFreezeEvidence,
  deriveTimerQuantum,
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
} from '../bench/compare/methodology.mjs';

describe('benchmark methodology fail-closed contracts', () => {
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
    expect(deriveTimerQuantum(deltas)).toBe(0.1);
    expect(() => deriveTimerQuantum(deltas.slice(1))).toThrow(/16/);
    expect(() => deriveTimerQuantum([...deltas.slice(0, 15), 0])).toThrow(/положительных/);
    expect(deriveTimerQuantum([1e-12, ...Array.from({ length: 15 }, () => 0.1)]))
      .toBe(0.1);
    expect(() => deriveTimerQuantum([
      ...Array.from({ length: 8 }, () => 0.1),
      ...Array.from({ length: 8 }, () => 0.3),
    ])).toThrow(/концентрац/i);
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
    )).toThrow(/samples/i);
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

    expect(evaluatePerformanceClaim(evidence, gates)).toMatchObject({
      verdict: 'win',
      relativeGain: 0.2,
      absoluteGain: 2,
    });
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
    expect(source).toContain('push({ run, samples, semantic, semanticEvidence })');
    expect(source).toContain('push({ run, samples: [sample], semantic, semanticEvidence })');
    expect(source).not.toContain('semantic: true');
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
      ...overrides,
    });
    const matrix = {
      lab: [valid(), valid()],
      'waapi-ctl': [valid(), valid()],
    };
    expect(() => assertFreezeMatrix(matrix, 'waapi-ctl')).not.toThrow();
    expect(() => assertFreezeMatrix({ ...matrix, lab: [valid(), valid({ valid: false })] }, 'waapi-ctl'))
      .toThrow(/lab.*run 2/i);
    expect(() => assertFreezeMatrix({
      ...matrix,
      'waapi-ctl': [valid({ movement: movementStats([{ t: 0, x: 10 }]) })],
    }, 'waapi-ctl')).toThrow(/waapi-ctl.*движ/i);
  });
});
