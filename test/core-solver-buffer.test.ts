/**
 * Структурный seal нулевой кадровой аллокации ядра: drive и MotionValue
 * передают один caller-owned result в солвер на всём протяжении запуска.
 * Wall-clock здесь не подходит: уникальность ссылок детерминированно ловит
 * возврат к созданию объекта на каждом кадре независимо от машины CI.
 */
import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  calls: [] as Array<{
    v0: number;
    output: object | undefined;
  }>,
}));

vi.mock('../src/internal/solver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return {
    ...actual,
    solveSpring(...args: Parameters<typeof actual.solveSpring>) {
      probe.calls.push({ v0: args[2], output: args[3] });
      return actual.solveSpring(...args);
    },
  };
});

import { drive } from '../src/drive.js';
import { solveSpring } from '../src/internal/solver.js';
import { MotionValue } from '../src/motion-value.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function clock(): {
  requestFrame: (cb: (ts?: number) => void) => number;
  step: () => void;
  drain: () => void;
} {
  const queue: Array<(ts?: number) => void> = [];
  return {
    requestFrame(cb) {
      queue.push(cb);
      return queue.length;
    },
    step() {
      queue.shift()?.();
    },
    drain() {
      while (queue.length > 0) queue.shift()!();
    },
  };
}

function expectOneScratch(): void {
  expect(probe.calls.length).toBeGreaterThan(2);
  expect(probe.calls.every(({ output }) => output !== undefined)).toBe(true);
  expect(new Set(probe.calls.map(({ output }) => output)).size).toBe(1);
}

describe('ядро переиспользует result-buffer солвера', () => {
  it('drive не создаёт result на каждом кадре', () => {
    const c = clock();
    probe.calls.length = 0;
    void drive({
      from: 0,
      to: 100,
      spring: SPRING,
      clamp: false,
      onStep: () => {},
      requestFrame: c.requestFrame,
    });
    c.drain();
    expectOneScratch();
  });

  it('MotionValue не создаёт result на каждом кадре', () => {
    const c = clock();
    probe.calls.length = 0;
    const value = new MotionValue({ initial: 0, spring: SPRING, requestFrame: c.requestFrame });
    value.setTarget(100);
    c.drain();
    expectOneScratch();
    value.destroy();
  });

  it('solveSpring возвращает тот же scratch во всех режимах и при t=0', () => {
    const regimes = [
      { mass: 1, stiffness: 100, damping: 10 },
      { mass: 1, stiffness: 100, damping: 20 },
      { mass: 1, stiffness: 100, damping: 30 },
    ];
    const scratch = { value: NaN, velocity: NaN };

    for (const spring of regimes) {
      for (const t of [0, 1 / 60]) {
        expect(solveSpring(spring, t, -37, scratch)).toBe(scratch);
        expect(Number.isFinite(scratch.value)).toBe(true);
        expect(Number.isFinite(scratch.velocity)).toBe(true);
      }
    }
  });

  it('hostile IEEE-754 pickup сохраняет finite-гард нормализованной скорости', () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    const next = (value: number, up: boolean): number => {
      view.setFloat64(0, value);
      view.setBigUint64(0, view.getBigUint64(0) + (up ? 1n : -1n));
      return view.getFloat64(0);
    };
    const cases = [
      { initial: Number.MAX_VALUE, target: -Number.MAX_VALUE, velocity: Number.MAX_VALUE },
      { initial: -Number.MAX_VALUE, target: Number.MAX_VALUE, velocity: -Number.MAX_VALUE },
      { initial: Number.MAX_VALUE, target: Number.MAX_VALUE, velocity: -Number.MAX_VALUE },
      { initial: -Number.MAX_VALUE, target: -Number.MAX_VALUE, velocity: Number.MAX_VALUE },
      { initial: next(Number.MAX_VALUE, false), target: Number.MAX_VALUE, velocity: Number.MAX_VALUE },
      { initial: 1, target: next(1, true), velocity: Number.MIN_VALUE },
      { initial: -1, target: next(-1, true), velocity: -Number.MIN_VALUE },
      { initial: 1, target: next(1, true), velocity: -0 },
      { initial: -0, target: 0, velocity: 1 },
      { initial: 0, target: -0, velocity: -1 },
      // Конечные операнды не гарантируют конечное частное: guard обязан
      // погасить overflow до того, как v0 попадёт в аналитический солвер.
      { initial: 0, target: 2e-10, velocity: Number.MAX_VALUE },
    ];

    let sawQuotientOverflow = false;
    for (const { initial, target, velocity } of cases) {
      const targetRange = target - initial;
      const range =
        !(Math.abs(targetRange) > 1e-10) && velocity !== 0
          ? Math.sign(velocity) * Math.max(1e-10, Math.abs(initial) * Number.EPSILON)
          : targetRange;
      const quotient = velocity / range;
      const expected = Number.isFinite(quotient) ? quotient : 0;
      sawQuotientOverflow ||= !Number.isFinite(quotient);

      const c = clock();
      const value = new MotionValue({
        initial,
        initialVelocity: velocity,
        spring: SPRING,
        requestFrame: c.requestFrame,
      });
      probe.calls.length = 0;
      value.setTarget(target);
      c.step();

      expect(probe.calls).toHaveLength(1);
      expect(Object.is(probe.calls[0]!.v0, expected)).toBe(true);
      value.destroy();
    }
    expect(sawQuotientOverflow).toBe(true);
  });
});
