// Временная hosted qualification; удалить после решения о кандидате.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const [baselinePath, outputPath] = process.argv.slice(2);
assert(baselinePath && outputPath);
const candidatePath = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), 'sampler-qualification-'));
mkdirSync(outputPath, { recursive: true });
let stage = 'bundle', context;
const sources = {};
const json = value => JSON.stringify(value, (_, item) => typeof item === 'number' && !Number.isFinite(item) ? String(item) : Object.is(item, -0) ? '-0' : item, 2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = directory => ({
  revision: execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  programSha256: hash(readFileSync(path.join(directory, 'src/motion/program.ts'))),
});
function adjacent(value, upwards) {
  if (value === 0) return upwards ? Number.MIN_VALUE : -Number.MIN_VALUE;
  if (!Number.isFinite(value)) return value;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0);
  bytes.setBigUint64(0, bits + ((value > 0) === upwards ? 1n : -1n));
  return bytes.getFloat64(0);
}
function same(left, right) {
  assert.equal(left.length, right.length);
  for (let i = 0; i < left.length; i++) assert(Object.is(left[i], right[i]), `Numeric mismatch at ${i}`);
}

try {
  const modules = {}, sizes = {};
  for (const [id, directory] of [['baseline', path.resolve(baselinePath)], ['candidate', candidatePath]]) {
    const bundle = path.join(temporary, id + '.mjs');
    await build({ stdin: { contents: 'export { program, point, sample } from "./src/motion/program.ts"; export { timing } from "./src/motion/model.ts"; export { runSequence } from "./src/motion/sequence.ts";', resolveDir: directory, loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true });
    const bytes = readFileSync(bundle);
    sizes[id] = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: hash(bytes) };
    sources[id] = identity(directory);
    modules[id] = await import(pathToFileURL(bundle).href);
  }
  stage = 'semantic-controls';
  // Fixtures создаёт настоящий baseline producer, а не копия алгоритма поиска.
  const producer = modules.baseline;
  const callbacks = [];
  let collecting = true, callbackCount = 0;
  const ease = p => { callbackCount++; if (collecting) callbacks.push(p); return p * p * (3 - 2 * p); };
  const make = (values, duration, delay = 0, times) => producer.program('x', producer.point('x', values[0]), values, true,
    producer.timing({ duration, delay, times, ease }), [3]);
  const authored = make([2, 7, -3, 40, 9], 1000, 10, [0, 0.05, 0.4, 0.9, 1]);
  // Реальный runSequence валидирует/объединяет шаги и продлевает каналы до global end.
  // Engine заменяет только DOM drafting/execution; Program и sequence compiler настоящие.
  const target = {}, otherTarget = {};
  let sequenceDrafts;
  const engine = {
    _draft(element, input, clock, offset, prior) {
      return input.map(property => {
        const previous = prior(element, property._key);
        const from = previous ?? producer.point(property._key, property._values[0]);
        return { _element: element, _key: property._key, _reduced: false,
          _program: producer.program(property._key, from, property._values, property._authored, clock, [0], offset) };
      });
    },
    _execute(drafts) { sequenceDrafts = drafts; return {}; },
  };
  const taggedEase = id => p => { callbackCount++; if (collecting) callbacks.push(id, p); return p; };
  producer.runSequence(engine, [
    [target, { x: [1, 2] }, { at: 0, duration: 10, ease: taggedEase(0) }],
    [target, { x: [2, 3] }, { at: 10, duration: 0, ease: taggedEase(1) }],
    [target, { x: [3, 20] }, { at: 10, duration: 0, ease: taggedEase(2) }],
    [target, { x: [20, 30] }, { at: 40, duration: 10, ease: taggedEase(3) }],
    [otherTarget, { x: [0, 1] }, { at: 0, duration: 100, ease: taggedEase(4) }],
  ]);
  const sequence = sequenceDrafts.find(draft => draft._element === target)._program;
  assert.deepEqual(sequence._segments.map(s => s._at), [0, 10, 10, 40]);
  assert.equal(sequence._duration, 100);
  const fixtures = [authored, sequence, make([5, 8], 100), make([4, 6], 0)];
  let comparisons = 0;
  function observe(sample, program, time, rate) {
    const value = [123], velocity = [456];
    callbacks.length = 0;
    let error;
    try { sample(program, time, value, velocity, rate); }
    catch (caught) { error = { name: caught.name, message: caught.message, code: caught.code }; }
    return { value, velocity, callbacks: [...callbacks], error };
  }
  function compareObservations(a, b) {
    for (const channel of ['error', 'value', 'velocity', 'callbacks']) {
      try {
        if (channel === 'error') assert.deepEqual(a.error, b.error);
        else same(a[channel], b[channel]);
      } catch (error) { error.channel = channel; throw error; }
    }
  }
  function rejectOnly(channel, a, b) {
    for (const other of ['error', 'value', 'velocity', 'callbacks']) {
      if (other === channel) continue;
      if (other === 'error') assert.deepEqual(a.error, b.error);
      else same(a[other], b[other]);
    }
    assert.throws(() => compareObservations(a, b), error => error.channel === channel);
  }
  function compare(program, time, rate, candidateProgram = program) {
    context = { segments: program._segments.length, starts: program._segments.map(s => s._at).slice(0, 8), time, rate };
    const a = observe(modules.baseline.sample, program, time, rate);
    const b = observe(modules.candidate.sample, candidateProgram, time, rate);
    context.outputs = { baseline: a, candidate: b };
    compareObservations(a, b);
    comparisons++;
  }
  // Эти witnesses ниже global end: early-final не скрывает выбор последнего старта.
  for (const id of ['baseline', 'candidate']) {
    for (const time of [10, 25]) {
      const held = observe(modules[id].sample, sequence, time, 1);
      assert.equal(held.error, undefined);
      same(held.value, [20]); same(held.velocity, [0]); same(held.callbacks, []);
    }
    const last = observe(modules[id].sample, sequence, 75, 1);
    same(last.value, [30]); same(last.velocity, [0]); same(last.callbacks, []);
    const invalid = observe(modules[id].sample, sequence, NaN, 1);
    assert(invalid.error);
    // NaN _elapsed > 0 ложно: старый первый сегмент fails до easing callback.
    same(invalid.callbacks, []);
    same(invalid.value, [123]); same(invalid.velocity, [456]);
  }
  // Неправильный NaN выбор zero-duration сегмента меняет error outcome.
  assert.throws(() => compare(sequence, NaN, 1, { ...sequence,
    _segments: [sequence._segments[1], ...sequence._segments.slice(1)] }));
  for (const fixture of fixtures) {
    const boundaries = fixture._segments.flatMap(s => [s._at, s._end]);
    const trace = [NaN, -Infinity, Infinity, -1, -0, 0, ...boundaries.flatMap(t => [adjacent(t, false), t, adjacent(t, true)]),
      ...fixture._segments.map(s => (s._at + s._end) / 2), fixture._duration];
    for (const rate of [1, -1, 0, 2]) for (const time of [...trace, ...trace.toReversed(), 700, 25, 900, 3]) compare(fixture, time, rate);
  }
  // Oracle sensitivity: endpoint and timing mutations must not be accepted.
  assert.throws(() => compare(authored, authored._duration, 1, { ...authored, _final: [999] }));
  const changed = { ...authored, _segments: authored._segments.map((s, i) => i === 1 ? { ...s, _end: s._end + 100 } : s) };
  assert.throws(() => compare(authored, 100, 1, changed));
  // Независимые channels: все остальные результаты обязаны совпасть до rejection.
  const velocityChanged = { ...authored, _segments: authored._segments.map((s, i) => i === 0 ? { ...s, _velocity: [91] } : s) };
  rejectOnly('velocity', observe(modules.baseline.sample, authored, 10, 1),
    observe(modules.candidate.sample, velocityChanged, 10, 1));

  const constantEase = p => { callbackCount++; if (collecting) callbacks.push(p); return 0.5; };
  const callbackProgram = producer.program('x', producer.point('x', 2), [2, 8], true,
    producer.timing({ duration: 1000, ease: constantEase }), [0]);
  const withEase = (program, replacement) => ({ ...program,
    _segments: program._segments.map(s => ({ ...s, _timing: { ...s._timing, _ease: replacement } })) });
  compare(callbackProgram, 500, 1);
  const callbackBaseline = observe(modules.baseline.sample, callbackProgram, 500, 1);
  const extraCalls = withEase(callbackProgram, p => { constantEase(p); return constantEase(p); });
  rejectOnly('callbacks', callbackBaseline, observe(modules.candidate.sample, extraCalls, 500, 1));
  // high/low отражаются относительно 0.5; callback возвращает ту же константу.
  const reorderedCalls = withEase(callbackProgram, p => constantEase(1 - p));
  rejectOnly('callbacks', callbackBaseline, observe(modules.candidate.sample, reorderedCalls, 500, 1));

  const throwingEase = code => p => {
    callbackCount++; if (collecting) callbacks.push(p);
    const error = new Error(); error.code = code; throw error;
  };
  const throwingProgram = withEase(callbackProgram, throwingEase('E_CONTROL_A'));
  compare(throwingProgram, 500, 1);
  const thrownBaseline = observe(modules.baseline.sample, throwingProgram, 500, 1);
  assert.equal(thrownBaseline.error.code, 'E_CONTROL_A');
  same(thrownBaseline.value, [123]); same(thrownBaseline.velocity, [456]);
  assert.equal(thrownBaseline.callbacks.length, 1);
  rejectOnly('error', thrownBaseline, observe(modules.candidate.sample,
    withEase(callbackProgram, throwingEase('E_CONTROL_B')), 500, 1));
  collecting = false;

  assert.equal(100 * 1000, 100_000); // MAX_CHANNELS: цели * authored values.
  const values = Array.from({ length: 1000 }, (_, i) => (i * 37) % 101 - 50);
  const times = Array.from({ length: 1000 }, (_, i) => (i / 999) ** 2);
  const longPrograms = Array.from({ length: 100 }, (_, i) => make(values.map(v => v + i), 1000, 0, times));
  const singlePrograms = Array.from({ length: 100 }, (_, i) => make([i, i + 100], 1000));
  const longTrace = [...Array.from({ length: 257 }, (_, i) => ((i * 97) % 257 + 0.5) / 257 * 999), 0, 999, 1000];
  const singleTrace = [...Array.from({ length: 97 }, (_, i) => ((i * 37) % 97 + 0.5) / 97 * 999), 0, 999, 1000];
  // Валидная authored hold: первые два значения равны, первый интервал 500ms.
  // Оставшиеся 998 интервалов равномерно заполняют вторую половину шкалы.
  const holdTimes = [0, ...Array.from({ length: 999 }, (_, i) => 0.5 + 0.5 * i / 998)];
  const holdValues = [values[0], values[0], ...values.slice(2)];
  const holdPrograms = Array.from({ length: 100 }, (_, i) => make(holdValues.map(v => v + i), 1000, 0, holdTimes));
  // Равномерный full-trajectory trace, включая обе границы; без oversampling hold.
  const holdTrace = Array.from({ length: 121 }, (_, i) => i * 1000 / 120);
  const panels = [
    { name: 'realistic-authored-hold-full-trajectory', programs: holdPrograms, trace: holdTrace, repeats: 16 },
    { name: 'long-jumps-regression', programs: longPrograms, trace: longTrace, repeats: 16 },
    { name: 'single-interval-negative', programs: singlePrograms, trace: singleTrace, repeats: 1 },
  ];
  const panelMetadata = panels.map(panel => ({ name: panel.name,
    times: panel.trace, authoredTimes: panel.programs[0]._segments.map(s => s._at),
    firstIntervalCallFraction: panel.trace.filter(time => time < (panel.programs[0]._segments[1]?._at ?? panel.programs[0]._duration)).length / panel.trace.length,
    callsPerVariantRound: panel.repeats * panel.trace.length * panel.programs.length }));
  // Полный sampler differential на всех measured inputs вне timing window.
  collecting = true;
  for (const panel of panels) for (const program of panel.programs) for (const time of panel.trace) compare(program, time, 1);
  collecting = false;
  const value = [0], velocity = [0];
  function work(sample, panel, repeats) {
    let sum = 0, speed = 0;
    for (let pass = 0; pass < repeats; pass++) for (const time of panel.trace) for (const program of panel.programs) {
      sample(program, time, value, velocity);
      sum += value[0]; speed += velocity[0];
    }
    return { sum, speed };
  }
  // Подготовка, allocation traces/programs, differential и warmup вне measured window.
  for (const panel of panels) for (const id of ['baseline', 'candidate']) work(modules[id].sample, panel, 2);
  const rows = [];
  stage = 'paired-measurement';
  for (const panel of panels) for (let round = 0; round < 6; round++) {
    const pair = {};
    for (const id of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      context = { panel: panel.name, round, id };
      callbackCount = 0;
      const cpu = process.cpuUsage();
      const began = process.hrtime.bigint();
      const checksum = work(modules[id].sample, panel, panel.repeats);
      const wallMs = Number(process.hrtime.bigint() - began) / 1e6;
      const used = process.cpuUsage(cpu);
      pair[id] = { ...checksum, callbacks: callbackCount };
      rows.push({ panel: panel.name, round, id, calls: panel.repeats * panel.trace.length * panel.programs.length,
        wallMs, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, checksum, callbacks: callbackCount });
    }
    assert.deepEqual(pair.baseline, pair.candidate);
  }
  mkdirSync(outputPath, { recursive: true });
  writeFileSync(path.join(outputPath, 'sampler-qualification.json'), JSON.stringify({ sources, sizes, comparisons,
    controls: { endpointMutationRejected: true, timingMutationRejected: true, nanWrongSegmentRejected: true,
      velocityOnlyRejected: true, callbackExtraOnlyRejected: true, callbackReorderedOnlyRejected: true,
      throwingEasingParity: true, throwingErrorOnlyRejected: true }, rows, panelMetadata,
    qualification: 'RAW_NARROW_FALSIFIER_ONLY_PENDING_NEW_SOURCE_REVIEW',
    materialityRule: 'Accept guard only if realistic authored hold FULL trajectory improves without established regression in long-jumps/single controls. Raw capture alone is not acceptance; micro-first-instant improvement is not material. No startup x or general-world claim.',
    scope: 'Current baseline already binary; only first interval guard is candidate. Node full sampler, not browser/public lifecycle or allocation totals. CPU includes wall-clock probes; buffers/checksums/callback counts symmetric inside window. Sizes are diagnostic sampler bundles, not package size gates.' }, null, 2));
  console.log('SAMPLER_EVIDENCE_CAPTURE_COMPLETE', comparisons, rows.length);
} catch (error) {
  writeFileSync(path.join(outputPath, 'sampler-failure.json'), json({ stage, context, sources, error: String(error.stack ?? error) }));
  throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }
