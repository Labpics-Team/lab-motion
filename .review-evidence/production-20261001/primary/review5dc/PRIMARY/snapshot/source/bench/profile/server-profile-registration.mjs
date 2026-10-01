// Серверная диагностическая клетка PROFILE-01. Устройства, энергия, GPU и
// частота физического экрана требуют отдельного evidence и здесь не выводятся.
import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes } from '../compare/provenance.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export const SERVER_PROFILE = freeze({
  schema: 1,
  rawEncoding: 'compact-json-stream-v1; every sample preserved; external digest and journal bind exact file bytes',
  id: 'PROFILE-01-server',
  baselineRevision: '0b6f537e148b7dadadfb9e3ce7c446d014975958',
  browsers: ['chromium', 'firefox', 'webkit'],
  viewport: { width: 800, height: 200 },
  deviceScaleFactor: 1,
  headless: true,
  cpuThrottle: 1,
  engineScenes: [
    { id: 'scalar-live-100', lifecycle: 'live', count: 100, channels: 1 },
    { id: 'transform-fresh-1000', lifecycle: 'fresh', count: 1000, channels: 7 },
  ],
  browserScenes: [
    { id: 's2', targetsPerCall: 100, staggerGapMs: 0 },
    { id: 's3', targetsPerCall: 200, staggerGapMs: 5 },
  ],
  comparators: ['motion', 'gsap', 'anime', 'waapi-ctl', 'motion-mini', 'anime-waapi'],
  durationMs: 128,
  toPx: 300,
  repetitions: 8,
  browserBatchCalls: 32,
  browserSemanticCalls: 1,
  browserSemantics: { movementThresholdPx: 0.5, finalTolerancePx: 2, requireFreshStart: true, fromPx: 0, requireDocumentFrame: true,
    temporalOracle: 'наблюдаемый свежий onset 0→300 до/после API; фаза связана с началом вызова; полный displacement interval разрешающей пары внутри прежнего CSS допуска; timed onset ограничен actual batch/read часами; CSS в actual стабильном document frame, связанном с rAF; perf chronology сохранена, без расширения при uncertainty' },
  warmupRuns: 4,
  pilotRuns: 8,
  minRuns: 288,
  maxRuns: 1024,
  seed: 0x53525652,
  statistics: 'точные биномиальные интервалы порядковых статистик по среднему стоимости двух противоположных runs',
  familyAlpha: 0.05,
  familySize: 10,
  nonInferiorityUpper: 1.05,
  positiveLower: 1.5,
  positiveWorkMultiplier: 2,
  mdeRelative: 0.05,
  power: 0.8,
  zPower: 0.8416212335729143,
  // Bonferroni: 10 клеток × p50/p95, двухсторонняя family-wise 95% полоса.
  zFamily: 3.023341439739154,
  metrics: {
    engine: ['operationNs', 'meanFrameNs', 'cancelDrainNs'],
    browser: ['startMs', 'cancelMs'],
  },
  clock: { engine: 'process.threadCpuUsage (user + system), наносекунды', browser: 'realm-local performance.now, миллисекунды' },
  engineRawLineage: 'все actual user/system CPU fields,16 clock endpoints и ordered scheduler/CSS traces сохраняются lossless; interval/coordinate/hash пересчитываются существующим lifecycle owner',
  samplingUnit: 'средняя стоимость парного блока двух противоположных runs; повторы/кадры зависимы; p95 относится к распределению средних блоков',
  denominator: 'стоимость полезного вызова с зарегистрированными targets: browser batch/32; positive содержит 64 actual calls без деления на два; engine unchanged',
  stoppingRule: 'один baseline-only pilot → замороженный N → один A/A и 2×work → A/B только при годной калибровке; добор и повтор к green запрещены',
  preservedGuards: 'size-gate, численные/семантические допуски и protected p95 upper ≤1.05 не меняются',
  scope: 'headless server: CPU потока engine и API browser при duration=128 ms; counts/stagger закреплены; endpoint/start/frame/retarget/cancel отдельно; canonical 1200 ms guards независимы',
  unproven: ['mobile Android/iOS', 'physical 60/120 Hz', 'whole-page energy', 'GPU', 'M-04 physical-device envelope', 'M-05 product scene families'],
  forcedGc: 'только отдельный retention child process; в timing отсутствует',
  rawControls: 'baseline no-motion: два одинаковых PNG; reduced-motion: endpoint без rAF/WAAPI; candidate controls только после PASS calibration',
  resourcePolicy: 'весь cgroup: до/после каждого парного блока; affinity неизменна, nr_throttled/throttled_usec delta=0; все samples сохраняются, нарушение даёт UNPROVEN без post-hoc исключений',
  browserOperationTimeoutMs: 30_000,
  clockError: {
    id: 'linux-node24.19-chromium149-isolated',
    kernelRelease: '6.18.44',
    nodeVersion: 'v24.19.0',
    nodeExecutableSha256: 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
    browser: 'chromium',
    browserVersion: '149.0.7827.55',
    browserExecutableSha256: '2d18db9d8608b052b6a552ee00ec1e830f93692e928b65ecc67d693bd33fe801',
    browserClampErrorPerTimestampMs: 0.005,
    browserTickTruncationPerTimestampMs: 0.001,
    monotonicCounterLimitMs: 2 ** 42,
    engineIntervalUncertaintyNs: 2_000,
    sources: {
      timeClamper: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/timing/time_clamper.cc', sha256: '2491cb64f50a54ccd10f778c058f0960ad4d9fa0861e39212bc27b8343bd103c' },
      timeClamperHeader: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/timing/time_clamper.h', sha256: 'f8065edb3ba8da66d58eb7042523fba44b6d515c04d482614670a5414a684944' },
      performance: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/third_party/blink/renderer/core/timing/performance.cc', sha256: '62de6788c9361958757f47a173369cc668f3691ec58f27e2d2edfab780efe200' },
      windowPerformance: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/third_party/blink/renderer/core/timing/window_performance.cc', sha256: '5916501d9960c6355f1b2b0cee7cbc10091bf63ac64b0bf6397d96e495f71983' },
      timeTicks: { url: 'https://raw.githubusercontent.com/chromium/chromium/149.0.7827.55/base/time/time_now_posix.cc', sha256: '6a7b898ec4a2eedbfcc2173ca3cac17b188829b9531ba3febcfe942925ed5796' },
      documentTimeline: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/document_timeline.cc', sha256: 'e8e405492b4f49f6be850e68c3431d1e2107ac032ea4ff11c433cc726642c702' },
      animationClock: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/animation_clock.cc', sha256: 'f3290008c81dab4f17c7ae8439de25c1c95d0204be6dbb16dada0fd1a8e584eb' },
      animationTimeline: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/animation_timeline.cc', sha256: '6745f06a855d19691098929b29a5d28331d814c6ae21f1cdf12368eeb7ab5c90' },
      documentAnimations: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/animation/document_animations.cc', sha256: '6b20e0668cc740d1e2c9a9828b5316c81b7c43f2eb907af686729e51d10855d2' },
      pageAnimator: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/page/page_animator.cc', sha256: 'ba6157ecdc92b5e3375e0239c3b79f39050f5ea3a84d27f65e60b03f1b676e03' },
      cssComputedStyle: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/css/css_computed_style_declaration.cc', sha256: 'fc8f9580c1fd1bc2c28d753083925118c38134c37406dcd2f55d98a8ea2bbfb6' },
      documentStyle: { url: 'https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/third_party/blink/renderer/core/dom/document.cc', sha256: '8a09dd50bdbbca54b11af849376c4f76df2fd62b14ae665c4c208553b4941dd6' },
      nodeProcess: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/src/node_process_methods.cc', sha256: '6f2d27513a933dd3d076c0ffe2f95a1846ba1d1060f7ccfbc6eb2df6692a34eb' },
      libuvCore: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/deps/uv/src/unix/core.c', sha256: '18bfd5f2045417f8ace5d76e222bf7441b31ead5fc2cbaf6225965e0afea8767' },
      libuvLinux: { url: 'https://raw.githubusercontent.com/nodejs/node/v24.19.0/deps/uv/src/unix/linux.c', sha256: '215185d94697e05cd75ba9466bb9ea93076769a7767218d4183eaf0723ccf2d2' },
      linuxRusage: { url: 'https://raw.githubusercontent.com/gregkh/linux/v6.18.44/kernel/sys.c', sha256: '0b656f8809d781b7e684a1a4c4144d925684c69e9f6050c41c6374c5206d2c8d' },
      linuxTimeval: { url: 'https://raw.githubusercontent.com/gregkh/linux/v6.18.44/kernel/time/time.c', sha256: 'e757e825d72489c929a273f22aba8fa31487c29738960aea2683ac0274a58e6a' },
    },
    documentFrame: 'Chromium149 PageAnimator coarsens frame TimeTicks тем же isolated TimeClamper; DocumentTimeline origin совпадает с навигацией; AnimationClock стабилен в rendering/task; CSS recalc обновляет animation timing этим clock. До/после onset API observed publication clock одинаков и связывает origin свежего движения; checkpoint clock одинаков до/после CSS и связан с observed rAF. Frame timestamp может предшествовать execution wall, wall chronology отдельна. Сопоставление frame/perf включает три coarsened timestamps(frame/now/origin): upward(1.5×прежний2-endpoint envelope), без изменения API-cost bounds. Нет qualification или clocks противоречат — отказ. Это clock публикации CSS, а не атрибуция внутреннего таймера JS/native API.',
    scope: 'Linux: два user/system counters с microsecond truncation; Chromium isolated TimeClamper может округлять в обе стороны на5us, TimeTicks truncates1us; обе clockreads и binary64 roundoff входят в pointwise bounds до CI, без shrink по repeats/N',
    assumption: 'закреплённые official browser/Node binaries и Linux6.18.44 исполняют указанную upstream clock model; Node hrtime и browser TimeTicks используют общий Linux CLOCK_MONOTONIC без namespace/clock override; observed quantum является control, а не сертификатом error; другие binary/model/небезопасные counters дают отказ',
  },
  browserCancellationWitness: { frames: 2, transformTolerancePx: 0.000001,
    scope: 'attached targets после cancel: нет WAAPI, transform неизменен два rAF; sync cancelMs и elapsed cancel→drain раздельно; swallowed vendor exceptions нормализованного adapter не наблюдаются' },
  stationarityAssumption: 'независимые одинаково распределённые средние paired blocks при закреплённой среде; A/A и ресурсные controls проверяют разрешимость, перенос за пределы этой клетки не доказан',
});

export function serverProfileDigest(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value)));
}

export function verifyServerProfile(value) {
  if (!isDeepStrictEqual(value, SERVER_PROFILE)) throw new Error('server profile: изменён зарегистрированный протокол');
}

export function serverTailPolicy() {
  const alphaPerTail = SERVER_PROFILE.familyAlpha / (SERVER_PROFILE.familySize * 2 * 2 * 2);
  return { alphaPerTail, quantiles: [0.5, 0.95], minimumBlocks: Math.ceil(Math.log(alphaPerTail) / Math.log(0.95)),
    correction: 'Bonferroni: 10 cells × 2 quantiles × 2 participants × 2 tails; family-wise 95%' };
}

// Требуемый N выводится только из baseline A/A pilot, до любых candidate samples.
// Формула планирует средний парный log-contrast; tail admission остаётся отдельным
// строгим гейтом и не получает гарантии мощности от этой приближённой оценки.
export function planServerSampleSize(pilotPairs) {
  if (!Array.isArray(pilotPairs) || pilotPairs.length !== SERVER_PROFILE.familySize) {
    throw new Error('server profile: неполное семейство null-pilot');
  }
  const cells = pilotPairs.map(({ id, left, right }) => {
    if (typeof id !== 'string' || !Array.isArray(left) || !Array.isArray(right) ||
        left.length !== SERVER_PROFILE.pilotRuns || right.length !== left.length ||
        [...left, ...right].some((x) => !Number.isFinite(x) || x <= 0)) {
      throw new Error('server profile: некорректные baseline-only pilot samples');
    }
    const differences = Array.from({ length: left.length / 2 }, (_, block) =>
      (Math.log(left[block * 2]) - Math.log(right[block * 2]) + Math.log(left[block * 2 + 1]) - Math.log(right[block * 2 + 1])) / 2);
    const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
    const variance = differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (differences.length - 1);
    const requiredRuns = 2 * Math.ceil(((SERVER_PROFILE.zFamily + SERVER_PROFILE.zPower) * Math.sqrt(variance) /
      Math.log(1 + SERVER_PROFILE.mdeRelative)) ** 2);
    return { id, logContrastSd: Math.sqrt(variance), requiredRuns };
  });
  if (new Set(cells.map(({ id }) => id)).size !== cells.length) throw new Error('server profile: повторная pilot cell');
  const tail = serverTailPolicy();
  const requiredRuns = Math.max(SERVER_PROFILE.minRuns, tail.minimumBlocks * 2, ...cells.map(({ requiredRuns: n }) => n));
  const runs = Math.min(SERVER_PROFILE.maxRuns, Math.ceil(requiredRuns / 2) * 2);
  return { runs, requiredRuns, feasible: requiredRuns <= SERVER_PROFILE.maxRuns, cells, tail,
    method: 'baseline-only paired block log-contrast normal approximation; power 0.8, MDE 5%, Bonferroni family 10×2; N в runs, блок содержит два run' };
}
