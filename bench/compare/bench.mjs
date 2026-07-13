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
 * Переменные: BENCH_RUNS (дефолт 20), BENCH_FREEZE_RUNS (дефолт 9, полный
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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import esbuild from 'esbuild';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import {
  assertFileHashesUnchanged,
  assertCheckoutUnchanged,
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
  validateBenchmarkReportPair,
} from './report-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RUNS = parseBenchCount('BENCH_RUNS', process.env.BENCH_RUNS, 20, { min: 20, max: 60 });
const FREEZE_RUNS = parseBenchCount(
  'BENCH_FREEZE_RUNS',
  process.env.BENCH_FREEZE_RUNS,
  9,
  { min: 3, max: 45 },
);
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
  { id: 'lab-native', entry: 'entries/lab-native.entry.mjs', pkg: null, group: 'transform-spring-start-adapter' },
  // Лучшие официальные native-пути: без них freeze-победа была бы ложной.
  { id: 'motion-mini', entry: 'entries/motion-mini.entry.mjs', pkg: 'motion', group: 'transform-linear-native-start-adapter' },
  { id: 'anime-waapi', entry: 'entries/anime-waapi.entry.mjs', pkg: 'animejs', group: 'transform-linear-native-start-adapter' },
];
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
  esbuild.buildSync({
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
  const res = esbuild.buildSync({
    ...PRODUCTION_ADAPTER_PROFILE,
    entryPoints: [path.join(__dirname, lib.entry)],
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const raw = res.outputFiles[0].contents;
  return {
    raw: raw.byteLength,
    gz: gzipSync(raw, { level: 9 }).byteLength,
    br: brotliCompressSync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
    sha256: sha256Bytes(raw),
  };
}

// ─── страница ────────────────────────────────────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; }
  .box { position: absolute; left: 0; top: 0; width: 10px; height: 10px; background: #0000ff; }
  #probe { position: absolute; left: 0; top: 20px; width: 30px; height: 30px; background: #ff0000; }
</style></head><body></body></html>`;

async function startBenchmarkOrigin() {
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
async function runSemanticStartCheck(page, scenario, calls) {
  const evidence = await page.evaluate(async ({ config, calls: expectedCalls }) => {
    const A = window.__adapterModule;
    const groups = Array.from({ length: expectedCalls }, () => (
      Array.from({ length: config.targetsPerCall }, () => {
        const element = document.createElement('div');
        element.className = 'box';
        document.body.appendChild(element);
        return element;
      })
    ));
    const epoch = performance.now();
    const callStartedAtMs = [];
    const controls = groups.map((elements) => {
      callStartedAtMs.push(performance.now() - epoch);
      return config.staggerGapMs > 0
        ? A.startStagger(elements, config.toPx, config.durationMs, config.staggerGapMs)
        : A.start(elements, config.toPx, config.durationMs);
    });
    const delaySpan = config.staggerGapMs * (config.targetsPerCall - 1);
    const checkpointTimes = config.staggerGapMs > 0
      ? [0.2, 0.5, 0.8].map((fraction) => delaySpan * fraction)
      : [config.durationMs * 0.25];
    const checkpoints = [];
    for (const checkpointTime of checkpointTimes) {
      const remaining = checkpointTime - (performance.now() - epoch);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      checkpoints.push({
        groups: groups.map((elements) => {
          const readStartedMs = performance.now() - epoch;
          const positions = elements.map((element) => (
            new DOMMatrixReadOnly(getComputedStyle(element).transform).e
          ));
          return { readStartedMs, readEndedMs: performance.now() - epoch, positions };
        }),
      });
    }
    const terminalAt = config.durationMs + delaySpan + 100;
    const remaining = terminalAt - (performance.now() - epoch);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const terminal = groups.map((elements) => elements.map((element) => (
      new DOMMatrixReadOnly(getComputedStyle(element).transform).e
    )));
    for (const control of controls) { try { control.cancel(); } catch { /* семантика уже снята */ } }
    for (const elements of groups) for (const element of elements) element.remove();
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
    };
  }, { config: scenario, calls });
  return {
    ...evidence,
    valid: evaluateStartSemanticEvidence(evidence, scenario, calls),
  };
}

// ─── сценарий S5: freeze-continuity (визуальный) ─────────────────────────────

function redLeftEdge(pngBuf) {
  // Полный скан: кадры скринкаста — целый вьюпорт (возможен и letterbox),
  // привязываться к конкретной строке нельзя. Ищем левейший красный пиксель.
  const img = PNG.sync.read(pngBuf);
  let left = null;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (left !== null && x >= left) break;
      const i = (img.width * y + x) << 2;
      if (img.data[i] > 180 && img.data[i + 1] < 120 && img.data[i + 2] < 120) {
        left = x;
        break;
      }
    }
  }
  return left;
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

async function startWithCdpClock(page, cdp, scenario) {
  const token = `lab-motion-start-${++cdpStartSequence}`;
  let timeout;
  const eventPromise = new Promise((resolve, reject) => {
    const onConsole = (event) => {
      const cdpToken = event.args?.[0]?.value;
      if (cdpToken !== token) return;
      clearTimeout(timeout);
      cdp.off('Runtime.consoleAPICalled', onConsole);
      resolve({ cdpToken, cdpRuntimeTimestampMs: event.timestamp });
    };
    cdp.on('Runtime.consoleAPICalled', onConsole);
    timeout = setTimeout(() => {
      cdp.off('Runtime.consoleAPICalled', onConsole);
      reject(new Error('first presented: CDP start marker timeout'));
    }, 2_000);
  });
  const pageClock = await page.evaluate(({ clockToken, config }) => {
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
  }, { clockToken: token, config: scenario });
  return {
    token,
    cdpClockDomain: 'TimeSinceEpoch',
    runtimeTimestampUnit: 'milliseconds',
    frameTimestampUnit: 'seconds',
    ...pageClock,
    ...await eventPromise,
  };
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

const FREEZE_PX = 600;
const FREEZE_DURATION_MS = 2400;
const BLOCK_AT_MS = 300;
const BLOCK_MS = 900;

async function captureTrajectory(browser, adapterPath, blocked, pageUrl) {
  const { context, page } = await newPage(browser, adapterPath, pageUrl);
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let screencastActive = false;
  const stopScreencast = async () => {
    if (!screencastActive) return;
    screencastActive = false;
    await cdp.send('Page.stopScreencast').catch(() => {});
  };
  try {
    await page.evaluate(() => {
      const p = document.createElement('div');
      p.id = 'probe';
      document.body.appendChild(p);
    });

    // Кадры забираем скринкастом: компоситор пушит их сам, main-thread страницы
    // не участвует. Одиночный Page.captureScreenshot при мёртвом main стопорится
    // и возвращает кадр уже ПОСЛЕ разблокировки — это давало бы wall-clock-прыжку
    // RAF-библиотек фальшивые 100% (проверено первым прогоном этого файла).
    cdp.on('Page.screencastFrame', (ev) => {
      frames.push({ ts: ev.metadata.timestamp, data: ev.data });
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'png', everyNthFrame: 1, maxWidth: 800, maxHeight: 200,
    });
    screencastActive = true;
    // CDP может не прислать новый кадр во время блокировки без visual damage.
    // Предстартовый пиксель даёт честную точку удержания, не синтезируя движение.
    await waitForBaselineFrame(frames);

    // Epoch фиксируется в page realm рядом с API-вызовом: RTT Node↔page не входит.
    const startedAt = await page.evaluate(({ px, duration, shouldBlock, blockAt, blockMs }) => {
      const el = document.getElementById('probe');
      const epoch = () => (performance.timeOrigin + performance.now()) / 1000;
      const start = epoch();
      window.__benchTiming = { startedAt: start, blockStartedAt: null, blockEndedAt: null };
      window.__c = window.__adapterModule.start([el], px, duration);
      if (shouldBlock) setTimeout(() => {
        window.__benchTiming.blockStartedAt = epoch();
        const end = performance.now() + blockMs;
        while (performance.now() < end) { /* реальная блокировка main-thread */ }
        window.__benchTiming.blockEndedAt = epoch();
      }, blockAt);
      return start;
    }, {
      px: FREEZE_PX,
      duration: FREEZE_DURATION_MS,
      shouldBlock: blocked,
      blockAt: BLOCK_AT_MS,
      blockMs: BLOCK_MS,
    });

    // Ждём: анимация + блок + запас на lagSmoothing-подобное продление (GSAP
    // после лага честно доигрывает сдвинутый таймлайн, а не прыгает — это
    // валидное поведение, ему нужно время).
    await new Promise((r) => setTimeout(
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

    const decoded = frames
      .map((f) => ({ t: f.ts - startedAt, x: redLeftEdge(Buffer.from(f.data, 'base64')) }))
      .filter((f) => Number.isFinite(f.t) && f.x !== null)
      .sort((a, b) => a.t - b.t);
    return {
      decoded,
      finalX: terminal.finalX,
      timing: terminal.timing,
      rawFrames: frames.length,
    };
  } finally {
    await stopScreencast();
    await context.close();
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
  const evidence = createFreezeEvidence(blocked.decoded, baseline.decoded, grid);
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
      'dist/animate/index.js',
      'dist/animate/native/index.js',
    ],
    requiredPackages: BENCH_PACKAGES,
    requiredInputs: [
      ['bench/bench.mjs', path.join(__dirname, 'bench.mjs')],
      ['bench/methodology.mjs', path.join(__dirname, 'methodology.mjs')],
      ['bench/provenance.mjs', path.join(__dirname, 'provenance.mjs')],
      ['bench/report-contract.mjs', path.join(__dirname, 'report-contract.mjs')],
    ],
  });
  mkdirSync(path.join(__dirname, 'results'), { recursive: true });

  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
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
        assertStartSemanticEvidence(`${id}.${scenario} run ${run + 1}`, semanticEvidence);
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
        assertStartSemanticEvidence(`${id}.cold.${scenario} run ${run + 1}`, semanticEvidence);
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
        assertStartSemanticEvidence(`cold.firstPresented ${id} run ${run + 1}`, semanticEvidence);
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
  const chromiumTreeAfter = hashFileTree(chromiumInstall.directory);
  if (
    chromiumTreeAfter.files !== chromiumTreeBefore.files ||
    chromiumTreeAfter.sha256 !== chromiumTreeBefore.sha256
  ) fail('Chromium runtime tree изменился во время benchmark-прогона');

  // ─── отчёт ─────────────────────────────────────────────────────────────────
  const ids = LIBS.map((l) => l.id);
  const stem = `${generatedAt.slice(0, 10)}-${provenance.revisionLabel}-${provenance.distRuntime.sha256.slice(0, 12)}`;
  const rawPayload = {
    schema: 7,
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
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main().catch((e) => fail(e.stack ?? String(e)));
