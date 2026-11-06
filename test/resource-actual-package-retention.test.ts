import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Архив пакета, сведения о сборке, точный скрипт и журналы сохраняют воспроизводимость,
// включая неудачные прогоны. r11 G-PERF §4/§6 защищает ошибки и единственную копию доказательств.
const EVIDENCE = process.env.LAB_MOTION_RESOURCE_EVIDENCE_DIR ?? join(ROOT, 'scratchpad', 'resource-evidence');
const WINDOWS_SHELL = process.platform === 'win32';
const NPM = WINDOWS_SHELL ? 'npm.cmd' : 'npm';
const shellPath = (value: string): string => WINDOWS_SHELL ? `"${value}"` : value;
const RUNTIME_FILES = [
  'index', 'frame/index', 'compositor/index', 'bindings/index',
  'behaviors/index', 'behaviors/reorder/index', 'compositor/follow/index',
  'presence/index', 'animate/index', 'motion/index',
].flatMap(entry => [`dist/${entry}.js`, `dist/${entry}.cjs`]);
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const EXISTING_KINDS = [
  'frame', 'motion-value', 'compositor-native', 'compositor-live', 'compositor-delay',
  'compositor-handoff', 'compositor-roundtrip', 'compositor-reduced-loans', 'binding', 'state-cascade', 'reorder',
  'follow-native', 'follow-pickup', 'follow-live',
];
const ADDED_KINDS = ['presence-transition', 'animate-scope-main', 'animate-scope-native'];
const ROOT_KINDS = ['root-value', 'root-scope-main', 'root-scope-native', 'root-playhead', 'root-sequence', 'root-layout'];
const ownerNames = (kinds: string[]) => ['esm', 'cjs'].flatMap(format => kinds.map(owner => `${format}/${owner}`));
const EXPECTED_OWNERS = ownerNames([...EXISTING_KINDS, ...ADDED_KINDS]);

// Heap-срез измеряется после завершённой работы компилятора VM. Остальные
// lifecycle/reference проверки сохраняют обычный оптимизирующий runtime.
const vmFlags = (mode: string, forcedGc: boolean): string[] => [
  ...(forcedGc ? ['--expose-gc'] : []),
  ...(mode === 'bytes' ? ['--no-concurrent-recompilation'] : []),
];

describe('RESOURCE-01: реальные байты установленного production tarball', () => {
  let work: string | undefined;
  let app: string;
  let entry: string;
  let evidenceRun: string;

  beforeAll(() => {
    mkdirSync(EVIDENCE, { recursive: true });
    evidenceRun = mkdtempSync(join(EVIDENCE, 'run-'));
    work = mkdtempSync(join(tmpdir(), 'resource-actual-package-'));
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
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
      dirty,
      tarballSha256: digest(readFileSync(tarball)), installedRuntimeSha256: files,
      fixtureSha256: digest(readFileSync(join(ROOT, 'test/fixtures/resource-package-probe.mjs'))),
    }, null, 2) + '\n');
    entry = join(app, 'resource-package-probe.mjs');
    copyFileSync(join(ROOT, 'test/fixtures/resource-package-probe.mjs'), entry);
    copyFileSync(entry, join(evidenceRun, 'resource-package-probe.mjs'));
  }, 60_000);

  // Hosted logs — существующий durable export, без нового CI artifact исключения.
  // Полный tarball остаётся локальным archive; tuple связывает его с точным SHA.
  afterAll(() => {
    try {
      if (evidenceRun) for (const name of readdirSync(evidenceRun).sort()) {
        if (name === 'package-tuple.json' || name.endsWith('.stdout.log') || name.endsWith('.stderr.log'))
          console.log(JSON.stringify({ resourceEvidence: 1, file: name, content: readFileSync(join(evidenceRun, name), 'utf8') }));
      }
    } finally {
      if (work !== undefined) rmSync(work, { recursive: true, force: true });
    }
  });

  function probe(mode: string, forcedGc = false, corpus = 'combined', script = entry): Record<string, unknown> {
    const args = [...vmFlags(mode, forcedGc), script, mode, corpus];
    const receiptName = corpus === 'combined' ? mode : `${mode}-${corpus}`;
    const child = spawnSync(process.execPath, args, {
      cwd: app, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(evidenceRun, `${receiptName}.stdout.log`), child.stdout ?? '');
    writeFileSync(join(evidenceRun, `${receiptName}.stderr.log`), child.stderr ?? '');
    if (child.error) throw child.error;
    if (child.status !== 0 || child.signal !== null) throw Object.assign(
      new Error(`RESOURCE probe exit=${child.status} signal=${child.signal}`),
      { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(result.corpus).toBe(corpus);
    return result;
  }

  function completeCycles(result: Record<string, unknown>, owners = EXPECTED_OWNERS): void {
    expect(result.cyclesPerOwner).toBe(10_000);
    const measured = result.executions as Array<{ name: string; cycles: number }>;
    expect(measured.map(owner => owner.name)).toEqual(owners);
    expect(measured.every(owner => owner.cycles === 10_000)).toBe(true);
  }

  it.each(['success', 'exit', 'signal'])('probe сохраняет обе streams и различает %s', outcome => {
    const script = join(app, `receipt-${outcome}.mjs`);
    const stderr = `RESOURCE_RECEIPT_${outcome}\n`;
    writeFileSync(script, `import { writeSync } from 'node:fs';\nwriteSync(1, JSON.stringify({ status: 'pass', corpus: 'root' }) + '\\n');\nwriteSync(2, ${JSON.stringify(stderr)});\n`
      + (outcome === 'exit' ? 'process.exitCode = 1;\n' : outcome === 'signal' ? "process.kill(process.pid, 'SIGTERM');\n" : ''));
    const invoke = () => probe(`receipt-${outcome}`, false, 'root', script);
    if (outcome === 'success') expect(invoke()).toEqual({ status: 'pass', corpus: 'root' });
    else if (outcome === 'exit') expect(invoke).toThrow(expect.objectContaining({ status: 1, signal: null }));
    else expect(invoke).toThrow(expect.objectContaining({ status: null, signal: 'SIGTERM' }));
    expect(readFileSync(join(evidenceRun, `receipt-${outcome}-root.stderr.log`), 'utf8')).toBe(stderr);
    expect(JSON.parse(readFileSync(join(evidenceRun, `receipt-${outcome}-root.stdout.log`), 'utf8'))).toEqual({ status: 'pass', corpus: 'root' });
  });

  it('packed ESM/CJS сохраняют один frame clock после getter reentry и частичного host failure', () => {
    const result = probe('reentry');
    expect(result.status).toBe('pass');
    const checks = result.checks as Array<{ format: string; scenario: string }>;
    expect(checks.map(check => `${check.format}/${check.scenario}`)).toEqual(
      ['esm', 'cjs'].flatMap(format => ['control', 'nested-failure', 'cancel', 'pause']
        .map(scenario => `${format}/${scenario}`)),
    );
  }, 120_000);

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
    const result = probe('bytes', true, 'existing');
    expect(result.status).toBe('pass');
    completeCycles(result, ownerNames(EXISTING_KINDS));
    expect(result.baseline).toMatchObject({ warmupCyclesPerOwner: 2000,
      calibrationCyclesPerSample: 2000, workloadCyclesPerSample: 2000,
      collector: 'major/async/last-resort', optimizer: 'foreground', maximumResolvableBand: 262144 });
    expect(result.excess).toEqual([0, 0, 0, 0, 0]);
    expect(result.tailExcess).toEqual([0, 0, 0, 0]);
  }, 120_000);

  it.each(['existing', 'root'].flatMap(corpus => ['prefix', 'growing'].map(kind => ({ corpus, kind }))))('измеритель обнаруживает $kind удержание в установленном $corpus пакете', ({ corpus, kind }) => {
    const source = readFileSync(entry, 'utf8');
    const boundary = '    const measured = await memory();';
    expect(source.split(boundary)).toHaveLength(2);
    const injection = kind === 'prefix'
      ? 'globalThis.__resourceChurnControl = prefix === BATCH_CYCLES ? component(prefix, CONTROL_WORDS) : undefined;'
      : '(globalThis.__resourceChurnControl ??= []).push(component(prefix, CONTROL_WORDS));';
    const mutant = join(app, `retained-${kind}-${corpus}.mjs`);
    writeFileSync(mutant, source.replace(boundary, `    ${injection}\n${boundary}`));
    const run = spawnSync(process.execPath, [...vmFlags('bytes', true), mutant, 'bytes', corpus], {
      cwd: app, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(evidenceRun, `retained-${kind}-${corpus}.stdout.log`), run.stdout ?? '');
    writeFileSync(join(evidenceRun, `retained-${kind}-${corpus}.stderr.log`), run.stderr ?? '');
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(result.status).toBe('fail');
    completeCycles(result, ownerNames(corpus === 'root' ? ROOT_KINDS : EXISTING_KINDS));
    const excess = result.excess as number[];
    expect(excess).toHaveLength(5);
    expect(excess[0]).toBeGreaterThan(0);
    if (kind === 'prefix') {
      expect(excess.slice(1)).toEqual([0, 0, 0, 0]);
      expect(result.tailExcess).toEqual([0, 0, 0, 0]);
    } else {
      expect(excess.every(bytes => bytes > 0)).toBe(true);
      expect(excess.at(-1)).toBeGreaterThan(excess[0]!);
      expect((result.tailExcess as number[]).every(bytes => bytes > 0)).toBe(true);
    }
  }, 120_000);

  it.each(['registration', 'removal'])('ROOT event control rejects no-op %s', kind => {
    const source = readFileSync(entry, 'utf8');
    const boundary = kind === 'registration'
      ? 'addEventListener(_event, callback) { value.listeners.add(callback); }'
      : 'removeEventListener(_event, callback) { value.listeners.delete(callback); }';
    expect(source.split(boundary)).toHaveLength(2);
    const mutant = join(app, `root-event-${kind}.mjs`);
    writeFileSync(mutant, source.replace(boundary, boundary.replace(/\{.*\}/, '{}')));
    const run = spawnSync(process.execPath, [...vmFlags('witness', true), mutant, 'witness', 'root'], {
      cwd: app, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(evidenceRun, `root-event-${kind}.stdout.log`), run.stdout ?? '');
    writeFileSync(join(evidenceRun, `root-event-${kind}.stderr.log`), run.stderr ?? '');
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    const rejection = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(rejection).toEqual({ status: 'fail', mode: 'witness', corpus: 'root',
      code: kind === 'registration' ? 'ROOT_EVENT_REGISTRATION' : 'ROOT_EVENT_REMOVAL' });
  }, 120_000);

  it.each(['witness', 'lifecycle', 'retention', 'bytes'])('root public ESM/CJS %s uses the existing resource engine', mode => {
    const result = probe(mode, mode !== 'lifecycle', 'root');
    expect(result.status).toBe('pass');
    if (mode !== 'witness') completeCycles(result, ownerNames(ROOT_KINDS));
    if (mode === 'witness' || mode === 'retention') {
      expect(result.retainedComponentReferences).toBe(0);
      expect(result.retainedComponentPayloadBytes).toBe(0);
      expect(result.controls).toMatchObject({ live: 12, expectedLive: 12, dropped: 0, deliberate: 1,
        addedLiveReleased: 0, addedLiveReleaseControls: 12 });
    }
    if (mode === 'bytes') {
      expect(result.baseline).toMatchObject({ warmupCyclesPerOwner: 2000, calibrationCyclesPerSample: 2000,
        workloadCyclesPerSample: 2000, collector: 'major/async/last-resort', optimizer: 'foreground', maximumResolvableBand: 262144 });
      expect(result.excess).toEqual([0, 0, 0, 0, 0]);
      expect(result.tailExcess).toEqual([0, 0, 0, 0]);
    }
  }, 120_000);

  it('presence/scope после 10 000 циклов имеет стабильный terminal tail в своей A/A baseline-полосе', () => {
    const result = probe('bytes', true, 'presence-scope');
    expect(result.status).toBe('pass');
    completeCycles(result, ownerNames(ADDED_KINDS));
    const tailExcess = result.tailExcess as number[];
    expect(tailExcess).toHaveLength(4);
    expect(tailExcess.every(bytes => bytes === 0)).toBe(true);
  }, 120_000);
});
