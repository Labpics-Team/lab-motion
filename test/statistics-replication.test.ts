import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exactBinomialOrderStatisticBounds, pairedClusterBootstrap } from '../bench/compare/methodology.mjs';

import { legacyBootstrap, legacyBounds } from './fixtures/legacy-statistics.mjs';

it('сохраняет независимый reference побайтно равным исходному Git blob 393c0f5895d53a891c9c857f70cbae7f8cde953c', () => {
  const fixture = readFileSync(new URL('./fixtures/legacy-statistics.mjs', import.meta.url));
  const aliasSuffix = Buffer.from("\n// Exact pre-optimization module; aliases expose the reference API.\nexport { pairedClusterBootstrap as legacyBootstrap, exactBinomialOrderStatisticBounds as legacyBounds };\n");
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
