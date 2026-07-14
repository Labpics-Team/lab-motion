import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('frame rollback освобождает dead reentrant callbacks', () => {
  const work = mkdtempSync(join(tmpdir(), 'labmotion-frame-gc-'));
  const outfile = join(work, 'probe.mjs');
  try {
    buildSync({
      entryPoints: [resolve(ROOT, 'test/fixtures/frame-retention-gc.probe.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
    });
    const output = execFileSync(process.execPath, ['--expose-gc', outfile], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(output).toContain('frame-gc-retention: PASS');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
