import { describe, expect, it } from 'vitest';
import { exactBinomialOrderStatisticBounds, pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

import { legacyBootstrap, legacyBounds } from './fixtures/legacy-statistics.mjs';

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
