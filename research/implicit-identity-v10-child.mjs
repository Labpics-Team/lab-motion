import { pathToFileURL } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const entry = arg('entry');
const n = Number(arg('n'));
const treatmentFactor = Number(arg('factor'));
if (![3, 1025].includes(n)) throw new Error('bad n');
if (treatmentFactor !== 1 && treatmentFactor !== 2) throw new Error('bad factor');

const mod = await import(`${pathToFileURL(entry).href}?v10=${process.pid}`);
const { keyframes } = mod;
if (typeof keyframes !== 'function') throw new Error('missing keyframes export');

const values = Array.from({ length: n }, (_, i) => ((i % 11) - 5) * 17 + (i % 3) * 0.125);
const times = Array.from({ length: n }, (_, i) => i / (n - 1));
const linear = (t) => t;
const progress = Array.from({ length: 4096 }, (_, i) => 0.0001 + (((i * 2654435761) >>> 0) % 999800) / 1_000_000);
let sink = 0;

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

function seekBlock(control, nominalCalls, factor = 1) {
  const actualCalls = nominalCalls * factor;
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < actualCalls; i++) control.seek(progress[i & 4095]);
  const t1 = process.hrtime.bigint();
  const d = process.cpuUsage(cpu0);
  return { wallNs: Number(t1 - t0), cpuNs: (d.user + d.system) * 1000, nominalCalls, actualCalls };
}

const implicit = makeControl(false);
const explicit = makeControl(true);
const warmCalls = n === 3 ? 27_500 : 20_000;
for (let i = 0; i < 8; i++) {
  seekBlock(implicit, warmCalls, 1);
  seekBlock(explicit, warmCalls, 1);
}

const blockCalls = 5_000;
const quartets = n === 3 ? 44 : 24;
const observations = [];
for (let obs = 0; obs < 4; obs++) {
  const blocks = [];
  let implicitWall = 0, explicitWall = 0, implicitCpu = 0, explicitCpu = 0;
  let implicitNominal = 0, explicitNominal = 0;
  for (let q = 0; q < quartets; q++) {
    const order = ((q + obs) & 1) === 0
      ? ['implicit', 'explicit', 'explicit', 'implicit']
      : ['explicit', 'implicit', 'implicit', 'explicit'];
    for (const role of order) {
      const result = seekBlock(role === 'implicit' ? implicit : explicit, blockCalls, role === 'implicit' ? treatmentFactor : 1);
      blocks.push({ quartet: q, role, ...result });
      if (role === 'implicit') {
        implicitWall += result.wallNs; implicitCpu += result.cpuNs; implicitNominal += result.nominalCalls;
      } else {
        explicitWall += result.wallNs; explicitCpu += result.cpuNs; explicitNominal += result.nominalCalls;
      }
    }
  }
  if (implicitNominal !== explicitNominal) throw new Error('unbalanced nominal work');
  const implicitWallPerNominal = implicitWall / implicitNominal;
  const explicitWallPerNominal = explicitWall / explicitNominal;
  const implicitCpuPerNominal = implicitCpu / implicitNominal;
  const explicitCpuPerNominal = explicitCpu / explicitNominal;
  observations.push({
    wallRatio: implicitWallPerNominal / explicitWallPerNominal,
    cpuRatio: implicitCpuPerNominal / explicitCpuPerNominal,
    implicitWallPerNominal, explicitWallPerNominal,
    implicitCpuPerNominal, explicitCpuPerNominal,
    implicitNominal, explicitNominal,
    blocks,
  });
}

implicit.cancel();
explicit.cancel();
if (!Number.isFinite(sink)) throw new Error('non-finite checksum');
console.log(JSON.stringify({ schema: 1, n, treatmentFactor, blockCalls, quartets, warmCallsPerControl: warmCalls * 8, observations, sink, node: process.version, pid: process.pid }));
