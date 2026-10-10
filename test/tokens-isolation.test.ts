import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { spring } from '../src/tokens/index.js';
import { DEFAULT_SPRING, SNAPPY_SPRING } from '../src/internal/motion-defaults.js';
import { physics, timing } from '../src/motion/model.js';

const defaults = { mass: 1, stiffness: 170, damping: 26 };

describe('preset ownership', () => {
  it.each(['default', 'snappy'] as const)('%s cannot change runtime defaults', name => {
    const preset = spring[name];
    const saved = { ...preset };
    const runtime = { normal: { ...DEFAULT_SPRING }, snappy: { ...SNAPPY_SPRING } };
    try {
      for (const key of ['mass', 'stiffness', 'damping'] as const) {
        Reflect.set(preset, key, saved[key] * 2);
        expect(physics(undefined)).toEqual(defaults);
        expect(DEFAULT_SPRING).toEqual(runtime.normal);
        expect(SNAPPY_SPRING).toEqual(runtime.snappy);
      }
    } finally {
      for (const key of ['mass', 'stiffness', 'damping'] as const) Reflect.set(preset, key, saved[key]);
    }
  });

  it('each call snapshots an independent application profile', () => {
    const profile = { mass: 2, stiffness: 240, damping: 36 };
    const first = timing({ spring: profile });
    profile.stiffness = 400;
    const second = timing({ spring: profile });
    expect(first.spring).toEqual({ mass: 2, stiffness: 240, damping: 36 });
    expect(second.spring).toEqual(profile);
    expect(timing(undefined).spring).toEqual(defaults);
  });

  it('the browser runtime does not load optional preset dictionaries', async () => {
    const result = await build({
      entryPoints: ['src/motion/index.ts'], bundle: true, write: false,
      metafile: true, format: 'esm', platform: 'browser', logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile!.inputs).map(file => resolve(file));
    for (const file of ['src/tokens/index.ts', 'src/presets/index.ts']) {
      expect(inputs).not.toContain(resolve(file));
    }
  });
});
