import { describe, expect, it } from 'vitest';
import { MotionValue } from '../src/motion-value.js';

describe('MotionValue: сохранённая ориентация вырожденного bounded span', () => {
  it.each([0, -0])('начальный signed zero %s сохраняется при отрицательном импульсе', initial => {
    const queue: Array<(time?: number) => void> = [];
    const value = new MotionValue({
      initial, initialVelocity: -1,
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame(callback) { queue.push(callback); return 1; },
    });
    value.setTarget(Object.is(initial, -0) ? 0 : -0);
    queue.shift()!(0);
    queue.shift()!(1);
    // При равном span legacy from→target orientation остаётся неубывающей.
    // Положительный lower bound сохраняет +0; отрицательный допускает -0.
    expect(Object.is(value.value, initial)).toBe(true);
    expect(value.velocity).toBeLessThan(0);
    value.destroy();
    for (const callback of queue.splice(0)) callback(2);
    expect(queue).toHaveLength(0);
  });
});
