/**
 * WebKit execution policy: поддержка синтаксиса CSS linear() не доказывает
 * compositor-residency. В WebKit многостоповый custom easing замирает вместе с
 * main thread, тогда как явные WAAPI-keyframes с обычным `linear` продолжают
 * исполняться вне main thread. Пин проверяет фактический план контроллера.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ builds: 0 }));

vi.mock('../src/compositor/segmenter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compositor/segmenter.js')>();
  return {
    ...actual,
    buildSpringNodes(...args: Parameters<typeof actual.buildSpringNodes>) {
      work.builds++;
      return actual.buildSpringNodes(...args);
    },
    buildSpringNodesWithHorizon(
      ...args: Parameters<typeof actual.buildSpringNodesWithHorizon>
    ) {
      work.builds++;
      return actual.buildSpringNodesWithHorizon(...args);
    },
    tryBuildSpringNodes(...args: Parameters<typeof actual.tryBuildSpringNodes>) {
      work.builds++;
      return actual.tryBuildSpringNodes(...args);
    },
  };
});

import {
  compileSpringPlan,
  CompositorSpring,
  supportsCompositor,
} from '../src/compositor/index.js';
import { CompositorStaggerGroup } from '../src/compositor/stagger/index.js';
import {
  __resetDetectionCache,
  requiresExplicitSpringKeyframes,
  requiresExplicitSpringKeyframesFor,
} from '../src/compositor/detect.js';
import {
  __resetSpringExecutionCache,
  compileSpringRuntimeExecutionPlanUnchecked,
} from '../src/compositor/execution.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { settleTimeUpperBound } from '../src/spring.js';

const SPRING = { mass: 1, stiffness: 220, damping: 8 };

interface AnimateCall {
  readonly keyframes: Record<string, string | number>[];
  readonly timing: Record<string, unknown>;
}

function recordingTarget(calls: AnimateCall[]) {
  return {
    animate(
      keyframes: Record<string, string | number>[],
      timing: Record<string, unknown>,
    ) {
      calls.push({ keyframes, timing });
      return { cancel() {} };
    },
  };
}

function stubEngine(vendor: string, userAgent: string): void {
  vi.stubGlobal('navigator', { vendor, userAgent });
  vi.stubGlobal('CSS', { supports: () => true });
}

describe('compositor: WebKit исполняет пружину явными keyframes', () => {
  beforeEach(() => {
    work.builds = 0;
    __resetDetectionCache();
    __resetSpringExecutionCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetDetectionCache();
    __resetSpringExecutionCache();
  });

  it('AppleWebKit получает adaptive keyframes + standard linear, не custom linear()', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    const calls: AnimateCall[] = [];
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target: recordingTarget(calls),
    });

    spring.start();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.timing['easing']).toBe('linear');
    expect(calls[0]!.keyframes.length).toBeGreaterThan(2);
    expect(calls[0]!.keyframes[0]).toEqual({ offset: 0, opacity: 0 });
    expect(calls[0]!.keyframes.at(-1)).toEqual({ offset: 1, opacity: 1 });
  });

  it('каждый explicit keyframe точно проецирует те же adaptive nodes, включая overshoot', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    const from = 10;
    const to = 110;
    const reference = compileSpringExecutionArtifactUnchecked(
      SPRING,
      0,
      DEFAULT_TOLERANCE,
    ).samples;
    const calls: AnimateCall[] = [];
    new CompositorSpring({
      spring: SPRING,
      property: 'x',
      from,
      to,
      target: recordingTarget(calls),
    }).start();

    const frames = calls[0]!.keyframes;
    expect(calls[0]!.timing['easing']).toBe('linear');
    expect(frames).toHaveLength(reference.length / 2);
    for (let i = 0; i < reference.length / 2; i++) {
      const offset = reference[i * 2]! / 100;
      const progress = reference[i * 2 + 1]!;
      const expectedValue = i === 0
        ? from
        : i === reference.length / 2 - 1
          ? to
          : (1 - progress) * from + progress * to;
      expect(frames[i]!['offset']).toBe(i === 0 ? 0 : i === frames.length - 1 ? 1 : offset);
      expect(frames[i]!['x']).toBe(expectedValue);
    }
    expect(Math.max(...frames.map((frame) => Number(frame['x'])))).toBeGreaterThan(to);
  });

  it('WebKit production-keyframes сохраняют физическую v0 на первом сегменте', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    for (const v0 of [-1, 0, 1]) {
      const plan = compileSpringRuntimeExecutionPlanUnchecked({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        v0,
      });
      const second = plan.keyframes[1]!;
      const durationMs = plan.duration;
      const slope = Number(second['opacity']) / (Number(second['offset']) * durationMs / 1000);
      const machineBudget = Number.EPSILON * Math.max(1, Math.abs(v0)) * 4;
      expect(plan.easing).toBe('linear');
      expect(durationMs).toBe(settleTimeUpperBound(SPRING, v0) * 1000);
      expect(Math.abs(slope - v0)).toBeLessThanOrEqual(machineBudget);
    }
  });

  it('MAX↔-MAX остаётся конечным для монотонных critical/overdamped кривых', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    const max = Number.MAX_VALUE;
    const springs = [
      { mass: 1, stiffness: 100, damping: 20 },
      { mass: 1, stiffness: 100, damping: 40 },
    ];
    for (const spring of springs) {
      for (const [from, to] of [[max, -max], [-max, max]] as const) {
        const calls: AnimateCall[] = [];
        new CompositorSpring({
          spring,
          property: 'x',
          from,
          to,
          target: recordingTarget(calls),
        }).start();
        const values = calls[0]!.keyframes.map((frame) => Number(frame['x']));
        expect(values[0]).toBe(from);
        expect(values.at(-1)).toBe(to);
        expect(values.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('public compileSpringPlan отдаёт исполнимые adaptive keyframes на WebKit', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    const plan = compileSpringPlan({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
    });
    expect(plan.easing).toBe('linear');
    expect(plan.keyframes).toHaveLength(plan.nodes.length);
    expect(plan.keyframes.length).toBeGreaterThan(2);
    for (let i = 0; i < plan.keyframes.length; i++) {
      expect(plan.keyframes[i]!['offset']).toBe(plan.nodes[i]!.percent / 100);
      if (i > 0) {
        expect(Number(plan.keyframes[i]!['offset']))
          .toBeGreaterThan(Number(plan.keyframes[i - 1]!['offset']));
      }
      expect(plan.keyframes[i]!['opacity']).toBe(
        i === 0 ? 0 : i === plan.keyframes.length - 1 ? 1 : plan.nodes[i]!.progress,
      );
    }
  });

  it('Chromium сохраняет два keyframes и ранний CSS-linear путь', () => {
    stubEngine(
      'Google Inc.',
      'Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    );
    const calls: AnimateCall[] = [];
    new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target: recordingTarget(calls),
    }).start();
    expect(calls[0]!.keyframes).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    expect(String(calls[0]!.timing['easing']).startsWith('linear(')).toBe(true);
  });

  it('WebKit остаётся compositor без поддержки custom CSS linear()', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    );
    vi.stubGlobal('CSS', { supports: () => false });
    __resetDetectionCache();
    const calls: AnimateCall[] = [];
    const target = recordingTarget(calls);
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target,
    });
    expect(spring.tier).toBe('compositor');
    expect(supportsCompositor(target)).toBe(true);
    spring.start();
    expect(calls[0]!.timing['easing']).toBe('linear');
    expect(calls[0]!.keyframes.length).toBeGreaterThan(2);
  });

  it('engine policy требует одновременно Apple vendor и AppleWebKit', () => {
    expect(requiresExplicitSpringKeyframesFor(undefined)).toBe(false);
    expect(requiresExplicitSpringKeyframesFor({
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15',
    })).toBe(true);
    expect(requiresExplicitSpringKeyframesFor({
      vendor: 'Google Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36',
    })).toBe(false);
    expect(requiresExplicitSpringKeyframesFor({
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/128',
    })).toBe(false);
  });

  it('production identity читается один раз на realm и перечитывается после reset', () => {
    let reads = 0;
    vi.stubGlobal('navigator', {
      get vendor() {
        reads++;
        return 'Apple Computer, Inc.';
      },
      get userAgent() {
        reads++;
        return 'Mozilla/5.0 AppleWebKit/605.1.15 Safari/605.1.15';
      },
    });
    __resetDetectionCache();
    expect(requiresExplicitSpringKeyframes()).toBe(true);
    expect(requiresExplicitSpringKeyframes()).toBe(true);
    expect(reads).toBe(2);
    __resetDetectionCache();
    expect(requiresExplicitSpringKeyframes()).toBe(true);
    expect(reads).toBe(4);
  });

  it('WebKit stagger N=100 строит nodes O(1), не по разу на элемент', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    const before = work.builds;
    const calls: AnimateCall[][] = Array.from({ length: 100 }, () => []);
    const group = new CompositorStaggerGroup({
      spring: { mass: 1.125, stiffness: 237.125, damping: 19.125 },
      property: 'opacity',
      from: 0,
      to: 1,
      targets: calls.map((targetCalls) => recordingTarget(targetCalls)),
    });
    // Общий публичный plan сразу сеет защищённую execution-кривую: дети только
    // проецируют её в keyframes, сетка/RDP не повторяются.
    expect(work.builds - before).toBe(1);
    // Публичная диагностика caller-owned; мутация после конструктора не должна
    // отравить защищённые узлы общего исполняемого LRU.
    (group.plan.nodes[1] as { progress: number }).progress = 999;
    group.start();
    expect(work.builds - before).toBe(1);
    expect(calls[0]![0]!.keyframes.some((frame) => frame['opacity'] === 999)).toBe(false);
    group.destroy();
  });

  it('WebKit stagger N=100 строит raw-key q=null кривую ровно один раз', () => {
    stubEngine(
      'Apple Computer, Inc.',
      'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    );
    // mass·Q_MASS выходит за safe integer, хотя сама критическая пружина
    // валидна и быстро оседает. Raw exact fallback не должен вернуть N×RDP.
    const spring = { mass: 1e10, stiffness: 1e12, damping: 2e11 };
    const before = work.builds;
    const group = new CompositorStaggerGroup({
      spring,
      property: 'opacity',
      from: 0,
      to: 1,
      targets: Array.from({ length: 100 }, () => recordingTarget([])),
    });

    expect(work.builds - before).toBe(1);
    group.start();
    expect(work.builds - before).toBe(1);
    group.destroy();
  });

  it('Chromium второй production-план попадает в строковый LRU без нового node-build', () => {
    stubEngine(
      'Google Inc.',
      'Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    );
    const spring = { mass: 1.234567, stiffness: 287.6543, damping: 17.2468 };
    const before = work.builds;
    for (let i = 0; i < 2; i++) {
      new CompositorSpring({
        spring,
        property: 'opacity',
        from: 0,
        to: 1,
        tolerance: 0.00731,
        target: recordingTarget([]),
      }).start();
    }
    expect(work.builds - before).toBe(1);
  });
});
