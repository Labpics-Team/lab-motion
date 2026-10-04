import { expect, it } from 'vitest';
import { MotionValue } from '../src/index.js';

it('одна заявка кадра не размножает цикл при повторной доставке', () => {
  const queue: Array<(timestamp?: number) => void> = [];
  const value = new MotionValue({
    initial: 0,
    spring: { mass: 1, stiffness: 200, damping: 20 },
    requestFrame(callback) { queue.push(callback); return 1; },
  });
  let emissions = 0;
  value.onChange(() => emissions++);
  value.setTarget(1);
  const delivered = queue.shift()!;
  delivered();
  const snapshot = [value.value, value.velocity, emissions];
  try {
    // Повтор старой заявки не заменяет отдельную заявку следующего кадра.
    delivered();
    expect([value.value, value.velocity, emissions]).toEqual(snapshot);
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(value.value).toBeGreaterThan(snapshot[0]!);
    expect(emissions).toBe(snapshot[2]! + 1);
    expect(queue).toHaveLength(1);
  } finally {
    value.destroy();
    for (const callback of queue) callback();
  }
});
