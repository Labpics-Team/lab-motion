import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('завершённые animate controls не владеют execution graph', () => {
  for (const entry of ['source', 'esm', 'cjs'] as const) {
    it(`${entry}: release после natural/cancel/reduced и live-owner positive control`, async () => {
      const work = mkdtempSync(join(tmpdir(), 'labmotion-animate-gc-'));
      const outfile = join(work, 'probe.mjs');
      try {
        await build({
          entryPoints: [resolve(ROOT, 'test/fixtures/animate-terminal-retention-gc.probe.ts')],
          outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
          // Каждый формат исполняет РЕАЛЬНЫЙ dist, без повторной минификации:
          // inlining может вернуть общий closure context и скрыто восстановить retention.
          plugins: entry === 'source' ? [] : [{
            name: 'actual-packed-animate',
            setup(build) {
              build.onResolve({ filter: /\/src\/animate\/index\.js$/ }, () => ({
                path: pathToFileURL(resolve(ROOT, `dist/animate/index.${entry === 'cjs' ? 'cjs' : 'js'}`)).href,
                external: true,
              }));
            },
          }],
        });
        const output = execFileSync(process.execPath, ['--expose-gc', outfile], {
          cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        });
        expect(output).toContain('animate-terminal-retention: PASS');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
