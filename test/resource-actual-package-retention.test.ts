import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Архив пакета, сведения о сборке, точный скрипт и журналы сохраняют воспроизводимость,
// включая неудачные прогоны. r11 G-PERF §4/§6 защищает ошибки и единственную копию доказательств.
const EVIDENCE = join(ROOT, 'scratchpad', 'resource-evidence');
const WINDOWS_SHELL = process.platform === 'win32';
const NPM = WINDOWS_SHELL ? 'npm.cmd' : 'npm';
const shellPath = (value: string): string => WINDOWS_SHELL ? `"${value}"` : value;
const RUNTIME_FILES = [
  'index', 'frame/index', 'compositor/index', 'bindings/index',
  'behaviors/index', 'behaviors/reorder/index', 'compositor/follow/index',
].flatMap(entry => [`dist/${entry}.js`, `dist/${entry}.cjs`]);
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const EXPECTED_OWNERS = ['esm', 'cjs'].flatMap(format => [
  'frame', 'motion-value', 'compositor-native', 'compositor-live', 'compositor-delay',
  'compositor-handoff', 'compositor-roundtrip', 'compositor-reduced-loans', 'binding', 'sheet', 'pager',
  'dismiss', 'pull', 'pull-pending', 'pull-settled', 'reorder',
  'follow-native', 'follow-pickup', 'follow-live',
].map(owner => `${format}/${owner}`));

describe('RESOURCE-01: реальные байты установленного production tarball', () => {
  let work: string | undefined;
  let app: string;
  let entry: string;
  let evidenceRun: string;

  beforeAll(() => {
    mkdirSync(EVIDENCE, { recursive: true });
    evidenceRun = mkdtempSync(join(EVIDENCE, 'run-'));
    work = mkdtempSync(join(tmpdir(), 'resource-actual-package-'));
    const packed = JSON.parse(execFileSync(NPM, [
      'pack', '--ignore-scripts', '--json', '--pack-destination', shellPath(work),
    ], { cwd: ROOT, encoding: 'utf8', shell: WINDOWS_SHELL, timeout: 30_000 })) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);
    const tarball = join(work, packed[0]!.filename);
    copyFileSync(tarball, join(evidenceRun, 'package.tgz'));
    app = join(work, 'consumer');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{"name":"resource-retention-consumer","private":true,"type":"module"}\n');
    execFileSync(NPM, ['install', '--ignore-scripts', '--no-audit', '--no-fund', shellPath(tarball)], {
      cwd: app, stdio: 'pipe', shell: WINDOWS_SHELL, timeout: 30_000,
    });
    const installed = join(app, 'node_modules', '@labpics', 'motion');
    // Полный manifest и runtime readback связывают proof с доставляемым tuple;
    // исходники, source aliases и урезанная export-map здесь не участвуют.
    expect(readFileSync(join(installed, 'package.json'))).toEqual(readFileSync(join(ROOT, 'package.json')));
    const files = Object.fromEntries(RUNTIME_FILES.map(relative => {
      const actual = readFileSync(join(installed, relative));
      expect(actual).toEqual(readFileSync(join(ROOT, relative)));
      return [relative, digest(actual)];
    }));
    writeFileSync(join(evidenceRun, 'package-tuple.json'), JSON.stringify({
      node: process.version, platform: process.platform,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      tarballSha256: digest(readFileSync(tarball)), installedRuntimeSha256: files,
      fixtureSha256: digest(readFileSync(join(ROOT, 'test/fixtures/resource-package-probe.mjs'))),
    }, null, 2) + '\n');
    entry = join(app, 'resource-package-probe.mjs');
    copyFileSync(join(ROOT, 'test/fixtures/resource-package-probe.mjs'), entry);
    copyFileSync(entry, join(evidenceRun, 'resource-package-probe.mjs'));
  }, 60_000);

  // Удаляется только временный установленный пакет; evidenceRun сохраняет доказательства.
  afterAll(() => { if (work !== undefined) rmSync(work, { recursive: true, force: true }); });

  function probe(mode: string, forcedGc = false): Record<string, unknown> {
    const args = [...(forcedGc ? ['--expose-gc'] : []), entry, mode];
    let output: string;
    try {
      output = execFileSync(process.execPath, args, {
        cwd: app, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      writeFileSync(join(evidenceRun, `${mode}.stdout.log`), result.stdout ?? '');
      writeFileSync(join(evidenceRun, `${mode}.stderr.log`), result.stderr ?? result.message);
      throw error;
    }
    writeFileSync(join(evidenceRun, `${mode}.stdout.log`), output);
    return JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
  }

  function completeCycles(result: Record<string, unknown>): void {
    expect(result.cyclesPerOwner).toBe(10_000);
    const measured = result.executions as Array<{ name: string; cycles: number }>;
    expect(measured.map(owner => owner.name)).toEqual(EXPECTED_OWNERS);
    expect(measured.every(owner => owner.cycles === 10_000)).toBe(true);
  }

  it('terminal owner не удерживает компонент: дешёвый различающий witness', () => {
    expect(probe('witness', true).status).toBe('pass');
  }, 120_000);

  it('10 000 mount/update/interrupt/dispose циклов на каждый ESM/CJS owner не оставляют effects/listeners/jobs', () => {
    const result = probe('lifecycle');
    expect(result.status).toBe('pass');
    completeCycles(result);
  }, 120_000);

  it('отдельный forced-GC proof различает terminal/live/dropped/deliberate owners после 10 000 циклов', () => {
    const result = probe('retention', true);
    expect(result.status).toBe('pass');
    completeCycles(result);
    expect(result.retainedComponentReferences).toBe(0);
    expect(result.retainedComponentPayloadBytes).toBe(0);
  }, 120_000);

  it('dropped owners возвращают heap в заранее разрешённую A/A baseline-полосу без роста по циклам', () => {
    const result = probe('bytes', true);
    expect(result.status).toBe('pass');
    completeCycles(result);
  }, 120_000);
});
