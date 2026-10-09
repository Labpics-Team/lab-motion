import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { exactBinomialOrderStatisticBounds, pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

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
    { name: 'нулевое отношение', lab: [[Number.MIN_VALUE], [Number.MIN_VALUE]], competitor: [[Number.MAX_VALUE], [Number.MAX_VALUE]] },
    { name: 'бесконечное отношение', lab: [[Number.MAX_VALUE], [Number.MAX_VALUE]], competitor: [[Number.MIN_VALUE], [Number.MIN_VALUE]] },
    { name: 'переполнение отдельного наблюдения', lab: [[1e-100, 1e-100], [1e-100, Number.MAX_VALUE]], competitor: [[1e200, 1e200], [1e200, 1e200]] },
  ])('сохраняет исходный отказ при fallback: $name', ({ lab, competitor }) => {
    const left = population(lab), right = population(competitor);
    const outcome = (operation: () => unknown) => {
      try { return { value: operation() }; }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        return { error: { name: (error as Error).name, message: (error as Error).message } };
      }
    };
    const expected = outcome(() => legacyBootstrap(left, right, { seed: 23, iterations: 257 }));
    expect(expected).toHaveProperty('error');
    expect(outcome(() => pairedClusterBootstrap(left, right, { seed: 23, iterations: 257 }))).toEqual(expected);
  });

  it('удерживает восемь пар рангов и пересчитывает вытесненный ключ', async () => {
    const source = readFileSync(new URL('../bench/compare/methodology.mjs', import.meta.url), 'utf8');
    // Временный модуль открывает состояние тесту, сохраняя исходные вычисления и публичный API.
    const address = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { binomialRanks };\n').toString('base64');
    const { exactBinomialOrderStatisticBounds: bounds, binomialRanks: cache } = await import(/* @vite-ignore */ address);
    const values = Array.from({ length: 48 }, (_, index) => index + 0.5);
    const keys: string[] = [];
    let firstRanks: unknown;
    for (let policy = 1; policy <= 12; policy++) {
      const probability = [BigInt(policy), 20n], alpha = [1n, 1000n];
      expect(bounds(values, probability, alpha)).toEqual(legacyBounds(values, probability, alpha));
      keys.push([...cache.keys()].at(-1));
      expect(cache.size).toBe(Math.min(policy, 8));
      expect([...cache.keys()]).toEqual(keys.slice(-8));
      if (policy === 1) {
        firstRanks = cache.get(keys[0]);
        bounds(values.map(value => value + 10), probability, alpha);
        expect(cache.get(keys[0])).toBe(firstRanks);
      }
    }
    expect(cache.has(keys[0])).toBe(false);
    expect(bounds(values, [1n, 20n], [1n, 1000n])).toEqual(legacyBounds(values, [1n, 20n], [1n, 1000n]));
    expect(cache.size).toBe(8);
    expect(cache.has(keys[0])).toBe(true);
    expect(cache.get(keys[0])).not.toBe(firstRanks);
    expect([...cache.keys()]).toEqual([...keys.slice(-7), keys[0]]);
  });
});
