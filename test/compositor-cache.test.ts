/**
 * test/compositor-cache.test.ts — bounded exact-LRU cache linear()-строк.
 * Классы: А (roundtrip/eviction/recency), Д (LRU и верификация ключа).
 *
 * ── RED PROOF (мутации) ───────────────────────────────────────────────────────
 * - Убрать перенос hit в MRU → «recency: touched выживает» RED.
 * - Заменить exact LRU на CLOCK → дифференциальный policy-oracle RED.
 * - Убрать сверку полей в lookup (только хеш) → «отличный ключ → промах» RED.
 * - Сломать переиспользование узла при вытеснении → тесты eviction всё равно
 *   зелены (аллокация нового узла корректна), но контракт zero-alloc держится
 *   структурно (см. cache.ts): ветка попадания не аллоцирует и не рекомпилирует.
 *
 * Замечание о zero-alloc-на-попадании: строки в JS — примитивы, сравниваются по
 * значению, поэтому reference-identity их не отличает. Контракт доказывается
 * СТРУКТУРНО (lookup не содержит пути компиляции/аллокации) + стабильностью size
 * (повторная компиляция того же ключа НЕ растит кэш → путь попадания взят).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_CAPACITY,
  clearSpringLinearCache,
  createSpringLinearCacheState,
  lookupSpringLinearCache,
  springLinearCacheCapacity,
  springLinearCacheSize,
  storeSpringLinearCache,
} from '../src/compositor/cache.js';
import { createSpringLinearCache, compileSpringLinear } from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

// ─── SpringLinearCache state: прямой юнит bounded cache ──────────────────────

describe('compositor cache: functional state — roundtrip', () => {
  it('store → lookup возвращает то же значение; промах → undefined', () => {
    const c = createSpringLinearCacheState(4);
    expect(lookupSpringLinearCache(c, 1, 2, 3, 4, 5)).toBeUndefined();
    storeSpringLinearCache(c, 1, 2, 3, 4, 5, 'linear(A)');
    expect(lookupSpringLinearCache(c, 1, 2, 3, 4, 5)).toBe('linear(A)');
    expect(springLinearCacheSize(c)).toBe(1);
  });

  it('отличный хоть на одно поле ключ → промах (верификация ключа, не только хеш)', () => {
    const c = createSpringLinearCacheState(4);
    storeSpringLinearCache(c, 1, 2, 3, 4, 5, 'X');
    expect(lookupSpringLinearCache(c, 1, 2, 3, 4, 6)).toBeUndefined(); // e отличается
    expect(lookupSpringLinearCache(c, 9, 2, 3, 4, 5)).toBeUndefined(); // a отличается
    expect(lookupSpringLinearCache(c, 1, 2, 3, 4, 5)).toBe('X'); // точный ключ — попадание
  });

  it('повторный store того же ключа не растит size (перезапись на месте)', () => {
    const c = createSpringLinearCacheState(4);
    storeSpringLinearCache(c, 1, 1, 1, 1, 1, 'v1');
    storeSpringLinearCache(c, 1, 1, 1, 1, 1, 'v2');
    expect(springLinearCacheSize(c)).toBe(1);
    expect(lookupSpringLinearCache(c, 1, 1, 1, 1, 1)).toBe('v2');
  });

  it('generic node-pool сверяет raw exact-key при коллизии числового хеша', () => {
    const c = createSpringLinearCacheState<readonly { progress: number; percent: number }[]>(4);
    const oldNodes = [{ progress: 0, percent: 0 }];
    const nextNodes = [{ progress: 1, percent: 100 }];
    // Детерминированная коллизия числовой свёртки: +1 в первом поле ровно
    // компенсируется −31 во втором. Identity всё равно решают raw-поля.
    storeSpringLinearCache(c, 1, 0, 3, 4, 5, oldNodes);
    storeSpringLinearCache(c, 2, -31, 3, 4, 5, nextNodes);

    expect(lookupSpringLinearCache(c, 1, 0, 3, 4, 5)).toBeUndefined();
    expect(lookupSpringLinearCache(c, 2, -31, 3, 4, 5)).toBe(nextNodes);
    expect(springLinearCacheSize(c)).toBe(1);
  });
});

describe('compositor cache: exact-LRU вытеснение и recency', () => {
  it('size никогда не превышает capacity; холодный слот вытесняется', () => {
    const c = createSpringLinearCacheState(2);
    storeSpringLinearCache(c, 1, 0, 0, 0, 0, 'A');
    storeSpringLinearCache(c, 2, 0, 0, 0, 0, 'B');
    storeSpringLinearCache(c, 3, 0, 0, 0, 0, 'C'); // вытесняет A (самый старый)
    expect(springLinearCacheSize(c)).toBe(2);
    expect(lookupSpringLinearCache(c, 1, 0, 0, 0, 0)).toBeUndefined(); // A вытеснен
    expect(lookupSpringLinearCache(c, 2, 0, 0, 0, 0)).toBe('B');
    expect(lookupSpringLinearCache(c, 3, 0, 0, 0, 0)).toBe('C');
  });

  it('recency: lookup переносит ключ в MRU — вытесняется НЕ он', () => {
    const c = createSpringLinearCacheState(2);
    storeSpringLinearCache(c, 1, 0, 0, 0, 0, 'A');
    storeSpringLinearCache(c, 2, 0, 0, 0, 0, 'B');
    lookupSpringLinearCache(c, 1, 0, 0, 0, 0); // трогаем A → теперь B самый старый
    storeSpringLinearCache(c, 3, 0, 0, 0, 0, 'C'); // должно вытеснить B, не A
    expect(lookupSpringLinearCache(c, 1, 0, 0, 0, 0)).toBe('A'); // выжил (был тронут)
    expect(lookupSpringLinearCache(c, 2, 0, 0, 0, 0)).toBeUndefined(); // B вытеснен
    expect(lookupSpringLinearCache(c, 3, 0, 0, 0, 0)).toBe('C');
  });

  it('чтение WebKit-узлов участвует в том же LRU', () => {
    const c = createSpringLinearCacheState<readonly { progress: number; percent: number }[]>(2);
    const nodes = (progress: number) => [{ progress, percent: progress * 100 }];
    storeSpringLinearCache(c, 1, 0, 0, 0, 0, nodes(1));
    storeSpringLinearCache(c, 2, 0, 0, 0, 0, nodes(2));
    lookupSpringLinearCache(c, 1, 0, 0, 0, 0); // 1 становится MRU; 2 остаётся LRU
    storeSpringLinearCache(c, 3, 0, 0, 0, 0, nodes(3));

    expect(lookupSpringLinearCache(c, 1, 0, 0, 0, 0)).toBeDefined();
    expect(lookupSpringLinearCache(c, 2, 0, 0, 0, 0)).toBeUndefined();
    expect(lookupSpringLinearCache(c, 3, 0, 0, 0, 0)).toBeDefined();
    expect(springLinearCacheSize(c)).toBe(2);
  });

  it('policy точно совпадает с эталонным LRU на exhaustive и длинной трассе', () => {
    const assertTrace = (capacity: number, keys: readonly number[]): number => {
      const cache = createSpringLinearCacheState<number>(capacity);
      const model: number[] = [];
      let hits = 0;
      for (const key of keys) {
        const index = model.indexOf(key);
        const expectedHit = index >= 0;
        const actual = lookupSpringLinearCache(cache, key, 0, 0, 0, 0);
        expect(actual !== undefined).toBe(expectedHit);
        if (expectedHit) {
          hits++;
          model.splice(index, 1);
        } else {
          storeSpringLinearCache(cache, key, 0, 0, 0, 0, key);
          if (model.length === capacity) model.pop();
        }
        model.unshift(key);
      }
      return hits;
    };

    // Все трассы длины 6 над capacity+1 ключами: policy, а не отдельный пример.
    for (let capacity = 1; capacity <= 4; capacity++) {
      const radix = capacity + 1;
      for (let encoded = 0; encoded < radix ** 6; encoded++) {
        let value = encoded;
        const keys = new Array<number>(6);
        for (let i = 0; i < keys.length; i++) {
          keys[i] = value % radix;
          value = Math.floor(value / radix);
        }
        assertTrace(capacity, keys);
      }
    }

    // Регулярный период, который отличает LRU от CLOCK при capacity=4:
    // первый круг даёт 4 hit, каждый следующий — 7; факт меняется с policy.
    const period = [4, 6, 6, 0, 2, 4, 3, 0, 2];
    expect(assertTrace(4, Array.from({ length: 100 }, () => period).flat())).toBe(697);
  });

  it('clear опустошает кэш', () => {
    const c = createSpringLinearCacheState(4);
    storeSpringLinearCache(c, 1, 2, 3, 4, 5, 'X');
    clearSpringLinearCache(c);
    expect(springLinearCacheSize(c)).toBe(0);
    expect(lookupSpringLinearCache(c, 1, 2, 3, 4, 5)).toBeUndefined();
  });

  it('невалидная ёмкость → дефолт', () => {
    const hostile: unknown[] = [
      0,
      -5,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2',
      true,
      new Number(2),
      { valueOf: () => 2 },
      Symbol('2'),
      2n,
    ];
    for (const input of hostile) {
      const capacity = input as number;
      const state = createSpringLinearCacheState<number>(capacity);
      expect(springLinearCacheCapacity(state)).toBe(DEFAULT_CACHE_CAPACITY);
      for (let key = 0; key <= DEFAULT_CACHE_CAPACITY; key++) {
        storeSpringLinearCache(state, key, 0, 0, 0, 0, key);
      }
      expect(springLinearCacheSize(state)).toBe(DEFAULT_CACHE_CAPACITY);
      expect(createSpringLinearCache(capacity).capacity).toBe(DEFAULT_CACHE_CAPACITY);
    }
    expect(createSpringLinearCache(8).capacity).toBe(8);
  });

  it('заполнение + поток промахов держит size = capacity и переиспользует слоты', () => {
    const c = createSpringLinearCacheState(3);
    for (let i = 0; i < 50; i++) storeSpringLinearCache(c, i, 0, 0, 0, 0, `v${i}`);
    expect(springLinearCacheSize(c)).toBe(3);
    // Последние три должны быть на месте.
    expect(lookupSpringLinearCache(c, 49, 0, 0, 0, 0)).toBe('v49');
    expect(lookupSpringLinearCache(c, 48, 0, 0, 0, 0)).toBe('v48');
    expect(lookupSpringLinearCache(c, 47, 0, 0, 0, 0)).toBe('v47');
    expect(lookupSpringLinearCache(c, 46, 0, 0, 0, 0)).toBeUndefined();
  });

  it('часто читаемый слот переживает поток cold-miss без роста cache', () => {
    const c = createSpringLinearCacheState<number>(4);
    for (let key = 0; key < 4; key++) storeSpringLinearCache(c, key, 0, 0, 0, 0, key);
    for (let key = 4; key < 100; key++) {
      expect(lookupSpringLinearCache(c, 0, 0, 0, 0, 0)).toBe(0);
      storeSpringLinearCache(c, key, 0, 0, 0, 0, key);
      expect(springLinearCacheSize(c)).toBe(4);
    }
    expect(lookupSpringLinearCache(c, 0, 0, 0, 0, 0)).toBe(0);
  });
});

// ─── createSpringLinearCache / compileSpringLinear: контракт кэша компилятора ─

const A: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const B: SpringParams = { mass: 1, stiffness: 180, damping: 8 };
const C: SpringParams = { mass: 1, stiffness: 120, damping: 30 };

describe('compositor cache: компилятор поверх кэша', () => {
  it('изолированный кэш: одинаковая пружина не растит size (путь попадания)', () => {
    const compiler = createSpringLinearCache(8);
    const s1 = compiler.compile(A);
    expect(compiler.size).toBe(1);
    const s2 = compiler.compile(A);
    expect(compiler.size).toBe(1); // попадание, не новая запись
    expect(s1).toBe(s2); // одинаковый результат
  });

  it('разные пружины → разные строки и рост кэша', () => {
    const compiler = createSpringLinearCache(8);
    const sa = compiler.compile(A);
    const sb = compiler.compile(B);
    expect(sa).not.toBe(sb);
    expect(compiler.size).toBe(2);
  });

  it('ёмкость соблюдается: size ≤ capacity при потоке разных пружин', () => {
    const compiler = createSpringLinearCache(2);
    compiler.compile(A);
    compiler.compile(B);
    compiler.compile(C); // вытесняет A
    expect(compiler.size).toBeLessThanOrEqual(2);
  });

  it('результат изолированного кэша == общего compileSpringLinear (одинаковая математика)', () => {
    const compiler = createSpringLinearCache(4);
    expect(compiler.compile(A)).toBe(compileSpringLinear(A));
    expect(compiler.compile(B, { tolerance: 0.001 })).toBe(
      compileSpringLinear(B, { tolerance: 0.001 }),
    );
  });

  it('clear компилятора сбрасывает кэш', () => {
    const compiler = createSpringLinearCache(4);
    compiler.compile(A);
    expect(compiler.size).toBe(1);
    compiler.clear();
    expect(compiler.size).toBe(0);
  });

  it('exact-key: даже близкие коэффициенты не смешивают физику', () => {
    const compiler = createSpringLinearCache(8);
    compiler.compile({ mass: 1, stiffness: 170, damping: 26 });
    compiler.compile({ mass: 1, stiffness: 170.000001, damping: 26 });
    expect(compiler.size).toBe(2);
    compiler.compile({ mass: 1, stiffness: 175, damping: 26 });
    expect(compiler.size).toBe(3);
  });
});

// ─── #239: scale-инвариантный exact-key (k/m, c/m) ───────────────────────────
//
// Артефакт — функция битовых частных ω²=k/m и c/m (канонические первые
// операции всех потребителей, #226), поэтому масс-эквивалентные тройки
// обязаны делить ОДИН слот кэша и получать бит-идентичный артефакт.
// Mutation proof: вернуть ключ (m,k,c) → size станет 2 и identity-ассерт падёт.

describe('#239: масс-эквивалентные пружины делят один слот кэша', () => {
  it('{m:2,k:340,c:52} — cache hit артефакта {m:1,k:170,c:26}, один слот', async () => {
    const { tryCompileSpringExecutionArtifactTupleUnchecked } = await import('../src/compositor/curve.js');
    const { createSpringLinearCacheState, springLinearCacheSize } = await import('../src/compositor/cache.js');
    const cache = createSpringLinearCacheState<never[]>(8) as never;
    const base = tryCompileSpringExecutionArtifactTupleUnchecked(
      { mass: 1, stiffness: 170, damping: 26 }, 0, 1 / 400, cache,
    );
    const scaled = tryCompileSpringExecutionArtifactTupleUnchecked(
      { mass: 2, stiffness: 340, damping: 52 }, 0, 1 / 400, cache,
    );
    expect(base).toBeDefined();
    expect(scaled).toBe(base); // тот же tuple-объект: hit, не перекомпиляция
    expect(springLinearCacheSize(cache)).toBe(1);
  });

  it('другая физика (то же k/m, другой c/m) — честный промах', async () => {
    const { tryCompileSpringExecutionArtifactTupleUnchecked } = await import('../src/compositor/curve.js');
    const { createSpringLinearCacheState, springLinearCacheSize } = await import('../src/compositor/cache.js');
    const cache = createSpringLinearCacheState<never[]>(8) as never;
    tryCompileSpringExecutionArtifactTupleUnchecked({ mass: 1, stiffness: 170, damping: 26 }, 0, 1 / 400, cache);
    tryCompileSpringExecutionArtifactTupleUnchecked({ mass: 1, stiffness: 170, damping: 27 }, 0, 1 / 400, cache);
    expect(springLinearCacheSize(cache)).toBe(2);
  });
});
