import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  PROCESS_RESET_PREREGISTRATION as DESIGN,
  validateProcessResetPreregistration,
} from './process-reset-preregistration.mjs';
import {
  ProcessResetResolutionFailure,
  acquireProcessResetControls,
  buildProcessResetPilotReceipt,
  finalizeProcessResetPilotReceipt,
} from './process-reset-pilot-core.mjs';
import { pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';
import { validateCalibrationReceipt, validateDesktopInventory } from './validate.mjs';

export const PROCESS_RESET_HARNESS_KIND = 'fresh-browser-process-fixed-owner-ms-v1';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 process-reset desktop: ${message}`);
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
      sourcefile: 'profile-process-reset-entry.mjs',
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
      for (const root of roots) for (const el of Array.from(root.children).reverse()) root.appendChild(el);
      let runs;
      own += timedRegion(() => { runs = captures.map((capture) => capture.animate()); });
      for (const run of runs) {
        if (run.plan.matched.length !== 100 || run.plan.entered.length || run.plan.exited.length) {
          throw new Error('collection first plan lost stable identity');
        }
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
        const canonical = Array.from(root.children).sort(
          (a, b) => Number(a.getAttribute('data-motion-key')) - Number(b.getAttribute('data-motion-key')),
        );
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
      for (let index = 0; index < copies; index++) {
        if (Math.abs(drags[index].y - releaseY[index]) > 1e-9) throw new Error('direct release continuity failed');
      }
      own += timedDrain(clocks, 6);
      const beforeInterrupt = drags.map((drag) => drag.y);
      own += timedRegion(() => {
        for (let index = 0; index < copies; index++) drags[index].pointerDown({ x: 0, y: beforeInterrupt[index], t: 0.70 });
      });
      for (let index = 0; index < copies; index++) {
        if (Math.abs(drags[index].y - beforeInterrupt[index]) > 1e-9) throw new Error('direct interrupt continuity failed');
      }
      own += timedRegion(() => { for (const drag of drags) drag.pointerMove({ x: 0, y: 600, t: 0.82 }); });
      own += timedRegion(() => { for (const drag of drags) drag.pointerUp({ x: 0, y: 600, t: 0.84 }); });
      own += timedDrainAll(clocks);
      for (let index = 0; index < copies; index++) {
        const drag = drags[index];
        if (Math.abs(drag.y - 600) > 0.01 || drag.dragging || drag.gliding) {
          throw new Error(`direct terminal snap failed: y=${drag.y}`);
        }
        sheets[index].style.transform = `translateY(${drag.y}px)`;
        if (sheets[index].style.transform !== 'translateY(600px)') throw new Error('direct rendered value drifted');
      }
      return own;
    };

    const runScene = (sceneId, copies) => sceneId === 'collection-reorder-100'
      ? runCollection(copies)
      : sceneId === 'direct-manipulation-sheet'
        ? runDirectManipulation(copies)
        : (() => { throw new Error(`unknown profile scene ${sceneId}`); })();

    globalThis.__labMotionProcessReset = {
      warmup(sceneId, copies, logicalUnits) {
        if (!Number.isSafeInteger(copies) || copies <= 0) throw new Error('invalid warmup live-batch size');
        if (!Number.isSafeInteger(logicalUnits) || logicalUnits <= 0) throw new Error('invalid warmup logical-unit count');
        for (let logicalUnit = 0; logicalUnit < logicalUnits; logicalUnit++) runScene(sceneId, copies);
        return { warmupPhysicalExecutions: logicalUnits, semantic: true };
      },
      measure(sceneId, copies, logicalUnits, workMultiplier) {
        if (!Number.isSafeInteger(copies) || copies <= 0) throw new Error('invalid formal live-batch size');
        if (!Number.isSafeInteger(logicalUnits) || logicalUnits <= 0) throw new Error('invalid formal logical-unit count');
        if (workMultiplier !== 1 && workMultiplier !== 2) throw new Error('invalid work multiplier');
        const started = performance.now();
        let ownerMs = 0;
        let physicalExecutions = 0;
        for (let logicalUnit = 0; logicalUnit < logicalUnits; logicalUnit++) {
          for (let execution = 0; execution < workMultiplier; execution++) {
            ownerMs += runScene(sceneId, copies);
            physicalExecutions++;
          }
        }
        const enclosingWallMs = performance.now() - started;
        if (!Number.isFinite(ownerMs) || ownerMs < 0) throw new Error('invalid owner-time result');
        if (!Number.isFinite(enclosingWallMs) || enclosingWallMs < ownerMs) throw new Error('invalid enclosing wall-time result');
        return { ownerMs, enclosingWallMs, physicalExecutions, semantic: true };
      },
    };
  });
}

function assertPilotWallBudget(pilotStartedAt) {
  const elapsed = Date.now() - pilotStartedAt;
  if (elapsed > DESIGN.measurement.maximumPilotWallMs) {
    throw new ProcessResetResolutionFailure('pilot exceeded whole-pilot wall bound', {
      elapsedWallMs: elapsed,
      maximumPilotWallMs: DESIGN.measurement.maximumPilotWallMs,
    });
  }
  return elapsed;
}

async function measureFreshProcess(browserType, engine, bundle, expectedVersion, request, launchOrdinal, pilotStartedAt) {
  assertPilotWallBudget(pilotStartedAt);
  const isolationToken = `${engine}:${launchOrdinal}:${randomUUID()}`;
  const setupStartedAt = Date.now();
  const browser = await browserType.launch({ headless: true });
  let result;
  let closeWallMs = 0;
  try {
    invariant(browser.version() === expectedVersion, `${engine}: inventory/version drift (${expectedVersion} -> ${browser.version()})`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installHarness(page, bundle);
    const launchSetupWallMs = Date.now() - setupStartedAt;

    const warmupStartedAt = Date.now();
    const warmup = await page.evaluate(
      ([sceneId, batchCalls, warmupLogicalUnits]) => globalThis.__labMotionProcessReset.warmup(sceneId, batchCalls, warmupLogicalUnits),
      [request.sceneId, request.batchCalls, request.warmupLogicalUnits],
    );
    const warmupWallMs = Date.now() - warmupStartedAt;
    invariant(warmup?.semantic === true && warmup.warmupPhysicalExecutions === request.warmupLogicalUnits, `${request.sceneId}: warmup semantic/work drifted`);

    const measured = await page.evaluate(
      ([sceneId, batchCalls, logicalUnits, workMultiplier]) => globalThis.__labMotionProcessReset.measure(sceneId, batchCalls, logicalUnits, workMultiplier),
      [request.sceneId, request.batchCalls, request.logicalUnits, request.workMultiplier],
    );
    result = {
      ...measured,
      launchSetupWallMs,
      warmupWallMs,
      logicalUnits: request.logicalUnits,
      batchCalls: request.batchCalls,
      warmupLogicalUnits: request.warmupLogicalUnits,
      warmupPhysicalExecutions: warmup.warmupPhysicalExecutions,
      workMultiplier: request.workMultiplier,
      processLifecycle: 'launch-warmup-measure-close',
      isolationToken,
      launchOrdinal,
      browserVersion: browser.version(),
      semantic: true,
    };
    await context.close();
  } finally {
    const closeStartedAt = Date.now();
    await browser.close();
    closeWallMs = Date.now() - closeStartedAt;
  }
  assertPilotWallBudget(pilotStartedAt);
  invariant(result, `${request.sceneId}: fresh process closed without formal result`);
  result.closeWallMs = closeWallMs;
  return result;
}

async function measureEngine(engine, browserType, bundle, inventory, pilotStartedAt) {
  const bound = inventory.browsers.find((entry) => entry.engine === engine);
  invariant(bound, `${engine}: inventory binding missing`);
  let launchOrdinal = 0;
  const measure = (request) => measureFreshProcess(
    browserType,
    engine,
    bundle,
    bound.version,
    request,
    ++launchOrdinal,
    pilotStartedAt,
  );
  const scenes = [];
  for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
    const sceneId = DESIGN.sceneIds[sceneIndex];
    const raw = await acquireProcessResetControls(measure, sceneId, {
      orderSeed: DESIGN.controls.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b),
    });
    scenes.push({ id: sceneId, raw });
  }
  invariant(launchOrdinal === DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 4, `${engine}: fresh-launch cardinality drifted`);
  return { id: `desktop-${engine}`, engine, browserVersion: bound.version, launches: launchOrdinal, scenes };
}

async function main() {
  validateProcessResetPreregistration();
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const calibrationPath = process.env.PROFILE_CALIBRATION_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_PROCESS_RESET_OUTPUT;
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  const preregRevision = process.env.PROFILE_PROCESS_RESET_PREREG_REVISION ?? '';
  invariant(inventoryPath && calibrationPath && baselineDir && outputPath, 'inventory, calibration, baseline and output paths are required');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harness revision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'prereg revision must be exact SHA');

  const [inventory, calibration] = await Promise.all([
    readFile(inventoryPath, 'utf8').then(JSON.parse),
    readFile(calibrationPath, 'utf8').then(JSON.parse),
  ]);
  validateDesktopInventory(inventory);
  validateCalibrationReceipt(calibration);
  invariant(calibration.inventoryArtifactSha256 === pairedLogReceiptSha256(inventory), 'calibration/inventory content address drifted');

  const bundle = await baselineBundle(baselineDir);
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  const playwright = compareRequire('playwright');
  const cells = [];
  const pilotStartedAt = Date.now();

  try {
    for (const engine of DESIGN.engines) {
      cells.push(await measureEngine(engine, playwright[engine], bundle, inventory, pilotStartedAt));
    }
    const receipt = buildProcessResetPilotReceipt({
      inventory,
      calibration,
      preregRevision,
      harnessRevision,
      cells,
      pilotEnclosingWallMs: assertPilotWallBudget(pilotStartedAt),
    });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const accepted = finalizeProcessResetPilotReceipt(receipt);
    await writeFile(outputPath, `${JSON.stringify(accepted, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: 'PASS', designId: accepted.designId, candidateSamples: 0, sha256: pairedLogReceiptSha256(accepted), pilotEnclosingWallMs: accepted.pilotEnclosingWallMs, processIsolation: accepted.processIsolation, cells: accepted.cells.map((cell) => ({ id: cell.id, launches: cell.launches, scenes: cell.scenes.map((scene) => ({ id: scene.id, aa: scene.aa, deliberate2x: scene.deliberate2x })) })) }, null, 2)}\n`);
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
        evidence: error instanceof ProcessResetResolutionFailure ? error.evidence : null,
      },
    };
    await writeFile(outputPath, `${JSON.stringify(failureReceipt, null, 2)}\n`, 'utf8');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
