/**
 * compositor-compile-work.test.ts — машинный бюджет работы компилятора.
 *
 * Время на разных машинах шумит, поэтому seal считает доминирующую работу:
 * построение адаптивной сетки/RDP. Публичный план обязан построить диагностические
 * nodes ровно один раз, а production-путь детей — переиспользовать bounded cache
 * без скрытого построения неиспользуемых diagnostics.
 */

import { describe, expect, it, vi } from 'vitest';

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
  CompositorStaggerGroup,
} from '../src/compositor/stagger/index.js';
import { roundShortest } from '../src/compositor/format.js';
import type { SpringNode } from '../src/compositor/segmenter.js';

function target(): {
  animate(
    keyframes: Record<string, string | number>[],
    timing: object,
  ): { cancel(): void };
} {
  return {
    animate() {
      return { cancel(): void {} };
    },
  };
}

function emit(nodes: readonly SpringNode[], tolerance = 1 / 400): string {
  let maxSlope = 0;
  let minGap = 100;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const gap = b.percent - a.percent;
    maxSlope = Math.max(maxSlope, Math.abs((b.progress - a.progress) / gap));
    minGap = Math.min(minGap, gap);
  }
  const progressDigits = Math.max(4, Math.ceil(Math.log10(8 / tolerance)));
  const percentDigits = Math.max(
    3,
    Math.ceil(Math.log10(8 * maxSlope / tolerance)),
    Math.ceil(Math.log10(2 / minGap)),
  );
  let out = 'linear(';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const progress = i === 1 || progressDigits > 100
      ? String(node.progress)
      : roundShortest(node.progress, progressDigits);
    const percent = i === 1 || percentDigits > 100
      ? String(node.percent)
      : roundShortest(node.percent, percentDigits);
    out += `${progress} ${percent}%`;
    if (i < nodes.length - 1) out += ', ';
  }
  return `${out})`;
}

describe('compositor: бюджет компиляции curve', () => {
  it('cold compileSpringPlan строит nodes один раз и эмитит easing из них', () => {
    const before = work.builds;
    const plan = compileSpringPlan({
      spring: {
        mass: 0.8360063795698807,
        stiffness: 466.1481373012066,
        damping: 11.70013600261882,
      },
      property: 'x',
      from: 0,
      to: 1,
      v0: 1.4615731034427881,
      tolerance: 0.008828559996560216,
    });

    expect(work.builds - before).toBe(1);
    expect(emit(plan.nodes, 0.008828559996560216)).toBe(plan.easing);
  });

  it('группа строит общие nodes один раз, start N детей не строит diagnostics', () => {
    const spring = { mass: 1.125, stiffness: 237.125, damping: 19.125 };
    const targets = Array.from({ length: 50 }, target);
    const before = work.builds;
    const group = new CompositorStaggerGroup({
      spring,
      property: 'opacity',
      from: 0,
      to: 1,
      targets,
      gap: 10,
    });

    expect(work.builds - before).toBe(1);
    group.start();
    expect(work.builds - before).toBe(1);
    group.destroy();
  });

  it('plan.nodes свежи: диагностика одного вызова не отравляет следующий', () => {
    const options = {
      spring: { mass: 1, stiffness: 191, damping: 24 },
      property: 'x',
      from: 0,
      to: 1,
    } as const;
    const before = work.builds;
    const first = compileSpringPlan(options);
    const second = compileSpringPlan(options);

    // Внутренняя подготовленная кривая общая, наружу каждый раз выходит только
    // свежая копия диагностики: повторный public-plan не должен заново гонять grid/RDP.
    expect(work.builds - before).toBe(1);
    expect(first.nodes).not.toBe(second.nodes);
    const original = second.nodes[0]!.progress;
    (first.nodes as SpringNode[])[0] = { progress: 999, percent: 999 };
    expect(second.nodes[0]!.progress).toBe(original);
    expect(emit(second.nodes)).toBe(second.easing);
  });
});
