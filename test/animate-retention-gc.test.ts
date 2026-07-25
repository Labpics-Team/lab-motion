/**
 * animate-retention-gc.test.ts — драйвер GC-пробы фасада ./animate.
 *
 * Тот же контур, что у compositor-retention-gc: проба собирается esbuild-ом и
 * гоняется отдельным процессом под `node --expose-gc`, потому что WeakRef и
 * принудительный GC внутри vitest недетерминированы.
 *
 * ЗАЧЕМ. Аудит 2026-07-25: удержанный потребителем AnimateControls (реестр
 * ради последующего cancel() — стандарт SPA) навсегда держал ЦЕЛЬ на
 * compositor-ветке. Замер: 50 завершённых прогонов → 118.8 МБ против 6.3 МБ на
 * main-ветке, которая освобождала ссылки. Ни одного WeakRef-пина для ./animate
 * в сьюте не было.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('animate retention', () => {
  it('завершённый прогон не держит цель, даже если controls удержаны', () => {
    const work = mkdtempSync(join(tmpdir(), 'labmotion-animate-gc-'));
    const outfile = join(work, 'probe.mjs');
    try {
      buildSync({
        entryPoints: [resolve(ROOT, 'test/fixtures/animate-retention-gc.probe.ts')],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
      });
      const output = execFileSync(process.execPath, ['--expose-gc', outfile], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(output).toContain('animate-retention: PASS');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 90_000);
});
