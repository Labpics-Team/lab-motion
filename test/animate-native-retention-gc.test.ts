import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('animate/native: terminal retention', () => {
  it('доказывает разрыв host Promise → DOM в отдельном --expose-gc процессе', () => {
    const work = mkdtempSync(join(tmpdir(), 'labmotion-native-gc-'));
    const outfile = join(work, 'probe.mjs');
    try {
      // Bundle берёт текущий src, а не потенциально устаревший dist.
      buildSync({
        entryPoints: [resolve(ROOT, 'test/fixtures/animate-native-retention-gc.probe.ts')],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
      });
      const output = execFileSync(process.execPath, ['--expose-gc', outfile], {
        cwd: ROOT,
        encoding: 'utf8',
      });

      expect(output).toContain('gc-retention: PASS');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
