import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import { finalizePilotReceipt, receiptSha256 } from './power-design.mjs';
import { validateDesktopInventory } from './validate.mjs';

const ENGINES = ['chromium', 'firefox', 'webkit'];
const RUN_BLOCKS = PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks;
const SELECTOR = PROFILE_PREREGISTRATION.scenarioSelector;
const AGGREGATE_FLOOR_MS = SELECTOR.formalFloorMs;
const SELECTION_FLOOR_MS = SELECTOR.selectionFloorMs;
const UNIT_BATCH_CALLS = SELECTOR.unitBatchCalls;
const MAX_SERIAL_REPEATS = SELECTOR.maximumSerialRepeats;
const DISCOVERY_PROBE_COUNT = SELECTOR.discoveryProbeCount;
const HOLDOUT_PROBE_COUNT = SELECTOR.holdoutProbeCount;
const DEFAULT_PILOT_ID = 'scenario-null-control-20260918-v4';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 pilot: ${message}`);
}

function cluster(run, sample, floorMs = AGGREGATE_FLOOR_MS) {
  invariant(Number.isFinite(sample) && sample >= floorMs, `run ${run}: sample ${sample}ms is below ${floorMs}ms timing floor`);
  return { run, samples: [sample], semantic: true };
}

function orderGenerator(seed) {
  let state = seed >>> 0;
  invariant(state !== 0, 'orderSeed must be a non-zero 32-bit value');
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) & 1;
  };
}

function powerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export async function chooseSerialRepeats(measureAggregate, options = {}) {
  const formalFloorMs = options.formalFloorMs ?? AGGREGATE_FLOOR_MS;
  const selectionFloorMs = options.selectionFloorMs ?? SELECTION_FLOOR_MS;
  const unitBatchCalls = options.unitBatchCalls ?? UNIT_BATCH_CALLS;
  const maxSerialRepeats = options.maxSerialRepeats ?? MAX_SERIAL_REPEATS;
  const discoveryProbeCount = options.discoveryProbeCount ?? DISCOVERY_PROBE_COUNT;
  const holdoutProbeCount = options.holdoutProbeCount ?? HOLDOUT_PROBE_COUNT;
  invariant(Number.isFinite(formalFloorMs) && formalFloorMs > 0, 'formal timing floor must be positive');
  invariant(Number.isFinite(selectionFloorMs) && selectionFloorMs >= formalFloorMs, 'selection timing floor must cover the formal floor');
  invariant(powerOfTwo(unitBatchCalls), 'unitBatchCalls must be a positive power of two');
  invariant(powerOfTwo(maxSerialRepeats), 'maxSerialRepeats must be a positive power of two');
  invariant(Number.isSafeInteger(discoveryProbeCount) && discoveryProbeCount > 0, 'discovery probe count must be positive');
  invariant(Number.isSafeInteger(holdoutProbeCount) && holdoutProbeCount > 0, 'holdout probe count must be positive');

  for (let serialRepeats = 1; serialRepeats <= maxSerialRepeats; serialRepeats *= 2) {
    const discovery = [];
    for (let probe = 0; probe < discoveryProbeCount; probe++) {
      const elapsed = await measureAggregate(serialRepeats);
      invariant(Number.isFinite(elapsed) && elapsed >= 0, `discovery probe returned invalid elapsed ${elapsed}`);
      discovery.push(elapsed);
    }
    if (!discovery.every((elapsed) => elapsed >= selectionFloorMs)) {
      if (serialRepeats > Math.floor(maxSerialRepeats / 2)) break;
      continue;
    }

    // Holdout не участвует в выборе. Его провал завершает pilot, а не обучает selector.
    const holdout = [];
    for (let probe = 0; probe < holdoutProbeCount; probe++) {
      const elapsed = await measureAggregate(serialRepeats);
      invariant(Number.isFinite(elapsed) && elapsed >= 0, `holdout probe returned invalid elapsed ${elapsed}`);
      holdout.push(elapsed);
    }
    invariant(
      holdout.every((elapsed) => elapsed >= selectionFloorMs),
      `selector holdout failed at ${serialRepeats} serial repeats; same-pilot repeat escalation is forbidden`,
    );
    return {
      unitBatchCalls,
      serialRepeats,
      selector: {
        kind: SELECTOR.kind,
        unitBatchCalls,
        serialRepeats,
        formalFloorMs,
        selectionFloorMs,
        maximumSerialRepeats: maxSerialRepeats,
        discoveryProbeCount,
        holdoutProbeCount,
        holdoutCoverage: SELECTOR.holdoutCoverage,
        holdoutConfidence: SELECTOR.holdoutConfidence,
        aggregationRule: SELECTOR.aggregationRule,
        positiveControlRule: SELECTOR.positiveControlRule,
        discovery,
        holdout,
      },
    };
  }
  throw new Error(
    `PROFILE-01 pilot: scenario aggregate does not resolve above ${selectionFloorMs}ms by ${maxSerialRepeats} serial repeats at ${unitBatchCalls} live scene copies`,
  );
}

export async function acquireSceneControls(measureAggregate, serialRepeats, options = {}) {
  const runBlocks = options.runBlocks ?? RUN_BLOCKS;
  const floorMs = options.floorMs ?? AGGREGATE_FLOOR_MS;
  const seed = options.orderSeed ?? PROFILE_PREREGISTRATION.statistics.orderSeed;
  invariant(powerOfTwo(serialRepeats), 'serialRepeats must be a positive power of two');
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(seed);
  const aa = { a: [], b: [] };
  const deliberate2x = { single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    let a;
    let b;
    if (nextOrder()) {
      b = await measureAggregate(serialRepeats);
      a = await measureAggregate(serialRepeats);
    } else {
      a = await measureAggregate(serialRepeats);
      b = await measureAggregate(serialRepeats);
    }
    aa.a.push(cluster(run, a, floorMs));
    aa.b.push(cluster(run, b, floorMs));

    let single;
    let doubled;
    if (nextOrder()) {
      doubled = await measureAggregate(serialRepeats * 2);
      single = await measureAggregate(serialRepeats);
    } else {
      single = await measureAggregate(serialRepeats);
      doubled = await measureAggregate(serialRepeats * 2);
    }
    deliberate2x.single.push(cluster(run, single, floorMs));
    deliberate2x.doubled.push(cluster(run, doubled, floorMs));
  }

  return { aa, deliberate2x };
}

export function buildPilotReceipt({ inventory, harnessRevision, cells, pilotId = DEFAULT_PILOT_ID, generatedAt = new Date().toISOString() }) {
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be an exact commit SHA');
  return {
    schemaVersion: 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    pilotId,
    generatedAt,
    candidateSamples: 0,
    inventoryArtifactSha256: receiptSha256(inventory),
    methodologyBlob: PROFILE_PREREGISTRATION.baseline.methodologyBlob,
    harness: {
      kind: 'scenario-null-control-v3',
      harnessRevision,
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      independentUnit: PROFILE_PREREGISTRATION.statistics.independentUnit,
      runBlocks: RUN_BLOCKS,
      samplesPerCluster: 1,
      orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
      aggregateFloorMs: AGGREGATE_FLOOR_MS,
      selectorKind: SELECTOR.kind,
    },
    cells,
  };
}

function exactBaselineCheckout(baselineDir) {
  let head;
  try {
    head = execFileSync('git', ['-C', baselineDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`PROFILE-01 pilot: cannot attest frozen baseline checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(head === PROFILE_PREREGISTRATION.baseline.revision, `baseline checkout drifted (${head} != ${PROFILE_PREREGISTRATION.baseline.revision})`);
}

async function baselineBundle(baselineDir) {
  exactBaselineCheckout(baselineDir);
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const { build } = compareRequire('esbuild');
  const smart = JSON.stringify(resolve(baselineDir, 'dist/smart/index.js'));
  const gestures = JSON.stringify(resolve(baselineDir, 'dist/gestures/index.js'));
  const result = await build({
    stdin: {
      contents: `export { captureSmart } from ${smart}; export { createDrag } from ${gestures};`,
      resolveDir: baselineDir,
      sourcefile: 'profile-pilot-entry.mjs',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__lm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
  });
  invariant(result.outputFiles?.length === 1, 'baseline bundle missing');
  return result.outputFiles[0].text;
}

async function installBrowserHarness(page, bundle) {
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const timedRegion = (fn) => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    };

    const createClock = () => {
      let queue = [];
      let ts = 0;
      return {
        requestFrame(cb) {
          queue.push(cb);
          return queue.length;
        },
        drainOne() {
          if (queue.length === 0) return false;
          const current = queue;
          queue = [];
          for (const cb of current) cb(ts);
          ts += 1000 / 60;
          return true;
        },
        hasPending() {
          return queue.length > 0;
        },
      };
    };

    const timedDrain = (clocks, frames) => timedRegion(() => {
      for (let frame = 0; frame < frames; frame++) {
        for (const clock of clocks) clock.drainOne();
      }
    });

    const timedDrainAll = (clocks, limit = 300) => {
      let elapsed = 0;
      for (let frame = 0; frame < limit && clocks.some((clock) => clock.hasPending()); frame++) {
        elapsed += timedDrain(clocks, 1);
      }
      if (clocks.some((clock) => clock.hasPending())) throw new Error('virtual frame queue did not settle');
      return elapsed;
    };

    const card = (key) => {
      const el = document.createElement('div');
      el.setAttribute('data-motion-key', String(key));
      el.style.width = '30px';
      el.style.height = '20px';
      return el;
    };

    const setupCollection = () => {
      const root = document.createElement('div');
      root.style.display = 'grid';
      root.style.gridTemplateColumns = 'repeat(10, 30px)';
      root.style.gap = '2px';
      for (let key = 0; key < 100; key++) root.appendChild(card(key));
      document.body.appendChild(root);
      return root;
    };

    const smartOptions = (requestFrame) => ({
      requestFrame,
      radius: false,
      getScroll: () => ({ x: 0, y: 0 }),
      matchMedia: () => ({ matches: false }),
    });

    const runCollection = (copies) => {
      document.body.textContent = '';
      const roots = Array.from({ length: copies }, setupCollection);
      const clocks = roots.map(() => createClock());
      let own = 0;
      let captures;

      own += timedRegion(() => {
        captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      });
      for (const root of roots) {
        for (const el of Array.from(root.children).reverse()) root.appendChild(el);
      }
      let runs;
      own += timedRegion(() => { runs = captures.map((capture) => capture.animate()); });
      for (const run of runs) {
        if (run.plan.matched.length !== 100 || run.plan.entered.length || run.plan.exited.length) throw new Error('collection first plan lost stable identity');
      }
      own += timedDrain(clocks, 8);

      own += timedRegion(() => {
        captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      });
      const sentinels = roots.map((root) => root.querySelector('[data-motion-key="1"]'));
      const before = sentinels.map((el) => el.getBoundingClientRect());
      for (const root of roots) {
        const ordered = Array.from(root.children);
        for (let index = 0; index < ordered.length; index += 5) {
          const old = ordered[index];
          root.replaceChild(card(old.getAttribute('data-motion-key')), old);
        }
        const shifted = Array.from(root.children);
        for (let index = 0; index < 17; index++) shifted.push(shifted.shift());
        for (const el of shifted) root.appendChild(el);
      }
      own += timedRegion(() => { runs = captures.map((capture) => capture.animate()); });
      for (let index = 0; index < roots.length; index++) {
        if (runs[index].plan.matched.length !== 100) throw new Error('collection replacement lost stable identity');
        const after = roots[index].querySelector('[data-motion-key="1"]').getBoundingClientRect();
        const jump = Math.hypot(after.x - before[index].x, after.y - before[index].y);
        if (!Number.isFinite(jump) || jump > 2) throw new Error(`collection retarget teleported by ${jump}px`);
      }
      own += timedDrain(clocks, 8);

      own += timedRegion(() => {
        captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      });
      for (const root of roots) {
        const canonical = Array.from(root.children).sort((a, b) => Number(a.getAttribute('data-motion-key')) - Number(b.getAttribute('data-motion-key')));
        for (const el of canonical) root.appendChild(el);
      }
      own += timedRegion(() => { runs = captures.map((capture) => capture.animate()); });
      for (const run of runs) if (run.plan.matched.length !== 100) throw new Error('collection final plan lost stable identity');
      own += timedDrainAll(clocks);

      for (const root of roots) {
        const keys = Array.from(root.children).map((el) => Number(el.getAttribute('data-motion-key')));
        if (keys.some((key, index) => key !== index)) throw new Error('collection terminal order drifted');
        for (const el of root.children) if (el.style.transform !== '') throw new Error('collection terminal transform not released');
      }
      return own;
    };

    const setupSheet = () => {
      const sheet = document.createElement('div');
      sheet.style.transform = 'translateY(0px)';
      document.body.appendChild(sheet);
      return sheet;
    };

    const runDirectManipulation = (copies) => {
      document.body.textContent = '';
      const sheets = Array.from({ length: copies }, setupSheet);
      const clocks = sheets.map(() => createClock());
      const drags = new Array(copies);
      let own = 0;

      own += timedRegion(() => {
        for (let index = 0; index < copies; index++) {
          drags[index] = globalThis.__lm.createDrag({
            axis: 'y',
            from: { y: 0 },
            bounds: { y: { min: 0, max: 600 } },
            rubberBand: 0.25,
            requestFrame: clocks[index].requestFrame,
            matchMedia: () => ({ matches: false }),
            onStep: (_x, y) => { sheets[index].style.transform = `translateY(${y}px)`; },
          });
        }
      });
      own += timedRegion(() => { for (const drag of drags) drag.pointerDown({ x: 0, y: 0, t: 0 }); });
      own += timedRegion(() => { for (const drag of drags) drag.pointerMove({ x: 0, y: 120, t: 0.05 }); });
      own += timedRegion(() => { for (const drag of drags) drag.pointerMove({ x: 0, y: 240, t: 0.10 }); });
      own += timedRegion(() => { for (const drag of drags) drag.pointerMove({ x: 0, y: 360, t: 0.16 }); });
      const releaseY = drags.map((drag) => drag.y);
      own += timedRegion(() => { for (const drag of drags) drag.pointerUp({ x: 0, y: 360, t: 0.18 }); });
      for (let index = 0; index < copies; index++) if (Math.abs(drags[index].y - releaseY[index]) > 1e-9) throw new Error('direct release continuity failed');
      own += timedDrain(clocks, 6);
      const beforeInterrupt = drags.map((drag) => drag.y);
      own += timedRegion(() => { for (let index = 0; index < copies; index++) drags[index].pointerDown({ x: 0, y: beforeInterrupt[index], t: 0.70 }); });
      for (let index = 0; index < copies; index++) if (Math.abs(drags[index].y - beforeInterrupt[index]) > 1e-9) throw new Error('direct interrupt continuity failed');
      own += timedRegion(() => { for (const drag of drags) drag.pointerMove({ x: 0, y: 600, t: 0.82 }); });
      own += timedRegion(() => { for (const drag of drags) drag.pointerUp({ x: 0, y: 600, t: 0.84 }); });
      own += timedDrainAll(clocks);
      for (let index = 0; index < copies; index++) {
        const drag = drags[index];
        if (Math.abs(drag.y - 600) > 0.01 || drag.dragging || drag.gliding) throw new Error(`direct terminal snap failed: y=${drag.y}`);
        if (sheets[index].style.transform !== 'translateY(600px)') throw new Error('direct rendered value drifted');
      }
      return own;
    };

    globalThis.__labMotionProfileScene = {
      measure(sceneId, copies) {
        if (!Number.isSafeInteger(copies) || copies <= 0) throw new Error('invalid scene copy count');
        if (sceneId === 'collection-reorder-100') return runCollection(copies);
        if (sceneId === 'direct-manipulation-sheet') return runDirectManipulation(copies);
        throw new Error(`unknown profile scene ${sceneId}`);
      },
    };
  });
}

async function measureSceneAggregate(page, sceneId, copies, serialRepeats) {
  invariant(Number.isSafeInteger(serialRepeats) && serialRepeats > 0, 'serial repeat count must be positive');
  return page.evaluate(([id, count, repeats]) => {
    let elapsed = 0;
    for (let repeat = 0; repeat < repeats; repeat++) {
      elapsed += globalThis.__labMotionProfileScene.measure(id, count);
    }
    return elapsed;
  }, [sceneId, copies, serialRepeats]);
}

async function measureEngine(engine, browserType, bundle, inventory) {
  const browser = await browserType.launch({ headless: true });
  try {
    const bound = inventory.browsers.find((entry) => entry.engine === engine);
    invariant(bound, `${engine}: missing inventory binding`);
    invariant(browser.version() === bound.version, `${engine}: inventory/version drift (${bound.version} -> ${browser.version()})`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installBrowserHarness(page, bundle);
    const scenes = [];
    for (let sceneIndex = 0; sceneIndex < PROFILE_PREREGISTRATION.scenes.length; sceneIndex++) {
      const scene = PROFILE_PREREGISTRATION.scenes[sceneIndex];
      const measure = (serialRepeats) => measureSceneAggregate(page, scene.id, UNIT_BATCH_CALLS, serialRepeats);
      const selected = await chooseSerialRepeats(measure);
      const raw = await acquireSceneControls(measure, selected.serialRepeats, {
        orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b),
      });
      scenes.push({
        id: scene.id,
        unitBatchCalls: selected.unitBatchCalls,
        serialRepeats: selected.serialRepeats,
        selector: selected.selector,
        raw,
      });
    }
    await context.close();
    return { id: `desktop-${engine}`, engine, browserVersion: browser.version(), scenes };
  } finally {
    await browser.close();
  }
}

async function main() {
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_PILOT_OUTPUT;
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  invariant(inventoryPath, 'PROFILE_INVENTORY_PATH is required');
  invariant(baselineDir, 'PROFILE_BASELINE_DIR is required');
  invariant(outputPath, 'PROFILE_PILOT_OUTPUT is required');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'PROFILE_HARNESS_REVISION must be an exact commit SHA');

  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateDesktopInventory(inventory);
  const bundle = await baselineBundle(baselineDir);
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  const cells = [];
  for (const engine of ENGINES) cells.push(await measureEngine(engine, playwright[engine], bundle, inventory));

  const rawReceipt = buildPilotReceipt({
    inventory,
    harnessRevision,
    cells,
    pilotId: process.env.PROFILE_PILOT_ID ?? DEFAULT_PILOT_ID,
  });
  // Persist pre-validation evidence first. If a semantic/calibration gate rejects
  // the pilot, the exact malformed/raw packet remains inspectable instead of
  // encouraging repeat-to-green.
  await writeFile(outputPath, `${JSON.stringify(rawReceipt, null, 2)}\n`, 'utf8');
  const pilot = finalizePilotReceipt(rawReceipt);
  await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    profileId: pilot.profileId,
    pilotId: pilot.pilotId,
    candidateSamples: pilot.candidateSamples,
    sha256: receiptSha256(pilot),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
