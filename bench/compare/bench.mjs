/**
 * bench/compare/bench.mjs — сравнительный бенчмарк @labpics/motion vs Motion / GSAP / anime.js.
 *
 * ЧЕСТНОСТЬ (контракт файла):
 * - Все четыре библиотеки — РЕАЛЬНЫЕ пакеты (vendor'ы из npm, наш — собранный dist),
 *   собранные esbuild'ом в IIFE и исполняемые в реальном Chromium (Playwright).
 * - Ни одного захардкоженного «vendor»-числа, ни одного множителя поверх измерений,
 *   ни одного sim-фоллбэка: нет браузера или dist — процесс падает с ошибкой.
 * - Freeze-тест меряется ВИЗУАЛЬНО: кадры через CDP Page.startScreencast
 *   (компоситор жив при заблокированном main-thread), позиция — пиксель-скан pngjs.
 * - Смоук-гейт: если адаптер библиотеки не двигает элемент — прогон прерывается,
 *   а не публикует нули за конкурента.
 *
 * Запуск: cd bench/compare && pnpm i && node bench.mjs
 * Корневой dist пересобирается самим стендом до фиксации provenance.
 * Переменные: BENCH_RUNS (дефолт 20), BENCH_FREEZE_RUNS (дефолт 8, полный
 * позиционно-сбалансированный блок; допустимы только кратные числу участников).
 */

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalGzip,
  observationalBrotli,
} from '../../scripts/compression-oracle.mjs';
import { CANONICAL_GZIP_PACKAGE } from '../../scripts/compression-policy.mjs';
import {
  assertFileHashesUnchanged,
  assertCheckoutUnchanged,
  assertInstalledPackageTreesUnchanged,
  hashFileTree,
  prepareBenchmarkCheckout,
  sha256Bytes,
  sha256File,
} from './provenance.mjs';
import {
  assertBalancedRunBlocks,
  assertFreezeMatrix,
  assertPositiveFiniteSamples,
  assertStartSemanticEvidence,
  assertWarmStartMeasurement,
  BENCHMARK_TIMER_ISOLATION_POLICY,
  createFreezeEvidence,
  deriveFirstPresentedElapsedMs,
  deriveRealmClockUncertainty,
  deriveRealmTimerStep,
  deriveWarmStartCalibration,
  evaluateStartSemanticEvidence,
  makeRoundRobinOrders,
  movementStats,
  parseBenchCount,
  PRODUCTION_ADAPTER_PROFILE,
  scoreAgainstBaseline,
  START_SCENARIO_MANIFEST,
  summarizeReportSamples,
  summarizeMedianSamples,
  WARM_TIMER_CALIBRATION_POLICY,
} from './methodology.mjs';
import {
  renderBenchmarkMarkdown,
  renderBenchmarkEnvironment,
  createBenchmarkClaims,
  createBenchmarkMotionConformance,
  S5_MOTION_REQUIREMENTS,
  validateBenchmarkReportPair,
} from './report-contract.mjs';
import { S5_MOTION_CONTRACT } from './motion-conformance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
// Чистые проверки семантики не требуют отдельной установки браузерного стенда.
// Его зависимости остаются обязательными при фактической сборке и измерениях.
const requireBenchmark = createRequire(import.meta.url);
const RUNS = parseBenchCount('BENCH_RUNS', process.env.BENCH_RUNS, 20, { min: 20, max: 60 });
const ORDER_SEED = 0x51f15e;
const BOOTSTRAP_ITERATIONS = 10_000;

const LIBS = [
  { id: 'lab', entry: 'entries/lab.entry.mjs', pkg: null, group: 'transform-linear-start+stagger-adapter', startCosts: true },
  { id: 'motion', entry: 'entries/motion.entry.mjs', pkg: 'motion', group: 'transform-linear-start+stagger-adapter', startCosts: true },
  { id: 'gsap', entry: 'entries/gsap.entry.mjs', pkg: 'gsap', group: 'transform-linear-start+stagger-adapter', startCosts: true },
  { id: 'anime', entry: 'entries/anime.entry.mjs', pkg: 'animejs', group: 'transform-linear-start+stagger-adapter', startCosts: true },
  // Freeze-only ряды вне tween-матрицы (S1–S4 у них «н/д»; S6 измеряется):
  // контроль инструмента и компоситорный (spring→WAAPI) путь нашего фасада.
  { id: 'waapi-ctl', entry: 'entries/waapi-control.entry.mjs', pkg: null, group: 'transform-linear-waapi-control', ver: 'платформа Chromium (без библиотеки)' },
  { id: 'lab-spring', entry: 'entries/lab-spring.entry.mjs', pkg: null, group: 'transform-spring-start-adapter' },
  // Лучшие официальные native-пути: без них freeze-победа была бы ложной.
  { id: 'motion-mini', entry: 'entries/motion-mini.entry.mjs', pkg: 'motion', group: 'transform-linear-native-start-adapter' },
  { id: 'anime-waapi', entry: 'entries/anime-waapi.entry.mjs', pkg: 'animejs', group: 'transform-linear-native-start-adapter' },
];
const FREEZE_RUNS = parseBenchCount(
  'BENCH_FREEZE_RUNS',
  process.env.BENCH_FREEZE_RUNS,
  LIBS.length,
  { min: LIBS.length, max: LIBS.length * 5 },
);
const ENTRY_INPUTS = LIBS.map(({ entry }) => [
  `bench/${entry}`,
  path.join(__dirname, entry),
]);
const BENCH_PACKAGES = ['animejs', 'esbuild', 'gsap', 'motion', 'playwright', 'pngjs'];

// ─── утилиты ─────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`\nБЕНЧ ПРЕРВАН: ${msg}`);
  console.error('Симуляций и подстановок этот бенчмарк не делает намеренно.');
  process.exit(1);
}

async function resolveChromiumInstall() {
  const playwrightRoot = realpathSync(path.join(__dirname, 'node_modules', 'playwright'));
  const coreRoot = path.join(path.dirname(playwrightRoot), 'playwright-core');
  const registryBundle = path.join(coreRoot, 'lib', 'coreBundle.js');
  const registryModule = await import(pathToFileURL(registryBundle).href);
  const descriptor = registryModule.registry.registry.findExecutable('chromium');
  return { directory: descriptor.directory, revision: descriptor.revision };
}

function libVersion(lib, rootPkg) {
  if (lib.ver) return lib.ver;
  if (!lib.pkg) return `${rootPkg.name}@${rootPkg.version} (локальный dist)`;
  const p = JSON.parse(readFileSync(path.join(__dirname, 'node_modules', lib.pkg, 'package.json'), 'utf8'));
  return `${p.name}@${p.version}`;
}

// ─── сборка адаптеров ────────────────────────────────────────────────────────

function buildAdapter(lib) {
  const outfile = path.join(__dirname, 'results', `.${lib.id}.iife.js`);
  requireBenchmark('esbuild').buildSync({
    ...PRODUCTION_ADAPTER_PROFILE,
    entryPoints: [path.join(__dirname, lib.entry)],
    format: 'iife',
    globalName: '__adapterModule',
    outfile,
    logLevel: 'silent',
  });
  return { path: outfile, sha256: sha256File(outfile) };
}

/** import-cost: один ESM+minify артефакт, затем gzip-9 и Brotli-11. */
function measureSize(lib) {
  const res = requireBenchmark('esbuild').buildSync({
    ...PRODUCTION_ADAPTER_PROFILE,
    entryPoints: [path.join(__dirname, lib.entry)],
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const raw = res.outputFiles[0].contents;
  return {
    raw: raw.byteLength,
    gz: canonicalGzip(raw).byteLength,
    br: observationalBrotli(raw).byteLength,
    sha256: sha256Bytes(raw),
  };
}

// ─── страница ────────────────────────────────────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; }
  .box { position: absolute; left: 0; top: 0; width: 10px; height: 10px; background: #0000ff; }
  #probe { position: absolute; left: 0; top: 20px; width: 30px; height: 30px; background: #ff0000; }
  #capture-witness { position: absolute; left: 0; top: 80px; width: 8px; height: 8px; background: #00ff00; }
</style></head><body></body></html>`;

export async function startBenchmarkOrigin() {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': BENCHMARK_TIMER_ISOLATION_POLICY.crossOriginOpenerPolicy,
      'cross-origin-embedder-policy': BENCHMARK_TIMER_ISOLATION_POLICY.crossOriginEmbedderPolicy,
      'origin-agent-cluster': BENCHMARK_TIMER_ISOLATION_POLICY.originAgentCluster,
    });
    response.end(PAGE_HTML);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('benchmark origin не получил TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error === undefined ? resolve() : reject(error)
    ))),
  };
}

async function newPage(browser, adapterPath, pageUrl) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 200 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.bringToFront();
  const isolated = await page.evaluate(() => crossOriginIsolated);
  if (isolated !== BENCHMARK_TIMER_ISOLATION_POLICY.crossOriginIsolated) {
    throw new Error('benchmark page не получила cross-origin isolated timer realm');
  }
  await page.addScriptTag({ path: adapterPath });
  const ok = await page.evaluate(() => typeof window.__adapterModule?.start === 'function');
  if (!ok) fail(`адаптер не загрузился: ${adapterPath}`);
  return { context, page };
}

/** Смоук: адаптер реально двигает элемент, иначе весь прогон недействителен. */
async function smokeCheck(page, libId) {
  const moved = await page.evaluate(async () => {
    const el = document.createElement('div');
    el.className = 'box';
    document.body.appendChild(el);
    window.__adapterModule.start([el], 200, 400);
    let x = 0;
    for (let attempt = 0; attempt < 20 && x <= 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      x = new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
    }
    el.remove();
    return x;
  });
  if (!(moved > 10)) fail(`смоук ${libId}: элемент не сдвинулся (x=${moved}) — адаптер неисправен, числа были бы враньём`);
}

/** Свидетельство отказа на стороне Node служит диагностике; исходный семантический гейт сохраняет отказ. */
export function assertStartSemanticEvidenceWithDiagnostic(label, evidence, metadata, resultsDirectory = path.join(__dirname, 'results')) {
  try {
    assertStartSemanticEvidence(label, evidence);
  } catch (error) {
    try {
      // Уникальный видимый каталог сохраняется при загрузке артефактов и не перезаписывает прошлую попытку.
      const directory = mkdtempSync(path.join(resultsDirectory, 'semantic-failure-'));
      const file = path.join(directory, 'evidence.json');
      const diagnostic = {
        ...metadata,
        diagnostic: 'start-semantic-failure',
        label,
        error: { name: error?.name, message: String(error?.message ?? error), stack: error?.stack },
        semanticEvidence: evidence,
      };
      // JSON превращает NaN/Infinity в null; сохраняем фактическое невалидное наблюдение явно.
      const json = JSON.stringify(diagnostic, (_key, value) => (
        typeof value === 'number' && !Number.isFinite(value) ? { $number: String(value) } : value
      ), 2) + '\n';
      writeFileSync(file, json, { flag: 'wx' });
      console.error(`Semantic diagnostic: ${file}`);
    } catch (diagnosticError) {
      console.error(`${label}: semantic diagnostic could not be saved: ${String(diagnosticError)}`);
    }
    throw error;
  }
}

async function measurePageTimerProbe(page, phase) {
  const raw = await page.evaluate(() => {
    const deltas = [];
    for (let observation = 0; observation < 64; observation++) {
      const started = performance.now();
      let current = started;
      for (let spin = 0; spin < 1_000_000 && current === started; spin++) {
        current = performance.now();
      }
      if (current > started) deltas.push(current - started);
    }
    return { timeOriginMs: performance.timeOrigin, performanceNowDeltasMs: deltas };
  });
  return { phase, ...raw };
}

async function measureTimerCalibration(browser, pageUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.bringToFront();
  const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  if (crossOriginIsolated !== BENCHMARK_TIMER_ISOLATION_POLICY.crossOriginIsolated) {
    throw new Error('timer calibration запущена без cross-origin isolation');
  }
  const timerEvidence = {
    crossOriginIsolated,
    probes: [
      await measurePageTimerProbe(page, 'before'),
      await measurePageTimerProbe(page, 'after'),
    ],
  };
  await context.close();
  return {
    timerEvidence,
    timerStepMs: deriveRealmTimerStep('reference timer', timerEvidence),
    clockUncertaintyMs: deriveRealmClockUncertainty('reference timer', timerEvidence),
    isolation: BENCHMARK_TIMER_ISOLATION_POLICY,
  };
}

// ─── сценарии S1–S4: scripting-стоимость старта ──────────────────────────────

async function runWarmStartCosts(page, scenario) {
  const before = await measurePageTimerProbe(page, 'before');
  const measurement = await page.evaluate(async (config) => {
    const A = window.__adapterModule;
    const mk = (n) => Array.from({ length: n }, () => {
      const element = document.createElement('div');
      element.className = 'box';
      document.body.appendChild(element);
      return element;
    });
    const drain = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const measure = async ({ calls, targets, staggerGapMs, samples, toPx, durationMs }) => {
      const rows = [];
      for (let sample = -1; sample < samples; sample++) {
        const groups = Array.from({ length: calls }, () => mk(targets));
        const controls = [];
        const started = performance.now();
        for (const elements of groups) {
          controls.push(staggerGapMs > 0
            ? A.startStagger(elements, toPx, durationMs, staggerGapMs)
            : A.start(elements, toPx, durationMs));
        }
        const batchElapsedMs = performance.now() - started;
        for (const control of controls) { try { control.cancel(); } catch { /* noop */ } }
        for (const elements of groups) for (const element of elements) element.remove();
        // Первый батч — warmup. Дрен rAF/микрозадач не даёт следующему батчу
        // бесплатно присоединиться к pending-frame предыдущего.
        await Promise.resolve();
        await drain();
        if (sample >= 0) rows.push({
          batchElapsedMs,
          perCallMs: batchElapsedMs / calls,
        });
      }
      return {
        samples: rows.map((row) => row.perCallMs),
        batchElapsedMs: rows.map((row) => row.batchElapsedMs),
      };
    };
    return {
      ...(await measure({
      calls: config.warmCalls,
      targets: config.targetsPerCall,
      staggerGapMs: config.staggerGapMs,
      samples: config.warmSamples,
      toPx: config.toPx,
      durationMs: config.durationMs,
      })),
      measurementTimeOriginMs: performance.timeOrigin,
    };
  }, scenario);
  const after = await measurePageTimerProbe(page, 'after');
  const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  return {
    ...measurement,
    timerEvidence: { crossOriginIsolated, probes: [before, after] },
  };
}

/**
 * Все библиотеки проходят один и тот же calls-раунд. Удвоение прекращается
 * только когда каждый batch выше физического timer-floor.
 */
async function measureWarmStartCalibration(browser, adapters, libs, pageUrl) {
  const participantIds = libs.map((lib) => lib.id);
  const pilots = {};
  for (const [id, config] of Object.entries(START_SCENARIO_MANIFEST)) {
    const rounds = [];
    let calls = config.warmCalls;
    for (;;) {
      const measurements = {};
      for (const lib of libs) {
        measurements[lib.id] = [];
        for (let cluster = 0; cluster < WARM_TIMER_CALIBRATION_POLICY.pilotClusters; cluster++) {
          const { context, page } = await newPage(browser, adapters[lib.id].path, pageUrl);
          const measurement = await runWarmStartCosts(page, { ...config, warmCalls: calls });
          measurements[lib.id].push({
            batchElapsedMs: measurement.batchElapsedMs,
            timerEvidence: measurement.timerEvidence,
            measurementTimeOriginMs: measurement.measurementTimeOriginMs,
          });
          await context.close();
        }
      }
      rounds.push({ calls, measurements });
      console.log(`  calibration ${id}: calls=${calls}, ` + participantIds
        .map((participant) => `${participant}=[${measurements[participant]
          .map((cluster) => (
            `${cluster.batchElapsedMs.map((value) => value.toFixed(3)).join('/')}` +
            `@step${deriveRealmTimerStep(
              `${id}.${participant} pilot`,
              cluster.timerEvidence,
            ).toFixed(6)}`
          ))
          .join(',')}]ms`)
        .join(', '));
      if (participantIds.every((participant) => (
        measurements[participant].every((cluster) => (
          cluster.batchElapsedMs.every((value) => (
            value >= deriveRealmTimerStep(
              `${id}.${participant} pilot`,
              cluster.timerEvidence,
            ) *
              WARM_TIMER_CALIBRATION_POLICY.minimumElapsedQuanta
          ))
        ))
      ))) break;
      const nextCalls = calls * 2;
      if (
        !Number.isSafeInteger(nextCalls) ||
        nextCalls * config.targetsPerCall > WARM_TIMER_CALIBRATION_POLICY.maximumTargetsPerPilot
      ) {
        throw new Error(`${id}: warm calibration не сошлась до лимита целей пилота`);
      }
      calls = nextCalls;
    }
    pilots[id] = rounds;
  }
  return {
    pilots,
    ...deriveWarmStartCalibration(pilots, participantIds),
  };
}

/** Cold single-call только для S2–S4; null/ноль затем fail-closed отклоняет отчёт. */
async function runColdStartCost(page, scenario) {
  const before = await measurePageTimerProbe(page, 'before');
  const measurement = await page.evaluate((config) => {
    const A = window.__adapterModule;
    const elements = Array.from({ length: config.targetsPerCall }, () => {
      const element = document.createElement('div');
      element.className = 'box';
      document.body.appendChild(element);
      return element;
    });
    const started = performance.now();
    const control = config.staggerGapMs > 0
      ? A.startStagger(elements, config.toPx, config.durationMs, config.staggerGapMs)
      : A.start(elements, config.toPx, config.durationMs);
    const elapsed = performance.now() - started;
    try { control.cancel(); } catch { /* noop */ }
    for (const element of elements) element.remove();
    return {
      sample: elapsed > 0 ? elapsed : null,
      measurementTimeOriginMs: performance.timeOrigin,
    };
  }, scenario);
  const after = await measurePageTimerProbe(page, 'after');
  const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  return {
    ...measurement,
    timerEvidence: { crossOriginIsolated, probes: [before, after] },
  };
}

/** Untimed oracle проверяет всю топологию, а не одного выжившего target. */
export async function runSemanticStartCheck(page, scenario, calls) {
  const evidence = await page.evaluate(async ({ config, calls: expectedCalls }) => {
    const A = window.__adapterModule;
    const groups = [], callStartedAtMs = [], controls = [], checkpoints = [], terminal = [], failures = [];
    const onset = config.requireFreshStart ? { before: [], after: [] } : undefined;
    const completion = config.completionTimeoutMs === undefined ? undefined
      : { timeoutMs: config.completionTimeoutMs, calls: [] };
    const pendingCompletions = [];
    const rendered = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let phase = 'setup', epoch, watchdog;
    const failed = (error, location) => failures.push({ phase: location, name: error?.name ?? typeof error, message: String(error?.message ?? error) });
    const delaySpan = config.staggerGapMs * (config.targetsPerCall - 1);
    const checkpointTimes = config.staggerGapMs > 0
      ? [0.2, 0.5, 0.8].map((fraction) => Math.min(config.durationMs, delaySpan) * fraction)
      : [config.durationMs * 0.25, config.durationMs * 0.5, config.durationMs * 0.625];
    try {
      for (let call = 0; call < expectedCalls; call++) {
        const elements = []; groups.push(elements);
        for (let target = 0; target < config.targetsPerCall; target++) {
          const element = document.createElement('div'); elements.push(element);
          element.className = 'box'; document.body.appendChild(element);
        }
      }
      // Подготовка DOM не входит в untimed trajectory oracle. Два rendering
      // шага дают браузеру опубликовать созданные цели до начала анимации.
      if (completion) { await rendered(); await rendered(); }
      epoch = performance.now();
      if (onset) {
        phase = 'onset-before';
        for (const elements of groups) {
          const group = { readStartedMs: performance.now() - epoch, positions: [] }; onset.before.push(group);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame = { beforeMs: typeof value === 'number' ? value - epoch : value ?? null };
          }
          for (const element of elements) group.positions.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame.afterMs = typeof value === 'number' ? value - epoch : value ?? null;
          }
          group.readEndedMs = performance.now() - epoch;
        }
      }
      for (const elements of groups) {
        phase = 'start';
        callStartedAtMs.push(performance.now() - epoch);
        controls.push(config.staggerGapMs > 0
          ? A.startStagger(elements, config.toPx, config.durationMs, config.staggerGapMs)
          : A.start(elements, config.toPx, config.durationMs));
        if (completion) {
          const outcome = { state: 'pending' }; completion.calls.push(outcome);
          const finished = controls.at(-1).finished();
          if (typeof finished?.then !== 'function') throw new Error('Adapter completion is not awaitable');
          // Подписываемся сразу; rejection до checkpoints остаётся acquired evidence.
          pendingCompletions.push(Promise.resolve(finished).then(
            () => { outcome.state = 'fulfilled'; outcome.observedAtMs = performance.now() - epoch; },
            (error) => {
              outcome.state = 'rejected'; outcome.observedAtMs = performance.now() - epoch;
              failed(error, 'completion');
            },
          ));
        }
        if (onset) {
          phase = 'onset-after';
          const group = { readStartedMs: performance.now() - epoch, positions: [] }; onset.after.push(group);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame = { beforeMs: typeof value === 'number' ? value - epoch : value ?? null };
          }
          for (const element of elements) group.positions.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame.afterMs = typeof value === 'number' ? value - epoch : value ?? null;
          }
          group.readEndedMs = performance.now() - epoch;
        }
      }
      if (onset && config.requireDocumentFrame) {
        phase = 'onset-first-frame';
        const frameTimestampMs = await new Promise((resolve) => requestAnimationFrame((timestamp) => resolve(timestamp - epoch)));
        onset.firstFrame = { frameTimestampMs, groups: [] };
        for (const elements of groups) {
          const group = { readStartedMs: performance.now() - epoch, positions: [] }; onset.firstFrame.groups.push(group);
          const before = document.timeline?.currentTime;
          group.documentFrame = { beforeMs: typeof before === 'number' ? before - epoch : before ?? null };
          for (const element of elements) group.positions.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
          const after = document.timeline?.currentTime;
          group.documentFrame.afterMs = typeof after === 'number' ? after - epoch : after ?? null;
          group.readEndedMs = performance.now() - epoch;
        }
      }
      phase = 'checkpoint';
      for (const checkpointTime of checkpointTimes) {
        const remaining = checkpointTime - (performance.now() - epoch);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        // CSS после обновления кадра соотносится с его наблюдаемым timestamp,
        // а не с предположением о частоте экрана или фазе первого callback.
        const frameTimestampMs = await new Promise((resolve) => requestAnimationFrame((timestamp) => resolve(timestamp - epoch)));
        const checkpoint = { frameTimestampMs, groups: [] }; checkpoints.push(checkpoint);
        for (const elements of groups) {
          const group = { readStartedMs: performance.now() - epoch, positions: [] }; checkpoint.groups.push(group);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame = { beforeMs: typeof value === 'number' ? value - epoch : value ?? null };
          }
          for (const element of elements) group.positions.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
          if (config.requireDocumentFrame) {
            const value = document.timeline?.currentTime;
            group.documentFrame.afterMs = typeof value === 'number' ? value - epoch : value ?? null;
          }
          group.readEndedMs = performance.now() - epoch;
        }
      }
      if (completion) {
        phase = 'completion';
        completion.waitStartedMs = performance.now() - epoch;
        try {
          await Promise.race([
            Promise.all(pendingCompletions),
            new Promise((_, reject) => {
              watchdog = setTimeout(() => reject(new Error('Completion watchdog expired')),
                Math.max(0, completion.timeoutMs - completion.waitStartedMs));
            }),
          ]);
        } finally { clearTimeout(watchdog); }
        completion.observedAtMs = performance.now() - epoch;
        if (completion.calls.some((call) => call.state !== 'fulfilled')) {
          throw new Error('Adapter completion rejected');
        }
        phase = 'terminal';
        await rendered();
        await new Promise((resolve) => requestAnimationFrame((timestamp) => {
          completion.terminalFrameTimestampMs = timestamp - epoch;
          // Timestamp кадра может отставать от wall clock его callback.
          completion.terminalFrameObservedAtMs = performance.now() - epoch;
          resolve();
        }));
        completion.terminalReadStartedMs = performance.now() - epoch;
      } else {
        // Locked server profile сохраняет прежний terminal contract;
        // его adapters не обязаны предоставлять completion API.
        phase = 'terminal';
        const remaining = config.durationMs + delaySpan + 100 - (performance.now() - epoch);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      for (const elements of groups) {
        const positions = []; terminal.push(positions);
        for (const element of elements) positions.push(new DOMMatrixReadOnly(getComputedStyle(element).transform).e);
      }
      if (completion) completion.terminalReadEndedMs = performance.now() - epoch;
    } catch (error) { failed(error, phase); } finally {
      clearTimeout(watchdog);
      for (const control of controls) { try { control.cancel(); } catch (error) { failed(error, 'cancel-cleanup'); } }
      for (const elements of groups) for (const element of elements) { try { element.remove(); } catch (error) { failed(error, 'target-cleanup'); } }
    }
    return {
      topology: {
        calls: expectedCalls,
        targetsPerCall: config.targetsPerCall,
        staggerGapMs: config.staggerGapMs,
        durationMs: config.durationMs,
        toPx: config.toPx,
      },
      callStartedAtMs,
      checkpoints,
      terminal,
      ...(completion ? { completion } : {}),
      ...(onset ? { onset } : {}),
      ...(failures.length ? { failures, acquiredOwners: controls.length, createdTargets: groups.map((elements) => elements.length) } : {}),
    };
  }, { config: scenario, calls });
  return {
    ...evidence,
    valid: !evidence.failures?.length && evaluateStartSemanticEvidence(evidence, scenario, calls),
  };
}

// ─── сценарий S5: freeze-continuity (визуальный) ─────────────────────────────

function colorLeftEdge(pngBuf, channel) {
  // Полный скан: кадры скринкаста — целый вьюпорт (возможен и letterbox),
  // привязываться к конкретной строке нельзя. Ищем левейший пиксель канала.
  const img = requireBenchmark('pngjs').PNG.sync.read(pngBuf);
  let left = null;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (left !== null && x >= left) break;
      const i = (img.width * y + x) << 2;
      if (img.data[i + channel] > 180 && img.data[i + 1 - channel] < 120 && img.data[i + 2] < 120) {
        left = x;
        break;
      }
    }
  }
  return left;
}

function redLeftEdge(pngBuf) {
  return colorLeftEdge(pngBuf, 0);
}

async function waitForBaselineFrame(frames) {
  const deadline = Date.now() + 2_000;
  let inspected = 0;
  while (Date.now() < deadline) {
    while (inspected < frames.length) {
      const frame = frames[inspected++];
      if (
        Number.isFinite(frame.ts) &&
        redLeftEdge(Buffer.from(frame.data, 'base64')) !== null
      ) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error('first presented: screencast не отдал baseline-пиксель');
}

let cdpStartSequence = 0;

async function readCdpStartClock(page, cdp, startPage, config) {
  const token = `lab-motion-start-${++cdpStartSequence}`;
  let timeout;
  let removeListener = () => {};
  const eventPromise = new Promise((resolve, reject) => {
    const onConsole = (event) => {
      const cdpToken = event.args?.[0]?.value;
      if (cdpToken !== token) return;
      clearTimeout(timeout);
      cdp.off('Runtime.consoleAPICalled', onConsole);
      resolve({ cdpToken, cdpRuntimeTimestampMs: event.timestamp });
    };
    cdp.on('Runtime.consoleAPICalled', onConsole);
    removeListener = () => cdp.off('Runtime.consoleAPICalled', onConsole);
    timeout = setTimeout(() => {
      cdp.off('Runtime.consoleAPICalled', onConsole);
      reject(new Error('CDP start marker timeout'));
    }, 2_000);
  });
  try {
    const [pageClock, marker] = await Promise.all([
      page.evaluate(startPage, { clockToken: token, config }), eventPromise,
    ]);
    return {
      token,
      cdpClockDomain: 'TimeSinceEpoch',
      runtimeTimestampUnit: 'milliseconds',
      frameTimestampUnit: 'seconds',
      ...pageClock,
      ...marker,
    };
  } finally {
    clearTimeout(timeout);
    removeListener();
  }
}

async function startWithCdpClock(page, cdp, scenario) {
  return readCdpStartClock(page, cdp, ({ clockToken, config }) => {
    const element = document.getElementById('probe');
    const pageTimeOriginMs = performance.timeOrigin;
    const pageBeforeNowMs = performance.now();
    console.debug(clockToken);
    const pageApiNowMs = performance.now();
    window.__firstPresentedControl = window.__adapterModule.start(
      [element],
      config.toPx,
      config.durationMs,
    );
    return { pageTimeOriginMs, pageBeforeNowMs, pageApiNowMs };
  }, scenario);
}

/** Cold S1: CDP marker перед API → первый сдвинувшийся compositor-пиксель. */
async function runFirstPresented(browser, adapterPath, scenario, pageUrl) {
  const { context, page } = await newPage(browser, adapterPath, pageUrl);
  const timerBefore = await measurePageTimerProbe(page, 'before');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  await page.evaluate(() => {
    const element = document.createElement('div');
    element.id = 'probe';
    document.body.appendChild(element);
  });
  const rawFrames = [];
  cdp.on('Page.screencastFrame', (event) => {
    rawFrames.push({ ts: event.metadata.timestamp, data: event.data });
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'png', everyNthFrame: 1, maxWidth: 800, maxHeight: 200,
  });
  await waitForBaselineFrame(rawFrames);
  const startClock = await startWithCdpClock(page, cdp, scenario);
  const startedAtSeconds = startClock.cdpRuntimeTimestampMs / 1000;
  await new Promise((resolve) => setTimeout(resolve, 700));
  await cdp.send('Page.stopScreencast').catch(() => {});
  await page.evaluate(() => {
    try { window.__firstPresentedControl.cancel(); } catch { /* evidence уже снят */ }
    document.getElementById('probe')?.remove();
  });
  const timerAfter = await measurePageTimerProbe(page, 'after');
  const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  await context.close();
  const evidence = {
    startedAtSeconds,
    timerEvidence: {
      crossOriginIsolated,
      probes: [timerBefore, timerAfter],
    },
    startClock,
    movementThresholdPx: scenario.movementThresholdPx,
    rawFrames: rawFrames.length,
    frames: rawFrames
      .map((frame) => ({
        timestampSeconds: frame.ts,
        x: redLeftEdge(Buffer.from(frame.data, 'base64')),
      }))
      .filter((frame) => frame.x !== null)
      .sort((left, right) => left.timestampSeconds - right.timestampSeconds),
  };
  return {
    sample: deriveFirstPresentedElapsedMs(evidence, scenario.movementThresholdPx),
    evidence,
  };
}

const FREEZE_PX = S5_MOTION_CONTRACT.distancePx;
const FREEZE_DURATION_MS = S5_MOTION_CONTRACT.durationMs;
const BLOCK_AT_MS = 300;
const BLOCK_MS = 900;

// Самодостаточная функция: исполняется в page realm и проверяется без браузера.
export function installNativeCaptureDiagnostics(realm = globalThis) {
  const prototype = realm.Element.prototype;
  const original = prototype.animate;
  const records = [];
  const replay = realm.__s5ReplayObservation === true;
  let visibilityChanges = 0;
  const onVisibility = () => { visibilityChanges++; };
  if (replay) realm.document.addEventListener('visibilitychange', onVisibility);
  const now = () => realm.performance.now();
  const snapshot = (animation) => {
    const startTime = animation.startTime;
    const defaultTimeline = animation.timeline !== null && animation.timeline === realm.document.timeline;
    const complete = defaultTimeline && Number.isFinite(startTime);
    return {
      observedNowMs: now(), pending: animation.pending,
      startTime, currentTime: animation.currentTime,
      timeline: defaultTimeline ? 'default-document' : 'unsupported',
      status: complete ? 'complete' : 'incomplete',
      reason: complete ? null : defaultTimeline ? 'unresolved-start-time' : 'unsupported-timeline',
      startEpochMs: complete ? realm.performance.timeOrigin + startTime : null,
    };
  };
  prototype.animate = function (...args) {
    if (this.id !== 'probe' && this.id !== 'capture-witness') {
      return Reflect.apply(original, this, args);
    }
    const apiBeforeNowMs = now();
    const animation = Reflect.apply(original, this, args);
    const apiAfterNowMs = now();
    records.push({ element: this.id, animation, apiBeforeNowMs, apiAfterNowMs, ready: null });
    return animation;
  };
  let observed = false;
  realm.__s5NativeCapture = {
    observe() {
      if (observed) return;
      observed = true;
      for (const record of records) {
        record.afterStartup = snapshot(record.animation);
        record.animation.ready.then(() => {
          record.ready = { ...snapshot(record.animation), outcome: 'resolved' };
          if (replay) {
            // Observation costs CPU/host synchronization; not part of qualification.
            const beforeNowMs = now();
            try {
              record.effect = { beforeNowMs,
                keyframes: record.animation.effect.getKeyframes(),
                timing: record.animation.effect.getTiming(), afterNowMs: now(),
              };
            } catch (error) {
              record.effect = { beforeNowMs, afterNowMs: now(), error: String(error) };
            }
          }
        }, (error) => {
          record.ready = { ...snapshot(record.animation), outcome: 'rejected', error: String(error) };
        });
      }
    },
    readPose() {
      // Post-event read, NOT a pose at the bitmap's presentation timestamp.
      const beforeNowMs = now();
      const beforeVisibilityChanges = visibilityChanges;
      const visibilityBefore = realm.document.visibilityState;
      const timingBefore = { ...realm.__benchTiming };
      const before = records.map(({ element, animation }) => ({ element, ...snapshot(animation) }));
      const poses = records.map(({ element }) => ({ element,
        transform: realm.getComputedStyle(realm.document.getElementById(element)).transform,
      }));
      const after = records.map(({ element, animation }) => ({ element, ...snapshot(animation) }));
      return { timeOriginMs: realm.performance.timeOrigin, beforeNowMs, afterNowMs: now(),
        timelineCurrentTime: realm.document.timeline.currentTime,
        beforeVisibilityChanges, afterVisibilityChanges: visibilityChanges,
        visibilityBefore, visibilityAfter: realm.document.visibilityState,
        timingBefore, timingAfter: { ...realm.__benchTiming }, before, after, poses,
      };
    },
    finish() {
      prototype.animate = original;
      if (replay) realm.document.removeEventListener('visibilitychange', onVisibility);
      return {
        timeOriginMs: realm.performance.timeOrigin,
        status: records.some((record) => record.element === 'probe')
          && records.some((record) => record.element === 'capture-witness') ? 'recorded' : 'incomplete',
        records: records.map(({ animation, ...record }) => ({
          ...record, terminal: snapshot(animation),
        })),
      };
    },
  };
}

export function captureDiagnosticError(error) {
  return {
    name: error?.name ?? 'Error', message: String(error),
    ...(error instanceof AggregateError ? { errors: Array.from(error.errors, captureDiagnosticError) } : {}),
  };
}

export function assessReplayPose(frame, pose, startClock) {
  const reasons = [];
  const markerMs = startClock.cdpRuntimeTimestampMs;
  const fromMs = pose.timeOriginMs + pose.beforeNowMs;
  const toMs = pose.timeOriginMs + pose.afterNowMs;
  if (!Number.isFinite(frame.ts) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
    || fromMs > toMs || fromMs < frame.ts * 1000 || frame.ts * 1000 < markerMs) reasons.push('clock-boundary');
  if (pose.visibilityBefore !== 'visible' || pose.visibilityAfter !== 'visible'
    || pose.beforeVisibilityChanges !== 0 || pose.afterVisibilityChanges !== 0) reasons.push('visibility-boundary');
  if (pose.before.length !== 2 || pose.after.length !== 2 || pose.poses.length !== 2
    || !['probe', 'capture-witness'].every(element => pose.poses.some(p => p.element === element))) reasons.push('missing-paired-pose');
  for (const before of pose.before) {
    const after = pose.after.find(record => record.element === before.element);
    if (!after || before.pending || after.pending || !Number.isFinite(before.startEpochMs)
      || before.startEpochMs !== after.startEpochMs || before.startEpochMs > frame.ts * 1000
      || before.currentTime !== after.currentTime || !Number.isFinite(before.currentTime)) reasons.push('native-start-or-frame-boundary');
  }
  const a = pose.timingBefore, b = pose.timingAfter;
  if (a.startedAt !== b.startedAt || a.blockStartedAt !== b.blockStartedAt
    || a.blockEndedAt !== b.blockEndedAt) reasons.push('block-or-start-boundary');
  if (b.blockStartedAt !== null && b.blockStartedAt * 1000 <= toMs
    && (b.blockEndedAt === null || b.blockEndedAt * 1000 >= frame.ts * 1000)) reasons.push('blocked-interval');
  return { status: reasons.length ? 'unknown' : 'bounded-post-event-read', reasons: [...new Set(reasons)],
    bitmapPoseEquality: 'unproven', presentationToReadMs: fromMs - frame.ts * 1000,
    readDurationMs: toMs - fromMs, qualification: false };
}

export async function captureTrajectory(browser, adapterPath, blocked, pageUrl, diagnostic = undefined) {
  const { context, page } = await newPage(browser, adapterPath, pageUrl);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  const timerBefore = await measurePageTimerProbe(page, 'before');
  const frames = [];
  const failures = [];
  let nativeDiagnostic;
  const replay = diagnostic?.replay === true;
  const replayTimers = [];
  const replayAcks = [];
  let firstFrameResolve, selectedFrameResolve, finishedResolve, replayFailureReject;
  const replayFailure = replay ? new Promise((_, reject) => { replayFailureReject = reject; }) : undefined;
  if (replay) replayFailure.catch(() => {});
  const failReplayEvent = (phase, error) => {
    failures.push({ phase, error });
    replayFailureReject(error);
  };
  const signal = (assign, label, timeoutMs) => {
    const promise = new Promise((resolve, reject) => {
      assign(resolve);
      const timer = setTimeout(() => reject(new Error(`S5 replay ${label} timeout`)), timeoutMs);
      replayTimers.push(timer);
    });
    // Every rejection is handled before triggering page/CDP actions.
    promise.catch(() => {});
    return promise;
  };
  const firstFrame = replay ? signal(resolve => { firstFrameResolve = resolve; }, 'baseline-frame', 2000) : undefined;
  const selectedFrame = replay ? signal(resolve => { selectedFrameResolve = resolve; }, 'selected-frame', 6000) : undefined;
  const replayFinished = replay ? signal(resolve => { finishedResolve = resolve; }, 'witness-finished', 6000) : undefined;
  let replayMarkerMs, replayFrame, replayPose, replayAssessment, replayFrameCount = 0;
  let replayFinishedRejected = false;
  const replayConsole = event => {
    if (event.args?.[0]?.value === 'lab-motion-s5-replay-finished') finishedResolve();
    if (event.args?.[0]?.value === 'lab-motion-s5-replay-rejected') { replayFinishedRejected = true; finishedResolve(); }
    if (event.args?.[0]?.value?.startsWith('lab-motion-start-')) replayMarkerMs = event.timestamp;
  };
  let screencastActive = false;
  const stopScreencast = async () => {
    if (!screencastActive) return;
    screencastActive = false;
    if (diagnostic === undefined) await cdp.send('Page.stopScreencast').catch(() => {});
    else await cdp.send('Page.stopScreencast');
  };
  try {
    if (replay) {
      cdp.on('Runtime.consoleAPICalled', replayConsole);
      await page.evaluate(() => { window.__s5ReplayObservation = true; });
    }
    if (diagnostic !== undefined) await page.evaluate(installNativeCaptureDiagnostics);
    await page.evaluate(({ adapter, blocked }) => {
      const p = document.createElement('div');
      p.id = 'probe';
      document.body.appendChild(p);
      const witness = document.createElement('div');
      witness.id = 'capture-witness';
      document.body.appendChild(witness);
      const expected = adapter.includes('lab-spring') ? 'пружина' : 'линейное движение';
      const legend = document.createElement('div');
      legend.style.cssText = 'position:absolute;left:8px;top:112px;color:#444;font:13px sans-serif;white-space:pre-line';
      legend.textContent = `Красный: проверяемый путь, ожидается ${expected}.\nЗелёный: линейный свидетель записи, не эталон красного.`;
      document.body.appendChild(legend);
      document.title = `S5 ${adapter} (${expected}): ${blocked ? 'блокировка 900 мс' : 'без блокировки'}`;
    }, { adapter: path.basename(adapterPath), blocked });

    // Кадры забираем скринкастом: компоситор пушит их сам, main-thread страницы
    // не участвует. Одиночный Page.captureScreenshot при мёртвом main стопорится
    // и возвращает кадр уже ПОСЛЕ разблокировки — это давало бы wall-clock-прыжку
    // RAF-библиотек фальшивые 100% (проверено первым прогоном этого файла).
    cdp.on('Page.screencastFrame', (ev) => {
      frames.push({ ts: ev.metadata.timestamp, data: ev.data,
        ...(diagnostic === undefined ? {} : {
          metadata: ev.metadata, sessionId: ev.sessionId, receivedHrtimeNs: process.hrtime.bigint().toString(),
        }),
      });
      if (replay) {
        const frame = { ...frames[frames.length - 1], frameIndex: replayFrameCount++ };
        try {
          if (Number.isFinite(frame.ts) && redLeftEdge(Buffer.from(frame.data, 'base64')) !== null) firstFrameResolve(frame);
          // First exact event at/after 120ms; not a retry to reproduce historical round 3.
          if (!replayFrame && Number.isFinite(replayMarkerMs) && frame.ts * 1000 >= replayMarkerMs + 120) {
            replayFrame = frame;
            selectedFrameResolve(frame);
          }
        } catch (error) {
          // Bytes are already retained; deliver failure to the awaited capture boundary.
          failReplayEvent('frame-decode', error);
        } finally {
          try {
            replayAcks.push(cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId })
              .catch(error => failReplayEvent('frame-ack', error)));
          } catch (error) { failReplayEvent('frame-ack', error); }
        }
      } else cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'png', everyNthFrame: 1, maxWidth: 800, maxHeight: 200,
    });
    screencastActive = true;
    // CDP может не прислать новый кадр во время блокировки без visual damage.
    // Предстартовый пиксель даёт честную точку удержания, не синтезируя движение.
    if (replay) await Promise.race([firstFrame, replayFailure]);
    else await waitForBaselineFrame(frames);

    // Runtime marker и кадры имеют один CDP clock domain; page realm ограничивает
    // задержку marker→API. RTT Node↔page не входит в начало траектории.
    const startClock = await readCdpStartClock(page, cdp, ({ clockToken, config }) => {
      const { px, duration, shouldBlock, blockAt, blockMs, diagnosticEnabled, replayEnabled } = config;
      const el = document.getElementById('probe');
      const epoch = () => (performance.timeOrigin + performance.now()) / 1000;
      const pageTimeOriginMs = performance.timeOrigin;
      const pageBeforeNowMs = performance.now();
      console.debug(clockToken);
      const start = epoch();
      window.__benchTiming = { startedAt: start, blockStartedAt: null, blockEndedAt: null };
      // Свидетель создаёт visual damage даже при неподвижной/завершённой цели.
      // Его пиксели в том же кадре проверяют, что запись не подменяет фриз пропуском.
      // Нулевая точка — API, не поздний Animation.startTime: startup расходует бюджет S5.
      window.__witness = document.getElementById('capture-witness').animate(
        [{ transform: 'translateX(0px)' }, { transform: `translateX(${px}px)` }],
        { duration, easing: 'linear', fill: 'forwards' },
      );
      const pageApiNowMs = performance.now();
      window.__c = window.__adapterModule.start([el], px, duration);
      if (shouldBlock) setTimeout(() => {
        window.__benchTiming.blockStartedAt = epoch();
        const end = performance.now() + blockMs;
        while (performance.now() < end) { /* реальная блокировка main-thread */ }
        window.__benchTiming.blockEndedAt = epoch();
      }, blockAt);
      // Только после обоих синхронных start и исходного планирования блока.
      if (diagnosticEnabled) window.__s5NativeCapture.observe();
      if (replayEnabled) window.__witness.finished.then(
        () => console.debug('lab-motion-s5-replay-finished'),
        () => console.debug('lab-motion-s5-replay-rejected'),
      );
      return { pageTimeOriginMs, pageBeforeNowMs, pageApiNowMs };
    }, {
      diagnosticEnabled: diagnostic !== undefined,
      replayEnabled: replay,
      px: FREEZE_PX,
      duration: FREEZE_DURATION_MS,
      shouldBlock: blocked,
      blockAt: BLOCK_AT_MS,
      blockMs: BLOCK_MS,
    });
    const startedAt = startClock.cdpRuntimeTimestampMs / 1000;

    // Ждём: анимация + блок + запас на lagSmoothing-подобное продление (GSAP
    // после лага доигрывает сдвинутый таймлайн; endpoint не заменяет S5-контракт).
    if (replay) {
      replayFrame = await Promise.race([selectedFrame, replayFailure]);
      // This main-thread read may synchronize style and describes a LATER pose.
      replayPose = await Promise.race([
        page.evaluate(() => window.__s5NativeCapture.readPose()),
        signal(() => {}, 'pose-read', 2000), replayFailure,
      ]);
      replayAssessment = assessReplayPose(replayFrame, replayPose, startClock);
      replayPose.lastReceivedFrameIndex = replayFrameCount - 1;
      if (replayPose.lastReceivedFrameIndex !== replayFrame.frameIndex) {
        replayAssessment = { ...replayAssessment, status: 'unknown',
          reasons: [...replayAssessment.reasons, 'screencast-frame-boundary'] };
      }
      await Promise.race([replayFinished, replayFailure]);
      if (replayFinishedRejected) throw new Error('S5 replay witness finished rejected');
    } else await new Promise((r) => setTimeout(
      r,
      FREEZE_DURATION_MS + (blocked ? BLOCK_MS : 0) + 700,
    ));
    await stopScreencast();
    const terminal = await page.evaluate(() => {
      const el = document.getElementById('probe');
      return {
        finalX: new DOMMatrixReadOnly(getComputedStyle(el).transform).e,
        timing: window.__benchTiming,
      };
    });
    if (diagnostic !== undefined) {
      nativeDiagnostic = await page.evaluate(() => window.__s5NativeCapture.finish());
    }
    const clock = {
      startClock,
      timerEvidence: {
        crossOriginIsolated: await page.evaluate(() => globalThis.crossOriginIsolated),
        probes: [timerBefore, await measurePageTimerProbe(page, 'after')],
      },
    };

    if (replay && nativeDiagnostic.records.some(record => record.ready?.status !== 'complete'
      || !record.effect?.keyframes || !record.effect?.timing || record.effect.error)) {
      replayAssessment = { ...replayAssessment, status: 'unknown',
        reasons: [...replayAssessment.reasons, 'ready-effect-incomplete'] };
    }
    const decoded = frames
      .map((f) => ({ t: f.ts - startedAt, x: redLeftEdge(Buffer.from(f.data, 'base64')) }))
      .filter((f) => Number.isFinite(f.t) && f.x !== null)
      .sort((a, b) => a.t - b.t);
    const witness = frames
      .map((f) => ({ t: f.ts - startedAt, x: colorLeftEdge(Buffer.from(f.data, 'base64'), 1) }))
      // Пропавший пиксель — исход захваченного кадра, не повод удалить кадр.
      .sort((a, b) => a.t - b.t);
    return {
      decoded,
      witness,
      measurement: { target: 'png-threshold-v1', witness: 'png-threshold-v1' },
      clock,
      finalX: terminal.finalX,
      timing: terminal.timing,
      rawFrames: frames.length,
      ...(diagnostic === undefined ? {} : { nativeDiagnostic }),
      ...(replay ? { replay: { selectedFrame: { ...replayFrame, data: undefined }, pose: replayPose,
        assessment: replayAssessment, qualification: false, observerEffect: 'style-and-host-reads-perturb' } } : {}),
    };
  } catch (error) {
    if (diagnostic === undefined) throw error;
    if (!replay || !failures.some(failure => failure.error === error)) failures.push({ phase: 'capture', error });
  } finally {
    for (const timer of replayTimers) clearTimeout(timer);
    if (replay) cdp.off('Runtime.consoleAPICalled', replayConsole);
    if (diagnostic === undefined) {
      try { await stopScreencast(); } finally { await context.close(); }
    } else {
      try { await stopScreencast(); } catch (error) { failures.push({ phase: 'stop', error }); }
      if (nativeDiagnostic === undefined) {
        try {
          nativeDiagnostic = await page.evaluate(() => window.__s5NativeCapture?.finish() ?? {
            status: 'incomplete', reason: 'instrumentation-not-installed', records: [],
          });
        } catch (error) {
          failures.push({ phase: 'snapshot', error });
          nativeDiagnostic = { status: 'incomplete', reason: 'snapshot-failed', error: captureDiagnosticError(error), records: [] };
        }
      }
      if (replay) {
        try { await context.close(); } catch (error) { failures.push({ phase: 'cleanup', error }); }
        await Promise.all(replayAcks);
        if (failures.length > 0) {
          replayAssessment = { ...replayAssessment,
            ...(replayAssessment ? { partialReadAssessment: { ...replayAssessment } } : {}),
            status: 'unknown',
            reasons: [...new Set([...(replayAssessment?.reasons ?? []),
              ...failures.map(({ phase }) => `failure:${phase}`)])],
            bitmapPoseEquality: 'unproven', qualification: false };
        }
      }
      try {
        await diagnostic.retain({ frames, nativeDiagnostic,
          ...(replay ? { replay: { selectedFrame: replayFrame && { ...replayFrame, data: undefined },
            pose: replayPose, assessment: replayAssessment ?? { status: 'unknown', reasons: ['incomplete-observation'], bitmapPoseEquality: 'unproven', qualification: false },
            qualification: false, observerEffect: 'style-and-host-reads-perturb' } } : {}),
          errors: failures.map(({ phase, error }) => ({ phase, error: captureDiagnosticError(error) })),
        });
      } catch (error) { failures.push({ phase: 'retain', error }); }
      if (!replay) {
        try { await context.close(); } catch (error) { failures.push({ phase: 'cleanup', error }); }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures.map(({ error }) => error), 'S5 capture or diagnostic teardown failed');
      }
    }
  }
}

async function runFreezePair(browser, adapterPath, blockedFirst, pageUrl) {
  const first = await captureTrajectory(browser, adapterPath, blockedFirst, pageUrl);
  const second = await captureTrajectory(browser, adapterPath, !blockedFirst, pageUrl);
  const baseline = blockedFirst ? second : first;
  const blocked = blockedFirst ? first : second;
  const blockStart = blocked.timing?.blockStartedAt - blocked.timing?.startedAt;
  const blockEnd = blocked.timing?.blockEndedAt - blocked.timing?.startedAt;
  const windowStart = blockStart + 0.08;
  const windowEnd = blockEnd - 0.08;
  const grid = [];
  if (Number.isFinite(windowStart) && Number.isFinite(windowEnd)) {
    for (let t = windowStart; t <= windowEnd; t += 0.1) grid.push(t);
  }
  const evidence = createFreezeEvidence(blocked.decoded, baseline.decoded, grid, {
    baseline: baseline.measurement,
    blocked: blocked.measurement,
  });
  evidence.baselineWitness = baseline.witness;
  evidence.blockedWitness = blocked.witness;
  evidence.baselineClock = baseline.clock;
  evidence.blockedClock = blocked.clock;
  const scored = scoreAgainstBaseline(evidence.blocked, evidence.baseline, evidence.grid);
  const blockedWindow = blocked.decoded.filter((f) => f.t >= windowStart && f.t <= windowEnd);
  const baselineWindow = baseline.decoded.filter((f) => f.t >= windowStart && f.t <= windowEnd);
  const movement = movementStats(blockedWindow);
  const baselineMovement = movementStats(baselineWindow);
  const finalTolerance = 2;
  const finalsValid =
    Math.abs(baseline.finalX - FREEZE_PX) <= finalTolerance &&
    Math.abs(blocked.finalX - FREEZE_PX) <= finalTolerance;
  const valid =
    finalsValid &&
    Number.isFinite(scored.score) &&
    scored.samples >= 5 &&
    baselineMovement.distinctPositions >= 5 &&
    baselineMovement.totalAdvancement >= 10;
  return {
    valid,
    score: scored.score,
    samples: scored.samples,
    movement,
    baselineMovement,
    finalX: blocked.finalX,
    baselineFinalX: baseline.finalX,
    blockStart,
    blockEnd,
    rawFrames: { baseline: baseline.rawFrames, blocked: blocked.rawFrames },
    evidence,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const generatedAt = new Date().toISOString();
  console.log('=== Подготовка воспроизводимого артефакта: pnpm build ===');
  const provenance = prepareBenchmarkCheckout({
    root: ROOT,
    benchDirectory: __dirname,
    requiredDist: [
      'dist/motion/index.js',
    ],
    requiredPackages: BENCH_PACKAGES,
    requiredRootPackages: [CANONICAL_GZIP_PACKAGE],
    requiredInputs: [
      ['root/scripts/compression-policy.mjs', path.join(ROOT, 'scripts', 'compression-policy.mjs')],
      ['root/scripts/compression-oracle.mjs', path.join(ROOT, 'scripts', 'compression-oracle.mjs')],
      ['bench/bench.mjs', path.join(__dirname, 'bench.mjs')],
      ['bench/methodology.mjs', path.join(__dirname, 'methodology.mjs')],
      ['bench/provenance.mjs', path.join(__dirname, 'provenance.mjs')],
      ['bench/report-contract.mjs', path.join(__dirname, 'report-contract.mjs')],
      ['bench/motion-conformance.mjs', path.join(__dirname, 'motion-conformance.mjs')],
    ],
    requiredEntries: ENTRY_INPUTS,
  });
  mkdirSync(path.join(__dirname, 'results'), { recursive: true });

  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { chromium } = requireBenchmark('playwright');
  const chromiumInstall = await resolveChromiumInstall();
  const chromiumTreeBefore = hashFileTree(chromiumInstall.directory);
  const benchmarkOrigin = await startBenchmarkOrigin();

  // Headed обязателен: headless-Chromium производит кадры только по main-thread
  // коммитам (BeginFrame по требованию) — во время фриза кадров нет ни у кого,
  // и S5 выродился бы в hold-артефакт ~45% у всех (проверено v3-прогоном).
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    });
  } catch (e) {
    fail(`Chromium не запустился (${e.message.split('\n')[0]}). Установите: npx playwright install chromium`);
  }
  const browserVersion = browser.version();
  const browserExecutableSha256 = sha256File(chromium.executablePath());
  const timerCalibration = await measureTimerCalibration(browser, benchmarkOrigin.url);

  const system = {
    cpu: os.cpus()[0]?.model?.trim() ?? 'н/д',
    logicalCpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    osType: os.type(),
    osRelease: os.release(),
  };

  const results = {};
  const adapters = {};
  const scenarioIds = Object.keys(START_SCENARIO_MANIFEST);
  const coldScenarioIds = scenarioIds.filter((id) => (
    START_SCENARIO_MANIFEST[id].coldMetric === 'apiReturn'
  ));
  for (const lib of LIBS) {
    console.log(`\n— ${lib.id}: production-сборка адаптера…`);
    adapters[lib.id] = buildAdapter(lib);
    results[lib.id] = {
      version: libVersion(lib, rootPkg),
      group: lib.group,
      size: measureSize(lib),
      adapterSha256: adapters[lib.id].sha256,
      raw: {
        warm: Object.fromEntries(scenarioIds.map((id) => [id, []])),
        cold: {
          ...Object.fromEntries(coldScenarioIds.map((id) => [id, []])),
          firstPresented: [],
        },
        freeze: [],
      },
    };
    const { context, page } = await newPage(browser, adapters[lib.id].path, benchmarkOrigin.url);
    await smokeCheck(page, lib.id);
    await context.close();
  }

  const startLibs = LIBS.filter((lib) => lib.startCosts);
  const startIds = startLibs.map((lib) => lib.id);
  const warmCalibration = await measureWarmStartCalibration(
    browser,
    adapters,
    startLibs,
    benchmarkOrigin.url,
  );
  const calibration = {
    raw: {
      referenceTimerEvidence: timerCalibration.timerEvidence,
      warmStartPilots: warmCalibration.pilots,
    },
    referenceTimerStepMs: timerCalibration.timerStepMs,
    referenceClockUncertaintyMs: timerCalibration.clockUncertaintyMs,
    isolation: timerCalibration.isolation,
    policy: WARM_TIMER_CALIBRATION_POLICY,
    effectiveWarmCalls: warmCalibration.effectiveWarmCalls,
  };
  const scenarioManifest = warmCalibration.scenarioManifest;
  const startOrders = makeRoundRobinOrders(startIds, RUNS, ORDER_SEED);
  assertBalancedRunBlocks('BENCH_RUNS', startOrders, startIds);
  const assertSemantic = (label, evidence, { id, scenario, run, metric }) => (
    assertStartSemanticEvidenceWithDiagnostic(label, evidence, {
      generatedAt,
      participant: { id, version: results[id].version, adapterSha256: adapters[id].sha256 },
      run: run + 1,
      metric,
      scenario,
      scenarioConfig: scenarioManifest[scenario],
      startOrder: startOrders[run],
      provenance,
      browser: {
        name: 'chromium',
        version: browserVersion,
        revision: chromiumInstall.revision,
        executableSha256: browserExecutableSha256,
      },
    })
  );
  for (let run = 0; run < RUNS; run++) {
    for (const id of startOrders[run]) {
      const adapterPath = adapters[id].path;
      console.log(`  start run ${run + 1}/${RUNS}: ${id}`);
      for (const scenario of scenarioIds) {
        const config = scenarioManifest[scenario];
        const { context, page } = await newPage(browser, adapterPath, benchmarkOrigin.url);
        const measurement = await runWarmStartCosts(page, config);
        assertWarmStartMeasurement(
          `${id}.${scenario} run ${run + 1}`,
          measurement.samples,
          measurement.batchElapsedMs,
          config.warmCalls,
          measurement.timerEvidence,
          measurement.measurementTimeOriginMs,
        );
        const semanticEvidence = await runSemanticStartCheck(page, config, config.warmCalls);
        assertSemantic(`${id}.${scenario} run ${run + 1}`, semanticEvidence, {
          id, scenario, run, metric: `warm.${scenario}`,
        });
        const semantic = semanticEvidence.valid;
        results[id].raw.warm[scenario].push({
          run,
          samples: measurement.samples,
          batchElapsedMs: measurement.batchElapsedMs,
          timerEvidence: measurement.timerEvidence,
          measurementTimeOriginMs: measurement.measurementTimeOriginMs,
          semantic,
          semanticEvidence,
        });
        await context.close();
      }
      for (const scenario of coldScenarioIds) {
        const config = scenarioManifest[scenario];
        const { context, page } = await newPage(browser, adapterPath, benchmarkOrigin.url);
        const measurement = await runColdStartCost(page, config);
        assertPositiveFiniteSamples(`${id}.cold.${scenario} run ${run + 1}`, [measurement.sample]);
        const semanticEvidence = await runSemanticStartCheck(page, config, 1);
        assertSemantic(`${id}.cold.${scenario} run ${run + 1}`, semanticEvidence, {
          id, scenario, run, metric: `cold.${scenario}`,
        });
        const semantic = semanticEvidence.valid;
        results[id].raw.cold[scenario].push({
          run,
          samples: [measurement.sample],
          timerEvidence: measurement.timerEvidence,
          measurementTimeOriginMs: measurement.measurementTimeOriginMs,
          semantic,
          semanticEvidence,
        });
        await context.close();
      }
      {
        const presented = await runFirstPresented(
          browser,
          adapterPath,
          scenarioManifest.s1,
          benchmarkOrigin.url,
        );
        assertPositiveFiniteSamples(`${id}.cold.firstPresented run ${run + 1}`, [presented.sample]);
        const { context, page } = await newPage(browser, adapterPath, benchmarkOrigin.url);
        const semanticEvidence = await runSemanticStartCheck(page, scenarioManifest.s1, 1);
        assertSemantic(`cold.firstPresented ${id} run ${run + 1}`, semanticEvidence, {
          id, scenario: 's1', run, metric: 'cold.firstPresented',
        });
        const semantic = semanticEvidence.valid;
        results[id].raw.cold.firstPresented.push({
          run,
          samples: [presented.sample],
          semantic,
          semanticEvidence,
          presentedEvidence: presented.evidence,
        });
        await context.close();
      }
    }
  }

  const freezeOrders = makeRoundRobinOrders(LIBS.map((lib) => lib.id), FREEZE_RUNS, ORDER_SEED ^ 0xa5a5a5);
  assertBalancedRunBlocks('BENCH_FREEZE_RUNS', freezeOrders, LIBS.map((lib) => lib.id));
  for (let run = 0; run < FREEZE_RUNS; run++) {
    for (const id of freezeOrders[run]) {
      console.log(`  freeze run ${run + 1}/${FREEZE_RUNS}: ${id}`);
      results[id].raw.freeze.push(await runFreezePair(
        browser,
        adapters[id].path,
        (run & 1) === 1,
        benchmarkOrigin.url,
      ));
    }
  }
  assertFreezeMatrix(
    Object.fromEntries(LIBS.map((lib) => [lib.id, results[lib.id].raw.freeze])),
    'waapi-ctl',
  );

  for (const lib of LIBS) {
    const result = results[lib.id];
    const flatten = (clusters) => clusters.flatMap((cluster) => cluster.samples);
    result.warm = Object.fromEntries(
      Object.entries(result.raw.warm).map(([name, clusters]) => [name, summarizeReportSamples(flatten(clusters))]),
    );
    result.cold = Object.fromEntries(
      Object.entries(result.raw.cold).map(([name, clusters]) => [name, summarizeReportSamples(flatten(clusters), { strict: true })]),
    );
    result.freeze = {
      score: summarizeMedianSamples(result.raw.freeze.map((run) => run.score)),
      frames: summarizeMedianSamples(result.raw.freeze.map((run) => run.movement.frames)),
      distinct: summarizeMedianSamples(result.raw.freeze.map((run) => run.movement.distinctPositions)),
      net: summarizeMedianSamples(result.raw.freeze.map((run) => run.movement.netAdvancement)),
      total: summarizeMedianSamples(result.raw.freeze.map((run) => run.movement.totalAdvancement)),
      finalX: summarizeMedianSamples(result.raw.freeze.map((run) => run.finalX)),
    };
  }
  await browser.close();
  await benchmarkOrigin.close();
  // Любая правка checkout во время долгого browser-прогона делает числа
  // непривязанными к зафиксированным входам — такой отчёт не публикуем.
  assertCheckoutUnchanged(ROOT, provenance);
  assertFileHashesUnchanged({
    chromium: { path: chromium.executablePath(), sha256: browserExecutableSha256 },
    ...adapters,
  });
  assertInstalledPackageTreesUnchanged(__dirname, provenance.environment.packages);
  assertInstalledPackageTreesUnchanged(ROOT, provenance.environment.rootPackages);
  const chromiumTreeAfter = hashFileTree(chromiumInstall.directory);
  if (
    chromiumTreeAfter.files !== chromiumTreeBefore.files ||
    chromiumTreeAfter.sha256 !== chromiumTreeBefore.sha256
  ) fail('Chromium runtime tree изменился во время benchmark-прогона');

  // ─── отчёт ─────────────────────────────────────────────────────────────────
  const ids = LIBS.map((l) => l.id);
  const stem = `${generatedAt.slice(0, 10)}-${provenance.revisionLabel}-${provenance.distRuntime.sha256.slice(0, 12)}`;
  const rawPayload = {
    schema: 10,
    motionContract: S5_MOTION_CONTRACT,
    package: { name: rootPkg.name, version: rootPkg.version },
    generatedAt,
    companion: { markdownFile: `${stem}.md`, markdownSha256: '' },
    environment: [],
    system,
    provenance,
    browser: {
      name: 'chromium',
      version: browserVersion,
      revision: chromiumInstall.revision,
      files: chromiumTreeBefore.files,
      treeSha256: chromiumTreeBefore.sha256,
      executableSha256: browserExecutableSha256,
    },
    calibration,
    scenarioManifest,
    orderSeed: ORDER_SEED,
    participants: { start: startIds, freeze: ids },
    startOrders,
    freezeOrders,
    results: Object.fromEntries(ids.map((id) => [id, {
      version: results[id].version,
      group: results[id].group,
      size: results[id].size,
      adapterSha256: results[id].adapterSha256,
      summary: {
        warm: results[id].warm,
        cold: results[id].cold,
        freeze: results[id].freeze,
      },
      raw: results[id].raw,
    }])),
  };
  rawPayload.claims = createBenchmarkClaims(rawPayload.results, {
    seed: ORDER_SEED,
    iterations: BOOTSTRAP_ITERATIONS,
    scenarioManifest,
  });
  rawPayload.environment = renderBenchmarkEnvironment(rawPayload);
  rawPayload.motionConformance = createBenchmarkMotionConformance(rawPayload.results);
  console.log('=== Честный сравнительный бенчмарк ===');
  rawPayload.environment.forEach((line) => console.log(line));
  const md = renderBenchmarkMarkdown(rawPayload);

  rawPayload.companion.markdownSha256 = sha256Bytes(Buffer.from(md));
  const rawJson = JSON.stringify(rawPayload) + '\n';
  validateBenchmarkReportPair({
    stem,
    markdown: md,
    payload: rawPayload,
    rootPackage: rootPkg,
    benchmarkPackage: JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')),
    now: Date.parse(generatedAt),
  });

  const outPath = path.join(__dirname, 'results', `${stem}.md`);
  const rawPath = path.join(__dirname, 'results', `${stem}.json`);
  const staging = mkdtempSync(path.join(__dirname, 'results', '.report-pair-'));
  const stagedMarkdown = path.join(staging, `${stem}.md`);
  const stagedJson = path.join(staging, `${stem}.json`);
  const linked = [];
  try {
    writeFileSync(stagedMarkdown, md, { flag: 'wx' });
    writeFileSync(stagedJson, rawJson, { flag: 'wx' });
    // link(2) не перезаписывает цель: same-day rerun не может заменить историю.
    linkSync(stagedJson, rawPath);
    linked.push(rawPath);
    linkSync(stagedMarkdown, outPath);
    linked.push(outPath);
  } catch (error) {
    for (const file of linked) {
      try { unlinkSync(file); } catch { /* первична исходная ошибка */ }
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`\n${md}`);
  console.log(`Отчёт: ${outPath}`);
  console.log(`Raw: ${rawPath}`);
  // Плохое измерение сохранено как evidence; успешный exit требует отдельного контракта.
  validateBenchmarkReportPair({
    stem, markdown: md, payload: rawPayload, rootPackage: rootPkg,
    benchmarkPackage: JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')),
    now: Date.parse(generatedAt), motionRequirements: S5_MOTION_REQUIREMENTS,
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main().catch((e) => fail(e.stack ?? String(e)));
