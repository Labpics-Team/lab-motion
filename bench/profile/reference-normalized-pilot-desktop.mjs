import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  REFERENCE_NORMALIZED_PREREGISTRATION as DESIGN,
  validateReferenceNormalizedPreregistration,
} from './reference-normalized-preregistration.mjs';
import {
  ReferenceNormalizedResolutionFailure,
  acquireReferenceNormalizedControls,
  buildReferenceNormalizedPilotReceipt,
  finalizeReferenceNormalizedPilotReceipt,
} from './reference-normalized-pilot-core.mjs';
import { pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';
import { validateCalibrationReceipt, validateDesktopInventory } from './validate.mjs';

export const REFERENCE_NORMALIZED_HARNESS_KIND = 'fixed-work-calibration-bracket-normalized-desktop-v1';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 reference-normalized desktop: ${message}`);
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
      sourcefile: 'profile-reference-normalized-entry.mjs',
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

async function installHarness(page, bundle, referenceBinding) {
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate((referenceBinding) => {
    const timedRegion = (fn) => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    };

    const createClock = () => {
      let queue = [];
      let ts = 0;
      return {
        requestFrame(cb) { queue.push(cb); return queue.length; },
        drainOne() {
          if (queue.length === 0) return false;
          const current = queue;
          queue = [];
          for (const cb of current) cb(ts);
          ts += 1000 / 60;
          return true;
        },
        hasPending() { return queue.length > 0; },
      };
    };

    const timedDrain = (clocks, frames) => timedRegion(() => {
      for (let frame = 0; frame < frames; frame++) for (const clock of clocks) clock.drainOne();
    });

    const timedDrainAll = (clocks, limit = 300) => {
      let elapsed = 0;
      for (let frame = 0; frame < limit && clocks.some((clock) => clock.hasPending()); frame++) elapsed += timedDrain(clocks, 1);
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

      own += timedRegion(() => { captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame))); });
      for (const root of roots) for (const el of Array.from(root.children).reverse()) root.appendChild(el);
      let runs;
      own += timedRegion(() => { runs = captures.map((capture) => capture.animate()); });
      for (const run of runs) if (run.plan.matched.length !== 100 || run.plan.entered.length || run.plan.exited.length) throw new Error('collection first plan lost stable identity');
      own += timedDrain(clocks, 8);

      own += timedRegion(() => { captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame))); });
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

      own += timedRegion(() => { captures = roots.map((root, index) => globalThis.__lm.captureSmart(root, smartOptions(clocks[index].requestFrame))); });
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
            onStep: () => {},
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
        sheets[index].style.transform = `translateY(${drag.y}px)`;
        if (sheets[index].style.transform !== 'translateY(600px)') throw new Error('direct rendered value drifted');
      }
      return own;
    };


    let referenceSink = 0;
    const referenceWork = (iterations) => {
      let x = referenceSink + 0.123456789;
      for (let i = 0; i < iterations; i++) x = (x * 1.0000001192092896 + (i & 7)) % 1024;
      referenceSink = x;
    };
    const measureReference = () => {
      const started = performance.now();
      for (let copy = 0; copy < referenceBinding.batchCopies; copy++) referenceWork(referenceBinding.iterationsPerCopy);
      return performance.now() - started;
    };
    for (let warm = 0; warm < 8; warm++) referenceWork(referenceBinding.iterationsPerCopy);

    globalThis.__labMotionReferenceNormalized = {
      measurePacket(sceneId, copies, logicalUnits, workMultiplier) {
        if (!Number.isSafeInteger(copies) || copies <= 0) throw new Error('invalid live batch size');
        if (!Number.isSafeInteger(logicalUnits) || logicalUnits <= 0) throw new Error('invalid fixed logical-unit count');
        if (workMultiplier !== 1 && workMultiplier !== 2) throw new Error('invalid work multiplier');
        const started = performance.now();
        const referenceBeforeMs = measureReference();
        let ownerMs = 0;
        let physicalExecutions = 0;
        for (let logicalUnit = 0; logicalUnit < logicalUnits; logicalUnit++) {
          for (let execution = 0; execution < workMultiplier; execution++) {
            ownerMs += sceneId === 'collection-reorder-100'
              ? runCollection(copies)
              : sceneId === 'direct-manipulation-sheet'
                ? runDirectManipulation(copies)
                : (() => { throw new Error(`unknown profile scene ${sceneId}`); })();
            physicalExecutions++;
          }
        }
        const referenceAfterMs = measureReference();
        const enclosingWallMs = performance.now() - started;
        if (!Number.isFinite(ownerMs) || ownerMs < 0) throw new Error('invalid owner-time result');
        if (![referenceBeforeMs, referenceAfterMs].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('invalid reference result');
        if (!Number.isFinite(enclosingWallMs) || enclosingWallMs < ownerMs) throw new Error('invalid enclosing wall-time result');
        return {
          ownerMs,
          enclosingWallMs,
          referenceBeforeMs,
          referenceAfterMs,
          referenceAnchorMs: referenceBinding.anchorMs,
          referenceCopies: referenceBinding.batchCopies,
          referenceIterationsPerCopy: referenceBinding.iterationsPerCopy,
          logicalUnits,
          physicalExecutions,
          batchCalls: copies,
          workMultiplier,
          semantic: true,
        };
      },
    };
  }, referenceBinding);
}

function assertPilotWallBudget(pilotStartedAt) {
  const elapsed = Date.now() - pilotStartedAt;
  if (elapsed > DESIGN.measurement.maximumPilotWallMs) {
    throw new ReferenceNormalizedResolutionFailure('pilot exceeded whole-pilot wall bound', {
      elapsedWallMs: elapsed,
      maximumPilotWallMs: DESIGN.measurement.maximumPilotWallMs,
    });
  }
  return elapsed;
}

async function measurePacket(page, request, pilotStartedAt) {
  assertPilotWallBudget(pilotStartedAt);
  const copies = DESIGN.measurement.liveBatchCallsByScene[request.sceneId];
  invariant(Number.isSafeInteger(copies) && copies > 0, `${request.sceneId}: frozen live-batch count missing`);
  const result = await page.evaluate(
    ([sceneId, batchCalls, logicalUnits, workMultiplier]) => globalThis.__labMotionReferenceNormalized.measurePacket(sceneId, batchCalls, logicalUnits, workMultiplier),
    [request.sceneId, copies, request.logicalUnits, request.workMultiplier],
  );
  assertPilotWallBudget(pilotStartedAt);
  return result;
}

function median(values) {
  invariant(Array.isArray(values) && values.length > 0 && values.every((value) => Number.isFinite(value) && value > 0), `reference anchor samples invalid`);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function referenceBindingForEngine(calibration, engine) {
  const iterationsPerCopy = calibration.workload?.iterationsPerCopy;
  const batchCopies = calibration.workload?.batchCopiesByEngine?.[engine];
  const aa = calibration.raw?.aa?.find((entry) => entry.engine === engine);
  const deliberate = calibration.raw?.deliberate2x?.find((entry) => entry.engine === engine);
  const anchorSamples = [
    ...(aa?.clusters?.a ?? []),
    ...(aa?.clusters?.b ?? []),
    ...(deliberate?.clusters?.single ?? []),
  ].flatMap(({ samples }) => samples ?? []);
  const anchorMs = median(anchorSamples);
  invariant(Number.isSafeInteger(iterationsPerCopy) && iterationsPerCopy > 0, `${engine}: calibration reference iterations missing`);
  invariant(Number.isSafeInteger(batchCopies) && batchCopies > 0, `${engine}: calibration reference copies missing`);
  invariant(anchorSamples.length === 20 * 3 * 3, `${engine}: calibration anchor sample cardinality drifted`);
  invariant(anchorMs >= DESIGN.measurement.referenceFloorMs, `${engine}: calibration anchor below frozen floor`);
  return { iterationsPerCopy, batchCopies, anchorMs };
}

async function measureEngine(engine, browserType, bundle, inventory, calibration, pilotStartedAt) {
  const browser = await browserType.launch({ headless: true });
  try {
    const bound = inventory.browsers.find((entry) => entry.engine === engine);
    invariant(bound, `${engine}: inventory binding missing`);
    invariant(browser.version() === bound.version, `${engine}: inventory/version drift (${bound.version} -> ${browser.version()})`);
    const referenceBinding = referenceBindingForEngine(calibration, engine);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installHarness(page, bundle, referenceBinding);
    const scenes = [];
    for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
      const sceneId = DESIGN.sceneIds[sceneIndex];
      const raw = await acquireReferenceNormalizedControls(
        (request) => measurePacket(page, request, pilotStartedAt),
        sceneId,
        { orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b) },
      );
      scenes.push({ id: sceneId, raw });
    }
    await context.close();
    return { id: `desktop-${engine}`, engine, browserVersion: browser.version(), referenceBinding, scenes };
  } finally {
    await browser.close();
  }
}

async function main() {
  validateReferenceNormalizedPreregistration();
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const calibrationPath = process.env.PROFILE_CALIBRATION_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_REFERENCE_NORMALIZED_OUTPUT;
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  const preregRevision = process.env.PROFILE_REFERENCE_NORMALIZED_PREREG_REVISION ?? '';
  invariant(inventoryPath && calibrationPath && baselineDir && outputPath, 'inventory, calibration, baseline and output paths are required');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harness revision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'prereg revision must be exact SHA');

  const [inventory, calibration] = await Promise.all([
    readFile(inventoryPath, 'utf8').then(JSON.parse),
    readFile(calibrationPath, 'utf8').then(JSON.parse),
  ]);
  validateDesktopInventory(inventory);
  validateCalibrationReceipt(calibration);
  invariant(calibration.inventoryArtifactSha256 === pairedLogReceiptSha256(inventory), 'calibration/inventory content address mismatch');

  const bundle = await baselineBundle(baselineDir);
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  const cells = [];
  const pilotStartedAt = Date.now();

  try {
    for (const engine of DESIGN.engines) cells.push(await measureEngine(engine, playwright[engine], bundle, inventory, calibration, pilotStartedAt));
  } catch (error) {
    const failureReceipt = {
      schemaVersion: 1,
      node: 'PROFILE-01',
      designId: DESIGN.id,
      preregRevision,
      harnessRevision,
      baselineRevision: DESIGN.baselineRevision,
      generatedAt: new Date().toISOString(),
      candidateSamples: 0,
      pilotEnclosingWallMs: Date.now() - pilotStartedAt,
      inventorySha256: pairedLogReceiptSha256(inventory),
      calibrationSha256: pairedLogReceiptSha256(calibration),
      design: DESIGN,
      status: 'failed',
      cells,
      failure: {
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error),
        evidence: error instanceof ReferenceNormalizedResolutionFailure ? error.evidence : null,
      },
    };
    await writeFile(outputPath, `${JSON.stringify(failureReceipt, null, 2)}\n`, 'utf8');
    throw error;
  }

  const pilotEnclosingWallMs = assertPilotWallBudget(pilotStartedAt);
  const raw = buildReferenceNormalizedPilotReceipt({ inventory, calibration, harnessRevision, preregRevision, cells, pilotEnclosingWallMs });
  await writeFile(outputPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const pilot = finalizeReferenceNormalizedPilotReceipt(raw);
  await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    harnessKind: REFERENCE_NORMALIZED_HARNESS_KIND,
    designId: DESIGN.id,
    candidateSamples: 0,
    sha256: pairedLogReceiptSha256(pilot),
    cells: pilot.cells.map((cell) => ({ id: cell.id, referenceBinding: cell.referenceBinding, scenes: cell.scenes.map((scene) => ({ id: scene.id, aa: scene.aa, deliberate2x: scene.deliberate2x })) })),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
