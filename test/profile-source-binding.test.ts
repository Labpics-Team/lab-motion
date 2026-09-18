import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import {
  ANIMATE_COMPOSITOR_MIXED_GATE_BYTES,
  BESPOKE_SUBPATH_GATES,
  FULL_ANIMATE_GATE_BYTES,
  NANO_GATE_BYTES,
} from '../scripts/size-gate.mjs';

const comparePackage = JSON.parse(readFileSync(new URL('../bench/compare/package.json', import.meta.url), 'utf8'));
const pairedLogHarness = readFileSync(new URL('../bench/profile/paired-log-pilot-desktop.mjs', import.meta.url), 'utf8');

describe('PROFILE-01 source bindings', () => {
  it('pins the exact compare toolchain that the benchmark actually installs', () => {
    const expected = PROFILE_PREREGISTRATION.baseline.competitors;
    expect({
      motion: comparePackage.devDependencies.motion,
      gsap: comparePackage.devDependencies.gsap,
      animejs: comparePackage.devDependencies.animejs,
      playwright: comparePackage.devDependencies.playwright,
      esbuild: comparePackage.devDependencies.esbuild,
      pngjs: comparePackage.devDependencies.pngjs,
    }).toEqual(expected);
    expect(comparePackage.packageManager).toBe(PROFILE_PREREGISTRATION.baseline.packageManager);
  });

  it('cannot silently raise the historical cost vector away from the live size SSOT', () => {
    expect(PROFILE_PREREGISTRATION.oldCostVector.gzipBytes).toEqual({
      nano: NANO_GATE_BYTES,
      compilerRuntime: BESPOKE_SUBPATH_GATES['./compiler/runtime'],
      compilerSurface: BESPOKE_SUBPATH_GATES['./compiler/surface'],
      fullAnimateConsumer: FULL_ANIMATE_GATE_BYTES,
      animateCompositorMixed: ANIMATE_COMPOSITOR_MIXED_GATE_BYTES,
    });
  });

  it('keeps consumer rendering outside the paired-log owner clock', () => {
    const start = pairedLogHarness.indexOf('const runDirectManipulation =');
    const end = pairedLogHarness.indexOf('globalThis.__labMotionPairedLog', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const direct = pairedLogHarness.slice(start, end);
    expect(direct).toContain('onStep: () => {},');
    const ownerDrain = direct.indexOf('own += timedDrainAll(clocks);');
    const consumerRender = direct.indexOf('sheets[index].style.transform =');
    expect(ownerDrain).toBeGreaterThanOrEqual(0);
    expect(consumerRender).toBeGreaterThan(ownerDrain);
  });
});
