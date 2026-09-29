import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const format of ['source', 'esm', 'cjs']) {
  it(`scope не удерживает завершённые цели и уничтоженный root: ${format}`, async () => {
    const dist = resolve(root, `dist/animate/index.${format === 'cjs' ? 'cjs' : 'js'}`);
    if (format !== 'source' && !existsSync(dist)) throw new Error('GC-контракт требует pnpm build');
    const dir = mkdtempSync(join(tmpdir(), 'motion-scope-gc-'));
    try {
      const file = join(dir, 'probe.mjs');
      await build({ entryPoints: [resolve(root, 'test/fixtures/animate-scope-gc.probe.ts')], outfile: file,
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        plugins: format === 'source' ? [] : [{ name: 'actual-emitted-package', setup(b) {
          b.onResolve({ filter: /\/src\/animate\/index\.js$/ }, () => ({ path: pathToFileURL(dist).href, external: true }));
        } }],
      });
      // Minified dist исполняется как есть. Перебандлирование его в тесте
      // могло бы скрыть утечку контекста, созданную исходной минификацией.
      const out = execFileSync(process.execPath, ['--expose-gc', file], { encoding: 'utf8', timeout: 60_000 });
      expect(out).toContain('animate-scope-gc: PASS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
