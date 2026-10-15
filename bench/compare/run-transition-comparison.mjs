import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'bench/compare/results/transition-comparison');
const temporary = mkdtempSync(join(tmpdir(), 'motion-comparison-'));
const baseline = join(temporary, 'baseline');
const source = execFileSync('git', ['rev-parse', 'v0.5.0^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
try {
  mkdirSync(baseline);
  const archive = join(temporary, 'source.tar');
  execFileSync('git', ['archive', '--output', archive, source], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', baseline]);
  // Одинаковый toolchain сравнивает изменения движка, а не версии сборщика.
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    if (file.endsWith('.json')) {
      const before = JSON.parse(readFileSync(join(baseline, file))).devDependencies;
      const after = JSON.parse(readFileSync(join(root, file))).devDependencies;
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Comparison requires the same development dependencies');
    } else if (!readFileSync(join(baseline, file)).equals(readFileSync(join(root, file)))) {
      throw new Error('Comparison requires the same lockfile');
    }
  }
  symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  execFileSync('pnpm', ['build'], { cwd: baseline, stdio: 'inherit' });
  for (const group of ['full', 'native']) {
    execFileSync(process.execPath, [join(root, 'bench/compare/transition-profile.mjs'), root,
      join(output, group), group, join(baseline, 'dist')], {
      cwd: root, stdio: 'inherit', timeout: 15 * 60 * 1000,
      env: { ...process.env, COMPARISON_BASELINE_SHA: source },
    });
  }
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ source, error: String(error?.stack ?? error) }, null, 2));
  throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
