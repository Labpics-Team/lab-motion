import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BESPOKE_SUBPATH_GATES,
  COMPOSITOR_CAPABILITY_GATE_BYTES,
  IMPORT_COST_SCENARIOS,
} from '../scripts/size-gate.mjs';
import { entriesFromPackageExports } from '../tsup.config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('compositor/stagger: package contract', () => {
  it('публикует одну runtime-цель и одну декларацию', () => {
    expect(pkg.exports['./compositor/stagger']).toEqual({
      types: './dist/compositor/stagger/index.d.ts',
      default: './dist/compositor/stagger/index.js',
    });
  });

  it('собирает официальный entry из исходного capability-фасада', () => {
    // exports — SSOT entry-points: субпуть обязан выводиться в build-entry.
    expect(entriesFromPackageExports()['compositor/stagger/index'])
      .toBe('src/compositor/stagger/index.ts');
  });

  it('не переносит consumer-предел на физические entry', () => {
    // 6450 → 6250 (2026-07-22): ратчет ./compositor затянут по факту 6082;
    // смысл пина прежний — физический entry не наследует consumer-предел.
    // 6250 → 6090 (2026-07-22, #223+охота): факт 6062.
    expect(BESPOKE_SUBPATH_GATES['./compositor']).toBe(6090);
    expect(BESPOKE_SUBPATH_GATES['./compositor/stagger']).toBe(6450);

    const scenario = IMPORT_COST_SCENARIOS.find(
      ({ name }) => name === 'compositor-stagger capability',
    );
    expect(scenario?.gate).toBe(COMPOSITOR_CAPABILITY_GATE_BYTES);
    expect(scenario?.code).toContain('/compositor/stagger/index.js');
    for (const name of [
      'CompositorSpring',
      'CompositorStaggerGroup',
      'compileSpringPlan',
      'compileStaggerPlan',
    ]) {
      expect(scenario?.code).toContain(name);
    }
  });
});
