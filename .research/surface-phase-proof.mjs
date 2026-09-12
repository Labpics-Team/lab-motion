import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const evidence = resolve(process.env.EVIDENCE_DIR);
const base = resolve(process.env.BASE_ROOT);
const acorn = resolve(process.env.ACORN_PATH);
await mkdir(evidence, { recursive: true });
const original = await readFile(new URL('./surface-fresh-isolate-worker.mjs', import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
assert.equal(hash(original), '1d194697ca7c51b9a73402be33f3423270f0f29e98f6e443e8770887a4f14add');
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'historical source boundary must occur exactly once');
  return source.replace(before, after);
}
const warm = `for (let round = 0; round < 64; round++) {
  for (const side of warmOrder) executeSurfaceBurst(side === 0 ? opA : opB);
}`;
const clock = `for (let i = 0; i < 256; i++) {
  const t = process.hrtime.bigint();
  let u;
  do { u = process.hrtime.bigint(); } while (u === t);
  clock.push(Number(u - t));
}`;
const measured = `for (const side of warmOrder) {
  const detail = timed(side === 0 ? opA : opB);
  samples[side].push(detail.ns);
  details.push({ side, ...detail });
}`;
const unified = `for (let round = 0; round < 65; round++) {
  if (round === 64) {
    ${clock}
  }
  for (const side of warmOrder) {
    // One physical call-site and identical instrumentation in both phases.
    const detail = timed(side === 0 ? opA : opB);
    if (round === 64) {
      samples[side].push(detail.ns);
      details.push({ side, ...detail });
    }
  }
}`;
let fixed = replaceOnce(original, warm, '');
fixed = replaceOnce(fixed, clock, '');
fixed = replaceOnce(fixed, measured, unified);
await writeFile(join(evidence, 'surface-fixed-worker.mjs'), fixed);

// Standalone copies are diagnostic only. Publish uses the uninstrumented
// Worker source above, the original bootstrap and the original inequalities.
const prelude = `import { writeFileSync, writeSync } from 'node:fs';
const workerData = JSON.parse(process.env.PHASE_DATA);
globalThis.__phaseProbe = { phase: 'warm', paths: {}, counts: {} };
const parentPort = { postMessage(row) {
  writeSync(1, '__LM_END__\\n');
  writeFileSync(process.env.PHASE_RESULT, JSON.stringify({ ...row, probe: globalThis.__phaseProbe }));
} };
`;
const marker = `globalThis.__phaseProbe.phase = 'measured'; writeSync(1, '__LM_TIMED__\\n');\n`;
function standalone(source, kind) {
  let out = replaceOnce(source, "import { parentPort, workerData } from 'node:worker_threads';\n", prelude);
  out = replaceOnce(out, kind === 'old' ? 'const clock = [];\n' : '\n  if (round === 64) {\n',
    kind === 'old' ? marker + 'const clock = [];\n' : '\n  if (round === 64) {\n' + marker);
  return out;
}
const paths = {};
for (const [kind, source] of [['old', original], ['fixed', fixed]]) {
  paths[kind] = join(evidence, `surface-${kind}-diagnostic.mjs`);
  await writeFile(paths[kind], standalone(source, kind));
}
const fakePlugin = join(evidence, 'phase-probe-plugin.mjs');
await writeFile(fakePlugin, `const side = new URL(import.meta.url).searchParams.get('bench').startsWith('A') ? 'A' : 'B';
export function motionCompiler() { return { transform(_source) {
  const state = globalThis.__phaseProbe;
  // Include every synchronous caller up to the top-level loop, not just the
  // helper frame. This detects split callers even when both enter one helper.
  const path = new Error().stack.split('\\n').slice(2, 6).join('\\n');
  const key = side + ':' + state.phase + ':' + path;
  state.paths[key] = (state.paths[key] ?? 0) + 1;
  const countKey = side + ':' + state.phase;
  state.counts[countKey] = (state.counts[countKey] ?? 0) + 1;
  if (JSON.parse(process.env.PHASE_DATA).scenario === 'reject') return undefined;
  return { code: '__labMotionSurface', map: { mappings: 'AA' } };
} }; }
`);
const fakeAcorn = join(evidence, 'phase-probe-acorn.mjs');
await writeFile(fakeAcorn, 'export function parse() { throw new Error("probe does not parse source"); }\n');
function execute(kind, data, tag, trace = false) {
  const output = join(evidence, `${tag}.json`);
  const result = spawnSync(process.execPath, [
    ...(trace ? ['--trace-opt', '--trace-deopt', '--trace-turbo-inlining'] : []), paths[kind],
  ], {
    env: { ...process.env, PHASE_DATA: JSON.stringify(data), PHASE_RESULT: output },
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { output, stdout: result.stdout, stderr: result.stderr };
}
function samePathAdmission(probe) {
  const measuredPaths = Object.entries(probe.paths).filter(([key]) => key.includes(':measured:'));
  return measuredPaths.length === 2 && measuredPaths.every(([key, count]) =>
    probe.paths[key.replace(':measured:', ':warm:')] === 64 * count);
}
const characterization = [];
for (const [scenario, calls, positiveControl] of [
  ['ordinary-warm', 32, false], ['ordinary-miss', 32, false],
  ['reject', 8, false], ['batch', 8, false], ['ordinary-warm', 32, true],
]) {
  for (const cluster of [0, 1]) {
    for (const kind of ['old', 'fixed']) {
      const data = { cluster, scenario, calls, positiveControl, sideAPath: fakePlugin, sideBPath: fakePlugin, acornPath: fakeAcorn };
      const run = execute(kind, data, `probe-${kind}-${scenario}-${positiveControl}-${cluster}`);
      const row = JSON.parse(await readFile(run.output, 'utf8'));
      for (const side of ['A', 'B']) {
        const multiplier = side === 'B' && positiveControl ? 2 : 1;
        assert.equal(row.probe.counts[`${side}:warm`], 128 * calls * multiplier);
        assert.equal(row.probe.counts[`${side}:measured`], 2 * calls * multiplier);
      }
      assert.deepEqual(row.details.map(detail => detail.side), cluster % 2 ? [1, 0, 0, 1] : [0, 1, 1, 0]);
      assert.equal(samePathAdmission(row.probe), kind === 'fixed', 'split-path positive control must fail; unified path must pass');
      characterization.push({ kind, scenario, calls, positiveControl, cluster, admission: samePathAdmission(row.probe), counts: row.probe.counts });
    }
  }
}
await writeFile(join(evidence, 'phase-characterization.json'), JSON.stringify(characterization, null, 2));
console.log('PHASE_CHARACTERIZATION_PASS: 10 split-path RED controls; 10 unified GREEN controls; unchanged workloads/counts/order');

const traces = [];
for (let cluster = 0; cluster < 16; cluster++) {
  for (const kind of cluster % 2 ? ['fixed', 'old'] : ['old', 'fixed']) {
    const data = {
      cluster, scenario: 'ordinary-warm', calls: 32, positiveControl: false,
      sideAPath: join(base, 'dist/compiler/vite/index.js'), sideBPath: join(base, 'dist/compiler/vite/index.js'), acornPath: acorn,
    };
    const run = execute(kind, data, `trace-${kind}-${cluster}`, true);
    await writeFile(join(evidence, `trace-${kind}-${cluster}.log`), run.stdout + run.stderr);
    const between = run.stdout.split('__LM_TIMED__\n')[1]?.split('__LM_END__\n')[0];
    assert.notEqual(between, undefined, 'phase marker missing');
    const events = between.split('\n').filter(line => /completed (compiling|optimizing)|bailout|deoptimizing/.test(line));
    traces.push({ kind, cluster, measuredPhaseEvents: events });
  }
}
await writeFile(join(evidence, 'phase-traces.json'), JSON.stringify(traces, null, 2));
const traceCounts = Object.fromEntries(['old', 'fixed'].map(kind => [kind, {
  isolates: traces.filter(row => row.kind === kind).length,
  withMeasuredPhaseEvents: traces.filter(row => row.kind === kind && row.measuredPhaseEvents.length > 0).length,
  events: traces.filter(row => row.kind === kind).reduce((n, row) => n + row.measuredPhaseEvents.length, 0),
}]));
await writeFile(join(evidence, 'phase-proof.json'), JSON.stringify({
  status: 'PHASE_PATH_REPAIR_PROVEN', originalSha256: hash(original), fixedSha256: hash(fixed),
  characterizationControls: characterization.length, traceCounts,
  limitation: 'Trace observations are diagnostic attribution only, never latency admission or a claim of eliminating all JIT activity.',
  publishPolicy: 'Original 64 clusters, 128 warm bursts per side, four balanced observations, 10000 bootstrap iterations and thresholds unchanged. One conditional candidate pass.',
}, null, 2));
console.log('PHASE_PROOF', JSON.stringify(traceCounts));
