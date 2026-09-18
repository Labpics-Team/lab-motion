import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { animate, type AnimateOptions, type AnimateProps } from '../src/animate/index.js';
import {
  TRANSFORM_PAIR_PROFILE,
  expectedTransformValues,
  runTransformLifecycleSample,
} from '../scripts/bench-transform-support.mjs';
import { makeTransformPairPlan, parseTransformPairArgs, runTransformPair } from '../scripts/bench-transform-pair.mjs';
import { summarizeDistribution } from '../scripts/bench-support.mjs';

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
    }
    expect(cancels).toBe(1);
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
