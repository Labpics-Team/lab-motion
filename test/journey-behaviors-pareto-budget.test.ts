import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalGzip,
  observationalBrotli,
} from '../scripts/compression-oracle.mjs';
import {
  IMPORT_COST_SCENARIOS,
  measureScenario,
} from '../scripts/size-gate.mjs';

/** Exact canonical build of R11 GEOMETRY-01 tuple #411 @ c5da964e. */
const BASE = {
  esm: { raw: 12_967, gzip: 4_514, brotli: 4_053 },
  cjs: { raw: 12_982, gzip: 4_525, brotli: 4_064 },
  sheet: { gzip: 2_921, brotli: 2_716 },
} as const;

function vector(path: string) {
  const bytes = readFileSync(resolve(path));
  return {
    raw: bytes.length,
    gzip: canonicalGzip(bytes).length,
    brotli: observationalBrotli(bytes).length,
  };
}

describe('JOURNEY-01 behaviors strict Pareto against accepted R11 tuple', () => {
  it('does not regress shipped behaviors ESM/CJS cells', () => {
    const esm = vector('dist/behaviors/index.js');
    const cjs = vector('dist/behaviors/index.cjs');

    expect(esm.raw).toBeLessThanOrEqual(BASE.esm.raw);
    expect(esm.gzip).toBeLessThanOrEqual(BASE.esm.gzip);
    expect(esm.brotli).toBeLessThanOrEqual(BASE.esm.brotli);
    expect(cjs.raw).toBeLessThanOrEqual(BASE.cjs.raw);
    expect(cjs.gzip).toBeLessThanOrEqual(BASE.cjs.gzip);
    expect(cjs.brotli).toBeLessThanOrEqual(BASE.cjs.brotli);
  });

  it('does not make the existing sheet consumer more expensive', async () => {
    const scenario = IMPORT_COST_SCENARIOS.find(
      ({ name }) => name === 'behaviors-sheet-one-liner',
    );
    expect(scenario).toBeDefined();

    const measured = await measureScenario(scenario!, resolve('dist/index.js'));
    expect(measured.error).toBeUndefined();
    expect(measured.gzBytes).toBeLessThanOrEqual(BASE.sheet.gzip);
    expect(measured.brBytes).toBeLessThanOrEqual(BASE.sheet.brotli);
  });
});
