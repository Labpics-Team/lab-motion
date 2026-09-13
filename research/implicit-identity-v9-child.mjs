import { pathToFileURL } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const entry = arg('entry');
const mode = arg('mode');
const n = Number(arg('n'));
const easingKind = arg('easing');
const treatmentFactor = Number(arg('factor'));
if (!Number.isSafeInteger(n) || n < 3) throw new Error('bad n');
if (treatmentFactor !== 1 && treatmentFactor !== 2) throw new Error('bad factor');
if (!['sample', 'seek-matched'].includes(mode)) throw new Error('bad mode');
if (!['linear', 'quadratic'].includes(easingKind)) throw new Error('bad easing');

const mod = await import(`${pathToFileURL(entry).href}?pid=${process.pid}`);
const { keyframes, sampleKeyframes } = mod;
if (typeof keyframes !== 'function' || typeof sampleKeyframes !== 'function') throw new Error('missing exports');

const values = Array.from({ length: n }, (_, i) => ((i % 11) - 5) * 17 + (i % 3) * 0.125);
const times = Array.from({ length: n }, (_, i) => i / (n - 1));
const linear = (t) => t;
const quadratic = (t) => t * t;
const easing = easingKind === 'linear' ? linear : quadratic;
const easings = Array.from({ length: n - 1 }, () => easing);
const progress = Array.from({ length: 4096 }, (_, i) => 0.0001 + (((i * 2654435761) >>> 0) % 999800) / 1_000_000);
let sink = 0;

function nowNs() { return process.hrtime.bigint(); }
function cpuNsSince(start) {
  const d = process.cpuUsage(start);
  return (d.user + d.system) * 1000;
}
function geo2(a, b) { return Math.sqrt(a * b); }

function sampleBatch(calls, factor = 1) {
  const actual = calls * factor;
  const cpu0 = process.cpuUsage();
  const t0 = nowNs();
  let local = 0;
  for (let i = 0; i < actual; i++) {
    local += sampleKeyframes(values, times, easings, progress[i & 4095]);
  }
  const wall = Number(nowNs() - t0);
  const cpu = cpuNsSince(cpu0);
  sink += local;
  return { wallNsPerNominal: wall / calls, cpuNsPerNominal: cpu / calls, actualCalls: actual };
}

function makeControl(explicit) {
  const opts = {
    values,
    times,
    duration: 1,
    requestFrame: () => 0,
    onStep(v) { sink += v; },
  };
  if (explicit) opts.easing = linear;
  const c = keyframes(opts);
  c.pause();
  return c;
}

function seekBatch(control, calls, factor = 1) {
  const actual = calls * factor;
  const cpu0 = process.cpuUsage();
  const t0 = nowNs();
  for (let i = 0; i < actual; i++) control.seek(progress[i & 4095]);
  const wall = Number(nowNs() - t0);
  const cpu = cpuNsSince(cpu0);
  return { wallNsPerNominal: wall / calls, cpuNsPerNominal: cpu / calls, actualCalls: actual };
}

const observations = [];
if (mode === 'sample') {
  const calls = n === 3 ? 1_500_000 : 500_000;
  for (let i = 0; i < 4; i++) sampleBatch(Math.max(50_000, Math.floor(calls / 8)), 1);
  for (let i = 0; i < 4; i++) observations.push(sampleBatch(calls, treatmentFactor));
} else {
  if (easingKind !== 'linear') throw new Error('seek-matched requires linear');
  const implicit = makeControl(false);
  const explicit = makeControl(true);
  const calls = n === 3 ? 220_000 : 120_000;
  for (let i = 0; i < 8; i++) {
    seekBatch(implicit, Math.max(20_000, Math.floor(calls / 8)), 1);
    seekBatch(explicit, Math.max(20_000, Math.floor(calls / 8)), 1);
  }
  for (let obs = 0; obs < 4; obs++) {
    const order = obs % 2 === 0 ? ['implicit', 'explicit', 'explicit', 'implicit'] : ['explicit', 'implicit', 'implicit', 'explicit'];
    const phases = [];
    for (const role of order) {
      phases.push({ role, result: seekBatch(role === 'implicit' ? implicit : explicit, calls, role === 'implicit' ? treatmentFactor : 1) });
    }
    const imp = phases.filter((p) => p.role === 'implicit').map((p) => p.result);
    const exp = phases.filter((p) => p.role === 'explicit').map((p) => p.result);
    observations.push({
      wallNsPerNominal: geo2(imp[0].wallNsPerNominal, imp[1].wallNsPerNominal) / geo2(exp[0].wallNsPerNominal, exp[1].wallNsPerNominal),
      cpuNsPerNominal: geo2(imp[0].cpuNsPerNominal, imp[1].cpuNsPerNominal) / geo2(exp[0].cpuNsPerNominal, exp[1].cpuNsPerNominal),
      phases,
    });
  }
  implicit.cancel();
  explicit.cancel();
}

if (!Number.isFinite(sink)) throw new Error('non-finite checksum');
console.log(JSON.stringify({ mode, n, easingKind, treatmentFactor, observations, sink, node: process.version, pid: process.pid }));
