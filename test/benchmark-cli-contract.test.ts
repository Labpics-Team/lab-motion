import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureTrajectory, installNativeCaptureDiagnostics } from '../bench/compare/bench.mjs';
import { recordCaptureDiagnostic } from '../bench/compare/conformance-smoke.mjs';
import { startClock, timerEvidence } from './benchmark-clock-fixture.js';

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

function controlledCapture(faults: { terminal?: Error; snapshot?: Error; cleanup?: Error; badPng?: boolean } = {}) {
  const events = new EventEmitter();
  const signals: string[] = [];
  const nodes = new Map<string, object>();
  const animations: { pending: boolean; startTime: number | null; currentTime: number | null; ready: Promise<void>; resolve(): void }[] = [];
  const timeline = {};
  let now = 0;
  class Element {
    id = ''; style = {}; textContent = '';
    animate() {
      signals.push(`start:${this.id}`);
      let resolve!: () => void;
      const ready = new Promise<void>(accept => { resolve = accept; });
      const animation = { timeline, pending: true, startTime: null as number | null, currentTime: 0 as number | null,
        ready, resolve };
      // Preserve the originating element, not the getter's animation receiver.
      Object.defineProperty(animation, 'ready', { get: () => { signals.push(`ready:${this.id}`); return ready; } });
      animations.push(animation);
      return animation;
    }
  }
  const realm = createContext({ Element, crossOriginIsolated: true,
    document: { timeline, title: '', createElement: () => new Element(),
      body: { appendChild: (node: Element) => nodes.set(node.id, node) }, getElementById: (id: string) => nodes.get(id) },
    performance: { timeOrigin: startClock().pageTimeOriginMs, now: () => now += 0.1 },
    console: { debug: (token: string) => events.emit('Runtime.consoleAPICalled', {
      args: [{ value: token }], timestamp: startClock().pageTimeOriginMs + now,
    }) },
    setTimeout: (_callback: unknown, delay: number) => { signals.push(`block:${delay}`); },
    getComputedStyle: () => { if (faults.terminal) throw faults.terminal; return { transform: 'matrix(1,0,0,1,600,0)' }; },
    DOMMatrixReadOnly: class { e = 600; },
  });
  runInContext('window = globalThis; __adapterModule = { start(elements) { elements[0].animate([], {}); return {}; } };', realm);
  const PNG = createRequire(new URL('../package.json', import.meta.url))('pngjs').PNG;
  const image = new PNG({ width: 2, height: 1 });
  image.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
  const png: Buffer = PNG.sync.write(image);
  let frame = 0;
  const emitFrame = () => events.emit('Page.screencastFrame', {
    data: png.toString('base64'), sessionId: ++frame,
    metadata: { timestamp: (startClock().pageTimeOriginMs + now) / 1000 },
  });
  const page = {
    async goto() {}, async bringToFront() {}, async addScriptTag() {},
    async evaluate(callback: { toString(): string }, argument?: unknown) {
      const source = callback.toString();
      if (faults.snapshot && source.includes('__s5NativeCapture?.finish')) throw faults.snapshot;
      realm.argument = argument;
      return await runInContext(`(${source})(argument)`, realm);
    },
  };
  const cdp = Object.assign(events, { async send(method: string) {
    if (method === 'Page.startScreencast') emitFrame();
    if (method === 'Page.stopScreencast') {
      signals.push('stop');
      if (faults.badPng) events.emit('Page.screencastFrame', { data: 'invalid', sessionId: ++frame,
        metadata: { timestamp: (startClock().pageTimeOriginMs + now) / 1000 } });
    }
  } });
  const context = { async newPage() { return page; }, async newCDPSession() { return cdp; },
    async close() { signals.push('close'); if (faults.cleanup) throw faults.cleanup; } };
  return { browser: { async newContext() { return context; } }, signals, png,
    async readyThenCancel() {
      const settled = Promise.all(animations.map(animation => animation.ready));
      for (const animation of animations) { animation.pending = false; animation.startTime = 25; animation.resolve(); }
      await settled;
      for (const animation of animations) { animation.startTime = null; animation.currentTime = null; }
    },
  };
}

// Observe the actual capture's completion-timer registration, not elapsed wall time.
function captureCompletionSignal() {
  vi.useFakeTimers();
  let complete!: () => void;
  let registered!: () => void;
  const registration = new Promise<void>(accept => { registered = accept; });
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 3100 || delay === 4000) {
      complete = () => { if (typeof callback === 'function') callback(...args); };
      registered();
      return original(callback, delay, ...args);
    }
    return original(callback, delay, ...args);
  });
  return { registration, complete: () => complete() };
}

describe('S5 opt-in native capture diagnostics', () => {
  it('preserves receiver, arguments and Animation identity; observes ready only after startup', async () => {
    const timeline = {};
    let clock = 10;
    const reads: string[] = [];
    const resolveReady: (() => void)[] = [];
    const returned: object[] = [];
    const calls: { receiver: object; args: unknown[] }[] = [];
    class Element {
      constructor(readonly id: string) {}
      animate(...args: unknown[]) {
        calls.push({ receiver: this, args });
        let resolve!: () => void;
        const ready = new Promise<void>(accept => { resolve = accept; });
        resolveReady.push(resolve);
        const animation = {
          timeline, pending: true, startTime: null as number | null, currentTime: 0,
          get ready() { reads.push('ready'); return ready; },
        };
        returned.push(animation);
        return animation;
      }
    }
    const original = Element.prototype.animate;
    const realm = { Element, document: { timeline }, performance: { timeOrigin: 1000, now: () => clock++ },
      __s5NativeCapture: undefined as unknown as {
        observe(): void; finish(): { records: {
          ready: { startEpochMs: number | null }; afterStartup: { startEpochMs: number | null };
          apiBeforeNowMs: number; apiAfterNowMs: number;
        }[] };
      } };
    installNativeCaptureDiagnostics(realm);
    const witness = new Element('capture-witness');
    const probe = new Element('probe');
    const frames = [{ transform: 'translateX(0px)' }];
    const timing = { duration: 2400 };
    const first = witness.animate(frames, timing);
    const second = probe.animate(frames, timing);
    expect(first).toBe(returned[0]);
    expect(second).toBe(returned[1]);
    expect(calls.map(call => call.receiver)).toEqual([witness, probe]);
    for (const call of calls) { expect(call.args[0]).toBe(frames); expect(call.args[1]).toBe(timing); }
    expect(reads).toEqual([]);
    realm.__s5NativeCapture.observe();
    expect(reads).toEqual(['ready', 'ready']);
    first.pending = second.pending = false;
    first.startTime = second.startTime = 40;
    // Subscribe to the exact promise before triggering settlement; no sleeps/polling.
    const settled = Promise.all([first.ready, second.ready]);
    resolveReady.forEach(resolve => resolve());
    await settled;
    const evidence = realm.__s5NativeCapture.finish();
    expect(Element.prototype.animate).toBe(original);
    expect(evidence.records.map(record => record.ready.startEpochMs)).toEqual([1040, 1040]);
    expect(evidence.records.map(record => record.afterStartup.startEpochMs)).toEqual([null, null]);
    expect(evidence.records[0].apiAfterNowMs - evidence.records[0].apiBeforeNowMs).toBe(1);
  });

  it.each([null, {}])('does not convert an unsupported timeline %s', timeline => {
    const defaultTimeline = {};
    class Element {
      id = 'probe';
      animate() { return { timeline, startTime: 42, currentTime: 0, pending: false, ready: Promise.resolve() }; }
    }
    const realm = { Element, document: { timeline: defaultTimeline },
      performance: { timeOrigin: 1000, now: () => 10 },
      __s5NativeCapture: undefined as unknown as { finish(): { status: string; records: {
        terminal: { status: string; reason: string; startEpochMs: number | null };
      }[] } } };
    installNativeCaptureDiagnostics(realm);
    new Element().animate();
    const evidence = realm.__s5NativeCapture.finish();
    expect(evidence.status).toBe('incomplete'); // Missing witness cannot be represented as complete.
    expect(evidence.records[0].terminal).toMatchObject({
      status: 'incomplete', reason: 'unsupported-timeline', startEpochMs: null,
    });
  });

  it('runs actual capture startup before ready access and retains cancelled terminal with valid ready', async () => {
    const control = controlledCapture();
    const completion = captureCompletionSignal();
    const retained: { frames: { data: string }[]; nativeDiagnostic: { records: { ready: { status: string; startTime: number }; terminal: { startTime: null } }[] } }[] = [];
    try {
      const capture = captureTrajectory(control.browser, 'lab-spring', true, 'fixture', {
        retain: (evidence: typeof retained[number]) => { control.signals.push('retain'); retained.push(evidence); },
      });
      await completion.registration;
      expect(control.signals).toEqual(['start:capture-witness', 'start:probe', 'block:300',
        'ready:capture-witness', 'ready:probe']);
      await control.readyThenCancel();
      completion.complete();
      const result = await capture;
      expect(result.nativeDiagnostic.records.map((record: { ready: { status: string }; terminal: { status: string } }) => ({
        ready: record.ready.status, terminal: record.terminal.status,
      }))).toEqual([{ ready: 'complete', terminal: 'incomplete' }, { ready: 'complete', terminal: 'incomplete' }]);
      expect(retained[0].nativeDiagnostic.records.map(record => record.ready.startTime)).toEqual([25, 25]);
      expect(retained[0].nativeDiagnostic.records.map(record => record.terminal.startTime)).toEqual([null, null]);
      expect(Buffer.from(retained[0].frames[0].data, 'base64')).toEqual(control.png);
      expect(control.signals.slice(-3)).toEqual(['stop', 'retain', 'close']);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each(['snapshot', 'retain', 'all', 'decode'] as const)('actual capture retains primary and %s failure with cleanup', async fault => {
    const primary = new Error('primary capture');
    const snapshot = new Error('snapshot failed');
    const retention = new Error('retain failed');
    const cleanup = new Error('cleanup failed');
    const control = controlledCapture({
      terminal: fault === 'decode' ? undefined : primary,
      snapshot: fault === 'snapshot' || fault === 'all' ? snapshot : undefined,
      cleanup: fault === 'all' ? cleanup : undefined, badPng: fault === 'decode',
    });
    const completion = captureCompletionSignal();
    const retained: { frames: { data: string }[]; errors: { phase: string; error: { message: string } }[] }[] = [];
    try {
      const capture = captureTrajectory(control.browser, 'lab-spring', true, 'fixture', {
        retain: (evidence: typeof retained[number]) => {
          control.signals.push('retain'); retained.push(evidence);
          if (fault === 'retain' || fault === 'all') throw retention;
        },
      });
      // Attach rejection handler before signalling any asynchronous failure.
      const rejected = capture.then(() => { throw new Error('capture unexpectedly passed'); }, (error: AggregateError) => error);
      await completion.registration;
      await control.readyThenCancel();
      completion.complete();
      const error = await rejected;
      expect(error).toBeInstanceOf(AggregateError);
      if (fault !== 'decode') expect(error.errors[0]).toBe(primary);
      else expect(error.errors[0]).toBeInstanceOf(Error);
      expect(error.errors).toHaveLength(fault === 'all' ? 4 : fault === 'decode' ? 1 : 2);
      if (fault === 'snapshot' || fault === 'all') expect(error.errors).toContain(snapshot);
      if (fault === 'retain' || fault === 'all') expect(error.errors).toContain(retention);
      if (fault === 'all') expect(error.errors).toContain(cleanup);
      expect(retained[0].errors[0].phase).toBe('capture');
      if (fault !== 'decode') expect(retained[0].errors[0].error.message).toContain('primary capture');
      expect(Buffer.from(retained[0].frames[0].data, 'base64')).toEqual(control.png);
      expect(retained[0].frames).toHaveLength(fault === 'decode' ? 2 : 1);
      expect(control.signals.slice(-3)).toEqual(['stop', 'retain', 'close']);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('retains all 16 captures and exact PNG bytes before aggregate rejection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 's5-diagnostic-control-'));
    try {
      const order: boolean[] = [];
      const png = Buffer.from('iVBORw0KGgo=', 'base64');
      const clock = { startClock: startClock(), timerEvidence: timerEvidence() };
      const capture = async (_browser: unknown, _path: string, blocked: boolean, _url: string,
        diagnostic: { retain(evidence: unknown): void }) => {
        order.push(blocked);
        const nativeDiagnostic = { status: 'recorded', records: ['probe', 'capture-witness'].map(element => ({
          element, terminal: { status: 'incomplete', startTime: null },
          ready: { status: 'complete', outcome: 'resolved', startTime: 25, startEpochMs: startClock().pageTimeOriginMs + 25 },
        })) };
        diagnostic.retain({ frames: [{ ts: 1, data: png.toString('base64'), metadata: { timestamp: 1 }, sessionId: 7 }], nativeDiagnostic });
        if (order.length === 1) throw new Error('capture failed after raw retention');
        // Valid witness/clock/coverage with a known wrong spring target in every later round.
        const times = Array.from({ length: 97 }, (_, index) => index / 40);
        return { decoded: times.map(t => ({ t, x: 0 })), witness: times.map(t => ({ t, x: 250 * t })),
          clock, rawFrames: times.length, nativeDiagnostic };
      };
      const aggregate = await recordCaptureDiagnostic({ version: () => 'fixture' }, { url: 'fixture' },
        { path: 'fixture', sha256: 'fixture' }, directory, capture).then(
        () => { throw new Error('diagnostic unexpectedly passed'); }, (error: AggregateError) => error,
      );
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(order).toEqual(Array.from({ length: 8 }, (_, round) => round % 2 ? [true, false] : [false, true]).flat());
      const report = JSON.parse(readFileSync(join(directory, 'diagnostic.json'), 'utf8'));
      expect(report.rounds).toHaveLength(8);
      expect(report.errors.some((error: { message: string }) => error.message.includes('native timing incomplete'))).toBe(false);
      for (let round = 1; round < 8; round++) for (const mode of ['baseline', 'blocked']) {
        expect(report.rounds[round].assessment.capture[mode].verdict).toBe('pass');
        expect(report.rounds[round].assessment.witness[mode].verdict).toBe('pass');
        expect(report.rounds[round].assessment[mode].verdict).toBe('fail');
        expect(report.errors.some((error: { message: string }) => error.message.includes(`round-${round}.${mode}: S5 contract failed`))).toBe(true);
        expect(aggregate.errors.some((error: Error) => error.message === `round-${round}.${mode}: S5 contract failed`)).toBe(true);
      }
      for (let round = 0; round < 8; round++) for (const mode of ['baseline', 'blocked']) {
        const path = join(directory, `round-${round}-${mode}`);
        expect(readFileSync(join(path, '0000.png'))).toEqual(png);
        expect(JSON.parse(readFileSync(join(path, 'raw.json'), 'utf8')).frames[0].sessionId).toBe(7);
        expect(existsSync(join(path, round === 0 && mode === 'baseline' ? 'error.json' : 'capture.json'))).toBe(true);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

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
