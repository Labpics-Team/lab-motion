/**
 * test/keyframes-lerp-value-pin.test.ts — точность линейной интерполяции
 * ПО ЗНАЧЕНИЮ на собственном слое ./keyframes.
 *
 * Класс (В, differential-oracle): QA-ревью PR #24 доказало, что мутант
 * «raw = v0» (интерполяция схлопнута в стартовую точку сегмента) ВЫЖИВАЕТ
 * во всём keyframes-сьюте — property-fuzz проверяет только конечность,
 * а точное значение пинилось лишь транзитивно потребителем (presets).
 * Слой обязан закрывать свой класс сам.
 *
 * Оракул: ручной lerp v0 + (v1 − v0) · localT против sampleKeyframes на
 * (а) детерминированной сетке точек и (б) seeded-LCG прогоне сегментов.
 *
 * RED-proof (диверсия): в src/keyframes/index.ts заменить
 *   `const raw = v0 + range * eased;` → `const raw = v0;`
 * → оба теста ниже красные (оракул расходится в середине сегмента).
 */

import { describe, expect, it } from 'vitest';
import { sampleKeyframes } from '../src/keyframes/index.js';

const linear = (t: number): number => t;

describe('./keyframes: lerp точен по значению (differential-oracle)', () => {
  it('середины и четверти сегментов совпадают с ручным lerp бит-в-бит', () => {
    const values = [0, 10, -5, 100];
    const times = [0, 0.25, 0.5, 1];
    const easings = [linear, linear, linear];

    const cases: Array<{ p: number; seg: number }> = [
      { p: 0.125, seg: 0 },
      { p: 0.0625, seg: 0 },
      { p: 0.375, seg: 1 },
      { p: 0.3125, seg: 1 },
      { p: 0.75, seg: 2 },
      { p: 0.875, seg: 2 },
    ];
    for (const { p, seg } of cases) {
      const t0 = times[seg]!;
      const t1 = times[seg + 1]!;
      const v0 = values[seg]!;
      const v1 = values[seg + 1]!;
      const localT = (p - t0) / (t1 - t0);
      const oracle = v0 + (v1 - v0) * localT;
      const got = sampleKeyframes(values, times, easings, p);
      expect(Object.is(got, oracle), `p=${p}: ${got} vs oracle ${oracle}`).toBe(true);
    }
  });

  it('seeded-LCG прогон: 2000 случайных (values, p) совпадают с оракулом', () => {
    // Детерминированный LCG (Numerical Recipes) — без Math.random.
    let seed = 0xdecafbad >>> 0;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let round = 0; round < 2000; round++) {
      const v0 = (next() - 0.5) * 2000;
      const v1 = (next() - 0.5) * 2000;
      const values = [v0, v1];
      const times = [0, 1];
      // Внутренняя точка сегмента (не края — края возвращают values[i] по контракту).
      const p = 0.001 + next() * 0.998;
      const oracle = v0 + (v1 - v0) * p;
      const got = sampleKeyframes(values, times, [linear], p);
      expect(Object.is(got, oracle), `round=${round} p=${p}: ${got} vs ${oracle}`).toBe(true);
    }
  });
});
