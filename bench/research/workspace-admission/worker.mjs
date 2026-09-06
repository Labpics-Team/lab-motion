// One canonical workload per fresh process and one constant consumer URL.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runMassLifecycleSample } from './bench-support.mjs';
const cell = JSON.parse(readFileSync(0, 'utf8'));
const began = process.hrtime.bigint();
const { animate } = await import('./consumer/dist/animate/index.js');
const importNs = Number(process.hrtime.bigint() - began);
// Deliberate start-delay control only; never enabled for A/B candidate samples.
const runAnimate = cell.penaltyNs ? (...args) => {
  const start = process.hrtime.bigint();
  const result = animate(...args);
  while (process.hrtime.bigint() - start < BigInt(cell.penaltyNs)) {}
  return result;
} : animate;
const warmup = cell.count === 1 ? 2000 : cell.count === 100 ? 128 : 48;
const iterations = cell.count === 1 ? 512 : cell.count === 100 ? 64 : 32;
let semanticSha256;
const samples = [];
for (let i = 0; i < warmup + iterations; i++) {
  const v = await runMassLifecycleSample({ animate: runAnimate, count: cell.count, motion: cell.motion });
  const digest = createHash('sha256').update(JSON.stringify(v.semantic)).digest('hex');
  if (semanticSha256 !== undefined && digest !== semanticSha256) throw Error('non-deterministic semantic journal');
  semanticSha256 = digest;
  if (i >= warmup) samples.push({ startNs: v.startNs, frames60Ns: v.frames60Ns, teardownNs: v.teardownNs });
}
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, importNs, warmup, iterations, semanticSha256, samples }));
