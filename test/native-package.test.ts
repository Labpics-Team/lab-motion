import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as native from '../src/native/index.js';
import {
  BESPOKE_SUBPATH_GATES,
  IMPORT_COST_SCENARIOS,
  NATIVE_GATE_BYTES,
} from '../scripts/size-gate.mjs';
import { entriesFromPackageExports } from '../tsup.config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('native: package contract', () => {
  it('публикует ровно один новый entry с ESM/CJS и соответствующими типами', () => {
    expect(Object.keys(native)).toEqual(['animate']);
    expect(pkg.exports['./nano']).toBeUndefined();
    expect(pkg.exports['./native']).toEqual({
      import: {
        types: './dist/native/index.d.ts',
        default: './dist/native/index.js',
      },
      require: {
        types: './dist/native/index.d.cts',
        default: './dist/native/index.cjs',
      },
    });
    // exports — SSOT entry-points: субпуть обязан выводиться в build-entry.
    expect(entriesFromPackageExports()['native/index']).toBe('src/native/index.ts');
  });

  it('держит один и тот же hard gate для shipped entry и consumer import-cost', () => {
    expect(NATIVE_GATE_BYTES).toBe(1024);
    expect(BESPOKE_SUBPATH_GATES['./native']).toBe(NATIVE_GATE_BYTES);
    const scenario = IMPORT_COST_SCENARIOS.find(({ name }) => name === 'native spring-to');
    expect(scenario?.gate).toBe(NATIVE_GATE_BYTES);
    expect(scenario?.code).toContain('/native/index.js');
  });
});
