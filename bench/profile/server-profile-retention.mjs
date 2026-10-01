// Forced GC изолирован от timing. Отрицательная delta не превращается в ноль.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTransformLifecycleSample } from '../../scripts/bench-transform-support.mjs';
import { SERVER_PROFILE } from './server-profile-registration.mjs';

if (typeof globalThis.gc !== 'function' || process.argv.length !== 3) throw new Error('retention: нужен отдельный --expose-gc процесс и один package directory');
const directory = process.argv[2];
const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
const { animate } = await import(pathToFileURL(path.join(directory, metadata.exports['./animate'].import.default)).href);
const rows = [];
let failure = null;
try {
  for (const scene of SERVER_PROFILE.engineScenes) {
    await runTransformLifecycleSample({ animate, ...scene });
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage();
    for (let repeat = 0; repeat < SERVER_PROFILE.repetitions; repeat++) await runTransformLifecycleSample({ animate, ...scene });
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage();
    rows.push({ scene: scene.id, before, after, retainedHeapDeltaBytes: after.heapUsed - before.heapUsed });
  }
} catch (error) {
  failure = { name: error.name, message: error.message };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify({ verdict: failure ? 'UNPROVEN' : 'COMPLETE', failure,
  scope: 'пакет + oracle; observational retained heap после двух GC; не тайминг и не точная атрибуция утечки', rows })}\n`);
