import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('compositor retention', () => {
  it('destroy разрывает target, artifact и effect/timer owners', () => {
    const work = mkdtempSync(join(tmpdir(), 'labmotion-compositor-gc-'));
    const outfile = join(work, 'probe.mjs');
    try {
      buildSync({
        entryPoints: [resolve(ROOT, 'test/fixtures/compositor-retention-gc.probe.ts')],
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
      expect(output).toContain('compositor-retention: PASS');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
