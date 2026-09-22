import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';
import {
  derivePoweredDesign,
  materializePilotReceipt,
  receiptSha256,
  validatePilotReceipt,
} from './power-design.mjs';
import {
  validateCalibrationReceipt,
  validateDesktopInventory,
  validatePoweredDesignReceipt,
} from './validate.mjs';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium, firefox, webkit } = compareRequire('playwright');
const ENGINE_TYPES = Object.freeze({ chromium, firefox, webkit });
const MIME = Object.freeze({ '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' });

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 pilot: ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export async function chooseScenarioSerialRepeats(measure, contract = PROFILE_PREREGISTRATION.scenarioSelector) {
  invariant(typeof measure === 'function', 'scenario measure must be callable');
  const discoveryHistory = [];
  for (let serialRepeats = 1; serialRepeats <= contract.maximumSerialRepeats; serialRepeats *= 2) {
    const discovery = [];
    for (let probe = 0; probe < contract.discoveryProbeCount; probe++) {
      const elapsed = await measure(serialRepeats);
      invariant(Number.isFinite(elapsed) && elapsed > 0, `selector discovery returned invalid elapsed ${elapsed}`);
      discovery.push(elapsed);
    }
    discoveryHistory.push({ serialRepeats, samples: discovery });
    if (!discovery.every((sample) => sample >= contract.selectionFloorMs)) continue;

    const holdout = [];
    for (let probe = 0; probe < contract.holdoutProbeCount; probe++) {
      const elapsed = await measure(serialRepeats);
      invariant(Number.isFinite(elapsed) && elapsed > 0, `selector holdout returned invalid elapsed ${elapsed}`);
      holdout.push(elapsed);
    }
    invariant(
      holdout.every((sample) => sample >= contract.selectionFloorMs),
      `holdout failed at selected serialRepeats=${serialRepeats}; repeat escalation is forbidden`,
    );
    return { serialRepeats, discoveryHistory, discovery, holdout };
  }
  throw new Error(
    `PROFILE-01 pilot: no power-of-two serial repeat count <= ${contract.maximumSerialRepeats} resolved ${contract.selectionFloorMs}ms`,
  );
}

function selectorReceipt(selection, contract = PROFILE_PREREGISTRATION.scenarioSelector) {
  return {
    kind: contract.kind,
    unitBatchCalls: contract.unitBatchCalls,
    serialRepeats: selection.serialRepeats,
    formalFloorMs: contract.formalFloorMs,
    selectionFloorMs: contract.selectionFloorMs,
    maximumSerialRepeats: contract.maximumSerialRepeats,
    discoveryProbeCount: contract.discoveryProbeCount,
    holdoutProbeCount: contract.holdoutProbeCount,
    holdoutCoverage: contract.holdoutCoverage,
    holdoutConfidence: contract.holdoutConfidence,
    aggregationRule: contract.aggregationRule,
    positiveControlRule: contract.positiveControlRule,
    discoveryHistory: selection.discoveryHistory,
    discovery: selection.discovery,
    holdout: selection.holdout,
  };
}

function cluster(run, value) {
  return { run, samples: [value], semantic: true };
}

async function startDistServer(baselineRoot) {
  const root = await realpath(resolve(baselineRoot));
  const dist = await realpath(resolve(root, 'dist'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>PROFILE-01</title>');
        return;
      }
      invariant(pathname.startsWith('/dist/'), 'only baseline dist is served');
      const candidate = await realpath(resolve(root, `.${pathname}`));
      invariant(candidate === dist || candidate.startsWith(`${dist}${sep}`), 'path escaped baseline dist');
      const bytes = await readFile(candidate);
      response.writeHead(200, {
        'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error instanceof Error ? error.message : error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'baseline server has no bound address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

async function installSceneHarness(page, origin, profile) {
  await page.goto(origin, { waitUntil: 'load' });
  await page.evaluate(async ({ projectionUrl, behaviorsUrl, sceneContracts }) => {
    const projection = await import(projectionUrl);
    const behaviors = await import(behaviorsUrl);
    const global = globalThis;
    global.__profileModules = { projection, behaviors };
    global.__profileSceneContracts = Object.fromEntries(sceneContracts.map((scene) => [scene.id, scene]));
    global.__runProfileSceneAggregate = async (sceneId, serialRepeats, unitBatchCalls) => {
      const sceneContract = global.__profileSceneContracts[sceneId];
      if (!sceneContract) throw new Error(`unknown PROFILE-01 scene ${sceneId}`);
      const now = () => performance.now();
      const waitUntil = async (startedAt, targetMs) => {
        while (now() - startedAt < targetMs) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const phase = { setup: 0, input: 0, frame: 0, interruption: 0, teardown: 0 };
      const timed = (key, fn) => {
        const start = now();
        const value = fn();
        phase[key] += now() - start;
        return value;
      };
      const scheduler = () => {
        let pending = 0;
        let failure;
        const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
        const checkFailure = () => {
          if (failure !== undefined) throw failure;
        };
        return {
          requestFrame(callback) {
            pending++;
            return requestAnimationFrame((timestamp) => {
              pending--;
              try {
                timed('frame', () => callback(timestamp));
              } catch (error) {
                failure ??= error;
              }
            });
          },
          async drain(roundLimit = 4000) {
            let rounds = 0;
            while (pending > 0) {
              if (++rounds > roundLimit) throw new Error(`${sceneId}: frame bound exceeded`);
              await nextFrame();
              checkFailure();
            }
            checkFailure();
          },
          async drainRounds(count) {
            for (let round = 0; round < count && pending > 0; round++) {
              await nextFrame();
              checkFailure();
            }
          },
          pending() { return pending; },
        };
      };

      const box = (index) => ({
        x: (index % 10) * 36,
        y: Math.floor(index / 10) * 36,
        width: 32,
        height: 32,
      });
      const runCollection = async () => {
        const sched = scheduler();
        const controls = [];
        for (let instance = 0; instance < unitBatchCalls; instance++) {
          controls.push(timed('setup', () => projection.createProjection({
            requestFrame: sched.requestFrame,
            onFrame: () => {},
          })));
        }
        const startedAt = now();
        for (const ctrl of controls) {
          const initial = Array.from({ length: 100 }, (_, index) => ({
            id: `card-${index}`,
            first: box(index),
            last: box(index),
          }));
          timed('input', () => ctrl.play(initial));
        }

        await waitUntil(startedAt, sceneContract.scheduleMs[1]);
        for (const ctrl of controls) {
          const reversed = Array.from({ length: 100 }, (_, index) => ({
            id: `card-${index}`,
            first: box(index),
            last: box(99 - index),
          }));
          timed('input', () => ctrl.play(reversed));
        }

        await waitUntil(startedAt, sceneContract.scheduleMs[2]);
        for (const ctrl of controls) {
          const replacements = Array.from({ length: 100 }, (_, index) => ({
            id: `card-${index}`,
            last: index % 5 === 0 ? box((index + 17) % 100) : box(99 - index),
          }));
          timed('interruption', () => ctrl.play(replacements));
        }

        await waitUntil(startedAt, sceneContract.scheduleMs[3]);
        if (!controls.every((ctrl) => ctrl.playing)) {
          throw new Error('collection mid-flight reorder reached a settled predecessor');
        }
        for (const ctrl of controls) {
          const reordered = Array.from({ length: 100 }, (_, index) => ({
            id: `card-${index}`,
            last: box((index * 37) % 100),
          }));
          timed('interruption', () => ctrl.play(reordered));
        }

        await waitUntil(startedAt, sceneContract.scheduleMs[4]);
        for (const ctrl of controls) {
          const restored = Array.from({ length: 100 }, (_, index) => ({ id: `card-${index}`, last: box(index) }));
          timed('interruption', () => ctrl.play(restored));
        }
        await sched.drain();
        for (const ctrl of controls) {
          if (ctrl.playing) throw new Error('collection projection did not settle');
          for (let index = 0; index < 100; index++) {
            const actual = ctrl.boxAt(`card-${index}`);
            const expected = box(index);
            if (
              !actual ||
              actual.x !== expected.x || actual.y !== expected.y ||
              actual.width !== expected.width || actual.height !== expected.height
            ) {
              throw new Error(`collection projection lost terminal geometry for card-${index}`);
            }
          }
        }
      };

      const runSheet = async () => {
        const sched = scheduler();
        const sheets = [];
        for (let instance = 0; instance < unitBatchCalls; instance++) {
          sheets.push(timed('setup', () => behaviors.createBottomSheet({
            snapPoints: [0, 300, 600],
            requestFrame: sched.requestFrame,
          })));
        }
        const startedAt = now();
        for (const sheet of sheets) timed('input', () => sheet.pointerDown({ x: 0, y: 0, t: 0 }));

        const dragY = [80, 180, 300];
        for (let index = 0; index < dragY.length; index++) {
          const scheduledMs = sceneContract.scheduleMs[index + 1];
          await waitUntil(startedAt, scheduledMs);
          const point = { x: 0, y: dragY[index], t: scheduledMs / 1000 };
          for (const sheet of sheets) timed('input', () => sheet.pointerMove(point));
        }
        for (const sheet of sheets) {
          timed('input', () => sheet.pointerUp({ x: 0, y: dragY[2], t: sceneContract.scheduleMs[3] / 1000 }));
        }

        await waitUntil(startedAt, sceneContract.scheduleMs[4]);
        if (!sheets.every((sheet) => sheet.state.phase === 'release')) {
          throw new Error('sheet interruption reached a settled predecessor');
        }
        for (const sheet of sheets) timed('interruption', () => sheet.snapTo(1));

        await waitUntil(startedAt, sceneContract.scheduleMs[5]);
        await sched.drain();
        for (const sheet of sheets) {
          const state = sheet.state;
          if (
            state.phase !== 'settle' || state.value !== 300 || state.snapIndex !== 1 ||
            !Number.isFinite(state.velocity) || state.velocity !== 0
          ) {
            throw new Error('sheet did not reach authored terminal snap 300');
          }
          timed('teardown', () => sheet.destroy());
        }
        if (sched.pending() !== 0) throw new Error('sheet retained pending frame work after teardown');
      };

      const before = now();
      for (let repeat = 0; repeat < serialRepeats; repeat++) {
        if (sceneId === 'collection-reorder-100') await runCollection();
        else if (sceneId === 'direct-manipulation-sheet') await runSheet();
        else throw new Error(`unknown PROFILE-01 scene ${sceneId}`);
      }
      const wallMs = now() - before;
      const ownedMs = Object.values(phase).reduce((sum, value) => sum + value, 0);
      if (!(ownedMs > 0) || !Number.isFinite(ownedMs)) throw new Error(`${sceneId}: invalid owned work ${ownedMs}`);
      return { ownedMs, wallMs, phase };
    };
  }, {
    projectionUrl: `${origin}/dist/projection/index.js`,
    behaviorsUrl: `${origin}/dist/behaviors/index.js`,
    sceneContracts: profile.scenes,
  });
}

async function measureScene(page, sceneId, serialRepeats, unitBatchCalls) {
  const result = await page.evaluate(
    ([id, repeats, calls]) => globalThis.__runProfileSceneAggregate(id, repeats, calls),
    [sceneId, serialRepeats, unitBatchCalls],
  );
  invariant(result && Number.isFinite(result.ownedMs) && result.ownedMs > 0, `${sceneId}: invalid browser measurement`);
  return result;
}

async function acquireScene(page, sceneId, profile) {
  const contract = profile.scenarioSelector;
  const selection = await chooseScenarioSerialRepeats(
    async (serialRepeats) => (await measureScene(page, sceneId, serialRepeats, contract.unitBatchCalls)).ownedMs,
    contract,
  );
  const aaA = [];
  const aaB = [];
  const single = [];
  const doubled = [];
  const phaseBreakdown = [];
  const random = lcg(profile.statistics.orderSeed ^ sceneId.length);
  for (let run = 0; run < profile.statistics.minimumIndependentBlocks; run++) {
    const aaReverse = random() >= 0.5;
    let a;
    let b;
    if (aaReverse) {
      b = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
      a = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
    } else {
      a = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
      b = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
    }
    const controlReverse = random() >= 0.5;
    let one;
    let two;
    if (controlReverse) {
      two = await measureScene(page, sceneId, selection.serialRepeats * 2, contract.unitBatchCalls);
      one = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
    } else {
      one = await measureScene(page, sceneId, selection.serialRepeats, contract.unitBatchCalls);
      two = await measureScene(page, sceneId, selection.serialRepeats * 2, contract.unitBatchCalls);
    }
    aaA.push(cluster(run, a.ownedMs));
    aaB.push(cluster(run, b.ownedMs));
    single.push(cluster(run, one.ownedMs));
    doubled.push(cluster(run, two.ownedMs));
    phaseBreakdown.push({ run, aaA: a.phase, aaB: b.phase, single: one.phase, doubled: two.phase });
  }
  const sceneContract = profile.scenes.find(({ id }) => id === sceneId);
  invariant(sceneContract, `${sceneId}: preregistered scene contract missing`);
  return {
    id: sceneId,
    sceneContractSha256: receiptSha256(sceneContract),
    unitBatchCalls: contract.unitBatchCalls,
    serialRepeats: selection.serialRepeats,
    selector: selectorReceipt(selection, contract),
    raw: { aa: { a: aaA, b: aaB }, deliberate2x: { single, doubled } },
    phaseBreakdown,
  };
}

async function acquireCell(engine, type, inventory, origin, profile) {
  const browser = await type.launch({ headless: true });
  try {
    const expected = inventory.browsers.find((entry) => entry.engine === engine);
    invariant(expected, `${engine}: no inventory binding`);
    invariant(browser.version() === expected.version, `${engine}: inventory/version drift (${expected.version} -> ${browser.version()})`);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    try {
      const page = await context.newPage();
      await installSceneHarness(page, origin, profile);
      const scenes = [];
      for (const sceneId of profile.statistics.m05.requiredSceneIds) {
        scenes.push(await acquireScene(page, sceneId, profile));
      }
      return { id: `desktop-${engine}`, engine, browserVersion: browser.version(), scenes };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function acquirePilot({ baselineRoot, inventory, calibration, harnessRevision, pilotId, generatedAt = new Date().toISOString(), profile = PROFILE_PREREGISTRATION }) {
  validateDesktopInventory(inventory, profile);
  validateCalibrationReceipt(calibration, profile);
  invariant(calibration.inventoryArtifactSha256 === receiptSha256(inventory), 'calibration is not bound to inventory');
  invariant(/^[0-9a-f]{40}$/.test(harnessRevision), 'harness revision must be an exact Git SHA');
  invariant(typeof pilotId === 'string' && pilotId.length > 0, 'pilot identity missing');

  const server = await startDistServer(baselineRoot);
  try {
    const cells = [];
    for (const engine of ['chromium', 'firefox', 'webkit']) {
      cells.push(await acquireCell(engine, ENGINE_TYPES[engine], inventory, server.origin, profile));
    }
    return materializePilotReceipt({
      schemaVersion: 1,
      profileId: profile.profileId,
      baselineRevision: profile.baseline.revision,
      pilotId,
      generatedAt,
      candidateSamples: 0,
      inventoryArtifactSha256: receiptSha256(inventory),
      methodologyBlob: profile.baseline.methodologyBlob,
      harness: {
        kind: 'scenario-null-control-v3',
        harnessRevision,
        baselineRevision: profile.baseline.revision,
        independentUnit: profile.statistics.independentUnit,
        runBlocks: profile.statistics.minimumIndependentBlocks,
        samplesPerCluster: 1,
        orderSeed: profile.statistics.orderSeed,
        aggregateFloorMs: profile.scenarioSelector.formalFloorMs,
        selectorKind: profile.scenarioSelector.kind,
      },
      cells,
    }, profile);
  } finally {
    await server.close();
  }
}

async function main() {
  const baselineRoot = arg('--baseline-root');
  const inventoryPath = arg('--inventory');
  const calibrationPath = arg('--calibration');
  const outputPath = arg('--out');
  const poweredOutputPath = arg('--powered-out');
  const harnessRevision = arg('--harness-revision') ?? process.env.GITHUB_SHA;
  const pilotId = arg('--pilot-id') ?? (process.env.GITHUB_RUN_ID ? `r11-profile-pilot-${process.env.GITHUB_RUN_ID}` : undefined);
  invariant(baselineRoot && inventoryPath && calibrationPath && outputPath && harnessRevision && pilotId, 'CLI requires --baseline-root --inventory --calibration --out --harness-revision --pilot-id');
  const [inventory, calibration] = await Promise.all([
    readFile(inventoryPath, 'utf8').then(JSON.parse),
    readFile(calibrationPath, 'utf8').then(JSON.parse),
  ]);
  const pilot = await acquirePilot({ baselineRoot, inventory, calibration, harnessRevision, pilotId });
  // Сначала сохраняем exact raw-backed receipt: красный admission не имеет права
  // уничтожить единственный результат эксперимента и провоцировать repeat-to-green.
  await writeFile(outputPath, `${JSON.stringify(pilot, null, 2)}\
`, 'utf8');
  validatePilotReceipt(pilot);
  const design = derivePoweredDesign(pilot, inventory, calibration);
  validatePoweredDesignReceipt(design);
  if (poweredOutputPath) await writeFile(poweredOutputPath, `${JSON.stringify(design, null, 2)}\
`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    pilotId: pilot.pilotId,
    pilotArtifactSha256: receiptSha256(pilot),
    source: basename(outputPath),
    cells: design.cells.map(({ id, chosenIndependentBlocks, estimatedPower, status }) => ({ id, chosenIndependentBlocks, estimatedPower, status })),
  })}\
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
