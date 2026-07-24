/**
 * compositor-cache-mass-invariance.test.ts — исполняемое ДОКАЗАТЕЛЬСТВО того
 * свойства, на котором стоит scale-инвариантный ключ кэша (#239).
 *
 * ЗАЧЕМ: ключ LRU сузился с сырых (m, k, c) до частных (ω²=k/m, c/m). Это
 * законно ТОЛЬКО если артефакт — бит-в-бит функция частных. Прежний тест пинил
 * это на одной «удачной» паре {1,170,26}/{2,340,52} (масштаб 2 — степень
 * двойки, где IEEE-округление точно по построению) и потому не мог упасть.
 * Состязательное ревью нашло контрпример на масштабе, не равном степени двойки:
 * `settleTimeAtRestUpperBound` считал ζ как c/(2·m·ω₀), где промежуточное
 * произведение 2·m·ω₀ округляется по-разному при разной массе, — и кэш начинал
 * отдавать ЧУЖОЙ артефакт (результат зависел от порядка компиляции).
 *
 * ЧТО ПИНИМ: (1) именно тот контрпример; (2) свойство на случайном корпусе
 * масс-эквивалентных троек — генератор берёт произвольную массу, а не масштаб
 * из степеней двойки. Mutation proof: вернуть в spring.ts форму
 * `c / (2 * m * omega0)` → оба блока RED.
 */

import { describe, expect, it } from 'vitest';

import {
  createSpringLinearCacheState,
  type SpringLinearCache,
} from '../src/compositor/cache';
import {
  clearSpringExecutionArtifactCacheUnchecked,
  compileRestingSpringExecutionArtifactTupleUnchecked,
  type SpringExecutionArtifactTuple,
  tryCompileSpringExecutionArtifactTupleUnchecked,
} from '../src/compositor/curve';
import { settleTimeAtRestUpperBound, settleTimeUpperBound } from '../src/spring';
import type { SpringParams } from '../src/types';

/** Компиляция в СВЕЖЕМ кэше: общий кэш схлопнул бы сравнение в тавтологию. */
function compileAlone(
  spring: SpringParams,
  v0: number,
  tolerance: number,
): SpringExecutionArtifactTuple | undefined {
  const cache: SpringLinearCache<SpringExecutionArtifactTuple> =
    createSpringLinearCacheState<SpringExecutionArtifactTuple>(4);
  return tryCompileSpringExecutionArtifactTupleUnchecked(spring, v0, tolerance, cache);
}

function expectBitIdenticalArtifacts(
  a: SpringExecutionArtifactTuple,
  b: SpringExecutionArtifactTuple,
  label: string,
): void {
  expect(a[0], `${label}: linear()-строка`).toBe(b[0]);
  expect(Object.is(a[2], b[2]), `${label}: durationMs ${a[2]} vs ${b[2]}`).toBe(true);
  expect(a[1].length, `${label}: длина samples`).toBe(b[1].length);
  for (let i = 0; i < a[1].length; i++) {
    expect(Object.is(a[1][i], b[1][i]), `${label}: samples[${i}]`).toBe(true);
  }
}

// Контрпример состязательного ревью: k/m и c/m совпадают бит-в-бит, масса — нет.
const COUNTEREXAMPLE_A: SpringParams = {
  mass: 1,
  stiffness: 468.5240518839676,
  damping: 25.07380844330127,
};
const COUNTEREXAMPLE_B: SpringParams = {
  mass: 8.088161650620476,
  stiffness: 3789.498268841225,
  damping: 202.80101588611325,
};

describe('#239: артефакт — бит-в-бит функция частных (k/m, c/m)', () => {
  it('контрпример ревью: одинаковые частные ⇒ одинаковый бюджет оседания', () => {
    // Предусловие контрпримера: частные РАВНЫ бит-в-бит, массы — различны.
    expect(COUNTEREXAMPLE_A.stiffness / COUNTEREXAMPLE_A.mass)
      .toBe(COUNTEREXAMPLE_B.stiffness / COUNTEREXAMPLE_B.mass);
    expect(COUNTEREXAMPLE_A.damping / COUNTEREXAMPLE_A.mass)
      .toBe(COUNTEREXAMPLE_B.damping / COUNTEREXAMPLE_B.mass);
    expect(COUNTEREXAMPLE_A.mass).not.toBe(COUNTEREXAMPLE_B.mass);

    expect(Object.is(
      settleTimeAtRestUpperBound(COUNTEREXAMPLE_A),
      settleTimeAtRestUpperBound(COUNTEREXAMPLE_B),
    )).toBe(true);
  });

  it('контрпример ревью: артефакт не зависит от порядка компиляции', () => {
    const a = compileAlone(COUNTEREXAMPLE_A, 0, 1 / 400)!;
    const b = compileAlone(COUNTEREXAMPLE_B, 0, 1 / 400)!;
    expect(a).toBeDefined();
    expectBitIdenticalArtifacts(a, b, 'контрпример');

    // Тот же кэш: B после A обязан быть тем же объектом (законное попадание),
    // а не «чужим планом», отличающимся от честной компиляции B.
    const shared = createSpringLinearCacheState<SpringExecutionArtifactTuple>(8);
    const first = tryCompileSpringExecutionArtifactTupleUnchecked(
      COUNTEREXAMPLE_A, 0, 1 / 400, shared,
    )!;
    const second = tryCompileSpringExecutionArtifactTupleUnchecked(
      COUNTEREXAMPLE_B, 0, 1 / 400, shared,
    )!;
    expect(second).toBe(first);
    expectBitIdenticalArtifacts(second, b, 'попадание против честной компиляции');
  });

  it('native resting-кэш живёт по ТОМУ ЖЕ закону идентичности, что generic LRU', () => {
    // Раньше resting-кэш ключевался сырыми (m,k,c), generic LRU — частными:
    // два закона в одном файле, различие не запинено. Теперь закон один.
    clearSpringExecutionArtifactCacheUnchecked();
    const first = compileRestingSpringExecutionArtifactTupleUnchecked(
      COUNTEREXAMPLE_A, 1 / 400,
    );
    const second = compileRestingSpringExecutionArtifactTupleUnchecked(
      COUNTEREXAMPLE_B, 1 / 400,
    );
    expect(second).toBe(first);

    // И тот же артефакт, что у generic-пути: два пути не расходятся байтами.
    clearSpringExecutionArtifactCacheUnchecked();
    const generic = compileAlone(COUNTEREXAMPLE_B, 0, 1 / 400)!;
    const resting = compileRestingSpringExecutionArtifactTupleUnchecked(
      COUNTEREXAMPLE_B, 1 / 400,
    );
    expectBitIdenticalArtifacts(resting, generic, 'resting против generic');
  });

  it('корпус масс-эквивалентных троек: 128 пар, произвольная масса', () => {
    // Seeded LCG (тот же приём, что в *finiteness-fuzz): воспроизводимо и без
    // зависимостей. Масштаб НЕ ограничен степенями двойки — прежний тест
    // проходил именно из-за такого ограничения.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    let pairs = 0;
    let attempts = 0;
    while (pairs < 128 && attempts < 20_000) {
      attempts++;
      const mass = 0.2 + rnd() * 4;
      const stiffness = 20 + rnd() * 2000;
      const damping = rnd() * 120;
      const omega2 = stiffness / mass;
      const perMass = damping / mass;
      const scaledMass = 0.3 + rnd() * 12;
      const partner: SpringParams = {
        mass: scaledMass,
        stiffness: omega2 * scaledMass,
        damping: perMass * scaledMass,
      };
      // Пара принимается, только если частные round-trip'ятся бит-в-бит:
      // именно такие тройки кэш обязан считать одним ключом.
      if (partner.stiffness / partner.mass !== omega2) continue;
      if (partner.damping / partner.mass !== perMass) continue;
      if (!Number.isFinite(partner.stiffness) || partner.stiffness <= 0) continue;

      const source: SpringParams = { mass, stiffness, damping };
      const label = `m=${mass} k=${stiffness} c=${damping} ↔ m=${scaledMass}`;

      // Бюджеты (они же — граница LM091) обязаны совпадать бит-в-бит.
      expect(Object.is(
        settleTimeAtRestUpperBound(source),
        settleTimeAtRestUpperBound(partner),
      ), `${label}: settle(v0=0)`).toBe(true);
      expect(Object.is(
        settleTimeUpperBound(source, 3.25),
        settleTimeUpperBound(partner, 3.25),
      ), `${label}: settle(v0≠0)`).toBe(true);

      const a = compileAlone(source, 0, 1 / 400);
      const b = compileAlone(partner, 0, 1 / 400);
      expect(a === undefined, `${label}: одинаковая компилируемость`)
        .toBe(b === undefined);
      if (a && b) expectBitIdenticalArtifacts(a, b, label);
      pairs++;
    }

    // Анти-вырожденность: корпус обязан быть непустым, иначе тест «зелёный» ни о чём.
    expect(pairs).toBe(128);
  });
});
