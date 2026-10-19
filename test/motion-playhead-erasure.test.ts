import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

function consumer(names: string, entry = 'motion'): string {
  return buildSync({
    stdin: { contents: 'export { ' + names + ' } from ' + JSON.stringify(resolve('dist', entry, 'index.js')), resolveDir: process.cwd() },
    bundle: true, minify: true, treeShaking: true, write: false, format: 'esm', platform: 'browser',
  }).outputFiles[0]!.text;
}

it('представление playhead отсутствует в обычном импортируемом scope', () => {
  const ordinary = consumer('scope');
  const controlled = consumer('scope, playhead');
  expect(ordinary).not.toContain('timeScale');
  expect(controlled).toContain('timeScale');
  expect(controlled.length).toBeGreaterThan(ordinary.length);
});

it('Nano и статический executor не получают transport корневого runtime', () => {
  for (const entry of ['nano', 'compiler/runtime']) {
    const code = buildSync({
      entryPoints: [resolve('dist', entry, 'index.js')], bundle: true, write: false,
      minify: true, format: 'esm', platform: 'browser',
    }).outputFiles[0]!.text;
    expect(code).not.toContain('timeScale');
    expect(code).not.toContain('playhead');
  }
});
