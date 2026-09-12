import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('завершённый результат animate не удерживает внутренний граф', () => {
  for (const entry of ['source', 'esm', 'cjs'] as const) {
    it(`${entry}: освобождение после завершения и контроль живого владельца`, async () => {
      const packed = entry === 'source'
        ? undefined
        : resolve(ROOT, `dist/animate/index.${entry === 'cjs' ? 'cjs' : 'js'}`);
      if (packed !== undefined && !existsSync(packed)) {
        throw new Error(`нет собранного артефакта ${packed}: выполните сборку перед тестом`);
      }
      const work = mkdtempSync(join(tmpdir(), 'labmotion-animate-gc-'));
      const outfile = join(work, 'probe.mjs');
      try {
        await build({
          entryPoints: [resolve(ROOT, 'test/fixtures/animate-terminal-retention-gc.probe.ts')],
          outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
          // Каждый формат исполняет реальный собранный артефакт без повторной минификации:
          // встраивание может вернуть общий контекст замыкания и снова скрыто удерживать цель.
          plugins: entry === 'source' ? [] : [{
            name: 'actual-packed-animate',
            setup(build) {
              build.onResolve({ filter: /\/src\/animate\/index\.js$/ }, () => ({
                path: pathToFileURL(packed!).href,
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
