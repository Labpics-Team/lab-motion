import { describe, expect, it } from 'vitest';
import { MotionParamError, spring } from '../src/index.js';

/**
 * Property-тест закона CSS-safety: валидный аналитический прогон не возвращает
 * NaN или бесконечность. Seed фиксирован, поэтому любой сбой воспроизводим.
 *
 * MotionParamError допустим только на входах вне безопасного settle-домена.
 * Любое другое исключение является дефектом реализации и не проглатывается.
 */

/** Park–Miller LCG: детерминированный источник без runtime-зависимостей. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = Math.imul(48271, state) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function range(unit: number, min: number, max: number): number {
  return min + unit * (max - min);
}

describe('solver finiteness property fuzz', () => {
  it('produces finite value and velocity over 10 000 seeded samples', () => {
    const seed = 0xdeadbeef;
    const rand = lcg(seed);
    const samples = 10_000;
    const edges: Array<{ mass: number; stiffness: number; damping: number; t: number }> = [
      { mass: 1e-9, stiffness: 1e-9, damping: 0, t: 0 },
      { mass: 100, stiffness: 2000, damping: 200, t: 1 },
      { mass: 1, stiffness: 1, damping: 0, t: 0.5 },
      { mass: 50, stiffness: 1000, damping: 100, t: 0 },
      { mass: 0.001, stiffness: 0.001, damping: 0.001, t: 1 },
    ];

    const failures: string[] = [];
    let accepted = 0;

    for (let index = 0; index < samples; index++) {
      const sample =
        index < edges.length
          ? (edges[index] ?? { mass: 1, stiffness: 100, damping: 10, t: 0.5 })
          : {
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
        failures.push(
          `seed=${seed} sample=${index}: value=${result.value}, input=${JSON.stringify(sample)}`,
        );
      }
      if (!Number.isFinite(result.velocity)) {
        failures.push(
          `seed=${seed} sample=${index}: velocity=${result.velocity}, input=${JSON.stringify(sample)}`,
        );
      }
    }

    expect(accepted, 'fuzz-домен не должен целиком отбрасываться валидатором').toBeGreaterThan(0);
    expect(failures, `Найдены не-конечные выходы:\n${failures.join('\n')}`).toHaveLength(0);
  });
});
