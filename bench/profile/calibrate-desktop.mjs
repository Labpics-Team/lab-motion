import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pairedClusterBootstrap } from '../compare/methodology.mjs';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import { receiptSha256 } from './power-design.mjs';
import { validateCalibrationReceipt, validateDesktopInventory } from './validate.mjs';

const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'];
const ITERATIONS = 5_000_000;
const RUN_BLOCKS = 20;
const SAMPLES_PER_BLOCK = 3;

function engineTypes() {
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  return ENGINE_NAMES.map((engine) => [engine, playwright[engine]]);
}

function cluster(run, samples) {
  return { run, samples, semantic: true };
}

async function measureEngine(engine, type) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.evaluate((iterations) => {
      globalThis.__profileSink = 0;
      globalThis.__profileWork = (n) => {
        let x = globalThis.__profileSink + 0.123456789;
        for (let i = 0; i < n; i++) {
          x = (x * 1.0000001192092896 + (i & 7)) % 1024;
        }
        globalThis.__profileSink = x;
      };
      globalThis.__profileMeasure = (n) => {
        const start = performance.now();
        globalThis.__profileWork(n);
        return performance.now() - start;
      };
      for (let i = 0; i < 8; i++) globalThis.__profileWork(iterations);
    }, ITERATIONS);

    const aaA = [], aaB = [], single = [], doubled = [];
    for (let run = 0; run < RUN_BLOCKS; run++) {
      const measured = await page.evaluate(({ iterations, samples, reverse }) => {
        const out = { a: [], b: [], single: [], doubled: [] };
        const pair = (left, right, leftN, rightN) => {
          if (reverse) {
            out[right].push(globalThis.__profileMeasure(rightN));
            out[left].push(globalThis.__profileMeasure(leftN));
          } else {
            out[left].push(globalThis.__profileMeasure(leftN));
            out[right].push(globalThis.__profileMeasure(rightN));
          }
        };
        for (let sample = 0; sample < samples; sample++) {
          pair('a', 'b', iterations, iterations);
          pair('single', 'doubled', iterations, iterations * 2);
        }
        return out;
      }, { iterations: ITERATIONS, samples: SAMPLES_PER_BLOCK, reverse: run % 2 === 1 });
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
  const pass = aaLower >= aaBand[0] &&
    aaUpper <= aaBand[1] &&
    deliberateLower >= PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min;

  return {
    schemaVersion: options.inventoryArtifactSha256 ? 2 : 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    calibrationId: options.calibrationId ?? 'desktop-controls-20260915-v1',
    ...(options.inventoryArtifactSha256
      ? { inventoryArtifactSha256: options.inventoryArtifactSha256 }
      : {}),
    attempt: 1,
    generatedAt,
    workload: {
      iterations: ITERATIONS,
      deliberateMultiplier: 2,
      runBlocks: RUN_BLOCKS,
      samplesPerBlock: SAMPLES_PER_BLOCK,
      samplingUnit: 'run-block',
      order: 'alternating paired order per run block',
    },
    aa: { lower95: aaLower, upper95: aaUpper },
    deliberate2x: { workMultiplier: 2, lower95: deliberateLower },
    raw: {
      aa: cells.map(({ engine, aa, raw }) => ({ engine, interval: aa, clusters: raw.aa })),
      deliberate2x: cells.map(({ engine, deliberate2x, raw }) => ({ engine, interval: deliberate2x, clusters: raw.deliberate2x })),
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

  const receipt = finalizeCalibrationReceipt(cells, undefined, {
    inventoryArtifactSha256: receiptSha256(inventory),
    calibrationId: process.env.PROFILE_CALIBRATION_ID ?? 'desktop-controls-20260918-v1',
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
