/**
 * Структурный TDD-пин горячего прямого кадра драйвера: один аналитический
 * вызов солвера несёт и проверку сходимости, и эмит значения. Число
 * вызовов — архитектурная метрика, поэтому тест не зависит от скорости CI.
 */

import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  calls: 0,
  times: [] as number[],
}));

vi.mock('../src/spring.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/spring.js')>();
  return {
    ...actual,
    springUnchecked(params: Parameters<typeof actual.springUnchecked>[0], t: number) {
      probe.calls++;
      probe.times.push(t);
      return actual.springUnchecked(params, t);
    },
  };
});

import { createDriver } from '../src/driver.js';

describe('driver: один вызов солвера на прямой кадр', () => {
  it('обычный незавершённый кадр использует один снимок для сходимости и onStep', () => {
    const queue: Array<(ts?: number) => void> = [];
    const steps: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: { mass: 1, stiffness: 170, damping: 14 },
      clamp: false,
      onStep: (value) => steps.push(value),
      requestFrame: (cb) => {
        queue.push(cb);
        return queue.length;
      },
    });

    probe.calls = 0;
    probe.times.length = 0;
    queue.shift()!(1000 / 60);

    expect(probe.calls).toBe(1);
    expect(probe.times).toEqual([1 / 60]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBeGreaterThan(0);
    expect(steps[0]).toBeLessThan(100);
    controls.complete();
  });
});
