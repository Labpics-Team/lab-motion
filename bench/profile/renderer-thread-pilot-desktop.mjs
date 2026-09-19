import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RENDERER_THREAD_PREREGISTRATION as DESIGN,
  validateRendererThreadPreregistration,
} from './renderer-thread-preregistration.mjs';
import {
  RendererThreadFailure,
  acquireRendererThreadControls,
  buildRendererThreadPilotReceipt,
  finalizeRendererThreadPilotReceipt,
  selectExecutionThread,
} from './renderer-thread-pilot-core.mjs';
import { pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';
import { validateCalibrationReceipt, validateDesktopInventory } from './validate.mjs';

export const RENDERER_THREAD_HARNESS_KIND = 'linux-page-main-thread-schedstat-differential-v1';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 renderer-thread desktop: ${message}`);
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
      sourcefile: 'profile-renderer-thread-entry.mjs',
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
    globalThis.__labMotionRendererThread = {
      identitySentinel() {
        const end = performance.now() + 300;
        let x = 0.123456789;
        while (performance.now() < end) {
          for (let i = 0; i < 4096; i++) x = (x * 1.0000001192092896 + (i & 7)) % 1024;
        }
        globalThis.__profileRendererThreadSink = x;
        return true;
      },
      warmup(sceneId, copies, logicalUnits) {
        for (let unit = 0; unit < logicalUnits; unit++) {
          run(sceneId, 'control', copies);
          run(sceneId, 'motion', copies);
        }
        return { motionPhysicalExecutions: logicalUnits, controlPhysicalExecutions: logicalUnits, semantic: true };
      },
      runArm(sceneId, arm, copies, logicalUnits, workMultiplier) {
        if (arm !== 'motion' && arm !== 'control') throw new Error('unknown arm');
        let physicalExecutions = 0;
        for (let unit = 0; unit < logicalUnits; unit++) {
          for (let repeat = 0; repeat < workMultiplier; repeat++) {
            run(sceneId, arm, copies);
            physicalExecutions++;
          }
        }
        return { physicalExecutions, semantic: true };
      },
    };
  });
}

function parseTaskStat(text) {
  const close = text.lastIndexOf(')');
  invariant(close > 0, 'malformed /proc task stat');
  const fields = text.slice(close + 2).trim().split(/\s+/u);
  const starttime = fields[19];
  invariant(/^[0-9]+$/u.test(starttime ?? ''), 'task starttime missing');
  return starttime;
}

function readTask(pid, tid) {
  try {
    const sched = readFileSync(`/proc/${pid}/task/${tid}/schedstat`, 'utf8').trim().split(/\s+/u);
    invariant(/^[0-9]+$/u.test(sched[0] ?? ''), `${pid}:${tid}: schedstat runtime missing`);
    const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
    return {
      pid,
      tid,
      starttime: parseTaskStat(stat),
      cpuNs: BigInt(sched[0]),
      comm: readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim(),
      cmd: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/gu, ' ').slice(0, 256),
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw error;
  }
}

function processChildren(pid) {
  const children = new Set();
  let tids = [];
  try { tids = readdirSync(`/proc/${pid}/task`).filter((entry) => /^\d+$/u.test(entry)); } catch { return []; }
  for (const tid of tids) {
    try {
      const text = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (text) for (const child of text.split(/\s+/u)) if (/^\d+$/u.test(child)) children.add(Number(child));
    } catch {}
  }
  return [...children];
}

function descendantPids(rootPid) {
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of processChildren(pid)) if (!seen.has(child)) { seen.add(child); queue.push(child); }
  }
  return [...seen];
}

function snapshotTasks(rootPid) {
  const snapshot = new Map();
  for (const pid of descendantPids(rootPid)) {
    let tids = [];
    try { tids = readdirSync(`/proc/${pid}/task`).filter((entry) => /^\d+$/u.test(entry)).map(Number); } catch { continue; }
    for (const tid of tids) {
      const entry = readTask(pid, tid);
      if (entry) snapshot.set(`${pid}:${tid}`, entry);
    }
  }
  return snapshot;
}

async function bindPageExecutionThread(page, rootPid) {
  const before = snapshotTasks(rootPid);
  const sentinelOk = await page.evaluate(() => globalThis.__labMotionRendererThread.identitySentinel());
  invariant(sentinelOk === true, 'identity sentinel failed');
  const after = snapshotTasks(rootPid);
  return selectExecutionThread(before, after, rootPid, { minimumCpuMs: 100, dominanceRatio: 4 });
}

function readBoundThreadCpuNs(thread, label) {
  const current = readTask(thread.pid, thread.tid);
  if (!current) throw new RendererThreadFailure('bound page execution thread disappeared', { label, thread });
  if (current.starttime !== thread.starttime) throw new RendererThreadFailure('bound page execution thread identity changed', { label, expected: thread, current });
  return current.cpuNs;
}

async function measureSubarm(page, thread, sceneId, arm, batchCalls, logicalUnits, workMultiplier, label) {
  const beforeNs = readBoundThreadCpuNs(thread, `${label}/before`);
  const result = await page.evaluate(
    ([id, selectedArm, copies, units, multiplier]) => globalThis.__labMotionRendererThread.runArm(id, selectedArm, copies, units, multiplier),
    [sceneId, arm, batchCalls, logicalUnits, workMultiplier],
  );
  const afterNs = readBoundThreadCpuNs(thread, `${label}/after`);
  invariant(result?.semantic === true && result.physicalExecutions === logicalUnits * workMultiplier, `${label}: semantic/work receipt drifted`);
  invariant(afterNs >= beforeNs, `${label}: schedstat moved backwards`);
  return { cpuMs: Number(afterNs - beforeNs) / 1e6, physicalExecutions: result.physicalExecutions };
}

async function measureObservation(page, thread, request, arm, position, isolationToken, pairOrdinal, browserVersion) {
  const warmup = await page.evaluate(
    ([sceneId, copies, units]) => globalThis.__labMotionRendererThread.warmup(sceneId, copies, units),
    [request.sceneId, request.batchCalls, request.warmupLogicalUnits],
  );
  invariant(warmup?.semantic === true && warmup.motionPhysicalExecutions === request.warmupLogicalUnits && warmup.controlPhysicalExecutions === request.warmupLogicalUnits, `${request.sceneId}: warmup drifted`);
  readBoundThreadCpuNs(thread, `${request.sceneId}/warmup`);
  const startedAt = Date.now();
  let motion;
  let control;
  if (arm.subarmOrder === 'motion-control') {
    motion = await measureSubarm(page, thread, request.sceneId, 'motion', request.batchCalls, request.logicalUnits, arm.workMultiplier, `${request.sceneId}/${arm.key}/motion`);
    control = await measureSubarm(page, thread, request.sceneId, 'control', request.batchCalls, request.logicalUnits, arm.workMultiplier, `${request.sceneId}/${arm.key}/control`);
  } else {
    control = await measureSubarm(page, thread, request.sceneId, 'control', request.batchCalls, request.logicalUnits, arm.workMultiplier, `${request.sceneId}/${arm.key}/control`);
    motion = await measureSubarm(page, thread, request.sceneId, 'motion', request.batchCalls, request.logicalUnits, arm.workMultiplier, `${request.sceneId}/${arm.key}/motion`);
  }
  const differentialCpuMs = motion.cpuMs - control.cpuMs;
  return {
    key: arm.key,
    motionThreadCpuMs: motion.cpuMs,
    controlThreadCpuMs: control.cpuMs,
    differentialCpuMs,
    motionPhysicalExecutions: motion.physicalExecutions,
    controlPhysicalExecutions: control.physicalExecutions,
    logicalUnits: request.logicalUnits,
    batchCalls: request.batchCalls,
    warmupLogicalUnits: request.warmupLogicalUnits,
    workMultiplier: arm.workMultiplier,
    subarmOrder: arm.subarmOrder,
    enclosingWallMs: Date.now() - startedAt,
    processLifecycle: 'fresh-browser-server-bound-page-thread-paired-arms-close',
    isolationToken,
    pairOrdinal,
    position,
    browserVersion,
    thread,
    semantic: true,
  };
}

function assertPilotWallBudget(pilotStartedAt) {
  const elapsed = Date.now() - pilotStartedAt;
  if (elapsed > DESIGN.measurement.maximumPilotWallMs) throw new RendererThreadFailure('pilot exceeded whole-pilot wall bound', { elapsedWallMs: elapsed, maximumPilotWallMs: DESIGN.measurement.maximumPilotWallMs });
  return elapsed;
}

async function measureFreshPair(browserType, engine, bundle, expectedVersion, request, pairOrdinal, pilotStartedAt) {
  assertPilotWallBudget(pilotStartedAt);
  const isolationToken = `${engine}:${pairOrdinal}:${randomUUID()}`;
  const pairStartedAt = Date.now();
  let server;
  let browser;
  const observations = [];
  try {
    server = await browserType.launchServer({ headless: true });
    const rootPid = server.process()?.pid;
    invariant(Number.isSafeInteger(rootPid) && rootPid > 1, `${engine}: BrowserServer pid missing`);
    browser = await browserType.connect(server.wsEndpoint());
    const browserVersion = browser.version();
    invariant(browserVersion === expectedVersion, `${engine}: inventory/version drift (${expectedVersion} -> ${browserVersion})`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installHarness(page, bundle);
    const thread = await bindPageExecutionThread(page, rootPid);
    for (let position = 0; position < request.arms.length; position++) {
      observations.push(await measureObservation(page, thread, request, request.arms[position], position, isolationToken, pairOrdinal, browserVersion));
    }
    readBoundThreadCpuNs(thread, `${engine}/${request.sceneId}/pair-${pairOrdinal}/terminal`);
    await context.close();
    return {
      processLifecycle: 'fresh-browser-server-bound-page-thread-paired-arms-close',
      isolationToken,
      pairOrdinal,
      browserVersion,
      rootPid,
      thread,
      observations,
      pairEnclosingWallMs: Date.now() - pairStartedAt,
      semantic: true,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

async function measureEngine(engine, browserType, bundle, inventory, pilotStartedAt) {
  const bound = inventory.browsers.find((entry) => entry.engine === engine);
  invariant(bound, `${engine}: inventory binding missing`);
  let pairOrdinal = 0;
  const measure = (request) => measureFreshPair(browserType, engine, bundle, bound.version, request, ++pairOrdinal, pilotStartedAt);
  const scenes = [];
  for (let sceneIndex = 0; sceneIndex < DESIGN.sceneIds.length; sceneIndex++) {
    const sceneId = DESIGN.sceneIds[sceneIndex];
    const raw = await acquireRendererThreadControls(measure, sceneId, { orderSeed: DESIGN.controls.orderSeed ^ Math.imul(sceneIndex + 1, 0x45d9f3b) });
    scenes.push({ id: sceneId, raw });
  }
  const expectedPairs = DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 2;
  invariant(pairOrdinal === expectedPairs, `${engine}: fresh-pair cardinality drifted`);
  return { id: `desktop-${engine}`, engine, browserVersion: bound.version, pairs: pairOrdinal, scenes };
}

async function main() {
  validateRendererThreadPreregistration();
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const calibrationPath = process.env.PROFILE_CALIBRATION_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_RENDERER_THREAD_OUTPUT;
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  const preregRevision = process.env.PROFILE_RENDERER_THREAD_PREREG_REVISION ?? '';
  invariant(inventoryPath && calibrationPath && baselineDir && outputPath, 'inventory, calibration, baseline and output paths are required');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision) && /^[0-9a-f]{40}$/u.test(preregRevision), 'exact prereg/harness revisions required');

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
    for (const engine of DESIGN.engines) cells.push(await measureEngine(engine, playwright[engine], bundle, inventory, pilotStartedAt));
    const receipt = buildRendererThreadPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs: assertPilotWallBudget(pilotStartedAt) });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const accepted = finalizeRendererThreadPilotReceipt(receipt);
    await writeFile(outputPath, `${JSON.stringify(accepted, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: 'PASS', designId: accepted.designId, candidateSamples: 0, sha256: pairedLogReceiptSha256(accepted), pilotEnclosingWallMs: accepted.pilotEnclosingWallMs, processIsolation: accepted.processIsolation, cells: accepted.cells.map((cell) => ({ id: cell.id, scenes: cell.scenes.map((scene) => ({ id: scene.id, aa: scene.aa, deliberate2x: scene.deliberate2x })) })) }, null, 2)}\n`);
  } catch (error) {
    const failureReceipt = {
      schemaVersion: 1, node: 'PROFILE-01', designId: DESIGN.id, preregRevision, harnessRevision,
      baselineRevision: DESIGN.baselineRevision, generatedAt: new Date().toISOString(), candidateSamples: 0,
      pilotEnclosingWallMs: Date.now() - pilotStartedAt,
      inventorySha256: pairedLogReceiptSha256(inventory), calibrationSha256: pairedLogReceiptSha256(calibration), design: DESIGN, cells,
      failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error), evidence: error instanceof RendererThreadFailure ? error.evidence : null },
    };
    await writeFile(outputPath, `${JSON.stringify(failureReceipt, null, 2)}\n`, 'utf8');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
