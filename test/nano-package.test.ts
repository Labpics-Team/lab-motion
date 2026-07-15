import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as nano from '../src/nano/index.js';
import {
  BESPOKE_SUBPATH_GATES,
  IMPORT_COST_SCENARIOS,
  NANO_GATE_BYTES,
} from '../scripts/size-gate.mjs';
import { entriesFromPackageExports } from '../tsup.config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('nano: package contract', () => {
  it('публикует ровно один новый entry с ESM/CJS и соответствующими типами', () => {
    expect(Object.keys(nano)).toEqual(['animate']);
    expect(pkg.exports['./nano']).toEqual({
      import: {
        types: './dist/nano/index.d.ts',
        default: './dist/nano/index.js',
      },
      require: {
        types: './dist/nano/index.d.cts',
        default: './dist/nano/index.cjs',
      },
    });
    // exports — SSOT entry-points: субпуть обязан выводиться в build-entry.
    expect(entriesFromPackageExports()['nano/index']).toBe('src/nano/index.ts');
  });

  it('держит один и тот же hard gate для shipped entry и consumer import-cost', () => {
    expect(NANO_GATE_BYTES).toBe(1024);
    expect(BESPOKE_SUBPATH_GATES['./nano']).toBe(NANO_GATE_BYTES);
    const scenario = IMPORT_COST_SCENARIOS.find(({ name }) => name === 'nano spring-to');
    expect(scenario?.gate).toBe(NANO_GATE_BYTES);
    expect(scenario?.code).toContain('/nano/index.js');
  });
});
