import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as follow from '../src/compositor/follow/index.js';
import * as base from '../src/compositor/index.js';
import * as stagger from '../src/compositor/stagger/index.js';
import { BESPOKE_SUBPATH_GATES, COMPOSITOR_FOLLOW_GATE_BYTES, IMPORT_COST_SCENARIOS } from '../scripts/size-gate.mjs';
import { entriesFromPackageExports } from '../tsup.config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('compositor/follow: граница новой capability', () => {
  it('не расширяет старые barrels и не публикует internal subclass', () => {
    expect(Object.keys(follow).sort()).toEqual(['compileSpringPlan', 'createCompositorFollow']);
    expect('createCompositorFollow' in base).toBe(false);
    expect('createCompositorFollow' in stagger).toBe(false);
    expect('beginFollow' in base.CompositorSpring.prototype).toBe(false);
  });

  it('поставляет ESM/CJS и отдельные declarations через официальный build entry', () => {
    expect(pkg.exports['./compositor/follow']).toEqual({
      import: { types: './dist/compositor/follow/index.d.ts', default: './dist/compositor/follow/index.js' },
      require: { types: './dist/compositor/follow/index.d.cts', default: './dist/compositor/follow/index.cjs' },
    });
    expect(entriesFromPackageExports()['compositor/follow/index']).toBe('src/compositor/follow/index.ts');
  });

  it('новый admission не ослабляет старые native ceilings', () => {
    expect(BESPOKE_SUBPATH_GATES['./compositor']).toBe(6450);
    expect(BESPOKE_SUBPATH_GATES['./compositor/stagger']).toBe(6450);
    expect(COMPOSITOR_FOLLOW_GATE_BYTES).toBe(6450 + 1024);
    expect(BESPOKE_SUBPATH_GATES['./compositor/follow']).toBe(COMPOSITOR_FOLLOW_GATE_BYTES);
    const scenario = IMPORT_COST_SCENARIOS.find(({ name }) => name === 'compositor-follow capability');
    expect(scenario?.gate).toBe(COMPOSITOR_FOLLOW_GATE_BYTES);
    expect(scenario?.code).toContain('createCompositorFollow');
    expect(scenario?.code).toContain('compileSpringPlan');
  });
});
