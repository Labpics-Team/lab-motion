import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const mode of ['source', 'esm', 'cjs']) it(`${mode}: retained terminal owner/session не удерживают callback; живой positive control`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reorder-gc-'));
  try {
    const file = resolve(root, `dist/behaviors/reorder/index.${mode === 'cjs' ? 'cjs' : 'js'}`);
    if (mode !== 'source') expect(existsSync(file), 'сначала build').toBe(true);
    const outfile = join(dir, 'probe.mjs');
    await build({ entryPoints: [join(root, 'test/fixtures/reorder-gc.probe.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      plugins: mode === 'source' ? [] : [{ name: 'actual-package', setup(build) { build.onResolve({ filter: /\/src\/behaviors\/reorder\/index\.js$/ }, () => ({ path: pathToFileURL(file).href, external: true })); } }] });
    expect(execFileSync(process.execPath, ['--expose-gc', outfile], { cwd: root, encoding: 'utf8', timeout: 60_000 })).toContain('reorder-gc: PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
