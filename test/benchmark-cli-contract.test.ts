import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const exportsSource = ['animate', 'sequence', 'scope', 'layout', 'value', 'playhead', 'MotionError']
  .map(name => `export const ${name} = x => x;`).join('\n');

function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture(directory: string, name: string) {
  const root = join(directory, name);
  mkdirSync(root);
  for (const path of ['scripts', 'bench/compare']) {
    cpSync(join(repository, path), join(root, path), {
      recursive: true,
      filter: source => !source.split(/[\\/]/).some(part => ['node_modules', 'results', 'evidence'].includes(part)),
    });
  }
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
  // Только чтение существующего HEAD: фикстура не создаёт Git-коммиты.
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repository, encoding: 'utf8' }).trim();
  put(root, '.git', `gitdir: ${gitDirectory}\n`);
  put(root, 'package.json', JSON.stringify({ name: '@fixture/motion', version: '1.0.0', type: 'module',
    exports: { '.': { import: { default: './dist/index.js' } } } }));
  put(root, 'dist/index.js', exportsSource);
  put(root, 'dist/easing/index.js', 'export const cubicBezier = () => x => x;');
  return root;
}

async function run(directory: string, script: string, args: string[], preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), join(repository, script), ...args], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${script}\n${stderr}`)); }, 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
}

async function isolated(work: (directory: string, baseline: string, candidate: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'motion-cli-contract-'));
  try { await work(directory, fixture(directory, 'baseline'), fixture(directory, 'candidate')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

// Мутация происходит синхронно на заданной границе чтения, а не по таймеру.
// Все чтения, esbuild, gzip и проверки CLI остаются настоящими.
function mutateOnRead(directory: string, target: string, occurrence: number) {
  const preload = join(directory, 'mutate.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const original = fs.readFileSync;
let reads = 0;
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && resolve(file) === ${JSON.stringify(resolve(target))} && ++reads === ${occurrence}) {
    fs.appendFileSync(file, '\\n// changed\\n');
  }
  return Reflect.apply(original, this, [file, ...args]);
};
syncBuiltinESMExports();`);
  return preload;
}

function observeRefusal(directory: string, mutation?: string) {
  const preload = join(directory, 'observe.mjs');
  writeFileSync(preload, `${mutation ? `import ${JSON.stringify(pathToFileURL(mutation).href)};` : ''}
import fs from 'node:fs';
process.on('uncaughtExceptionMonitor', error => {
  fs.writeFileSync(${JSON.stringify(join(directory, 'refusal.json'))}, JSON.stringify({
    code: error.code, operator: error.operator, actual: error.actual, expected: error.expected,
    frames: error.stack.split('\\n').slice(1)
  }));
});`);
  return preload;
}

describe('контракты настоящих CLI сравнительных измерений', () => {
  it('consumer-size сохраняет восемь реальных esbuild-графов и неизменность входов', async () => {
    await isolated(async (directory, baseline, candidate) => {
      const output = join(directory, 'report.json');
      const result = await run(directory, 'bench/consumer-size.mjs', [baseline, candidate, output]);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.verification).toEqual({ artifactsUnchanged: true, toolchainUnchanged: true, samePublicExports: true });
      expect(report.results).toHaveLength(8);
      for (const row of report.results) {
        expect(row.baseline.totalGzBytes).toBeGreaterThan(0);
        expect(row.candidate.totalGzBytes).toBe(row.baseline.totalGzBytes);
        expect(row.candidate.exports).toEqual(row.baseline.exports);
      }
    });
  }, 120_000);

  it.each(['root', 'external', 'exports', 'dist'] as const)('consumer-size отвергает %s до публикации отчёта', async fault => {
    await isolated(async (directory, baseline, candidate) => {
      if (fault === 'root') put(candidate, 'package.json', JSON.stringify({ type: 'module', exports: { '.': './dist/index.js' } }));
      if (fault === 'external') {
        put(candidate, 'outside.js', 'globalThis.externalRuntime = true;');
        put(candidate, 'dist/index.js', `import '../outside.js';\n${exportsSource}`);
      }
      if (fault === 'exports') put(candidate, 'dist/index.js', `${exportsSource}\nexport const extra = 1;`);
      const preload = fault === 'dist' ? mutateOnRead(directory, join(candidate, 'dist/index.js'), 2) : undefined;
      const output = join(directory, 'report.json');
      const result = await run(directory, 'bench/consumer-size.mjs', [baseline, candidate, output], observeRefusal(directory, preload));
      expect(result.code).toBe(1);
      const refusal = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
      expect(refusal.code).toBe('ERR_ASSERTION');
      expect(refusal.operator).toBe({ root: 'strictEqual', external: '==', exports: 'deepStrictEqual', dist: 'deepStrictEqual' }[fault]);
      if (fault === 'root') expect(refusal.expected).toBe('string');
      if (fault === 'external') expect(refusal.actual).toBe(false);
      if (fault === 'exports') {
        expect(refusal.actual).toContain('extra');
        expect(refusal.expected).not.toContain('extra');
      }
      if (fault === 'dist') {
        expect(readFileSync(join(candidate, 'dist/index.js'), 'utf8')).toBe(`${exportsSource}\n// changed\n`);
        expect(refusal.actual).not.toEqual(refusal.expected);
      }
      expect(existsSync(output)).toBe(false);
    });
  }, 120_000);

  it('easing-pair сравнивает все граничные значения и сохраняет парные samples', async () => {
    await isolated(async (directory, baseline, candidate) => {
      const output = join(directory, 'easing.json');
      const result = await run(directory, 'bench/easing-pair.mjs', [baseline, candidate, output]);
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.semantics).toEqual({ exactSamplesPerCurve: 4110, exact: true });
      expect(report.results).toHaveLength(9);
      for (const row of report.results) {
        expect(row.samples).toHaveLength(32);
        for (const sample of row.samples) expect(sample.baseline.checksum).toBe(sample.candidate.checksum);
      }
    });
  }, 120_000);

  it.each(['same-root', 'equality', 'entry'] as const)('easing-pair отвергает %s без отчёта', async fault => {
    await isolated(async (directory, baseline, candidate) => {
      if (fault === 'equality') put(candidate, 'dist/easing/index.js', 'export const cubicBezier = () => x => x + 1;');
      const preload = fault === 'entry' ? mutateOnRead(directory, join(candidate, 'dist/easing/index.js'), 2) : undefined;
      const output = join(directory, 'easing.json');
      const result = await run(directory, 'bench/easing-pair.mjs', [fault === 'same-root' ? candidate : baseline, candidate, output], observeRefusal(directory, preload));
      expect(result.code).toBe(1);
      const refusal = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
      expect(refusal.code).toBe('ERR_ASSERTION');
      expect(refusal.operator).toBe({ 'same-root': 'notStrictEqual', equality: '==', entry: 'strictEqual' }[fault]);
      if (fault === 'same-root') {
        expect(refusal.actual).toBe(candidate);
        expect(refusal.expected).toBe(candidate);
      } else if (fault === 'equality') {
        expect(refusal.actual).toBe(false);
        expect(refusal.expected).toBe(true);
      } else {
        expect(readFileSync(join(candidate, 'dist/easing/index.js'), 'utf8')).toBe('export const cubicBezier = () => x => x;\n// changed\n');
        expect(refusal.actual).not.toBe(refusal.expected);
      }
      expect(existsSync(output)).toBe(false);
    });
  }, 120_000);

  it('transition-profile отвергает одинаковые checkout до запуска браузера', async () => {
    await isolated(async (directory, _baseline, candidate) => {
      const output = join(directory, 'transition');
      const result = await run(directory, 'bench/compare/transition-profile.mjs', [candidate, output, 'js-pair', candidate], observeRefusal(directory));
      expect(result.code).toBe(1);
      const refusal = JSON.parse(readFileSync(join(directory, 'refusal.json'), 'utf8'));
      expect(refusal.frames[0]).toContain(pathToFileURL(join(repository, 'bench/compare/transition-profile.mjs')).href + ':');
      expect(existsSync(output)).toBe(false);
    });
  }, 120_000);
});
