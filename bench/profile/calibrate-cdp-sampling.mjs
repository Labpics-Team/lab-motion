import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pairedClusterBootstrap } from '../compare/methodology.mjs';
import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

const SCENE_IDS = Object.freeze([
  'collection-reorder-100',
  'direct-manipulation-sheet',
]);

export const CDP_SAMPLING_CALIBRATION = Object.freeze({
  schemaVersion: 1,
  family: 'chromium-cdp-script-sampling-v1',
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  engine: 'chromium',
  samplingIntervalUs: 100,
  sceneIds: SCENE_IDS,
  scriptUrlSuffixes: Object.freeze({
    'collection-reorder-100': Object.freeze(['/dist/projection/index.js']),
    'direct-manipulation-sheet': Object.freeze(['/dist/behaviors/index.js']),
  }),
  resolution: Object.freeze({
    minimumAttributableUs: PROFILE_PREREGISTRATION.calibration.timingFloorMs * 1000,
    minimumAttributableSamples: 200,
    maximumUnattributedShare: 0.5,
    discoveryProbeCount: 2,
    minimumSceneRepeats: 1,
    maximumSceneRepeats: 4096,
    selectionRule: 'smallest power-of-two complete-scene repeat count whose every discovery probe clears all frozen resolution gates',
    failureRule: 'fail closed at maximumSceneRepeats; do not lower a gate or continue to formal controls',
  }),
  controls: Object.freeze({
    independentBlocks: PROFILE_PREREGISTRATION.statistics.minimumIndependentBlocks,
    aaBand: PROFILE_PREREGISTRATION.calibration.aaNonInferiorityBand,
    deliberateMultiplier: PROFILE_PREREGISTRATION.calibration.deliberateWorkMultiplier,
    deliberateLower95Min: PROFILE_PREREGISTRATION.calibration.deliberateWorkDetectedLower95Min,
    orderRule: 'alternate arm order by run-block parity',
    retryRule: PROFILE_PREREGISTRATION.calibration.sameExperimentRetryPolicy,
  }),
  candidateSamples: 0,
});

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 CDP calibration: ${message}`);
}

function cluster(run, value) {
  return { run, samples: [value], semantic: true };
}

export function validateCdpSamplingContract(contract = CDP_SAMPLING_CALIBRATION) {
  invariant(contract?.schemaVersion === 1, 'schemaVersion drifted');
  invariant(contract.family === 'chromium-cdp-script-sampling-v1', 'family drifted');
  invariant(contract.profileId === PROFILE_PREREGISTRATION.profileId, 'profile identity drifted');
  invariant(contract.baselineRevision === PROFILE_PREREGISTRATION.baseline.revision, 'baseline drifted');
  invariant(contract.engine === 'chromium', 'engine drifted');
  invariant(contract.samplingIntervalUs === 100, 'sampling interval drifted');
  invariant(JSON.stringify(contract.sceneIds) === JSON.stringify(SCENE_IDS), 'scene set drifted');
  invariant(JSON.stringify(contract.scriptUrlSuffixes?.['collection-reorder-100']) === JSON.stringify(['/dist/projection/index.js']), 'collection attribution owner drifted');
  invariant(JSON.stringify(contract.scriptUrlSuffixes?.['direct-manipulation-sheet']) === JSON.stringify(['/dist/behaviors/index.js']), 'sheet attribution owner drifted');

  const resolution = contract.resolution;
  invariant(resolution?.minimumAttributableUs === 40_000, 'attributable time floor drifted');
  invariant(resolution.minimumAttributableSamples === 200, 'sample floor drifted');
  invariant(resolution.maximumUnattributedShare === 0.5, 'unattributed-share gate drifted');
  invariant(resolution.discoveryProbeCount === 2, 'probe count drifted');
  invariant(resolution.minimumSceneRepeats === 1 && resolution.maximumSceneRepeats === 4096, 'repeat bound drifted');
  invariant((resolution.maximumSceneRepeats & (resolution.maximumSceneRepeats - 1)) === 0, 'repeat bound must stay a power of two');
  invariant(/smallest power-of-two complete-scene/.test(resolution.selectionRule), 'selection rule drifted');
  invariant(/fail closed/.test(resolution.failureRule), 'resolution failure no longer fails closed');

  const controls = contract.controls;
  invariant(controls?.independentBlocks === 20, 'independent block count drifted');
  invariant(JSON.stringify(controls.aaBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(controls.deliberateMultiplier === 2, 'positive-control multiplier drifted');
  invariant(controls.deliberateLower95Min === 1.5, 'positive-control lower bound drifted');
  invariant(controls.orderRule === 'alternate arm order by run-block parity', 'arm order drifted');
  invariant(/new calibration identity/.test(controls.retryRule), 'repeat-to-green fence drifted');
  invariant(contract.candidateSamples === 0, 'candidate samples contaminated calibration contract');
  return contract;
}

export function summarizeCpuProfile(profile, urlSuffixes) {
  invariant(Array.isArray(urlSuffixes) && urlSuffixes.length > 0, 'attribution URL set is empty');
  const samples = profile?.samples ?? [];
  const deltas = profile?.timeDeltas ?? [];
  const nodes = profile?.nodes ?? [];
  invariant(Array.isArray(samples) && Array.isArray(deltas) && samples.length > 0, 'profiler returned no samples');
  invariant(samples.length === deltas.length, 'profiler sample/delta cardinality mismatch');
  invariant(Array.isArray(nodes) && nodes.length > 0, 'profiler returned no nodes');

  const byId = new Map(nodes.map((node) => [node.id, node]));
  let totalUs = 0;
  let attributableUs = 0;
  let attributableSamples = 0;
  const observedUrls = new Set();
  for (let index = 0; index < samples.length; index += 1) {
    const delta = deltas[index] ?? 0;
    invariant(Number.isFinite(delta) && delta >= 0, 'profiler returned invalid time delta');
    totalUs += delta;
    const url = byId.get(samples[index])?.callFrame?.url ?? '';
    if (url.length > 0) observedUrls.add(url);
    if (urlSuffixes.some((suffix) => url.endsWith(suffix))) {
      attributableSamples += 1;
      attributableUs += delta;
    }
  }
  invariant(totalUs > 0, 'profiler returned zero total time');
  const unattributedShare = Math.max(0, Math.min(1, 1 - attributableUs / totalUs));
  return {
    totalUs,
    attributableUs,
    attributableSamples,
    unattributedUs: totalUs - attributableUs,
    unattributedShare,
    observedUrls: [...observedUrls].sort(),
  };
}

export function resolutionPass(summary, contract = CDP_SAMPLING_CALIBRATION) {
  const gate = contract.resolution;
  return Number.isFinite(summary?.attributableUs)
    && summary.attributableUs >= gate.minimumAttributableUs
    && Number.isSafeInteger(summary.attributableSamples)
    && summary.attributableSamples >= gate.minimumAttributableSamples
    && Number.isFinite(summary.unattributedShare)
    && summary.unattributedShare <= gate.maximumUnattributedShare;
}

export async function chooseSceneRepeats(measure, contract = CDP_SAMPLING_CALIBRATION) {
  validateCdpSamplingContract(contract);
  const { minimumSceneRepeats, maximumSceneRepeats, discoveryProbeCount } = contract.resolution;
  const probes = [];
  for (let repeats = minimumSceneRepeats; repeats <= maximumSceneRepeats; repeats *= 2) {
    const attempts = [];
    for (let probe = 0; probe < discoveryProbeCount; probe += 1) {
      const summary = await measure(repeats);
      attempts.push(summary);
    }
    probes.push({ repeats, attempts });
    if (attempts.every((summary) => resolutionPass(summary, contract))) {
      return { selectedRepeats: repeats, probes, status: 'PASS' };
    }
    if (repeats > Math.floor(maximumSceneRepeats / 2)) break;
  }
  return { selectedRepeats: null, probes, status: 'FAIL' };
}

function interval(left, right, seed) {
  const result = pairedClusterBootstrap(left, right, {
    seed,
    iterations: PROFILE_PREREGISTRATION.statistics.bootstrapIterations,
  });
  return {
    ratio: result.p50.ratio,
    lower95: result.p50.low,
    upper95: result.p50.high,
  };
}

export function evaluateFormalControls(raw, contract = CDP_SAMPLING_CALIBRATION) {
  validateCdpSamplingContract(contract);
  const [aaLow, aaHigh] = contract.controls.aaBand;
  const aaInterval = interval(raw.aa.a, raw.aa.b, PROFILE_PREREGISTRATION.statistics.bootstrapSeed);
  const deliberateInterval = interval(
    raw.deliberate2x.doubled,
    raw.deliberate2x.single,
    PROFILE_PREREGISTRATION.statistics.bootstrapSeed ^ 0x2a2a2a,
  );
  const allSummaries = [
    ...raw.aa.aSummaries,
    ...raw.aa.bSummaries,
    ...raw.deliberate2x.singleSummaries,
    ...raw.deliberate2x.doubledSummaries,
  ];
  const resolved = allSummaries.every((summary) => resolutionPass(summary, contract));
  const aaPass = aaInterval.lower95 >= aaLow && aaInterval.upper95 <= aaHigh;
  const deliberatePass = deliberateInterval.lower95 >= contract.controls.deliberateLower95Min;
  return {
    status: resolved && aaPass && deliberatePass ? 'PASS' : 'FAIL',
    resolved,
    aaPass,
    deliberatePass,
    aa: aaInterval,
    deliberate2x: deliberateInterval,
  };
}

async function installSceneRunners(page) {
  await page.evaluate(async () => {
    const { createProjection } = await import('/dist/projection/index.js');
    const { createBottomSheet } = await import('/dist/behaviors/index.js');

    const makeClock = () => {
      let queue = [];
      let now = 0;
      const requestFrame = (callback) => {
        queue.push(callback);
        return queue.length;
      };
      const step = () => {
        const current = queue;
        queue = [];
        now += 1000 / 60;
        for (const callback of current) callback(now);
      };
      const pump = (count) => {
        for (let index = 0; index < count && queue.length > 0; index += 1) step();
      };
      const drain = () => {
        let frames = 0;
        while (queue.length > 0 && frames < 600) {
          step();
          frames += 1;
        }
        if (queue.length > 0) throw new Error('PROFILE-01 collection/sheet runner exceeded 600 frames');
        return frames;
      };
      return { requestFrame, pump, drain };
    };

    const rectAt = (index) => ({
      x: (index % 10) * 32,
      y: Math.floor(index / 10) * 32,
      width: 28,
      height: 28,
    });

    const collectionOnce = () => {
      const clock = makeClock();
      let sink = 0;
      const controls = createProjection({
        requestFrame: clock.requestFrame,
        onFrame: (frames) => {
          for (let index = 0; index < frames.length; index += 11) {
            const frame = frames[index];
            sink += frame.tx + frame.ty + frame.sx + frame.sy;
          }
        },
      });
      const canonical = Array.from({ length: 100 }, (_, index) => `card-${index}`);
      let order = canonical.slice();
      const nodes = (next, includeFirst) => {
        const currentIndex = new Map(order.map((key, index) => [key, index]));
        return next.map((id, index) => ({
          id,
          ...(includeFirst ? { first: rectAt(currentIndex.get(id)) } : {}),
          last: rectAt(index),
        }));
      };

      const reversed = canonical.slice().reverse();
      controls.play(nodes(reversed, true));
      clock.pump(4);
      order = reversed;

      // Та же stable identity, но новые snapshot-объекты моделируют remove/insert
      // DOM-узлов приложения без смены ключа и без включения mutation cost в owner.
      const replacedStableIdentity = order.slice();
      controls.play(nodes(replacedStableIdentity, false));
      clock.pump(4);
      order = replacedStableIdentity;

      const midFlight = order.slice(17).concat(order.slice(0, 17));
      controls.play(nodes(midFlight, false));
      clock.pump(4);
      order = midFlight;

      controls.play(nodes(canonical, false));
      order = canonical;
      sink += clock.drain();
      sink += controls.progress + controls.velocity;
      controls.cancel();
      return sink;
    };

    const sheetOnce = () => {
      const clock = makeClock();
      const sheet = createBottomSheet({
        snapPoints: [0, 300, 600],
        requestFrame: clock.requestFrame,
      });
      sheet.pointerDown({ x: 0, y: 0, t: 0 });
      sheet.pointerMove({ x: 0, y: 120, t: 0.016 });
      sheet.pointerMove({ x: 0, y: 260, t: 0.032 });
      sheet.pointerMove({ x: 0, y: 420, t: 0.048 });
      sheet.pointerUp({ x: 0, y: 420, t: 0.064 });
      clock.pump(4);

      const pickup = sheet.state.value;
      sheet.pointerDown({ x: 0, y: pickup, t: 0.080 });
      sheet.pointerMove({ x: 0, y: pickup - 90, t: 0.096 });
      sheet.pointerMove({ x: 0, y: pickup - 190, t: 0.112 });
      sheet.pointerUp({ x: 0, y: pickup - 190, t: 0.128 });
      const frames = clock.drain();
      const sink = sheet.state.value + sheet.state.velocity + frames;
      sheet.destroy();
      return sink;
    };

    globalThis.__labMotionProfileScenes = {
      run(sceneId, repeats) {
        let sink = 0;
        for (let index = 0; index < repeats; index += 1) {
          if (sceneId === 'collection-reorder-100') sink += collectionOnce();
          else if (sceneId === 'direct-manipulation-sheet') sink += sheetOnce();
          else throw new Error(`unknown PROFILE-01 scene: ${sceneId}`);
        }
        globalThis.__labMotionProfileSink = sink;
        return sink;
      },
    };
  });
}

async function profileScene(page, sceneId, repeats, contract = CDP_SAMPLING_CALIBRATION) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: contract.samplingIntervalUs });
    await session.send('Profiler.start');
    const sink = await page.evaluate(
      ({ id, count }) => globalThis.__labMotionProfileScenes.run(id, count),
      { id: sceneId, count: repeats },
    );
    const { profile } = await session.send('Profiler.stop');
    const summary = summarizeCpuProfile(profile, contract.scriptUrlSuffixes[sceneId]);
    return { ...summary, sink };
  } finally {
    try { await session.send('Profiler.disable'); } catch {}
    await session.detach();
  }
}

async function acquireScene(page, sceneId, contract = CDP_SAMPLING_CALIBRATION) {
  const selection = await chooseSceneRepeats(
    (repeats) => profileScene(page, sceneId, repeats, contract),
    contract,
  );
  if (selection.selectedRepeats === null) {
    return { sceneId, selection, formal: null, status: 'FAIL', failure: 'resolution-selection-failed' };
  }

  const repeats = selection.selectedRepeats;
  const raw = {
    aa: { a: [], b: [], aSummaries: [], bSummaries: [] },
    deliberate2x: { single: [], doubled: [], singleSummaries: [], doubledSummaries: [] },
  };
  for (let run = 0; run < contract.controls.independentBlocks; run += 1) {
    const aaFirst = run % 2 === 0 ? 'a' : 'b';
    const aaSecond = aaFirst === 'a' ? 'b' : 'a';
    for (const arm of [aaFirst, aaSecond]) {
      const summary = await profileScene(page, sceneId, repeats, contract);
      raw.aa[`${arm}Summaries`].push(summary);
      raw.aa[arm].push(cluster(run, summary.attributableUs / 1000));
    }

    const deliberateFirst = run % 2 === 0 ? 'single' : 'doubled';
    const deliberateSecond = deliberateFirst === 'single' ? 'doubled' : 'single';
    for (const arm of [deliberateFirst, deliberateSecond]) {
      const count = arm === 'single' ? repeats : repeats * contract.controls.deliberateMultiplier;
      const summary = await profileScene(page, sceneId, count, contract);
      raw.deliberate2x[`${arm}Summaries`].push(summary);
      raw.deliberate2x[arm].push(cluster(run, summary.attributableUs / 1000));
    }
  }

  const formal = evaluateFormalControls(raw, contract);
  return {
    sceneId,
    selection,
    formal,
    raw,
    status: formal.status,
    failure: formal.status === 'PASS' ? null : 'formal-control-failed',
  };
}

function playwrightRuntime() {
  const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
  return {
    playwright: compareRequire('playwright'),
    version: compareRequire('playwright/package.json').version,
  };
}

export async function acquireCdpSamplingCalibration(options = {}) {
  const contract = validateCdpSamplingContract(options.contract ?? CDP_SAMPLING_CALIBRATION);
  const baseUrl = options.baseUrl ?? process.env.PROFILE_CDP_BASE_URL;
  invariant(typeof baseUrl === 'string' && /^https?:\/\//.test(baseUrl), 'PROFILE_CDP_BASE_URL is required');
  const output = options.output ?? process.env.PROFILE_CDP_OUTPUT ?? 'bench/profile/out/cdp-sampling-calibration.json';
  const { playwright, version: playwrightVersion } = playwrightRuntime();
  const browser = await playwright.chromium.launch({ headless: true });
  let browserVersion = null;
  let sceneResults = [];
  let failure = null;
  try {
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await page.goto(`${baseUrl.replace(/\/$/, '')}/site/dist/index.html`, { waitUntil: 'load' });
    await installSceneRunners(page);
    for (const sceneId of contract.sceneIds) {
      try {
        const result = await acquireScene(page, sceneId, contract);
        sceneResults.push(result);
        if (result.status !== 'PASS') {
          failure = `${sceneId}: ${result.failure}`;
          break;
        }
      } catch (error) {
        failure = `${sceneId}: ${error instanceof Error ? error.message : String(error)}`;
        sceneResults.push({ sceneId, status: 'FAIL', failure, selection: null, formal: null });
        break;
      }
    }
  } finally {
    await browser.close();
  }

  const allPassed = failure === null
    && sceneResults.length === contract.sceneIds.length
    && sceneResults.every((result) => result.status === 'PASS');
  const receipt = {
    schemaVersion: 1,
    kind: 'PROFILE-01-cdp-sampling-calibration',
    profileId: contract.profileId,
    baselineRevision: contract.baselineRevision,
    family: contract.family,
    sourceRevision: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      playwright: playwrightVersion,
      browser: browserVersion,
      baseUrl,
    },
    contract,
    candidateSamples: 0,
    scenes: sceneResults,
    status: allPassed ? 'PASS' : 'FAIL',
    failure,
  };
  await mkdir(new URL('./out/', import.meta.url), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (!allPassed) throw new Error(`PROFILE-01 CDP calibration failed: ${failure ?? 'incomplete scene set'}`);
  return receipt;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  acquireCdpSamplingCalibration().then((receipt) => {
    console.log(JSON.stringify({
      status: receipt.status,
      sourceRevision: receipt.sourceRevision,
      scenes: receipt.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        repeats: scene.selection.selectedRepeats,
        aa: scene.formal.aa,
        deliberate2x: scene.formal.deliberate2x,
      })),
    }));
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
