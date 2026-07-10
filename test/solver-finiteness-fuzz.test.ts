import { describe, expect, it } from 'vitest';
import { MotionParamError, spring } from '../src/index.js';

/**
 * Property/fuzz-гейт финитности аналитического солвера.
 *
 * Зачем: любое нечисловое значение, вышедшее из домена, может сделать CSS-
 * свойство невалидным и разрушить последующие вычисления. Seeded LCG делает
 * пространство входов воспроизводимым без runtime-зависимости от fuzz-фреймворка.
 *
 * Тест не проглатывает произвольные исключения и требует достаточное число
 * реально принятых конфигураций. Поэтому реализация «отклонять всё» не может
 * превратить fuzz-цикл в ложный GREEN.
 */

/** Park–Miller LCG: одинаковый seed даёт одинаковый набор входов. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = Math.imul(48271, s) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function range(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

describe('solver finiteness property fuzz (invariant 2)', () => {
  it('produces finite value and velocity over a reproducible parameter space', () => {
    const rand = lcg(0xdeadbeef);
    const SAMPLES = 500;
    const MIN_ACCEPTED = 400;

    const edges: ReadonlyArray<{
      mass: number;
      stiffness: number;
      damping: number;
      t: number;
    }> = [
      { mass: 1e-9, stiffness: 1e-9, damping: 0, t: 0 },
      { mass: 100, stiffness: 2000, damping: 200, t: 1 },
      { mass: 1, stiffness: 1, damping: 0, t: 0.5 },
      { mass: 50, stiffness: 1000, damping: 100, t: 0 },
      { mass: 0.001, stiffness: 0.001, damping: 0.001, t: 1 },
    ];

    const failures: string[] = [];
    let accepted = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const sample =
        edges[i] ?? {
          mass: range(rand(), 1e-9, 100),
          stiffness: range(rand(), 1e-9, 2000),
          damping: range(rand(), 0, 200),
          t: rand(),
        };

      let result: { value: number; velocity: number };
      try {
        result = spring(sample, sample.t);
      } catch (error: unknown) {
        if (error instanceof MotionParamError) continue;
        throw error;
      }

      accepted++;

      if (!Number.isFinite(result.value)) {
        failures.push(`sample ${i}: value=${result.value}; input=${JSON.stringify(sample)}`);
      }
      if (!Number.isFinite(result.velocity)) {
        failures.push(`sample ${i}: velocity=${result.velocity}; input=${JSON.stringify(sample)}`);
      }
    }

    expect(accepted, 'fuzz-domain collapsed into parameter rejection').toBeGreaterThanOrEqual(
      MIN_ACCEPTED,
    );
    expect(
      failures,
      `Non-finite solver output:\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });
});
