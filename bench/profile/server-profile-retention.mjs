// Forced GC изолирован от timing. Отрицательная delta не превращается в ноль.
import { runTransformLifecycleSample } from '../../scripts/bench-transform-support.mjs';
import { createMotionValueDefaultBenchmark } from '../../scripts/bench-support.mjs';
import { SERVER_PROFILE } from './server-profile-registration.mjs';
import { loadServerParticipant } from './server-profile-consumer.mjs';

if (typeof globalThis.gc !== 'function' || process.argv.length !== 4) throw new Error('retention: нужен отдельный --expose-gc процесс, package directory и participant');
const { animate, MotionValue, lineage } = await loadServerParticipant(process.argv[2], process.argv[3]);
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
    // Микрозадача Promise не освобождает временно удерживаемые цели WeakRef в зафиксированном Node.
    // Новый оборот очереди отделяет это удержание от оставшейся памяти.
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
  lineage, scope: 'прежние animate/stock-C из установленного пакета и oracle; наблюдение удержанной кучи после оборота цикла событий хоста и двух GC, не тайминг и не точная атрибуция утечки', rows })}\n`);
