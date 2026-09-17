import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalGzip,
  observationalBrotli,
} from '../scripts/compression-oracle.mjs';

const BASE = {
  esm: { raw: 19_441, gzip: 6_837, brotli: 6_176 },
  cjs: { raw: 19_455, gzip: 6_838, brotli: 6_173 },
} as const;

function bytes(path: string) {
  const raw = readFileSync(path);
  return {
    raw: raw.byteLength,
    gzip: canonicalGzip(raw).byteLength,
    brotli: observationalBrotli(raw).byteLength,
  };
}

describe('./smart strict Pareto budget', () => {
  it.each([
    ['esm', 'dist/smart/index.js'],
    ['cjs', 'dist/smart/index.cjs'],
  ] as const)('%s не покупает JOURNEY-semantics ростом protected bytes', (kind, path) => {
    const actual = bytes(path);
    const ceiling = BASE[kind];

    expect(actual.raw, `${kind} raw`).toBeLessThanOrEqual(ceiling.raw);
    expect(actual.gzip, `${kind} canonical gzip`).toBeLessThanOrEqual(ceiling.gzip);
    expect(actual.brotli, `${kind} Brotli`).toBeLessThanOrEqual(ceiling.brotli);
  });
});
