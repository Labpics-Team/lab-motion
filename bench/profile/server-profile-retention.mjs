// Forced GC изолирован от timing. Отрицательная delta не превращается в ноль.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTransformLifecycleSample } from '../../scripts/bench-transform-support.mjs';
import { createMotionValueDefaultBenchmark } from '../../scripts/bench-support.mjs';
import { SERVER_PROFILE } from './server-profile-registration.mjs';

if (typeof globalThis.gc !== 'function' || process.argv.length !== 3) throw new Error('retention: нужен отдельный --expose-gc процесс и один package directory');
const directory = process.argv[2];
const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
const { animate } = await import(pathToFileURL(path.join(directory, metadata.exports['./animate'].import.default)).href);
const { MotionValue } = await import(pathToFileURL(path.join(directory, metadata.exports['.'].import.default)).href);
const rows = [];
let failure = null;
try {
  for (const scene of SERVER_PROFILE.engineScenes) {
    const macro = scene.workload === 'stock-c' ? createMotionValueDefaultBenchmark(MotionValue, scene.spring) : null;
    const run = async () => {
      if (!macro) return runTransformLifecycleSample({ animate, ...scene });
      for (let operation = 0; operation < scene.callsPerRepetition; operation++) {
        const value = macro.run(), frames = macro.getFrameCount();
        if (value !== scene.target || frames !== scene.expectedFrames) throw Object.assign(new Error('retention: stock C отдельная операция неверна'),
          { raw: { operation, completed: operation, value, frames } });
      }
    };
    for (let warmup = 0; warmup < (scene.warmupBatches ?? 1); warmup++) await run();
    // Promise checkpoint не завершает kept-alive job WeakRef в pinned Node.
    // Новый host turn отделяет temporary keepalive от retained heap.
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage();
    for (let repeat = 0; repeat < SERVER_PROFILE.repetitions; repeat++) await run();
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage();
    rows.push({ scene: scene.id, before, after, retainedHeapDeltaBytes: after.heapUsed - before.heapUsed });
  }
} catch (error) {
  failure = { name: error.name, message: error.message, ...(error.raw ? { raw: error.raw } : {}) };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify({ verdict: failure ? 'UNPROVEN' : 'COMPLETE', failure,
  scope: 'пакет + oracle; observational retained heap после host turn и двух GC; не тайминг и не точная атрибуция утечки', rows })}\n`);
