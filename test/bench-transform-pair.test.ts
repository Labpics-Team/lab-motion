import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { animate, type AnimateOptions, type AnimateProps } from '../src/animate/index.js';
import {
  TRANSFORM_PAIR_PROFILE,
  expectedTransformValues,
  runTransformLifecycleSample,
  validateTransformLifecycleSample,
} from '../scripts/bench-transform-support.mjs';
import { makeTransformPairPlan, parseTransformPairArgs, runTransformPair } from '../scripts/bench-transform-pair.mjs';
import { summarizeDistribution } from '../scripts/bench-support.mjs';

/** Независимый линейный контроль: конечные значения, время первого кадра и публичные запросы кадров. */
function independentFreshLinear(fault: 'cancel' | 'cleanup' | 'oracle' | null = null, reason: unknown = undefined) {
  return (targets: Parameters<typeof animate>[0], props: AnimateProps, options: AnimateOptions) => {
    if (typeof targets === 'string' || !('length' in targets) || typeof options?.duration !== 'number') {
      throw new Error('Линейный контроль: нужны список целей и числовая длительность');
    }
    const duration = options.duration;
    const from = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0 };
    const destination = props as Record<string, number>;
    let start: number | undefined;
    let stopped = false;
    let frame = 0;
    let cancels = 0;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const tick = (timestamp?: number) => {
      if (stopped) return;
      if (timestamp === undefined) throw new Error('Линейный контроль: время кадра отсутствует');
      start ??= timestamp;
      const progress = (timestamp - start) / duration;
      const value = Object.fromEntries(Object.entries(from).map(([key, initial]) =>
        [key, initial + ((destination[key] ?? initial) - initial) * progress]));
      const text = `translate(${value.x}px, ${value.y}px) scaleX(${value.scaleX}) scaleY(${value.scaleY}) rotate(${value.rotate}deg) skew(${value.skewX}deg, ${value.skewY}deg)`;
      for (let target = 0; target < targets.length; target++) {
        targets[target]!.style.setProperty('transform', fault === 'oracle' && frame === 2 && target === targets.length - 1
          ? 'translateX(999px)' : text);
      }
      frame++;
      options.requestFrame!(tick);
    };
    options.requestFrame!(tick);
    return {
      finished,
      cancel() {
        stopped = true;
        resolveFinished();
        cancels++;
        if ((fault === 'cancel' && cancels === 1) || (fault === 'cleanup' && cancels === 2)) throw reason;
      },
    };
  };
}

type RetainedTiming = number | null | { kind: 'nonfinite'; value: string };
type FailedTransformSample = AggregateError & {
  raw: {
    operationNs: RetainedTiming;
    frameNs: RetainedTiming[];
    cancelDrainNs: RetainedTiming;
    failurePhase: string;
    unfinishedInterval: { metric: string; frame: number | null; beforeNs: string | null; afterNs: string | null } | null;
    semantic: { valid: false; targetTraces: { values: (string | null)[]; writes: number[] }[] };
    beforeCleanupSemantic: { targetTraces: { values: (string | null)[]; writes: number[] }[] };
  };
};

describe('paired public transform lifecycle screening', () => {
  it('fixes the workload and balances AB/BA within every paired block', () => {
    expect(TRANSFORM_PAIR_PROFILE.counts).toEqual([1, 100, 1000]);
    const plan = makeTransformPairPlan();
    expect(plan).toEqual(makeTransformPairPlan());
    expect(plan).toHaveLength(18 * (2 + 8));
    for (let i = 0; i < plan.length; i += 2) {
      const first = plan[i]!;
      const second = plan[i + 1]!;
      expect(first.block).toBe(second.block);
      expect(first.case).toEqual(second.case);
      expect(first.order).toEqual([...second.order].reverse());
    }
    for (const first of plan.filter((entry) => entry.phase === 'measurement' && entry.round === 0)) {
      const blockStarts = plan.filter((entry) => entry.phase === 'measurement' && entry.round % 2 === 0 &&
        entry.case.lifecycle === first.case.lifecycle && entry.case.count === first.case.count && entry.case.channels === first.case.channels);
      expect(blockStarts.filter((entry) => entry.order[0] === 'baseline')).toHaveLength(2);
      expect(blockStarts.filter((entry) => entry.order[0] === 'candidate')).toHaveLength(2);
    }
  });

  it('reproduces the marginal-quantile false difference from a linear invocation drift', () => {
    const orders = Array.from({ length: 8 }, (_, round) => round % 2 === 0
      ? ['candidate', 'baseline'] : ['baseline', 'candidate']);
    const observations: Record<string, number[]> = { baseline: [], candidate: [] };
    let cost = 4;
    for (const order of orders) for (const id of order) observations[id]!.push(++cost);
    expect(summarizeDistribution(observations.baseline)).toEqual({ p50: 11, p95: 19, p99: 19 });
    expect(summarizeDistribution(observations.candidate)).toEqual({ p50: 12, p95: 20, p99: 20 });
  });

  it.each([0, 7])('separates linear drift from a constant candidate penalty of %i ns', async (penalty) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lab-motion-pair-drift-'));
    try {
      const roots = { baseline: path.join(directory, 'baseline'), candidate: path.join(directory, 'candidate') };
      mkdirSync(roots.baseline);
      mkdirSync(roots.candidate);
      const candidate = () => {};
      const baseline = () => {};
      let cost = 0;
      const report = await runTransformPair(roots, {
        prepare: () => ({}), verify: () => {},
        load: async (root: string) => root === roots.candidate ? candidate : baseline,
        measure: async ({ animate: implementation }: { animate: () => void }) => {
          const value = ++cost + (implementation === candidate ? penalty : 0);
          return { operationNs: value, frameNs: [value, value * 2], cancelDrainNs: value * 3, semantic: { valid: true } };
        },
      });
      expect(report.paired).toHaveLength(18);
      for (const entry of report.paired) {
        expect(entry.blocks).toHaveLength(4);
        for (const block of entry.blocks) {
          expect(block.candidateMinusBaselineNs).toEqual({ operation: penalty, frames: [penalty, penalty * 2], cancelDrain: penalty * 3 });
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('measures extra candidate work inside the real public animate call', async () => {
    const baseline = await runTransformLifecycleSample({
      animate, count: 1, lifecycle: 'fresh', channels: 7, nowNs: () => 0n,
    });
    let elapsed = 0n;
    let work = 0;
    const candidate: typeof animate = (targets, props, options) => {
      const controls = animate(targets, props, options);
      for (let step = 0; step < 7; step++) {
        work += step;
        elapsed += 1n;
      }
      return controls;
    };
    const slower = await runTransformLifecycleSample({
      animate: candidate, count: 1, lifecycle: 'fresh', channels: 7, nowNs: () => elapsed,
    });
    expect(work).toBe(21);
    expect(slower.semantic).toEqual(baseline.semantic);
    expect(slower.operationNs - baseline.operationNs).toBe(7);
    expect(slower.frameNs).toEqual(baseline.frameNs);
    expect(slower.cancelDrainNs).toBe(baseline.cancelDrainNs);
  });


  it.each(['operation', 'frame', 'cancel'] as const)(
    'accounts for work deferred across a measured %s boundary', async (stage) => {
      const baseline = await runTransformLifecycleSample({
        animate, count: 1, lifecycle: 'fresh', channels: 7, nowNs: () => 0n,
      });
      let elapsed = 0n;
      let work = 0;
      const burn = () => { work++; elapsed++; };
      let measuredFrameCallbacks = 0;
      const candidate: typeof animate = (targets, props, options) => {
        const controls = animate(targets, props, stage === 'frame' ? {
          ...options,
          requestFrame(callback) {
            return options!.requestFrame!((timestamp) => {
              callback(timestamp);
              if (++measuredFrameCallbacks <= TRANSFORM_PAIR_PROFILE.frameOffsetsMs.length) queueMicrotask(burn);
            });
          },
        } : options);
        if (stage === 'operation') queueMicrotask(() => { for (let step = 0; step < 7; step++) burn(); });
        if (stage !== 'cancel') return controls;
        let firstCancel = true;
        return {
          ...controls,
          cancel() {
            controls.cancel();
            if (firstCancel) {
              firstCancel = false;
              queueMicrotask(() => { for (let step = 0; step < 7; step++) burn(); });
            }
          },
        };
      };
      const slower = await runTransformLifecycleSample({
        animate: candidate, count: 1, lifecycle: 'fresh', channels: 7, nowNs: () => elapsed,
      });
      expect(slower.semantic).toEqual(baseline.semantic);
      if (stage === 'operation') {
        expect(work).toBe(7);
        expect(slower.operationNs - baseline.operationNs).toBe(7);
        expect(slower.frameNs).toEqual(baseline.frameNs);
        expect(slower.cancelDrainNs).toBe(baseline.cancelDrainNs);
      } else if (stage === 'frame') {
        expect(work).toBe(TRANSFORM_PAIR_PROFILE.frameOffsetsMs.length);
        expect(slower.operationNs).toBe(baseline.operationNs);
        expect(slower.frameNs.map((value, index) => value - baseline.frameNs[index]!))
          .toEqual(TRANSFORM_PAIR_PROFILE.frameOffsetsMs.map(() => 1));
        expect(slower.cancelDrainNs).toBe(baseline.cancelDrainNs);
      } else {
        expect(work).toBe(7);
        expect(slower.operationNs).toBe(baseline.operationNs);
        expect(slower.frameNs).toEqual(baseline.frameNs);
        expect(slower.cancelDrainNs - baseline.cancelDrainNs).toBe(7);
      }
    },
  );

  it('rejects ambiguous CLI arguments and the same resolved checkout', () => {
    expect(() => parseTransformPairArgs([])).toThrow(/baseline.*candidate/);
    expect(() => parseTransformPairArgs(['--baseline', '.', '--candidate', './'])).toThrow(/same|один/);
    expect(() => parseTransformPairArgs(['--baseline', '.', '--candidate', '..', '--rounds', '2'])).toThrow(/argument|аргумент/);
  });

  it.each(['fresh', 'settled', 'live'] as const)('%s validates every target/frame and isolates setup from timing', async (lifecycle) => {
    const events: string[] = [];
    let ticks = 0n;
    const measuredAnimate: typeof animate = (targets, props, options) => {
      events.push('animate');
      return animate(targets, props, options);
    };
    const sample = await runTransformLifecycleSample({
      animate: measuredAnimate, count: 1, lifecycle, channels: 1,
      nowNs: () => { events.push('clock'); return ++ticks; },
    });
    expect(events.slice(0, lifecycle === 'fresh' ? 3 : 4)).toEqual(
      lifecycle === 'fresh' ? ['clock', 'animate', 'clock'] : ['animate', 'clock', 'animate', 'clock'],
    );
    expect(sample.operationNs).toBe(1);
    expect(sample.frameNs).toEqual(TRANSFORM_PAIR_PROFILE.frameOffsetsMs.map(() => 1));
    expect(sample.cancelDrainNs).toBe(1);
    expect(sample.semantic.valid).toBe(true);
    expect(sample.semantic.finished).toBe(true);
    expect(sample.semantic.onCompleteCalls).toBe(0);
    expect(sample.semantic.previousCompleteCalls).toBe(lifecycle === 'settled' ? 1 : 0);
    expect(sample.semantic.pending).toBe(0);
    expect(sample.semantic.targetTraceHashes).toHaveLength(1);
  });

  it.each(['fresh', 'settled', 'live'] as const)('%s accepts writes deferred within their frame', async (lifecycle) => {
    const baseline = await runTransformLifecycleSample({ animate, count: 1, lifecycle, channels: 7 });
    const wrappedStyles = new WeakSet<object>();
    const deferred: typeof animate = (targets, props, options) => {
      if (typeof targets === 'string' || !('length' in targets)) throw new Error('expected target array');
      for (let target = 0; target < targets.length; target++) {
        const style = targets[target]!.style;
        if (wrappedStyles.has(style)) continue;
        wrappedStyles.add(style);
        const write = style.setProperty.bind(style);
        style.setProperty = (property, value) => { queueMicrotask(() => write(property, value)); };
      }
      return animate(targets, props, options);
    };
    const sample = await runTransformLifecycleSample({ animate: deferred, count: 1, lifecycle, channels: 7 });
    expect(sample.semantic).toEqual(baseline.semantic);
  });

  it('keeps the settled donor drain outside successor timing', async () => {
    const baseline = await runTransformLifecycleSample({ animate, count: 1, lifecycle: 'settled', channels: 7, nowNs: () => 0n });
    let calls = 0;
    let queued = false;
    let elapsed = 0n;
    let donorReactions = 0;
    const candidate: typeof animate = (targets, props, options) => {
      const donor = ++calls === 1;
      return animate(targets, props, {
        ...options,
        requestFrame(callback) {
          return options!.requestFrame!((timestamp) => {
            callback(timestamp);
            if (donor && !queued && timestamp === TRANSFORM_PAIR_PROFILE.clockOriginMs + TRANSFORM_PAIR_PROFILE.durationMs) {
              queued = true;
              options!.requestFrame!(() => queueMicrotask(() => { donorReactions++; elapsed++; }));
            }
          });
        },
      });
    };
    const sample = await runTransformLifecycleSample({
      animate: candidate, count: 1, lifecycle: 'settled', channels: 7, nowNs: () => elapsed,
    });
    expect(donorReactions).toBe(1);
    expect(sample.operationNs).toBe(0);
    expect(sample.frameNs).toEqual(baseline.frameNs);
    expect(sample.cancelDrainNs).toBe(0);
    expect(sample.semantic.targetTraceHashes).toEqual(baseline.semantic.targetTraceHashes);
    expect(sample.semantic.finished).toBe(true);
    expect(sample.semantic.pending).toBe(0);
  });

  it.each([1, 100, 1000])('covers all seven transform channels on %i targets', async (count) => {
    const sample = await runTransformLifecycleSample({ animate, count, lifecycle: 'live', channels: 7 });
    expect(sample.semantic.targets).toBe(count);
    expect(sample.semantic.targetTraceHashes).toHaveLength(count);
  });

  it('accepts real animate when donor and successor share one host callback', async () => {
    const direct = await runTransformLifecycleSample({ animate, count: 1, lifecycle: 'live', channels: 7 });
    type FrameCallback = Parameters<NonNullable<AnimateOptions['requestFrame']>>[0];
    let queue: FrameCallback[] = [];
    let scheduled = false;
    let logicalRequests = 0;
    let largestBatch = 0;
    const coalesced: typeof animate = (targets, props, options) => animate(targets, props, {
      ...options,
      requestFrame(callback) {
        queue.push(callback);
        largestBatch = Math.max(largestBatch, queue.length);
        if (!scheduled) {
          scheduled = true;
          options!.requestFrame!((timestamp) => {
            const current = queue;
            queue = [];
            scheduled = false;
            for (const queued of current) queued(timestamp);
          });
        }
        return ++logicalRequests;
      },
    });
    let ticks = 0n;
    const shared = await runTransformLifecycleSample({
      animate: coalesced, count: 1, lifecycle: 'live', channels: 7, nowNs: () => ++ticks,
    });
    expect(largestBatch).toBeGreaterThan(1);
    expect(shared.semantic.targetTraceHashes).toEqual(direct.semantic.targetTraceHashes);
    expect(shared.semantic.requests).toBeLessThan(direct.semantic.requests);
    expect(shared.semantic.executions).toBe(shared.semantic.requests);
    expect(shared.semantic.pending).toBe(0);
    expect(shared.semantic.finished).toBe(true);
    expect(shared.semantic.onCompleteCalls).toBe(0);
    expect(shared.operationNs).toBe(1);
    expect(shared.frameNs).toEqual(TRANSFORM_PAIR_PROFILE.frameOffsetsMs.map(() => 1));
    expect(shared.cancelDrainNs).toBe(1);
    expect(queue).toHaveLength(0);
    expect(scheduled).toBe(false);
  });

  it('uses an independent residual/pickup oracle with explicit checkpoints', () => {
    expect(expectedTransformValues('fresh', 1, 0)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0 });
    expect(expectedTransformValues('live', 1, 0)).toEqual({ x: 16, y: 8, scaleX: 1.25, scaleY: 1.5, rotate: 8, skewX: 2, skewY: 4 });
    expect(expectedTransformValues('settled', 1, 64)).toEqual({ x: 160, y: 32, scaleX: 2, scaleY: 3, rotate: 32, skewX: 8, skewY: 16 });
  });

  it('rejects no-op animate without hanging on a never-finished promise', async () => {
    const noop = () => ({ finished: new Promise<void>(() => {}), cancel() {} });
    await expect(runTransformLifecycleSample({ animate: noop, count: 1, lifecycle: 'fresh', channels: 1 })).rejects.toThrow(/scheduler/);
  });

  it.each(['residual', 'missing-frame', 'stale-callback', 'wrong-origin', 'never-finished'] as const)(
    'rejects deliberate public-API sabotage: %s', async (fault) => {
      let calls = 0;
      const sabotage: typeof animate = (targets, props: AnimateProps, options?: AnimateOptions) => {
        calls++;
        let delivered = 0;
        const isSuccessor = calls === 2;
        const changed: AnimateOptions = {
          ...options,
          requestFrame: (callback) => options!.requestFrame!((timestamp) => {
            delivered++;
            if (isSuccessor && fault === 'missing-frame' && delivered === 3) return;
            callback(isSuccessor && fault === 'wrong-origin' && delivered > 1 ? timestamp! + 16 : timestamp);
          }),
        };
        const controls = animate(targets, isSuccessor && fault === 'residual' ? { ...props, y: 0 } : props, changed);
        if (!isSuccessor) return controls;
        return {
          ...controls,
          finished: fault === 'never-finished' ? new Promise<void>(() => {}) : controls.finished,
          cancel() { controls.cancel(); if (fault === 'stale-callback') options?.onComplete?.(); },
        };
      };
      await expect(runTransformLifecycleSample({ animate: sabotage, count: 1, lifecycle: 'live', channels: 1 })).rejects.toThrow(/transform|scheduler|finished|Complete/);
      const clean = await runTransformLifecycleSample({ animate, count: 1, lifecycle: 'live', channels: 1 });
      expect(clean.semantic.valid).toBe(true);
    },
  );

  it('rejects a missing middle frame on the final target, not only target zero', async () => {
    let calls = 0;
    const sabotage: typeof animate = (targets, props, options) => {
      calls++;
      if (calls === 2 && typeof targets !== 'string' && 'length' in targets) {
        const last = targets[targets.length - 1]!;
        const write = last.style.setProperty.bind(last.style);
        let writes = 0;
        last.style.setProperty = (property, value) => {
          if (++writes !== 3) write(property, value);
        };
      }
      return animate(targets, props, options);
    };
    await expect(runTransformLifecycleSample({ animate: sabotage, count: 100, lifecycle: 'live', channels: 7 }))
      .rejects.toThrow(/target 99 frame 2/);
  });

  it.each(['successor-write', 'donor-write', 'successor-callback'] as const)(
    'rejects effects from final cleanup before returning a valid sample: %s', async (fault) => {
      let calls = 0;
      const sabotage: typeof animate = (targets, props, options) => {
        const isDonor = ++calls === 1;
        const controls = animate(targets, props, options);
        let cancels = 0;
        return {
          ...controls,
          cancel() {
            controls.cancel();
            const finalCleanup = isDonor ? ++cancels === 1 : ++cancels === 2;
            if (!finalCleanup) return;
            if (fault === 'successor-callback' && !isDonor) options!.requestFrame!(() => {});
            if ((fault === 'donor-write' && isDonor) || (fault === 'successor-write' && !isDonor)) {
              if (typeof targets !== 'string' && 'length' in targets) {
                targets[0]!.style.setProperty('transform', 'translateX(999px)');
              }
            }
          },
        };
      };
      await expect(runTransformLifecycleSample({ animate: sabotage, count: 1, lifecycle: 'live', channels: 1 }))
        .rejects.toThrow(/transform/);
    },
  );

  it('retains both measurement and cleanup failures without returning a sample', async () => {
    const measurementError = new Error('measurement clock');
    const cleanupError = new Error('cleanup cancel');
    let ticks = 0;
    let cancels = 0;
    const sabotage: typeof animate = (targets, props, options) => {
      const controls = animate(targets, props, options);
      return { ...controls, cancel() { cancels++; controls.cancel(); throw cleanupError; } };
    };
    try {
      await runTransformLifecycleSample({
        animate: sabotage, count: 1, lifecycle: 'fresh', channels: 1,
        nowNs: () => { if (++ticks === 2) throw measurementError; return 0n; },
      });
      expect.fail('measurement must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([measurementError, cleanupError]);
      expect((error as FailedTransformSample).raw).toMatchObject({
        operationNs: null, frameNs: [], cancelDrainNs: null,
        unfinishedInterval: { metric: 'operationNs', beforeNs: '0', afterNs: null },
        semantic: { valid: false, finished: 'fulfilled', pending: 0 },
      });
    }
    expect(cancels).toBe(1);
  });

  it('сохраняет семь завершённых интервалов при независимом позднем отказе cancel', async () => {
    let healthyReads = 0;
    const healthy = await runTransformLifecycleSample({
      animate: independentFreshLinear(), count: 1000, lifecycle: 'fresh', channels: 7,
      nowNs: () => BigInt(++healthyReads) * 1000n,
    });
    expect(healthy.semantic.valid).toBe(true);
    expect(healthyReads).toBe(16);
    expect(healthy.operationNs).toBe(1000);
    expect(healthy.frameNs).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    expect(healthy.cancelDrainNs).toBe(1000);

    const reason = new Error('Независимый отказ поздней отмены');
    let failedReads = 0;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear('cancel', reason), count: 1000, lifecycle: 'fresh', channels: 7,
      nowNs: () => BigInt(++failedReads) * 1000n,
    }).then(() => { throw new Error('Неуспешный замер не должен вернуться'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = failure as FailedTransformSample;
    expect(retained.errors).toEqual([reason]);
    expect(failedReads).toBe(15);
    expect(retained.raw).toMatchObject({
      operationNs: healthy.operationNs, frameNs: healthy.frameNs, cancelDrainNs: null,
      failurePhase: 'cancel', unfinishedInterval: { metric: 'cancelDrainNs', frame: null, beforeNs: '15000', afterNs: null },
      beforeCleanupSemantic: { valid: false, targets: 1000, finished: 'pending', pending: 1 },
      semantic: { valid: false, targets: 1000, finished: 'fulfilled', pending: 0 },
    });
    expect(retained.raw.semantic.targetTraces).toHaveLength(1000);
    expect(retained.raw.semantic.targetTraces.every((trace) => trace.writes.join(',') === '1,1,1,1,1,1' &&
      trace.values.length === 6 && trace.values.every((value) => typeof value === 'string'))).toBe(true);
    expect(JSON.parse(JSON.stringify(retained.raw))).toEqual(retained.raw);
  });

  it.each([7, 8])('сохраняет завершённые интервалы и CSS при throw undefined на чтении часов %i', async (failedRead) => {
    let reads = 0;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear(), count: 1, lifecycle: 'fresh', channels: 7,
      nowNs: () => { if (++reads === failedRead) throw undefined; return BigInt(reads) * 1000n; },
    }).then(() => { throw new Error('Отказ часов не должен стать замером'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = failure as FailedTransformSample;
    expect(retained.errors).toEqual([undefined]);
    expect(reads).toBe(failedRead);
    expect(retained.raw).toMatchObject({
      operationNs: 1000, frameNs: [1000, 1000], cancelDrainNs: null,
      failurePhase: 'frame', unfinishedInterval: { metric: 'frameNs', frame: 2, beforeNs: failedRead === 8 ? '7000' : null, afterNs: null },
      beforeCleanupSemantic: { finished: 'pending', pending: 1 },
      semantic: { valid: false, finished: 'fulfilled', pending: 0 },
    });
    expect(retained.raw.beforeCleanupSemantic.targetTraces[0].writes).toEqual([1, 1, failedRead === 8 ? 1 : 0, 0, 0, 0]);
    if (failedRead === 8) expect(retained.raw.beforeCleanupSemantic.targetTraces[0].values[2]).toContain('translate(64px, 40px)');
    else expect(retained.raw.beforeCleanupSemantic.targetTraces[0].values[2]).toBeNull();
    expect(retained.raw.beforeCleanupSemantic.targetTraces[0].values.slice(3)).toEqual([null, null, null]);
    expect(JSON.parse(JSON.stringify(retained.raw))).toEqual(retained.raw);
  });

  it('сохраняет состояние отказа до изменения CSS очисткой и обе исходные ошибки', async () => {
    const cleanupError = Object.freeze(new Error('Очистка изменила CSS и отказала'));
    const linear = independentFreshLinear();
    let reads = 0;
    const failure = await runTransformLifecycleSample({
      animate: (targets: Parameters<typeof animate>[0], props: AnimateProps, options: AnimateOptions) => {
        const controls = linear(targets, props, options);
        return { ...controls, cancel() {
          controls.cancel();
          if (typeof targets !== 'string' && 'length' in targets) targets[0]!.style.setProperty('transform', 'translateX(999px)');
          throw cleanupError;
        } };
      },
      count: 1, lifecycle: 'fresh', channels: 7,
      nowNs: () => { if (++reads === 8) throw undefined; return BigInt(reads) * 1000n; },
    }).then(() => { throw new Error('Отказ не должен стать замером'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = failure as FailedTransformSample;
    expect(retained.errors).toEqual([undefined, cleanupError]);
    expect(retained.raw.beforeCleanupSemantic.targetTraces[0]).toMatchObject({
      value: expect.stringContaining('translate(64px, 40px)'), outsideWrites: 0,
    });
    expect(retained.raw.semantic.targetTraces[0]).toMatchObject({ value: 'translateX(999px)', outsideWrites: 1 });
    expect(retained.raw).toMatchObject({ operationNs: 1000, frameNs: [1000, 1000], cancelDrainNs: null, semantic: { valid: false } });
    expect(JSON.parse(JSON.stringify(retained.raw))).toEqual(retained.raw);
  });

  it('сохраняет неконечный интервал явно при JSON-переносе неуспешного замера', async () => {
    let reads = 0;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear(), count: 1, lifecycle: 'fresh', channels: 7,
      nowNs: () => { reads++; return reads === 1 ? 0n : reads === 2 ? 1n << 1024n : BigInt(reads); },
    }).then(() => { throw new Error('Неконечные часы не должны дать замер'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = failure as FailedTransformSample;
    expect(retained.errors).toHaveLength(1);
    expect(retained.errors[0].message).toMatch(/некорректный timing/);
    expect(reads).toBe(16);
    expect(retained.raw).toMatchObject({
      operationNs: { kind: 'nonfinite', value: 'Infinity' }, frameNs: [1, 1, 1, 1, 1, 1], cancelDrainNs: 1,
      failurePhase: 'timing', unfinishedInterval: null, semantic: { valid: false, finished: 'fulfilled', pending: 0 },
    });
    expect(JSON.parse(JSON.stringify(retained.raw))).toEqual(retained.raw);
  });

  it('lineage сохраняет каждый внешний BigInt endpoint и фактический CSS всех целей', async () => {
    const counterValues: string[] = [];
    const writes: { target: number; timestampMs: number | undefined; value: string }[] = [];
    let counter = 10n ** 26n;
    let timestampMs: number | undefined;
    const linear = independentFreshLinear();
    const sample = await runTransformLifecycleSample({
      count: 1000, lifecycle: 'fresh', channels: 7,
      nowNs: () => { counter += 1000n; counterValues.push(counter.toString()); return counter; },
      animate: (targets: Parameters<typeof animate>[0], props: AnimateProps, options: AnimateOptions) => {
        if (typeof targets === 'string' || !('length' in targets)) throw new Error('Нужен список целей');
        for (let target = 0; target < targets.length; target++) {
          const style = targets[target]!.style;
          const write = style.setProperty.bind(style);
          style.setProperty = (property, value) => { writes.push({ target, timestampMs, value }); write(property, value); };
        }
        return linear(targets, props, { ...options, requestFrame: (callback) => options.requestFrame!((timestamp) => {
          timestampMs = timestamp;
          callback(timestamp);
        }) });
      },
    });
    expect(counterValues).toHaveLength(16);
    expect(sample.raw.clockReads.map((read: { valueNs: string }) => read.valueNs)).toEqual(counterValues);
    expect(writes).toHaveLength(6000);
    expect(sample.raw.targetTraces.encoding).toBe('runs');
    expect(sample.raw.targetTraces.count).toBe(1000);
    expect(sample.raw.targetTraces.runs).toHaveLength(1);
    const run = sample.raw.targetTraces.runs[0];
    expect(run.from).toBe(0);
    expect(run.count).toBe(1000);
    for (const write of writes) {
      const frame = TRANSFORM_PAIR_PROFILE.frameOffsetsMs.indexOf(write.timestampMs! - TRANSFORM_PAIR_PROFILE.clockOriginMs);
      expect(run.trace.values[frame]).toBe(write.value);
      expect(run.trace.events[frame]).toMatchObject({ timestampMs: write.timestampMs, property: 'transform', value: write.value });
    }
    const replay = validateTransformLifecycleSample(sample, { count: 1000, lifecycle: 'fresh', channels: 7 });
    expect(replay).toMatchObject({ operationNs: 1000, frameNs: [1000, 1000, 1000, 1000, 1000, 1000], cancelDrainNs: 1000 });
    expect(replay.intervals.map((interval: { durationNs: string }) => interval.durationNs)).toEqual(Array(8).fill('1000'));
    expect(replay.traceRuns).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(sample.raw))).toEqual(sample.raw);
  });

  it.each(['fresh', 'live', 'settled'] as const)('lineage пересчитывает generic clock и setup/frame координаты: %s', async (lifecycle) => {
    for (const channels of [1, 7]) {
      let counter = 0n;
      const sample = await runTransformLifecycleSample({ animate, count: 1, lifecycle, channels, nowNs: () => ++counter });
      const replay = validateTransformLifecycleSample(sample, { count: 1, lifecycle, channels });
      expect(replay.operationNs).toBe(1);
      expect(replay.frameNs).toEqual([1, 1, 1, 1, 1, 1]);
      expect(replay.cancelDrainNs).toBe(1);
      const setupCount = lifecycle === 'fresh' ? 0 : lifecycle === 'live' ? 2 : 3;
      expect(replay.traceRuns[0].trace.events).toHaveLength(setupCount + 6);
      expect(replay.traceRuns[0].trace.setup).toHaveLength(setupCount);
    }
  });

  it('lineage сохраняет весь приобретённый prefix при позднем cancel failure', async () => {
    const values: string[] = [];
    let counter = 0n;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear('cancel', new Error('Отказ отмены')), count: 1000, lifecycle: 'fresh', channels: 7,
      nowNs: () => { counter += 1000n; values.push(counter.toString()); return counter; },
    }).then(() => { throw new Error('Отказ не должен стать замером'); }, (error: any) => error);
    expect(failure.raw.clockReads.map((read: { valueNs: string }) => read.valueNs)).toEqual(values);
    expect(values).toHaveLength(15);
    expect(failure.raw.clockReads[14]).toMatchObject({ metric: 'cancelDrainNs', frame: null, edge: 'before', valueNs: '15000' });
    expect(failure.raw.targetTraces.runs[0]).toMatchObject({ from: 0, count: 1000 });
    expect(failure.raw.targetTraces.runs[0].trace.events).toHaveLength(6);
    expect(() => validateTransformLifecycleSample({ ...failure.raw, raw: failure.raw }, { count: 1000, lifecycle: 'fresh', channels: 7 })).toThrow(/отказ/);
  });

  it.each([7, 8])('lineage не придумывает endpoint при отказе часов на попытке %i', async (failedRead) => {
    const acquired: string[] = [];
    let attempted = 0;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear(), count: 1, lifecycle: 'fresh', channels: 7,
      nowNs: () => { if (++attempted === failedRead) throw undefined; const value = BigInt(attempted); acquired.push(value.toString()); return value; },
    }).then(() => { throw new Error('Отказ не должен стать замером'); }, (error: any) => error);
    expect(failure.errors).toEqual([undefined]);
    expect(failure.raw.clockReads.map((read: { valueNs: string }) => read.valueNs)).toEqual(acquired);
    expect(failure.raw.clockReads).toHaveLength(failedRead - 1);
    expect(failure.raw.targetTraces.runs[0].trace.events).toHaveLength(failedRead === 7 ? 2 : 3);
  });

  it('lineage сохраняет повторные и внешние записи CSS без потери overwritten значения', async () => {
    const linear = independentFreshLinear();
    let counter = 0n;
    const failure = await runTransformLifecycleSample({
      count: 1, lifecycle: 'fresh', channels: 7, nowNs: () => ++counter,
      animate: (targets: Parameters<typeof animate>[0], props: AnimateProps, options: AnimateOptions) => {
        if (typeof targets === 'string' || !('length' in targets)) throw new Error('Нужен список целей');
        const style = targets[0]!.style;
        const write = style.setProperty.bind(style);
        let writes = 0;
        style.setProperty = (property, value) => { if (++writes === 3) write(property, 'translateX(999px)'); write(property, value); };
        const controls = linear(targets, props, options);
        let cancels = 0;
        return { ...controls, cancel() { controls.cancel(); if (++cancels === 2) write('transform', 'translateX(888px)'); } };
      },
    }).then(() => { throw new Error('Отказ не должен стать замером'); }, (error: any) => error);
    const trace = failure.raw.targetTraces.runs[0].trace;
    expect(trace.writes).toEqual([1, 1, 2, 1, 1, 1]);
    expect(trace.outsideWrites).toBe(1);
    expect(trace.events).toHaveLength(8);
    expect(trace.events[2]).toMatchObject({ phase: 'frames', index: 2, value: 'translateX(999px)', timestampMs: 1000032 });
    expect(trace.events[3]).toMatchObject({ phase: 'frames', index: 2, value: expect.stringContaining('translate(64px, 40px)') });
    expect(trace.events[7]).toMatchObject({ phase: 'outside', index: null, step: null, timestampMs: null, value: 'translateX(888px)' });
  });

  it.each(['endpoint', 'clock-order', 'missing-clock', 'missing-target', 'RLE-count', 'RLE-from', 'RLE-hash-only', 'missing-event', 'event-order', 'event-time', 'coordinates-and-hash'] as const)(
    'lineage отвергает согласованное по labels повреждение: %s', async (fault) => {
      let counter = 0n;
      const original = await runTransformLifecycleSample({ animate: independentFreshLinear(), count: 100, lifecycle: 'fresh', channels: 7, nowNs: () => counter += 1000n });
      expect(() => validateTransformLifecycleSample(original, { count: 100, lifecycle: 'fresh', channels: 7 })).not.toThrow();
      const mutant = JSON.parse(JSON.stringify(original));
      const trace = mutant.raw.targetTraces.runs[0].trace;
      if (fault === 'endpoint') mutant.raw.clockReads[1].valueNs = '2001';
      if (fault === 'clock-order') [mutant.raw.clockReads[2], mutant.raw.clockReads[3]] = [mutant.raw.clockReads[3], mutant.raw.clockReads[2]];
      if (fault === 'missing-clock') mutant.raw.clockReads.splice(4, 1);
      if (fault === 'missing-target') mutant.raw.targetTraces.runs = [];
      if (fault === 'RLE-count') mutant.raw.targetTraces.runs[0].count = 99;
      if (fault === 'RLE-from') mutant.raw.targetTraces.runs[0].from = 1;
      if (fault === 'RLE-hash-only') mutant.raw.targetTraces.runs[0].trace = { hash: original.semantic.targetTraceHashes[0] };
      if (fault === 'missing-event') delete trace.events[2];
      if (fault === 'event-order') [trace.events[2], trace.events[3]] = [trace.events[3], trace.events[2]];
      if (fault === 'event-time') trace.events[2].timestampMs++;
      if (fault === 'coordinates-and-hash') {
        trace.values[2] = 'translateX(999px)';
        trace.events[2].value = trace.values[2];
        const hash = createHash('sha256').update(JSON.stringify(trace.values)).digest('hex');
        mutant.semantic.targetTraceHashes.fill(hash);
      }
      expect(() => validateTransformLifecycleSample(mutant, { count: 100, lifecycle: 'fresh', channels: 7 })).toThrow(/transform/);
    },
  );

  it('lineage связывает external case и повторённые hash identities с полным CSS', async () => {
    const sample = await runTransformLifecycleSample({ animate: independentFreshLinear(), count: 100, lifecycle: 'fresh', channels: 7, nowNs: () => 0n });
    sample.semantic.targetTraceHashes = { encoding: 'repeat', count: 100, value: sample.semantic.targetTraceHashes[0] };
    expect(() => validateTransformLifecycleSample(sample, { count: 100, lifecycle: 'fresh', channels: 7 })).not.toThrow();
    expect(() => validateTransformLifecycleSample(sample, { count: 1000, lifecycle: 'fresh', channels: 7 })).toThrow(/case/);
    sample.semantic.targetTraceHashes.count = 99;
    expect(() => validateTransformLifecycleSample(sample, { count: 100, lifecycle: 'fresh', channels: 7 })).toThrow(/hash RLE/);
  });

  it.each(['oracle', 'cleanup'] as const)('сохраняет все восемь интервалов при позднем отказе %s', async (fault) => {
    const reason = Object.freeze(new Error('Ошибка поздней очистки'));
    let reads = 0;
    const failure = await runTransformLifecycleSample({
      animate: independentFreshLinear(fault, reason), count: 100, lifecycle: 'fresh', channels: 7,
      nowNs: () => BigInt(++reads) * 1000n,
    }).then(() => { throw new Error('Отказ не должен стать замером'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retained = failure as FailedTransformSample;
    expect(reads).toBe(16);
    expect(retained.raw).toMatchObject({
      operationNs: 1000, frameNs: [1000, 1000, 1000, 1000, 1000, 1000], cancelDrainNs: 1000,
      failurePhase: fault, unfinishedInterval: null,
      semantic: { valid: false, targets: 100, finished: 'fulfilled', pending: 0 },
    });
    if (fault === 'oracle') {
      expect(retained.errors).toHaveLength(1);
      expect(retained.errors[0].message).toMatch(/target 99 frame 2/);
      expect(retained.raw.semantic.targetTraces[99].values[2]).toBe('translateX(999px)');
    } else {
      expect(retained.errors).toEqual([reason]);
    }
    expect(JSON.parse(JSON.stringify(retained.raw))).toEqual(retained.raw);
  });

  it('retains the primary and both live cancellation failures while draining and resolving finished', async () => {
    const primary = new Error('measurement clock');
    const successorError = new Error('successor cancel');
    const donorError = new Error('donor cancel');
    const cancelled: string[] = [];
    const finished = new Set<string>();
    let calls = 0;
    let ticks = 0;
    let cleanupDrains = 0;
    const sabotage: typeof animate = (targets, props, options) => {
      const role = ++calls === 1 ? 'donor' : 'successor';
      const controls = animate(targets, props, {
        ...options,
        requestFrame: (callback) => options!.requestFrame!((timestamp) => {
          if (cancelled.length > 0) cleanupDrains++;
          callback(timestamp);
        }),
      });
      void controls.finished.then(() => { finished.add(role); });
      return {
        ...controls,
        cancel() {
          cancelled.push(role);
          controls.cancel();
          throw role === 'donor' ? donorError : successorError;
        },
      };
    };
    try {
      await runTransformLifecycleSample({
        animate: sabotage, count: 1, lifecycle: 'live', channels: 7,
        nowNs: () => { if (++ticks === 2) throw primary; return 0n; },
      });
      expect.fail('all failures must be reported');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, successorError, donorError]);
      expect((error as FailedTransformSample).raw).toMatchObject({
        operationNs: null, frameNs: [], cancelDrainNs: null,
        semantic: { valid: false, finished: 'fulfilled', previousFinished: 'fulfilled', pending: 0 },
      });
    }
    expect(cancelled).toEqual(['successor', 'donor']);
    expect(cleanupDrains).toBeGreaterThan(0);
    expect([...finished].sort()).toEqual(['donor', 'successor']);
  });

  it.each([
    { role: 'donor', reason: new Error('donor finished') },
    { role: 'donor', reason: undefined },
    { role: 'successor', reason: new Error('successor finished') },
    { role: 'successor', reason: undefined },
  ])('observes rejected $role finished and preserves its reason: $reason', async ({ role, reason }) => {
    let calls = 0;
    const sabotage: typeof animate = (targets, props, options) => {
      const owner = ++calls === 1 ? 'donor' : 'successor';
      const controls = animate(targets, props, options);
      return owner === role ? { ...controls, finished: Promise.reject(reason) } : controls;
    };
    try {
      await runTransformLifecycleSample({ animate: sabotage, count: 1, lifecycle: 'live', channels: 7 });
      expect.fail('rejected finished must invalidate the sample');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([reason]);
      expect((error as FailedTransformSample).raw).toMatchObject({
        frameNs: [], cancelDrainNs: null,
        semantic: role === 'donor' ? { valid: false, previousFinished: 'rejected' } : { valid: false, finished: 'rejected' },
      });
    }
  });

  it('keeps throw undefined, both cancellation errors and a rejected successor finished', async () => {
    const successorError = new Error('successor cancel');
    const donorError = new Error('donor cancel');
    let calls = 0;
    let ticks = 0;
    const cancelled: string[] = [];
    const sabotage: typeof animate = (targets, props, options) => {
      const role = ++calls === 1 ? 'donor' : 'successor';
      const controls = animate(targets, props, options);
      return {
        ...controls,
        finished: role === 'successor' ? Promise.reject(undefined) : controls.finished,
        cancel() {
          cancelled.push(role);
          controls.cancel();
          throw role === 'successor' ? successorError : donorError;
        },
      };
    };
    try {
      await runTransformLifecycleSample({
        animate: sabotage, count: 1, lifecycle: 'live', channels: 7,
        nowNs: () => { if (++ticks === 2) throw undefined; return 0n; },
      });
      expect.fail('all failures must be retained');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([undefined, successorError, donorError, undefined]);
      expect((error as FailedTransformSample).raw).toMatchObject({
        operationNs: null, frameNs: [], cancelDrainNs: null,
        unfinishedInterval: { metric: 'operationNs', beforeNs: '0', afterNs: null },
        semantic: { valid: false, finished: 'rejected', previousFinished: 'fulfilled', pending: 0 },
      });
    }
    expect(cancelled).toEqual(['successor', 'donor']);
  });

  it.each(['reversed-order', 'split-skew'] as const)('rejects %s even when every channel value is unchanged', async (fault) => {
    const clean = await runTransformLifecycleSample({ animate, count: 1, lifecycle: 'live', channels: 7 });
    expect(clean.semantic.valid).toBe(true);
    let calls = 0;
    const sabotage: typeof animate = (targets, props, options) => {
      if (++calls === 2 && typeof targets !== 'string' && 'length' in targets) {
        for (const target of Array.from(targets)) {
          const write = target.style.setProperty.bind(target.style);
          target.style.setProperty = (property, value) => {
            write(property, fault === 'reversed-order'
              ? value.match(/[A-Za-z]+\([^)]*\)/g)!.reverse().join(' ')
              : value.replace(/skew\(([^,]+), ([^)]+)\)/, 'skewX($1) skewY($2)'));
          };
        }
      }
      return animate(targets, props, options);
    };
    await expect(runTransformLifecycleSample({ animate: sabotage, count: 1, lifecycle: 'live', channels: 7 }))
      .rejects.toThrow(/transform/);
  });

  it('pins both builds before importing/timing and rejects final provenance drift', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lab-motion-pair-test-'));
    try {
      for (const name of ['baseline', 'candidate']) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, 'package.json'), '{}');
      }
      const events: string[] = [];
      let candidateVerifications = 0;
      const roots = { baseline: path.join(root, 'baseline'), candidate: path.join(root, 'candidate') };
      await expect(runTransformPair(roots, {
        prepare: ({ root: checkout }: { root: string }) => { events.push(`build:${path.basename(checkout)}`); return { revision: checkout }; },
        load: async (checkout: string) => { events.push(`import:${path.basename(checkout)}`); return animate; },
        measure: async () => { events.push('sample'); return { operationNs: 1, frameNs: [1], cancelDrainNs: 1, semantic: { valid: true } }; },
        verify: (checkout: string) => {
          events.push(`verify:${path.basename(checkout)}`);
          if (checkout === roots.candidate && ++candidateVerifications === 2) throw new Error('dist changed');
        },
      })).rejects.toThrow(/dist changed/);
      expect(events.slice(0, 6)).toEqual(['build:baseline', 'build:candidate', 'verify:baseline', 'verify:candidate', 'import:baseline', 'import:candidate']);
      expect(events).toContain('sample');
      expect(events.slice(-2)).toEqual(['verify:baseline', 'verify:candidate']);

      const report = await runTransformPair(roots, {
        prepare: () => ({ revision: 'a'.repeat(40) }),
        load: async () => animate,
        measure: async () => ({ operationNs: 2, frameNs: [1, 3], cancelDrainNs: 4, semantic: { valid: true } }),
        verify: () => {},
      });
      expect(report.raw).toHaveLength(180);
      expect(report.summary).toHaveLength(18);
      expect(report.summary[0]?.baseline).toEqual({ observations: 8,
        operationNs: { p50: 2, p95: 2, p99: 2 }, frameNs: { p50: 1, p95: 3, p99: 3 },
        cancelDrainNs: { p50: 4, p95: 4, p99: 4 },
      });
      expect(JSON.parse(JSON.stringify(report)).raw[0].block).toBe(report.raw[0]?.block);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
