import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  finalizePilotReceipt,
  receiptSha256,
} from './power-design.mjs';
import { validateDesktopInventory } from './validate.mjs';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium, firefox, webkit } = compareRequire('playwright');
const { build } = compareRequire('esbuild');
const ENGINES = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];
const RUN_BLOCKS = PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks;
const BATCH_FLOOR_MS = 20;
const MAX_BATCH_CALLS = 64;

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 pilot: ${message}`);
}

function cluster(run, sample) {
  invariant(Number.isFinite(sample) && sample > 0, `run ${run}: invalid sample ${sample}`);
  return { run, samples: [sample], semantic: true };
}
async function baselineBundle(baselineDir) {
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
  await page.setContent('<!doctype html><meta charset="utf-8"><body><div id="root"></div><div id="sheet"></div></body>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const timed = (meter, fn) => {
      const started = performance.now();
      const value = fn();
      meter.own += performance.now() - started;
      return value;
    };    const clock = (meter) => {
      const queue = [];
      let ts = 0;
      return {
        requestFrame(cb) {
          queue.push(cb);
          return queue.length;
        },
        drain(frames = 1) {
          for (let frame = 0; frame < frames && queue.length > 0; frame++) {
            const current = queue.splice(0);
            for (const cb of current) timed(meter, () => cb(ts));
            ts += 1000 / 60;
          }
        },
        drainAll(limit = 300) {
          let frames = 0;
          while (queue.length > 0 && frames < limit) {
            this.drain(1);
            frames++;
          }
          if (queue.length > 0) throw new Error('virtual frame queue did not settle');
        },
      };
    };

    const card = (key) => {
      const el = document.createElement('div');
      el.setAttribute('data-motion-key', String(key));
      el.style.width = '30px';
      el.style.height = '20px';
      return el;
    };
    const setupCollection = () => {
      const root = document.getElementById('root');
      root.textContent = '';
      root.style.display = 'grid';
      root.style.gridTemplateColumns = 'repeat(10, 30px)';
      root.style.gap = '2px';
      for (let key = 0; key < 100; key++) root.appendChild(card(key));
      return root;
    };

    const smartOptions = (requestFrame) => ({
      requestFrame,
      radius: false,
      getScroll: () => ({ x: 0, y: 0 }),
      matchMedia: () => ({ matches: false }),
    });
    const runCollection = () => {
      const meter = { own: 0 };
      const c = clock(meter);
      const root = setupCollection();
      const options = smartOptions(c.requestFrame);
      const first = timed(meter, () => globalThis.__lm.captureSmart(root, options));
      const reversed = Array.from(root.children).reverse();
      for (const el of reversed) root.appendChild(el);
      const firstRun = timed(meter, () => first.animate());
      if (firstRun.plan.matched.length !== 100 || firstRun.plan.entered.length || firstRun.plan.exited.length) {
        throw new Error('collection first plan lost stable identity');
      }
      c.drain(8);
      const second = timed(meter, () => globalThis.__lm.captureSmart(root, options));
      const sentinel = root.querySelector('[data-motion-key="1"]');
      const before = sentinel.getBoundingClientRect();
      const ordered = Array.from(root.children);
      for (let i = 0; i < ordered.length; i += 5) {
        const old = ordered[i];
        const replacement = card(old.getAttribute('data-motion-key'));
        root.replaceChild(replacement, old);
      }
      const shifted = Array.from(root.children);
      for (let i = 0; i < 17; i++) shifted.push(shifted.shift());
      for (const el of shifted) root.appendChild(el);
      const secondRun = timed(meter, () => second.animate());
      if (secondRun.plan.matched.length !== 100) throw new Error('collection replacement lost stable identity');
      c.drain(1);
      const after = root.querySelector('[data-motion-key="1"]').getBoundingClientRect();
      const jump = Math.hypot(after.x - before.x, after.y - before.y);
      if (!Number.isFinite(jump) || jump > 2) throw new Error(`collection retarget teleported by ${jump}px`);
      c.drain(7);
      const third = timed(meter, () => globalThis.__lm.captureSmart(root, options));
      const canonical = Array.from(root.children).sort((a, b) =>
        Number(a.getAttribute('data-motion-key')) - Number(b.getAttribute('data-motion-key')),
      );
      for (const el of canonical) root.appendChild(el);
      const thirdRun = timed(meter, () => third.animate());
      if (thirdRun.plan.matched.length !== 100) throw new Error('collection final plan lost stable identity');
      c.drainAll();
      const keys = Array.from(root.children).map((el) => Number(el.getAttribute('data-motion-key')));
      if (keys.some((key, index) => key !== index)) throw new Error('collection terminal order drifted');
      for (const el of root.children) {
        if (el.style.transform !== '') throw new Error('collection terminal transform not released');
      }
      return meter.own;
    };

    const setupSheet = () => {
      const sheet = document.getElementById('sheet');
      sheet.style.transform = 'translateY(0px)';
      return sheet;
    };
    const runDirectManipulation = () => {
      const meter = { own: 0 };
      const c = clock(meter);
      const sheet = setupSheet();
      const drag = timed(meter, () => globalThis.__lm.createDrag({
        axis: 'y',
        from: { y: 0 },
        bounds: { y: { min: 0, max: 600 } },
        rubberBand: 0.25,
        requestFrame: c.requestFrame,
        matchMedia: () => ({ matches: false }),
        onStep: (_x, y) => { sheet.style.transform = `translateY(${y}px)`; },
      }));
      timed(meter, () => drag.pointerDown({ x: 0, y: 0, t: 0 }));
      timed(meter, () => drag.pointerMove({ x: 0, y: 120, t: 0.05 }));
      timed(meter, () => drag.pointerMove({ x: 0, y: 240, t: 0.10 }));
      timed(meter, () => drag.pointerMove({ x: 0, y: 360, t: 0.16 }));
      const releaseY = drag.y;
      timed(meter, () => drag.pointerUp({ x: 0, y: 360, t: 0.18 }));
      if (Math.abs(drag.y - releaseY) > 1e-9) throw new Error('direct release continuity failed');
      c.drain(6);
      const beforeInterrupt = drag.y;
      timed(meter, () => drag.pointerDown({ x: 0, y: beforeInterrupt, t: 0.70 }));
      if (Math.abs(drag.y - beforeInterrupt) > 1e-9) throw new Error('direct interrupt continuity failed');
      timed(meter, () => drag.pointerMove({ x: 0, y: 600, t: 0.82 }));
      timed(meter, () => drag.pointerUp({ x: 0, y: 600, t: 0.84 }));
      c.drainAll();
      if (Math.abs(drag.y - 600) > 0.01 || drag.dragging || drag.gliding) {
        throw new Error(`direct terminal snap failed: y=${drag.y}`);
      }
      return meter.own;
    };

    const runScene = (sceneId) => {
      if (sceneId === 'collection-reorder-100') return runCollection();
      if (sceneId === 'direct-manipulation-sheet') return runDirectManipulation();
      throw new Error(`unknown pilot scene ${sceneId}`);
    };
    globalThis.__profilePilot = {
      measure(sceneId, calls, multiplier) {
        let total = 0;
        for (let call = 0; call < calls; call++) {
          for (let copy = 0; copy < multiplier; copy++) total += runScene(sceneId);
        }
        if (!Number.isFinite(total) || total <= 0) throw new Error(`${sceneId}: invalid measured own-work ${total}`);
        return total;
      },
    };
  });
}

async function measure(page, sceneId, calls, multiplier = 1) {
  return page.evaluate(
    ({ sceneId: id, calls: n, multiplier: copies }) => globalThis.__profilePilot.measure(id, n, copies),
    { sceneId, calls, multiplier },
  );
}

async function chooseBatchCalls(page, sceneId) {
  await measure(page, sceneId, 1, 1);
  for (let calls = 1; calls <= MAX_BATCH_CALLS; calls *= 2) {
    const elapsed = await measure(page, sceneId, calls, 1);
    if (elapsed >= BATCH_FLOOR_MS) return calls;
  }
  throw new Error(`${sceneId}: own-work stays below ${BATCH_FLOOR_MS}ms at ${MAX_BATCH_CALLS} calls`);
}
async function measureEngine(engine, type, inventoryBrowser, bundle) {
  const browser = await type.launch({ headless: true });
  try {
    invariant(browser.version() === inventoryBrowser.version, `${engine}: inventory/browser version drift`);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await installBrowserHarness(page, bundle);
    const scenes = [];
    for (const sceneId of PROFILE_PREREGISTRATION.statistics.m05.requiredSceneIds) {
      const batchCalls = await chooseBatchCalls(page, sceneId);
      const aaA = [];
      const aaB = [];
      const single = [];
      const doubled = [];
      for (let run = 0; run < RUN_BLOCKS; run++) {
        let a;
        let b;
        let one;
        let two;
        if (run % 2 === 0) {
          a = await measure(page, sceneId, batchCalls, 1);
          b = await measure(page, sceneId, batchCalls, 1);
          one = await measure(page, sceneId, batchCalls, 1);
          two = await measure(page, sceneId, batchCalls, 2);
        } else {          b = await measure(page, sceneId, batchCalls, 1);
          a = await measure(page, sceneId, batchCalls, 1);
          two = await measure(page, sceneId, batchCalls, 2);
          one = await measure(page, sceneId, batchCalls, 1);
        }
        aaA.push(cluster(run, a));
        aaB.push(cluster(run, b));
        single.push(cluster(run, one));
        doubled.push(cluster(run, two));
      }
      scenes.push({
        id: sceneId,
        batchCalls,
        raw: {
          aa: { a: aaA, b: aaB },
          deliberate2x: { single, doubled },
        },
      });
    }
    await context.close();
    return {
      id: `desktop-${engine}`,
      engine,
      browserVersion: browser.version(),
      scenes,
    };
  } finally {
    await browser.close();
  }
}
async function main() {
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const outputPath = process.env.PROFILE_PILOT_OUTPUT;
  invariant(baselineDir && inventoryPath && outputPath, 'PROFILE_BASELINE_DIR, PROFILE_INVENTORY_PATH and PROFILE_PILOT_OUTPUT are required');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateDesktopInventory(inventory);
  const bundle = await baselineBundle(baselineDir);
  const cells = [];
  for (let index = 0; index < ENGINES.length; index++) {
    const [engine, type] = ENGINES[index];
    const bound = inventory.browsers[index];
    invariant(bound?.engine === engine, `${engine}: inventory order drifted`);
    cells.push(await measureEngine(engine, type, bound, bundle));
  }
  const pilot = finalizePilotReceipt({
    schemaVersion: 1,
    profileId: PROFILE_PREREGISTRATION.profileId,
    baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
    pilotId: process.env.PROFILE_PILOT_ID ?? 'desktop-heavy-scenes-null-control-20260918-v1',
    generatedAt: new Date().toISOString(),
    candidateSamples: 0,
    inventoryArtifactSha256: receiptSha256(inventory),
    methodologyBlob: PROFILE_PREREGISTRATION.baseline.methodologyBlob,
    harness: {
      kind: 'scenario-null-control-v1',
      harnessRevision: process.env.PROFILE_HARNESS_REVISION ?? '',
      baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
      independentUnit: PROFILE_PREREGISTRATION.statistics.independentUnit,
      runBlocks: RUN_BLOCKS,
      samplesPerCluster: 1,      orderSeed: PROFILE_PREREGISTRATION.statistics.orderSeed,
      batchFloorMs: BATCH_FLOOR_MS,
      measurement: 'sum of Lab Motion own-call/frame CPU intervals; application DOM mutation is untimed',
    },
    cells,
  });
  await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    pilotId: pilot.pilotId,
    inventoryArtifactSha256: pilot.inventoryArtifactSha256,
    cells: pilot.cells.map((cell) => ({
      id: cell.id,
      scenes: cell.scenes.map((scene) => ({
        id: scene.id,
        batchCalls: scene.batchCalls,
        aa: scene.aa,
        deliberate2x: scene.deliberate2x,
      })),
    })),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
