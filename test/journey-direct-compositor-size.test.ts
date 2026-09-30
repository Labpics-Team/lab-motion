import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalGzip, observationalBrotli } from '../scripts/compression-oracle.mjs';

/** First admitted JOURNEY-01 direct-control artifact; ceilings only ratchet down. */
const MAX = {
  esm: { raw: 18_221, gzip: 7_033, brotli: 6_423 },
  cjs: { raw: 18_226, gzip: 7_024, brotli: 6_418 },
} as const;

function vector(path: string) {
  const bytes = readFileSync(resolve(path));
  return {
    raw: bytes.length,
    gzip: canonicalGzip(bytes).length,
    brotli: observationalBrotli(bytes).length,
  };
}

describe('JOURNEY-01 direct-control optional-entry resource vector', () => {
  it('does not grow any admitted ESM/CJS byte cell', () => {
    const esm = vector('dist/behaviors/compositor/index.js');
    const cjs = vector('dist/behaviors/compositor/index.cjs');
    for (const key of ['raw', 'gzip', 'brotli'] as const) {
      expect(esm[key]).toBeLessThanOrEqual(MAX.esm[key]);
      expect(cjs[key]).toBeLessThanOrEqual(MAX.cjs[key]);
    }
  });
});
