import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import { DIFFERENTIAL_TIMING_PREREGISTRATION as DESIGN } from './differential-preregistration.mjs';
import { validateDesktopInventory } from './validate.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 differential pilot: ${message}`);
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function orderGenerator(seed) {
  let state = seed >>> 0;
  invariant(state !== 0, 'order seed must be non-zero');
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) & 1;
  };
}

function armFloor(sample, floorMs, label) {
  invariant(sample && Number.isFinite(sample.motionWallMs) && Number.isFinite(sample.controlWallMs), `${label}: arm timing missing`);
  invariant(sample.motionWallMs >= floorMs && sample.controlWallMs >= floorMs, `${label}: coarse arm escaped ${floorMs}ms timing floor`);
}

function admittedDifferential(run, sample, floorMs, label) {
  armFloor(sample, floorMs, label);
  invariant(Number.isFinite(sample.estimateMs) && sample.estimateMs > 0, `${label}: removable-cost differential is not positive`);
  return {
    run,
    samples: [sample.estimateMs],
    walls: { motionMs: sample.motionWallMs, controlMs: sample.controlWallMs },
    semantic: true,
  };
}

export async function chooseCoarseArmRepeats(measureProbe, options = {}) {
  const candidates = options.candidates ?? DESIGN.armRepeatCandidates;
  const floorMs = options.floorMs ?? DESIGN.timingFloorMs;
  const discoveryProbeCount = options.discoveryProbeCount ?? DESIGN.discoveryProbeCount;
  const holdoutProbeCount = options.holdoutProbeCount ?? DESIGN.holdoutProbeCount;
  invariant(Array.isArray(candidates) && candidates.length > 0, 'repeat candidates missing');
  invariant(candidates.every((value, index) => Number.isSafeInteger(value) && value > 0 && (index === 0 || value > candidates[index - 1])), 'repeat candidates must be positive and strictly increasing');
  invariant(Number.isFinite(floorMs) && floorMs > 0, 'timing floor must be positive');

  for (const repeats of candidates) {
    const discovery = [];
    for (let probe = 0; probe < discoveryProbeCount; probe++) {
      const sample = await measureProbe(repeats);
      discovery.push(sample);
    }
    if (!discovery.every((sample) => sample.motionWallMs >= floorMs && sample.controlWallMs >= floorMs)) continue;

    const holdout = [];
    for (let probe = 0; probe < holdoutProbeCount; probe++) holdout.push(await measureProbe(repeats));
    invariant(
      holdout.every((sample) => sample.motionWallMs >= floorMs && sample.controlWallMs >= floorMs),
      `holdout failed at ${repeats} repeats; same-pilot escalation is forbidden`,
    );
    return { repeats, discovery, holdout };
  }
  throw new Error(`PROFILE-01 differential pilot: no preregistered repeat count resolves both coarse arms above ${floorMs}ms`);
}

export async function acquireDifferentialControls(measureDifferential, repeats, options = {}) {
  const runBlocks = options.runBlocks ?? DESIGN.runBlocks;
  const floorMs = options.floorMs ?? DESIGN.timingFloorMs;
  const nextOrder = orderGenerator(options.orderSeed ?? PROFILE_PREREGISTRATION.statistics.orderSeed);
  invariant(Number.isSafeInteger(repeats) && repeats > 0, 'repeat count invalid');
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'run block count invalid');
  const aa = { a: [], b: [] };
  const deliberate2x = { single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    let a;
    let b;
    if (nextOrder()) {
      b = await measureDifferential(repeats, 1);
      a = await measureDifferential(repeats, 1);
    } else {
      a = await measureDifferential(repeats, 1);
      b = await measureDifferential(repeats, 1);
    }
    aa.a.push(admittedDifferential(run, a, floorMs, `run ${run}/aa-a`));
    aa.b.push(admittedDifferential(run, b, floorMs, `run ${run}/aa-b`));

    let single;
    let doubled;
    if (nextOrder()) {
      doubled = await measureDifferential(repeats, 2);
      single = await measureDifferential(repeats, 1);
    } else {
      single = await measureDifferential(repeats, 1);
      doubled = await measureDifferential(repeats, 2);
    }
    deliberate2x.single.push(admittedDifferential(run, single, floorMs, `run ${run}/single`));
    deliberate2x.doubled.push(admittedDifferential(run, doubled, floorMs, `run ${run}/doubled`));
  }
  return { aa, deliberate2x };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

export function pairedMedianRatioInterval(left, right, seed, iterations = PROFILE_PREREGISTRATION.statistics.bootstrapIterations) {
  invariant(left.length === right.length && left.length > 1, 'paired ratio input mismatch');
  const a = left.map((cluster) => cluster.samples[0]);
  const b = right.map((cluster) => cluster.samples[0]);
  const random = lcg(seed);
  const ratios = [];
  for (let trial = 0; trial < iterations; trial++) {
    const ra = [];
    const rb = [];
    for (let index = 0; index < a.length; index++) {
      const chosen = Math.floor(random() * a.length);
      ra.push(a[chosen]);
      rb.push(b[chosen]);
    }
    ratios.push(median(ra) / median(rb));
  }
  return { ratio: median(a) / median(b), lower95: quantile(ratios, 0.025), upper95: quantile(ratios, 0.975) };
}

function exactBaselineCheckout(baselineDir) {
  const head = execFileSync('git', ['-C', baselineDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  invariant(head === DESIGN.baselineRevision, `baseline checkout drifted (${head} != ${DESIGN.baselineRevision})`);
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
      sourcefile: 'profile-differential-entry.mjs',
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

async function installHarness(page, bundle) {
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const createClock = () => {
      let queue = [];
      let ts = 0;
      return {
        requestFrame(cb) { queue.push(cb); return queue.length; },
        drainOne() {
          if (!queue.length) return false;
          const current = queue;
          queue = [];
          for (const cb of current) cb(ts);
          ts += 1000 / 60;
          return true;
        },
        hasPending() { return queue.length > 0; },
      };
    };
    const drain = (clocks, frames) => {
      for (let frame = 0; frame < frames; frame++) for (const clock of clocks) clock.drainOne();
    };
    const drainAll = (clocks, limit = 300) => {
      for (let frame = 0; frame < limit && clocks.some((clock) => clock.hasPending()); frame++) drain(clocks, 1);
      if (clocks.some((clock) => clock.hasPending())) throw new Error('virtual frame queue did not settle');
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
    const firstReorder = (root) => { for (const el of Array.from(root.children).reverse()) root.appendChild(el); };
    const secondReorder = (root) => {
      const ordered = Array.from(root.children);
      for (let index = 0; index < ordered.length; index += 5) {
        const old = ordered[index];
        root.replaceChild(card(old.getAttribute('data-motion-key')), old);
      }
      const shifted = Array.from(root.children);
      for (let index = 0; index < 17; index++) shifted.push(shifted.shift());
      for (const el of shifted) root.appendChild(el);
    };
    const restoreCollection = (root) => {
      const canonical = Array.from(root.children).sort((a, b) => Number(a.getAttribute('data-motion-key')) - Number(b.getAttribute('data-motion-key')));
      for (const el of canonical) root.appendChild(el);
    };
    const assertCollectionTerminal = (roots) => {
      for (const root of roots) {
        const keys = Array.from(root.children).map((el) => Number(el.getAttribute('data-motion-key')));
        if (keys.some((key, index) => key !== index)) throw new Error('collection terminal order drifted');
      }
    };
    const smartOptions = (requestFrame) => ({
      requestFrame,
      radius: false,
      getScroll: () => ({ x: 0, y: 0 }),
      matchMedia: () => ({ matches: false }),
    });
    const collectionMotion = (copies) => {
      document.body.textContent = '';
      const roots = Array.from({ length: copies }, setupCollection);
      const clocks = roots.map(() => createClock());
      let captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      for (const root of roots) firstReorder(root);
      let runs = captures.map((capture) => capture.animate());
      for (const run of runs) if (run.plan.matched.length !== 100 || run.plan.entered.length || run.plan.exited.length) throw new Error('collection first plan lost stable identity');
      drain(clocks, 8);
      captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      const sentinels = roots.map((root) => root.querySelector('[data-motion-key="1"]'));
      const before = sentinels.map((el) => el.getBoundingClientRect());
      for (const root of roots) secondReorder(root);
      runs = captures.map((capture) => capture.animate());
      for (let index = 0; index < roots.length; index++) {
        if (runs[index].plan.matched.length !== 100) throw new Error('collection replacement lost stable identity');
        const after = roots[index].querySelector('[data-motion-key="1"]').getBoundingClientRect();
        const jump = Math.hypot(after.x - before[index].x, after.y - before[index].y);
        if (!Number.isFinite(jump) || jump > 2) throw new Error(`collection retarget teleported by ${jump}px`);
      }
      drain(clocks, 8);
      captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame)));
      for (const root of roots) restoreCollection(root);
      runs = captures.map((capture) => capture.animate());
      for (const run of runs) if (run.plan.matched.length !== 100) throw new Error('collection final plan lost stable identity');
      drainAll(clocks);
      assertCollectionTerminal(roots);
      for (const root of roots) for (const el of root.children) if (el.style.transform !== '') throw new Error('collection terminal transform not released');
    };
    const collectionControl = (copies) => {
      document.body.textContent = '';
      const roots = Array.from({ length: copies }, setupCollection);
      for (const root of roots) firstReorder(root);
      for (const root of roots) secondReorder(root);
      for (const root of roots) restoreCollection(root);
      assertCollectionTerminal(roots);
    };
    const setupSheet = () => {
      const sheet = document.createElement('div');
      sheet.style.transform = 'translateY(0px)';
      document.body.appendChild(sheet);
      return sheet;
    };
    const directMotion = (copies) => {
      document.body.textContent = '';
      const sheets = Array.from({ length: copies }, setupSheet);
      const clocks = sheets.map(() => createClock());
      const drags = sheets.map((sheet, index) => globalThis.__lm.createDrag({
        axis: 'y', from: { y: 0 }, bounds: { y: { min: 0, max: 600 } }, rubberBand: 0.25,
        requestFrame: clocks[index].requestFrame,
        matchMedia: () => ({ matches: false }),
        onStep: (_x, y) => { sheet.style.transform = `translateY(${y}px)`; },
      }));
      for (const drag of drags) drag.pointerDown({ x: 0, y: 0, t: 0 });
      for (const drag of drags) drag.pointerMove({ x: 0, y: 120, t: 0.05 });
      for (const drag of drags) drag.pointerMove({ x: 0, y: 240, t: 0.10 });
      for (const drag of drags) drag.pointerMove({ x: 0, y: 360, t: 0.16 });
      const releaseY = drags.map((drag) => drag.y);
      for (const drag of drags) drag.pointerUp({ x: 0, y: 360, t: 0.18 });
      for (let index = 0; index < copies; index++) if (Math.abs(drags[index].y - releaseY[index]) > 1e-9) throw new Error('direct release continuity failed');
      drain(clocks, 6);
      const beforeInterrupt = drags.map((drag) => drag.y);
      for (let index = 0; index < copies; index++) drags[index].pointerDown({ x: 0, y: beforeInterrupt[index], t: 0.70 });
      for (let index = 0; index < copies; index++) if (Math.abs(drags[index].y - beforeInterrupt[index]) > 1e-9) throw new Error('direct interrupt continuity failed');
      for (const drag of drags) drag.pointerMove({ x: 0, y: 600, t: 0.82 });
      for (const drag of drags) drag.pointerUp({ x: 0, y: 600, t: 0.84 });
      drainAll(clocks);
      for (let index = 0; index < copies; index++) {
        const drag = drags[index];
        if (Math.abs(drag.y - 600) > 0.01 || drag.dragging || drag.gliding) throw new Error(`direct terminal snap failed: y=${drag.y}`);
        if (sheets[index].style.transform !== 'translateY(600px)') throw new Error('direct rendered value drifted');
      }
    };
    const directControl = (copies) => {
      document.body.textContent = '';
      const sheets = Array.from({ length: copies }, setupSheet);
      const schedule = [0, 120, 240, 360, 600];
      for (const y of schedule) for (const sheet of sheets) sheet.style.transform = `translateY(${y}px)`;
      for (const sheet of sheets) if (sheet.style.transform !== 'translateY(600px)') throw new Error('direct control terminal value drifted');
    };
    const run = (sceneId, arm, copies) => {
      if (sceneId === 'collection-reorder-100') return arm === 'motion' ? collectionMotion(copies) : collectionControl(copies);
      if (sceneId === 'direct-manipulation-sheet') return arm === 'motion' ? directMotion(copies) : directControl(copies);
      throw new Error(`unknown scene ${sceneId}`);
    };
    globalThis.__labMotionDifferential = {
      measureArm(sceneId, arm, copies, repeats) {
        const started = performance.now();
        for (let repeat = 0; repeat < repeats; repeat++) run(sceneId, arm, copies);
        return performance.now() - started;
      },
    };
  });
}

async function measureArmPair(page, sceneId, repeats, factor, motionFirst) {
  const effectiveRepeats = repeats * factor;
  const measure = (arm) => page.evaluate(([id, selectedArm, copies, count]) => (
    globalThis.__labMotionDifferential.measureArm(id, selectedArm, copies, count)
  ), [sceneId, arm, DESIGN.liveBatchCalls, effectiveRepeats]);
  let motionWallMs;
  let controlWallMs;
  if (motionFirst) {
    motionWallMs = await measure('motion');
    controlWallMs = await measure('control');
  } else {
    controlWallMs = await measure('control');
    motionWallMs = await measure('motion');
  }
  return { motionWallMs, controlWallMs, estimateMs: motionWallMs - controlWallMs, factor };
}

async function measureEngine(engine, browserType, bundle, inventory) {
  const browser = await browserType.launch({ headless: true });
  try {
    const bound = inventory.browsers.find((entry) => entry.engine === engine);
    invariant(bound, `${engine}: inventory binding missing`);
    invariant(browser.version() === bound.version, `${engine}: browser version drift`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installHarness(page, bundle);
    const scenes = [];
    for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
      const sceneId = DESIGN.sceneIds[sceneIndex];
      const nextArmOrder = orderGenerator(PROFILE_PREREGISTRATION.statistics.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b));
      const probe = (repeats) => measureArmPair(page, sceneId, repeats, 1, Boolean(nextArmOrder()));
      const selected = await chooseCoarseArmRepeats(probe);
      const measureDifferential = (repeats, factor) => measureArmPair(page, sceneId, repeats, factor, Boolean(nextArmOrder()));
      const raw = await acquireDifferentialControls(measureDifferential, selected.repeats, {
        orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed ^ Math.imul(sceneIndex + 1, 0x119de1f3),
      });
      const aa = pairedMedianRatioInterval(raw.aa.a, raw.aa.b, PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ sceneIndex);
      const deliberate2x = pairedMedianRatioInterval(raw.deliberate2x.doubled, raw.deliberate2x.single, PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ sceneIndex ^ 0x2a2a2a);
      scenes.push({ id: sceneId, repeats: selected.repeats, selector: selected, raw, aa, deliberate2x });
    }
    await context.close();
    return { id: `desktop-${engine}`, engine, browserVersion: browser.version(), scenes };
  } finally {
    await browser.close();
  }
}

function validateCalibration(cells) {
  const [aaLow, aaHigh] = PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand;
  for (const cell of cells) for (const scene of cell.scenes) {
    invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${cell.id}/${scene.id}: A/A differential escaped [${aaLow}, ${aaHigh}]`);
    invariant(scene.deliberate2x.lower95 >= PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min, `${cell.id}/${scene.id}: deliberate-2x differential unresolved`);
  }
}

async function main() {
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_DIFFERENTIAL_OUTPUT;
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  const preregRevision = process.env.PROFILE_DIFFERENTIAL_PREREG_REVISION ?? '';
  invariant(inventoryPath && baselineDir && outputPath, 'inventory, baseline and output paths are required');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harness revision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'prereg revision must be exact SHA');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateDesktopInventory(inventory);
  const bundle = await baselineBundle(baselineDir);
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  const cells = [];
  for (const engine of DESIGN.engines) cells.push(await measureEngine(engine, playwright[engine], bundle, inventory));
  const receipt = {
    schemaVersion: 1,
    node: DESIGN.node,
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt: new Date().toISOString(),
    candidateSamples: 0,
    inventorySha256: sha256(inventory),
    design: DESIGN,
    cells,
  };
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  validateCalibration(cells);
  process.stdout.write(`${JSON.stringify({ designId: DESIGN.id, candidateSamples: 0, sha256: sha256(receipt), cells: cells.map((cell) => ({ id: cell.id, scenes: cell.scenes.map((scene) => ({ id: scene.id, repeats: scene.repeats, aa: scene.aa, deliberate2x: scene.deliberate2x })) })) }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
