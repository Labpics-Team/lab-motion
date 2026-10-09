import assert, { AssertionError } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRankCache, RANK_CACHE_LIMIT, exactBinomialOrderStatisticBounds, pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

import { legacyBootstrap, legacyBounds } from './fixtures/legacy-statistics.mjs';

it('сохраняет независимый reference побайтно равным исходному Git blob 393c0f5895d53a891c9c857f70cbae7f8cde953c', () => {
  const fixture = readFileSync(new URL('./fixtures/legacy-statistics.mjs', import.meta.url));
  const aliasSuffix = Buffer.from("\n// Исходная статистика; псевдонимы открывают её тестам.\nexport { pairedClusterBootstrap as legacyBootstrap, exactBinomialOrderStatisticBounds as legacyBounds };\n");
  expect(fixture.subarray(-aliasSuffix.length)).toEqual(aliasSuffix);
  expect(createHash('sha256').update(fixture.subarray(0, -aliasSuffix.length)).digest('hex'))
    .toBe('a6440e56752573684809765ba992ce01b0993a889e130f16eb870cd1fcbcda87');
});

describe('точная статистика после устранения повторных сортировок', () => {
  for (const seed of [0, 1, 4294967295, 2 ** 40 + 1]) {
    it.each([1, 2, 5])('сохраняет paired draws seed=' + seed + ', observations=%s', observations => {
      const population = (scale: number, semantic: boolean) => Array.from({ length: 7 }, (_, run) => ({
        run, semantic, samples: Array.from({ length: observations }, (_, sample) =>
          scale * (1 + ((run * 17 + sample * 13) % 11) / 16)),
      }));
      const lab = population(1e-120, true), competitor = population(3e-120, seed !== 1);
      expect(pairedClusterBootstrap(lab, competitor, { seed, iterations: 137 }))
        .toEqual(legacyBootstrap(lab, competitor, { seed, iterations: 137 }));
    });
  }
  it('сохраняет полный default из 10 000 реплик и конечные крупные observations', () => {
    const lab = [{ run: 0, semantic: true, samples: [1e200, 1e200 + 1e185] },
      { run: 1, semantic: true, samples: [2e200, 2e200] }];
    const competitor = lab.map(cluster => ({ ...cluster, samples: cluster.samples.map(value => value * 2) }));
    expect(pairedClusterBootstrap(lab, competitor, { seed: 77 })).toEqual(legacyBootstrap(lab, competitor, { seed: 77 }));
  });
  it('ранги общего размера/политики сохраняют независимые значения и восстановление после eviction', () => {
    for (let policy = 1; policy <= 12; policy++) {
      const probability = [BigInt(policy), 20n], alpha = [1n, 1000n];
      for (const offset of [0, 19, 1e120]) {
        const values = Array.from({ length: 48 }, (_, index) => offset + (47 - index) * 2);
        expect(exactBinomialOrderStatisticBounds(values, probability, alpha))
          .toEqual(legacyBounds(values, probability, alpha));
      }
    }
    const values = Array.from({ length: 48 }, (_, index) => index + 0.5);
    expect(exactBinomialOrderStatisticBounds(values, [1n, 20n], [1n, 1000n]))
      .toEqual(legacyBounds(values, [1n, 20n], [1n, 1000n]));
  });
});

describe('границы оптимизированной статистики', () => {
  const population = (rows: number[][]) => rows.map((samples, run) => ({ run, semantic: true, samples }));

  it.each([0, 23, 4294967295])('сохраняет непропорциональные пары и ненулевую нулевую гипотезу, seed=%s', seed => {
    const lab = population([[1, 2], [80, 120], [6, 9]]);
    const competitor = population([[70, 80], [1, 3], [7, 10]]);
    const options = { seed, iterations: 257 };
    const expected = legacyBootstrap(lab, competitor, options);
    const actual = pairedClusterBootstrap(lab, competitor, options);
    expect(actual).toEqual(expected);
    expect(actual.pValue).toBeGreaterThan(1 / (options.iterations + 1));
    expect(actual.pValue).toBeLessThan(1);
  });

  it('выполняет все парные выборки полного стандартного bootstrap', () => {
    const lab = population([[1, 2], [80, 120], [6, 9]]);
    const competitor = population([[70, 80], [1, 3], [7, 10]]);
    const expected = legacyBootstrap(lab, competitor, { seed: 77 });
    const draws = vi.spyOn(Math, 'imul');
    try {
      Math.imul(2, 3);
      expect(draws).toHaveBeenCalledOnce();
      draws.mockClear();
      expect(pairedClusterBootstrap(lab, competitor, { seed: 77 })).toEqual(expected);
      expect(draws).toHaveBeenCalledTimes(lab.length * 10_000);
    } finally {
      draws.mockRestore();
    }
  });

  it.each([
    { name: 'нулевое отношение', result: 'error', lab: [[Number.MIN_VALUE], [Number.MIN_VALUE]], competitor: [[Number.MAX_VALUE], [Number.MAX_VALUE]] },
    { name: 'бесконечное отношение', result: 'value', lab: [[Number.MAX_VALUE], [Number.MAX_VALUE]], competitor: [[Number.MIN_VALUE], [Number.MIN_VALUE]] },
    { name: 'переполнение отдельного наблюдения', result: 'error', lab: [[1e-100, 1e-100], [1e-100, Number.MAX_VALUE]], competitor: [[1e200, 1e200], [1e200, 1e200]] },
  ])('сохраняет исходное поведение fallback: $name', ({ lab, competitor, result }) => {
    const left = population(lab), right = population(competitor);
    const outcome = (operation: () => unknown) => {
      try { return { value: operation() }; }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        return { error: { name: (error as Error).name, message: (error as Error).message } };
      }
    };
    const expected = outcome(() => legacyBootstrap(left, right, { seed: 23, iterations: 257 }));
    expect(expected).toHaveProperty(result);
    if (result === 'value') expect(expected).toHaveProperty('value.p50.ratio', Number.POSITIVE_INFINITY);
    expect(outcome(() => pairedClusterBootstrap(left, right, { seed: 23, iterations: 257 }))).toEqual(expected);
  });

});

type RankParameters = [number, bigint, bigint, bigint, bigint];
type RankPair = { lowRank: number; highRank: number | null };
type RankCache = { readonly size: number; get(...parameters: RankParameters): RankPair };
type RankCacheFactory = (calculate: (...parameters: RankParameters) => RankPair) => RankCache;

const rankParameters: RankParameters[] = [
  [48, 3n, 20n, 1n, 1000n],
  [49, 3n, 20n, 1n, 1000n],
  [48, 4n, 20n, 1n, 1000n],
  [48, 3n, 21n, 1n, 1000n],
  [48, 3n, 20n, 2n, 1000n],
  [48, 3n, 20n, 1n, 1001n],
  ...Array.from({ length: RANK_CACHE_LIMIT }, (_, index): RankParameters => [64 + index, 3n, 20n, 1n, 1000n]),
];

function assertRankCache(factory: RankCacheFactory): void {
  const calls: RankParameters[] = [];
  const cache = factory((...parameters) => {
    calls.push(parameters);
    return { lowRank: calls.length, highRank: null };
  });
  let first: RankPair | undefined;
  assert.equal(cache.size, 0);
  for (const [index, parameters] of rankParameters.entries()) {
    const before = calls.length;
    const result = cache.get(...parameters);
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), parameters);
    assert.equal(cache.size, Math.min(index + 1, RANK_CACHE_LIMIT));
    assert.equal(cache.get(...parameters), result);
    assert.equal(calls.length, before + 1);
    assert.ok(Object.isFrozen(result));
    if (index === 0) first = result;
    if (index === RANK_CACHE_LIMIT - 1) {
      assert.equal(cache.get(...rankParameters[0]), first);
      assert.equal(calls.length, before + 1);
    }
  }
  const before = calls.length;
  const restored = cache.get(...rankParameters[0]);
  assert.equal(calls.length, before + 1);
  assert.notEqual(restored, first);
  assert.equal(cache.size, RANK_CACHE_LIMIT);
}

describe('ограниченная память биномиальных рангов', () => {
  it('различает все параметры, повторно использует пару и вытесняет старейшую', () => {
    assertRankCache(createRankCache);
  });

  it('сохраняет результаты публичной статистики при изменении каждого параметра ключа', () => {
    for (const [n, numerator, denominator, alphaNumerator, alphaDenominator] of [...rankParameters, ...rankParameters].reverse()) {
      const values = Array.from({ length: n }, (_, index) => index + 0.5);
      const probability = [numerator, denominator], alpha = [alphaNumerator, alphaDenominator];
      expect(exactBinomialOrderStatisticBounds(values, probability, alpha)).toEqual(legacyBounds(values, probability, alpha));
    }
  });

  it('сохраняет уже рассчитанное после отказа новой вычисляемой пары', () => {
    const calculate = vi.fn(() => ({ lowRank: 1, highRank: null }));
    const cache = createRankCache(calculate);
    const first = cache.get(...rankParameters[0]);
    calculate.mockImplementationOnce(() => { throw new Error('Расчёт недоступен'); });
    expect(() => cache.get(...rankParameters[1])).toThrow('Расчёт недоступен');
    expect(cache.size).toBe(1);
    expect(cache.get(...rankParameters[0])).toBe(first);
  });

  const key = 'const key = [n, numerator, denominator, alphaNumerator, alphaDenominator].join';
  const mutants = [
    ['размер выборки', key, 'const key = [numerator, denominator, alphaNumerator, alphaDenominator].join'],
    ['числитель вероятности', key, 'const key = [n, denominator, alphaNumerator, alphaDenominator].join'],
    ['знаменатель вероятности', key, 'const key = [n, numerator, alphaNumerator, alphaDenominator].join'],
    ['числитель хвоста', key, 'const key = [n, numerator, denominator, alphaDenominator].join'],
    ['знаменатель хвоста', key, 'const key = [n, numerator, denominator, alphaNumerator].join'],
    ['отключённое вытеснение', 'if (entries.size === RANK_CACHE_LIMIT)', 'if (false)'],
    ['отключённый повтор', 'if (known) return known;', 'if (false) return known;'],
  ];
  it.each(mutants)('обнаруживает намеренное повреждение: %s', async (_name, before, after) => {
    const source = readFileSync(new URL('../bench/compare/methodology.mjs', import.meta.url), 'utf8');
    expect(source.split(before)).toHaveLength(2);
    // Каждый мутант меняет один оператор настоящего модуля; контракт проверяется тем же oracle.
    const address = 'data:text/javascript;base64,' + Buffer.from(source.replace(before, after)).toString('base64');
    const altered = await import(/* @vite-ignore */ address);
    expect(() => assertRankCache(altered.createRankCache)).toThrow(AssertionError);
  });
});
