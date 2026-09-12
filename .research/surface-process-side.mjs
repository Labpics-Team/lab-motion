import { pathToFileURL } from 'node:url';

const [entryPath, acornPath, scenario, callsRaw, repeatsRaw] = process.argv.slice(2);
const calls = Number(callsRaw);
const repeats = Number(repeatsRaw);
if (!entryPath || !acornPath) throw new Error('entry/acorn paths are required');
if (!Number.isSafeInteger(calls) || calls <= 0) throw new Error('calls must be positive integer');
if (!Number.isSafeInteger(repeats) || repeats <= 0) throw new Error('repeats must be positive integer');
if (!['ordinary-warm', 'ordinary-miss', 'reject', 'batch'].includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);

const { parse } = await import(pathToFileURL(acornPath).href);
const { motionCompiler } = await import(`${pathToFileURL(entryPath).href}?fresh=${process.pid}`);
const plugin = motionCompiler();
const context = {
  parse: source => parse(source, { ecmaVersion: 2022, sourceType: 'module' }),
  warn: warning => { throw new Error(String(warning)); },
};

function surfaceCode(count = 1, spring = '') {
  return "import {animate} from '@labpics/motion/animate';\n" + Array.from({ length: count }, (_, i) =>
    `animate(el${i},{width:[240,360]},{layout:'project'${spring}});`,
  ).join('\n') + '\n';
}
const ORDINARY = surfaceCode(1);
const BATCH = surfaceCode(8);
const REJECT = "import {animate} from '@labpics/motion/animate';\n" + Array.from({ length: 64 }, (_, i) =>
  `animate(el${i},{width:[240,w${i}]},{layout:'project'});`,
).join('\n') + '\n';
const MISS = Array.from({ length: 512 }, (_, i) => {
  const stiffness = 170 * (1 + (i + 1) * 2 ** -40);
  return surfaceCode(1, `,spring:{mass:1,stiffness:${stiffness},damping:26}`);
});

let cursor = 0;
function operation() {
  const source = scenario === 'ordinary-miss' ? MISS[cursor++ & 511]
    : scenario === 'batch' ? BATCH
    : scenario === 'reject' ? REJECT
    : ORDINARY;
  let sink = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const out = plugin.transform.call(context, source, 'consumer.js');
    if (scenario === 'reject') {
      if (out !== undefined) throw new Error('reject control unexpectedly lowered');
      sink += 1;
      continue;
    }
    if (!out?.code.includes('__labMotionSurface')) throw new Error(`${scenario}: expected Surface lowering`);
    for (const text of [out.code, out.map.mappings]) {
      for (let i = 0; i < text.length; i++) sink += text.charCodeAt(i);
    }
  }
  return sink;
}

let blackhole = 0;
function burst() {
  let sink = 0;
  for (let i = 0; i < calls; i++) sink += operation();
  blackhole += sink;
}

// Preserve the previously registered warm work exactly: 128 bursts for this
// participant, each containing the same scenario-specific number of calls.
for (let warm = 0; warm < 128; warm++) burst();

const clock = [];
for (let i = 0; i < 256; i++) {
  const t = process.hrtime.bigint();
  let u;
  do { u = process.hrtime.bigint(); } while (u === t);
  clock.push(Number(u - t));
}

const samples = [];
const details = [];
for (let observation = 0; observation < 2; observation++) {
  const resources = process.resourceUsage();
  const cpu = process.cpuUsage();
  const start = process.hrtime.bigint();
  burst();
  const elapsed = Number(process.hrtime.bigint() - start);
  const endCpu = process.cpuUsage(cpu);
  const endResources = process.resourceUsage();
  if (!(elapsed > 0 && Number.isFinite(blackhole))) throw new Error('invalid timing sample');
  samples.push(elapsed / calls);
  details.push({
    observation,
    ns: elapsed / calls,
    elapsed,
    cpuUs: endCpu.user + endCpu.system,
    involuntary: endResources.involuntaryContextSwitches - resources.involuntaryContextSwitches,
    voluntary: endResources.voluntaryContextSwitches - resources.voluntaryContextSwitches,
  });
}

process.stdout.write(JSON.stringify({ samples, details, blackhole, clockMax: Math.max(...clock) }));
