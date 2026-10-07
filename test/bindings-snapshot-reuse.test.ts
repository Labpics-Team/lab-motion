import { describe, expect, it, vi } from 'vitest';
import { createMotionBinding, type MotionBindingGoal } from '../src/bindings/index.js';

function freezesDuring(action: () => void): number {
  const spy = vi.spyOn(Object, 'freeze');
  try {
    action();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('привязка: снимки изменённых ролей', () => {
  it('повторная цель проверяется без новых замороженных снимков', () => {
    const received: MotionBindingGoal[] = [];
    const binding = createMotionBinding((x: number) => ({ position: { x, y: 2 } }), {
      position: goal => { received.push(goal); },
    });
    binding.update(1);
    expect(freezesDuring(() => binding.update(1))).toBe(0);
    expect(received).toHaveLength(1);
    expect(Object.isFrozen(received[0])).toBe(true);
    binding.destroy();
  });

  it('копируется только изменившаяся роль, включая прежние значения её соседей', () => {
    const seen: Record<string, MotionBindingGoal[]> = { position: [], appearance: [] };
    const binding = createMotionBinding((x: number) => ({
      position: { x, y: 2, scale: 1 }, appearance: { opacity: 1, color: '#fff' },
    }), {
      position: goal => { seen.position!.push(goal); },
      appearance: goal => { seen.appearance!.push(goal); },
    });
    binding.update(0);
    expect(freezesDuring(() => binding.update(1))).toBe(1);
    expect(seen.position).toEqual([{ x: 0, y: 2, scale: 1 }, { x: 1, y: 2, scale: 1 }]);
    expect(seen.appearance).toHaveLength(1);
    binding.destroy();
  });

  it('изменение последнего поля сохраняет порядок ключей и один read каждого getter', () => {
    const seen: MotionBindingGoal[] = [];
    const binding = createMotionBinding((goal: Record<string, number>) => ({ role: goal }), {
      role: goal => { seen.push(goal); },
    });
    binding.update({ x: 0, y: 1, scale: 1 });
    const reads: string[] = [];
    const input = {
      get scale() { reads.push('scale'); return 1; },
      get y() { reads.push('y'); return 1; },
      get x() { reads.push('x'); return 2; },
    };
    binding.update(input);
    expect(reads).toEqual(['scale', 'y', 'x']);
    expect(Object.keys(seen[1]!)).toEqual(['scale', 'y', 'x']);
    expect(seen[1]).toEqual({ scale: 1, y: 1, x: 2 });
    binding.destroy();
  });

  it('повторная ссылка на mutable input всё равно проверяется и снимается по значениям', () => {
    const input = { x: 0, y: 1 };
    const seen: MotionBindingGoal[] = [];
    const binding = createMotionBinding(() => ({ role: input }), {
      role: goal => { seen.push(goal); },
    });
    binding.update(undefined);
    input.x = 2;
    binding.update(undefined);
    input.y = 9;
    expect(seen).toEqual([{ x: 0, y: 1 }, { x: 2, y: 1 }]);
    binding.destroy();
  });

  it('неизменённый префикс снимается до getter, меняющего исходный объект', () => {
    const seen: MotionBindingGoal[] = [];
    const binding = createMotionBinding((goal: Record<string, number>) => ({ role: goal }), {
      role: goal => { seen.push(goal); },
    });
    binding.update({ x: 1, y: 0 });
    const input = { x: 1, get y() { input.x = 8; return 2; } };
    binding.update(input);
    expect(seen[1]).toEqual({ x: 1, y: 2 });
    binding.destroy();
  });

  it('вложенное возвращение к прежней цели сохраняет порядок всех изменений', () => {
    const seen: number[] = [];
    const binding = createMotionBinding((x: number) => ({ role: { x } }), {
      role: goal => {
        seen.push(goal.x);
        if (goal.x === 1) {
          binding.update(2);
          binding.update(0);
          binding.update(2);
        }
      },
    });
    binding.update(0);
    binding.update(1);
    expect(seen).toEqual([0, 1, 2, 0, 2]);
    binding.destroy();
  });

  it('равные цели не скрывают ошибку позднего getter и не отменяют живой ресурс', () => {
    const cancel = vi.fn();
    const port = vi.fn(() => ({ cancel }));
    const failure = new Error('model read');
    const binding = createMotionBinding((goal: Record<string, number>) => ({ role: goal }), { role: port });
    binding.update({ x: 0, y: 1 });
    expect(() => binding.update({ x: 0, get y(): number { throw failure; } })).toThrow(failure);
    expect(binding.state).toBe('active');
    expect(port).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    binding.update({ x: 0, y: 1 });
    expect(port).toHaveBeenCalledTimes(1);
    binding.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('числовое сравнение сохраняет различие +0 и -0', () => {
    const seen: number[] = [];
    const binding = createMotionBinding((x: number) => ({ role: { x } }), {
      role: goal => { seen.push(goal.x); },
    });
    binding.update(0);
    binding.update(-0);
    binding.update(-0);
    expect(seen).toHaveLength(2);
    expect(Object.is(seen[1], -0)).toBe(true);
    binding.destroy();
  });
});

it('1000 изменяемых моделей с перестановкой ключей совпадают с копирующим эталоном', () => {
  const roles = ['position', 'appearance', '__proto__', 'constructor'];
  const keys = ['x', 'y', 'opacity', '__proto__', 'constructor'];
  const values: Array<number | string> = [0, -0, 1, -1, Number.MAX_VALUE, '#fff', '', 'a\0b'];
  let seed = 0x4b1d19;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const input: Record<string, Record<string, number | string>> = Object.create(null);
  for (const role of roles) input[role] = Object.fromEntries(keys.map(key => [key, 0]));
  const received: Array<{ role: string; values: MotionBindingGoal; keys: string[] }> = [];
  const expected: typeof received = [];
  const latest: Record<string, MotionBindingGoal> = Object.create(null);
  const binding = createMotionBinding((model: typeof input) => model,
    Object.fromEntries(roles.map(role => [role, (goal: MotionBindingGoal) => {
      expect(Object.isFrozen(goal)).toBe(true);
      expect(Object.getPrototypeOf(goal)).toBeNull();
      received.push({ role, values: goal, keys: Object.keys(goal) });
    }])));
  for (let step = 0; step < 1000; step++) {
    const role = roles[next() % roles.length]!;
    const key = keys[next() % keys.length]!;
    input[role]![key] = values[next() % values.length]!;
    for (const role of roles) {
      const offset = next() % keys.length;
      const order = [...keys.slice(offset), ...keys.slice(0, offset)];
      input[role] = Object.fromEntries(order.map(key => [key, input[role]![key]!]));
      const copy = { ...input[role] };
      if (!latest[role] || keys.some(key => !Object.is(copy[key], latest[role]![key]))) {
        expected.push({ role, values: copy, keys: Object.keys(copy) });
      }
      latest[role] = copy;
    }
    const before = received.length;
    binding.update(input);
    expect(received.slice(before)).toEqual(expected.slice(before));
  }
  expect(received).toEqual(expected);
  binding.destroy();
});

it('вложенные равные снимки сравниваются с уже применённой очередью', () => {
  const seen: number[] = [];
  let queued = false;
  const binding = createMotionBinding((x: number) => ({ role: { x } }), {
    role: goal => {
      seen.push(goal.x);
      if (goal.x === 1 && !queued) {
        queued = true;
        binding.update(1);
        binding.update(2);
        binding.update(2);
      }
    },
  });
  binding.update(0);
  binding.update(1);
  expect(seen).toEqual([0, 1, 2]);
  binding.destroy();
});
