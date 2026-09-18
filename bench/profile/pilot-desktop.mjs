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
    };
    const clock = (meter) => {
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
      // C0 is the synchronous handoff boundary. Advancing a virtual frame before
      // observing it mistakes legitimate post-handoff velocity for teleportation.
      const afterHandoff = root.querySelector('[data-motion-key="1"]').getBoundingClientRect();
      const jump = Math.hypot(afterHandoff.x - before.x, afterHandoff.y - before.y);
      if (!Number.isFinite(jump) || jump > 2) throw new Error(`collection retarget teleported by ${jump}px`);
      c.drain(8);
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
      if (sheet.style.transform !== 'translateY(600px)') throw new Error('direct rendered value drifted');
      drag.destroy();
      return meter.own;
    };

    globalThis.__labMotionProfileScene = {
      measure(scale = 1, calls = 1) {
        let total = 0;
        for (let i = 0; i < calls; i++) {
          const own = globalThis.__labMotionProfileScene.scene === 'collection-reorder-100'
            ? runCollection()
            : runDirectManipulation();
          total += own * scale;
        }
        return total;
      },
      scene: 'collection-reorder-100',
    };
  });
}

async function measure(page, scale, calls) {
  return page.evaluate(([requestedScale, batchCalls]) =>
    globalThis.__labMotionProfileScene.measure(requestedScale, batchCalls), [scale, calls]);
}

async function chooseBatchCalls(page) {
  let calls = 1;
  for (;;) {
    const elapsed = await measure(page, 1, calls);
    if (elapsed >= BATCH_FLOOR_MS || calls >= MAX_BATCH_CALLS) return calls;
    calls *= 2;
  }
}

async function measureEngine(engineName, browserType, bundle, cellId) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await installBrowserHarness(page, bundle);
    const blocks = [];
    for (const scene of PROFILE_PREREGISTRATION.scenes) {
      await page.evaluate((name) => { globalThis.__labMotionProfileScene.scene = name; }, scene);
      const batchCalls = await chooseBatchCalls(page);
      const aa = [];
      const positive = [];
      for (let run = 0; run < RUN_BLOCKS; run++) {
        const headA = await measure(page, 1, batchCalls);
        const headB = await measure(page, 1, batchCalls);
        aa.push({ a: cluster(run, headA), b: cluster(run, headB) });

        const baseline = await measure(page, 1, batchCalls);
        const deliberate2x = await measure(page, PROFILE_PREREGISTRATION.calibration.deliberateScale, batchCalls);
        positive.push({ a: cluster(run, baseline), b: cluster(run, deliberate2x) });
      }
      blocks.push({
        id: `${cellId}:${scene}`,
        cellId,
        scene,
        sampleCountPerBlock: 1,
        batchCalls,
        aa,
        positive,
      });
    }
    return blocks;
  } finally {
    await browser.close();
  }
}

async function main() {
  const inventoryPath = process.env.PROFILE_INVENTORY_PATH;
  const baselineDir = process.env.PROFILE_BASELINE_DIR;
  const outputPath = process.env.PROFILE_PILOT_OUTPUT;
  invariant(inventoryPath, 'PROFILE_INVENTORY_PATH is required');
  invariant(baselineDir, 'PROFILE_BASELINE_DIR is required');
  invariant(outputPath, 'PROFILE_PILOT_OUTPUT is required');
  const pilotId = process.env.PROFILE_PILOT_ID ?? PROFILE_PREREGISTRATION.powerDesign.pilotId;
  invariant(pilotId, 'PROFILE_PILOT_ID is required');
  const harnessRevision = process.env.PROFILE_HARNESS_REVISION ?? '';
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'PROFILE_HARNESS_REVISION must be an exact commit SHA');

  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  validateDesktopInventory(inventory);
  const inventoryArtifactSha256 = receiptSha256(inventory);
  const bundle = await baselineBundle(baselineDir);
  const cells = [];
  for (const [engineName, browserType] of ENGINES) {
    const cellId = `gha-ubuntu-24.04-${engineName}`;
    const blocks = await measureEngine(engineName, browserType, bundle, cellId);
    cells.push({ cellId, engine: engineName, blocks });
  }
  const pilot = finalizePilotReceipt({
    pilotId,
    harnessRevision,
    inventoryArtifactSha256,
    cells,
  });
  await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    profile: pilot.profile,
    pilotId: pilot.pilotId,
    candidateSamples: pilot.candidateSamples,
    sha256: receiptSha256(pilot),
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
