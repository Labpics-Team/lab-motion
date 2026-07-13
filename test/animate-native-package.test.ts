import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('animate/native: package export', () => {
  it('публикует ESM/CJS и типы только через официальный subpath', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./animate/native']).toEqual({
      import: {
        types: './dist/animate/native/index.d.ts',
        default: './dist/animate/native/index.js',
      },
      require: {
        types: './dist/animate/native/index.d.cts',
        default: './dist/animate/native/index.cjs',
      },
    });
    expect(pkg.exports['./compositor/execution']).toBeUndefined();
    expect(pkg.exports['./compositor/curve']).toBeUndefined();
  });
});
