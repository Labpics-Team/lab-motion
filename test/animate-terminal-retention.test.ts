import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

it('terminal animate освобождает исполнители и trajectory buffers при сохранённых controls', () => {
  const work = mkdtempSync(join(tmpdir(), 'labmotion-animate-terminal-'));
  const outfile = join(work, 'probe.mjs');
  try {
    buildSync({ entryPoints: [resolve('test/fixtures/animate-terminal-retention.probe.ts')],
      outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22' });
    const output = execFileSync(process.execPath, ['--expose-gc', outfile], {
      encoding: 'utf8', timeout: 60_000,
    });
    expect(output).toContain('animate-terminal-retention: PASS');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
