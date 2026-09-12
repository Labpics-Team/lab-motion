import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const {
  cluster, sideAPath, sideBPath, acornPath, scenario, calls, positiveControl = false,
} = workerData;
const { parse } = await import(pathToFileURL(acornPath).href);
const aUrl = `${pathToFileURL(sideAPath).href}?bench=A-${cluster}`;
const bUrl = `${pathToFileURL(sideBPath).href}?bench=B-${cluster}`;
const [{ motionCompiler: compilerA }, { motionCompiler: compilerB }] = await Promise.all([import(aUrl), import(bUrl)]);
const pluginA = compilerA();
const pluginB = compilerB();
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

function makeOperation(plugin, repeats = 1) {
  let cursor = 0;
  return () => {
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
  };
}

const opA = makeOperation(pluginA, 1);
const opB = makeOperation(pluginB, positiveControl ? 2 : 1);
let blackhole = 0;
function executeSurfaceBurst(op) {
  let sink = 0;
  for (let i = 0; i < calls; i++) sink += op();
  blackhole += sink;
}
// 128 warm bursts per side, as before, but with the same position-balanced
// ABBA/BAAB schedule as the measured phase. Sequential A×128 → B×128 made the
// 512-item miss control a cache-residency experiment: B was always the most
// recently touched working set, producing a false ~0.76 A/A ratio on the
// immutable baseline. The balanced schedule preserves warm-up work and JIT
// exposure while removing role-dependent starting state.
const warmOrder = cluster % 2 ? [1, 0, 0, 1] : [0, 1, 1, 0];
for (let round = 0; round < 64; round++) {
  for (const side of warmOrder) executeSurfaceBurst(side === 0 ? opA : opB);
}

const clock = [];
for (let i = 0; i < 256; i++) {
  const t = process.hrtime.bigint();
  let u;
  do { u = process.hrtime.bigint(); } while (u === t);
  clock.push(Number(u - t));
}
function timed(op) {
  const resources = process.resourceUsage();
  const cpu = process.cpuUsage();
  const start = process.hrtime.bigint();
  executeSurfaceBurst(op);
  const elapsed = Number(process.hrtime.bigint() - start);
  const endCpu = process.cpuUsage(cpu);
  const endResources = process.resourceUsage();
  if (!(elapsed > 0 && Number.isFinite(blackhole))) throw new Error('invalid timing sample');
  return {
    ns: elapsed / calls,
    elapsed,
    cpuUs: endCpu.user + endCpu.system,
    involuntary: endResources.involuntaryContextSwitches - resources.involuntaryContextSwitches,
    voluntary: endResources.voluntaryContextSwitches - resources.voluntaryContextSwitches,
  };
}
const samples = [[], []];
const details = [];
for (const side of warmOrder) {
  const detail = timed(side === 0 ? opA : opB);
  samples[side].push(detail.ns);
  details.push({ side, ...detail });
}
parentPort.postMessage({ cluster, samples, details, blackhole, clockMax: Math.max(...clock) });
