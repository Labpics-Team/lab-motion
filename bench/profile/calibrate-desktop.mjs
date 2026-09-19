import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pairedClusterBootstrap } from '../compare/methodology.mjs';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import { receiptSha256 } from './power-design.mjs';
import { validateCalibrationReceipt, validateDesktopInventory } from './validate.mjs';

const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'];
const ITERATIONS_PER_COPY = 5_000_000;
const RUN_BLOCKS = 20;
const SAMPLES_PER_BLOCK = 3;
const CONTROL_TIMING_FLOOR_MS = PROFILE_PREREGISTRATION.calibration.timingFloorMs;
const MAX_BATCH_COPIES = 64;
const BATCH_PROBE_COUNT = 2;

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 calibration: ${message}`);
}

function engineTypes() {
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  return ENGINE_NAMES.map((engine) => [engine, playwright[engine]]);
}

function cluster(run, samples) {
  return { run, samples, semantic: true };
}

export async function chooseCalibrationBatchCopies(measure, options = {}) {
  const floorMs = options.floorMs ?? CONTROL_TIMING_FLOOR_MS;
  const maxCopies = options.maxCopies ?? MAX_BATCH_COPIES;
  const probeCount = options.probeCount ?? BATCH_PROBE_COUNT;
  invariant(Number.isFinite(floorMs) && floorMs > 0, 'timing floor must be positive');
  invariant(Number.isSafeInteger(maxCopies) && maxCopies > 0, 'maxCopies must be a positive integer');
  invariant(Number.isSafeInteger(probeCount) && probeCount > 0, 'probeCount must be a positive integer');

  for (let copies = 1; copies <= maxCopies; copies *= 2) {
    let resolved = true;
    for (let probe = 0; probe < probeCount; probe++) {
      const elapsed = await measure(copies);
      invariant(Number.isFinite(elapsed) && elapsed >= 0, `batch probe returned invalid elapsed ${elapsed}`);
      if (elapsed < floorMs) resolved = false;
    }
    if (resolved) return copies;
    if (copies > Math.floor(maxCopies / 2)) break;
  }

  throw new Error(`PROFILE-01 calibration: control workload does not resolve above ${floorMs}ms by ${maxCopies} real work copies`);
}

function allSamples(clusters) {
  return clusters.flatMap(({ samples }) => samples);
}

function timingResolved(cell) {
  return [
    ...allSamples(cell.raw.aa.a),
    ...allSamples(cell.raw.aa.b),
    ...allSamples(cell.raw.deliberate2x.single),
    ...allSamples(cell.raw.deliberate2x.doubled),
  ].every((sample) => Number.isFinite(sample) && sample >= CONTROL_TIMING_FLOOR_MS);
}

async function measureEngine(engine, type) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.evaluate((iterationsPerCopy) => {
      globalThis.__profileSink = 0;
      globalThis.__profileWork = (n) => {
        let x = globalThis.__profileSink + 0.123456789;
        for (let i = 0; i < n; i++) {
          x = (x * 1.0000001192092896 + (i & 7)) % 1024;
        }
        globalThis.__profileSink = x;
      };
      globalThis.__profileMeasure = (copies) => {
        const start = performance.now();
        for (let copy = 0; copy < copies; copy++) globalThis.__profileWork(iterationsPerCopy);
        return performance.now() - start;
      };
      for (let i = 0; i < 8; i++) globalThis.__profileWork(iterationsPerCopy);
    }, ITERATIONS_PER_COPY);

    // Resolution is selected before formal A/A/control acquisition and is based
    // only on the synthetic control itself. Real work is repeated inside one
    // coarse timing region; no measured value is rescaled after the fact.
    const batchCopies = await chooseCalibrationBatchCopies(
      (copies) => page.evaluate((count) => globalThis.__profileMeasure(count), copies),
    );

    const aaA = [], aaB = [], single = [], doubled = [];
    for (let run = 0; run < RUN_BLOCKS; run++) {
      const measured = await page.evaluate(({ batchCopies, samples, reverse }) => {
        const out = { a: [], b: [], single: [], doubled: [] };
        const pair = (left, right, leftCopies, rightCopies) => {
          if (reverse) {
            out[right].push(globalThis.__profileMeasure(rightCopies));
            out[left].push(globalThis.__profileMeasure(leftCopies));
          } else {
            out[left].push(globalThis.__profileMeasure(leftCopies));
            out[right].push(globalThis.__profileMeasure(rightCopies));
          }
        };
        for (let sample = 0; sample < samples; sample++) {
          pair('a', 'b', batchCopies, batchCopies);
          pair('single', 'doubled', batchCopies, batchCopies * 2);
        }
        return out;
      }, { batchCopies, samples: SAMPLES_PER_BLOCK, reverse: run % 2 === 1 });
      aaA.push(cluster(run, measured.a));
      aaB.push(cluster(run, measured.b));
      single.push(cluster(run, measured.single));
      doubled.push(cluster(run, measured.doubled));
    }

    const aa = pairedClusterBootstrap(aaA, aaB, {
      seed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed,
      iterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    });
    const deliberate2x = pairedClusterBootstrap(doubled, single, {
      seed: PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ 0x2a2a2a,
      iterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
    });
    return {
      engine,
      browserVersion: browser.version(),
      batchCopies,
      aa: { ratio: aa.p50.ratio, lower95: aa.p50.low, upper95: aa.p50.high },
      deliberate2x: {
        ratio: deliberate2x.p50.ratio,
        lower95: deliberate2x.p50.low,
        upper95: deliberate2x.p50.high,
      },
      raw: { aa: { a: aaA, b: aaB }, deliberate2x: { single, doubled } },
    };
  } finally {
    await browser.close();
  }
}

export function createCalibrationReceipt(cells, generatedAt = new Date().toISOString(), options = {}) {
  const aaBand = PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand;
  const aaLower = Math.min(...cells.map((cell) => cell.aa.lower95));
  const aaUpper = Math.max(...cells.map((cell) => cell.aa.upper95));
  const deliberateLower = Math.min(...cells.map((cell) => cell.deliberate2x.lower95));
  const resolved = cells.every(timingResolved);
  const pass = resolved &&
    aaLower >= aaBand[0] &&
    aaUpper <= aaBand[1] &&
    deliberateLower >= PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min;

  return {
    schemaVersion: options.inventoryArtifactSha256 ? 2 : 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    calibrationId: options.calibrationId ?? 'desktop-controls-20260918-v2',
    ...(options.inventoryArtifactSha256
      ? { inventoryArtifactSha256: options.inventoryArtifactSha256 }
      : {}),
    attempt: 1,
    generatedAt,
    workload: {
      iterationsPerCopy: ITERATIONS_PER_COPY,
      deliberateMultiplier: 2,
      runBlocks: RUN_BLOCKS,
      samplesPerBlock: SAMPLES_PER_BLOCK,
      samplingUnit: 'run-block',
      order: 'alternating paired order per run block',
      timingFloorMs: CONTROL_TIMING_FLOOR_MS,
      maxBatchCopies: MAX_BATCH_COPIES,
      batchProbeCount: BATCH_PROBE_COUNT,
      batchSelection: 'smallest real power-of-two copy count with every pre-acquisition probe at or above timingFloorMs',
      batchCopiesByEngine: Object.fromEntries(cells.map(({ engine, batchCopies }) => [engine, batchCopies ?? 1])),
    },
    timing: { floorMs: CONTROL_TIMING_FLOOR_MS, resolved },
    aa: { lower95: aaLower, upper95: aaUpper },
    deliberate2x: { workMultiplier: 2, lower95: deliberateLower },
    raw: {
      aa: cells.map(({ engine, batchCopies, aa, raw }) => ({ engine, batchCopies: batchCopies ?? 1, interval: aa, clusters: raw.aa })),
      deliberate2x: cells.map(({ engine, batchCopies, deliberate2x, raw }) => ({ engine, batchCopies: batchCopies ?? 1, interval: deliberate2x, clusters: raw.deliberate2x })),
    },
    candidateSamples: 0,
    status: pass ? 'PASS' : 'FAIL',
  };
}

export function finalizeCalibrationReceipt(cells, generatedAt, options) {
  const receipt = createCalibrationReceipt(cells, generatedAt, options);
  // Генератор является admission boundary: FAIL не должен выглядеть для CI
  // успешным сохранённым артефактом.
  validateCalibrationReceipt(receipt);
  return receipt;
}

export async function persistCalibrationReceipt(cells, outputPath, generatedAt, options) {
  const receipt = createCalibrationReceipt(cells, generatedAt, options);
  // Failure evidence is evidence too: persist the exact raw receipt before the
  // fail-closed admission check so an invalid calibration can be diagnosed
  // without rerunning the same experiment until it happens to go green.
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  validateCalibrationReceipt(receipt);
  return receipt;
}

async function main() {
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH ?? new URL('./desktop-inventory-20260915.json', import.meta.url);
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateDesktopInventory(inventory);

  const cells = [];
  for (const [engine, type] of engineTypes()) {
    const cell = await measureEngine(engine, type);
    const bound = inventory.browsers.find((browser) => browser.engine === engine);
    if (cell.browserVersion !== bound?.version) {
      throw new Error(`PROFILE-01 calibration: ${engine} inventory/version drift (${bound?.version} -> ${cell.browserVersion})`);
    }
    cells.push(cell);
  }

  const options = {
    inventoryArtifactSha256: receiptSha256(inventory),
    calibrationId: process.env.PROFILE_CALIBRATION_ID ?? 'desktop-controls-20260918-v2',
  };
  const outputPath = process.env.PROFILE_CALIBRATION_OUTPUT;
  const receipt = outputPath
    ? await persistCalibrationReceipt(cells, outputPath, undefined, options)
    : finalizeCalibrationReceipt(cells, undefined, options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
