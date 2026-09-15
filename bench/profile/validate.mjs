import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_CONTROLS = Object.freeze([
  'absence-empty-raf',
  'native-waapi-equivalent-transform',
  'equal-linear-tween',
  'identical-serialized-plan-executor',
  'lab-motion-no-compiler',
  'aa-null',
  'deliberate-2x-work',
]);
const REQUIRED_CELLS = Object.freeze([
  'desktop-chromium',
  'desktop-firefox',
  'desktop-webkit',
  'android-60',
  'android-120',
  'ios-60',
  'ios-120',
]);
const REQUIRED_COSTS = Object.freeze({
  nano: 1024,
  compilerRuntime: 341,
  compilerSurface: 1024,
  fullAnimateConsumer: 15600,
  animateCompositorMixed: 17500,
});

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01: ${message}`);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function uniqueStrings(values, label) {
  invariant(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  invariant(values.every((value) => typeof value === 'string' && value.length > 0), `${label} contains a non-string`);
  invariant(new Set(values).size === values.length, `${label} contains duplicates`);
}

export function validatePreregistration(profile = PROFILE_PREREGISTRATION) {
  invariant(profile?.schemaVersion === 1, 'unsupported schemaVersion');
  invariant(profile.profileId === 'r11-profile-20260915-v1', 'unexpected profile identity');
  invariant(profile.node === 'PROFILE-01', 'wrong node');
  invariant(profile.registeredAt === '2026-09-15', 'registration date drifted');
  invariant(profile.candidateSamplesObservedAtRegistration === false, 'candidate data contaminated preregistration');
  invariant(profile.candidateAcquisitionGate === 'bound cell + powered design + PASS calibration receipt', 'candidate gate drifted');

  const baseline = profile.baseline;
  invariant(baseline?.repository === 'Labpics-Team/lab-motion', 'wrong repository');
  invariant(SHA40.test(baseline.revision), 'baseline revision must be exact SHA');
  invariant(baseline.revision === 'fe11daa407de396fad952be7679650f63dabd4dd', 'baseline revision drifted');
  invariant(baseline.packageVersion === '0.3.0', 'package version drifted');
  invariant(baseline.packageManager === 'pnpm@11.11.0', 'package manager is not frozen');
  invariant(baseline.nodeRange === '>=22', 'Node range drifted');
  for (const key of ['compareManifestBlob', 'compareLockBlob', 'methodologyBlob', 'benchmarkRunnerBlob']) {
    invariant(SHA40.test(baseline[key]), `${key} must be an exact blob SHA`);
  }
  invariant(exactKeys(baseline.competitors, ['motion', 'gsap', 'animejs', 'playwright', 'esbuild']), 'competitor set drifted');
  invariant(baseline.competitors.motion === '12.42.2', 'Motion version drifted');
  invariant(baseline.competitors.gsap === '3.15.0', 'GSAP version drifted');
  invariant(baseline.competitors.animejs === '4.5.0', 'Anime.js version drifted');
  invariant(baseline.competitors.playwright === '1.61.1', 'Playwright version drifted');
  invariant(baseline.competitors.esbuild === '0.27.4', 'esbuild version drifted');

  invariant(profile.oldCostVector?.kind === 'hard-ceilings-not-current-measurements', 'old cost vector must distinguish ceilings from observations');
  invariant(exactKeys(profile.oldCostVector.gzipBytes, Object.keys(REQUIRED_COSTS)), 'old cost vector keys drifted');
  for (const [key, expected] of Object.entries(REQUIRED_COSTS)) {
    invariant(profile.oldCostVector.gzipBytes[key] === expected, `${key} ceiling drifted`);
  }

  invariant(Array.isArray(profile.scenes) && profile.scenes.length === 2, 'exactly two heavy scenes are required');
  const sceneIds = profile.scenes.map(({ id }) => id);
  uniqueStrings(sceneIds, 'scene ids');
  invariant(new Set(profile.scenes.map(({ family }) => family)).size === 2, 'heavy scenes must come from different families');
  invariant(sceneIds.includes('collection-reorder-100') && sceneIds.includes('direct-manipulation-sheet'), 'registered heavy scenes drifted');
  for (const scene of profile.scenes) {
    invariant(Number.isInteger(scene.viewport?.width) && scene.viewport.width > 0, `${scene.id}: invalid viewport width`);
    invariant(Number.isInteger(scene.viewport?.height) && scene.viewport.height > 0, `${scene.id}: invalid viewport height`);
    invariant(Number.isFinite(scene.dpr) && scene.dpr > 0, `${scene.id}: invalid DPR`);
    invariant(Array.isArray(scene.scheduleMs) && scene.scheduleMs.length >= 4, `${scene.id}: schedule is underspecified`);
    invariant(scene.scheduleMs.every((value, index, all) => Number.isFinite(value) && value >= 0 && (index === 0 || value > all[index - 1])), `${scene.id}: schedule must be finite and strictly increasing`);
    uniqueStrings(scene.operations, `${scene.id} operations`);
    uniqueStrings(scene.requiredOutcomes, `${scene.id} outcomes`);
    invariant(typeof scene.dominantRemovableCost === 'string' && scene.dominantRemovableCost.length > 0, `${scene.id}: dominant removable cost is missing`);
  }

  invariant(JSON.stringify(profile.controls) === JSON.stringify(REQUIRED_CONTROLS), 'raw/control matrix drifted');
  invariant(Array.isArray(profile.roster) && profile.roster.length === REQUIRED_CELLS.length, 'roster cardinality drifted');
  invariant(JSON.stringify(profile.roster.map(({ id }) => id)) === JSON.stringify(REQUIRED_CELLS), 'roster identity/order drifted');
  for (const cell of profile.roster) {
    invariant(cell.candidateEligible === false, `${cell.id}: preregistration cannot pre-authorize candidate acquisition`);
    invariant(cell.refreshHz === 60 || cell.refreshHz === 120, `${cell.id}: unsupported refresh target`);
    if (cell.class === 'physical-mobile') {
      invariant(cell.availability === 'unavailable', `${cell.id}: mobile availability requires an explicit physical binding receipt`);
      invariant(cell.binding === null, `${cell.id}: unavailable mobile cell must not have a synthetic binding`);
      invariant(Array.isArray(cell.affectedMetrics) && cell.affectedMetrics.includes('M-04') && cell.affectedMetrics.includes('M-05'), `${cell.id}: missing hardware must expose affected metrics`);
      invariant(!/throttle|emulat/i.test(String(cell.reason)), `${cell.id}: desktop throttle/emulation cannot stand in for hardware`);
    } else {
      invariant(cell.class === 'desktop-browser', `${cell.id}: unknown cell class`);
      invariant(['chromium', 'firefox', 'webkit'].includes(cell.engine), `${cell.id}: unknown desktop engine`);
      invariant(cell.availability === 'bind-from-inventory-receipt', `${cell.id}: desktop version must come from an inventory receipt`);
    }
  }

  const stats = profile.statistics;
  invariant(stats?.independentUnit === 'run-block', 'independent sampling unit drifted');
  invariant(stats.neverTreatAsIndependent.includes('frame') && stats.neverTreatAsIndependent.includes('channel'), 'dependent frames/channels must not become participant count');
  invariant(stats.confidenceLevel === 0.95 && stats.familyAlpha === 0.05, 'confidence family drifted');
  invariant(stats.multiplicity === 'Holm', 'multiplicity correction drifted');
  invariant(stats.bootstrapIterations === 10000 && stats.bootstrapKind === 'paired-cluster', 'bootstrap law drifted');
  invariant(stats.practicalRelativeThreshold === 0.05, 'practical threshold drifted');
  invariant(stats.targetPower === 0.8, 'target power drifted');
  invariant(Number.isSafeInteger(stats.orderSeed) && Number.isSafeInteger(stats.bootstrapSeed), 'seeds must be fixed integers');
  invariant(stats.minimumIndependentBlocks >= 20 && stats.maximumIndependentBlocks >= stats.minimumIndependentBlocks, 'block bounds are invalid');
  invariant(/null\/control pilot/.test(stats.sampleCountRule) && />= 0\.80/.test(stats.sampleCountRule), 'MDE/power sample-count rule is not preregistered');
  invariant(/no optional stopping/.test(stats.stoppingRule), 'stopping rule is not fail closed');
  invariant(stats.m04.scalarChannels === 100 && stats.m04.ownCpuP99MsPerFrameMax === 0.5, 'M-04 CPU threshold drifted');
  invariant(stats.m04.fullScenario120HzMissedFrameUpper95Max === 0.001, 'M-04 missed-frame threshold drifted');
  invariant(stats.m05.candidateToBestComparatorUpper95Max === 0.5, 'M-05 superiority threshold drifted');
  invariant(JSON.stringify(stats.m05.requiredSceneIds) === JSON.stringify(['collection-reorder-100', 'direct-manipulation-sheet']), 'M-05 scene set drifted');

  invariant(profile.calibration?.requiredBeforeCandidate === true, 'calibration must precede candidate data');
  invariant(JSON.stringify(profile.calibration.aaNonInferiorityBand) === JSON.stringify([0.95, 1.05]), 'A/A non-inferiority band drifted');
  invariant(profile.calibration.deliberateWorkMultiplier === 2, 'positive-control work multiplier drifted');
  invariant(profile.calibration.deliberateWorkDetectedLower95Min === 1.5, 'positive-control detection threshold drifted');
  invariant(/new calibration identity/.test(profile.calibration.sameExperimentRetryPolicy), 'invalid calibration must not be repeated-to-green');

  invariant(profile.observationPolicy?.keepEverySample === true, 'all samples must be preserved');
  invariant(profile.observationPolicy.keepFailures === true && profile.observationPolicy.keepStalls === true, 'failures/stalls must be preserved');
  invariant(profile.observationPolicy.keepMalformedReceipts === true, 'malformed receipts must remain observable');
  invariant(profile.observationPolicy.forcedGcDuringTiming === false, 'forced GC during timing is forbidden');
  invariant(profile.observationPolicy.traceRequiredForClaims.includes('cpu') && profile.observationPolicy.traceRequiredForClaims.includes('paint') && profile.observationPolicy.traceRequiredForClaims.includes('compositor'), 'trace-required claim classes drifted');
  invariant(profile.observationPolicy.separateDenominators.length >= 10, 'denominators were collapsed');
  return profile;
}

export function validateDesktopInventory(receipt, profile = PROFILE_PREREGISTRATION) {
  validatePreregistration(profile);
  invariant(receipt?.schemaVersion === 1, 'desktop inventory schema mismatch');
  invariant(receipt.profileId === profile.profileId, 'desktop inventory belongs to another profile');
  invariant(receipt.baselineRevision === profile.baseline.revision, 'desktop inventory belongs to another baseline');
  invariant(typeof receipt.generatedAt === 'string' && !Number.isNaN(Date.parse(receipt.generatedAt)), 'desktop inventory timestamp is invalid');
  invariant(typeof receipt.host?.platform === 'string' && receipt.host.platform.length > 0, 'host platform is missing');
  invariant(typeof receipt.host?.release === 'string' && receipt.host.release.length > 0, 'host release is missing');
  invariant(typeof receipt.host?.arch === 'string' && receipt.host.arch.length > 0, 'host arch is missing');
  invariant(typeof receipt.host?.node === 'string' && receipt.host.node.length > 0, 'Node version is missing');
  invariant(Array.isArray(receipt.browsers) && receipt.browsers.length === 3, 'desktop receipt must bind exactly three engines');
  invariant(JSON.stringify(receipt.browsers.map(({ engine }) => engine)) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'desktop engine order/set drifted');
  for (const browser of receipt.browsers) {
    invariant(typeof browser.version === 'string' && browser.version.length > 0, `${browser.engine}: browser version is missing`);
    invariant(SHA256.test(browser.executableSha256), `${browser.engine}: executable SHA-256 is missing`);
    invariant(typeof browser.userAgent === 'string' && browser.userAgent.length > 0, `${browser.engine}: user agent is missing`);
    invariant(browser.refreshTargetHz === 60, `${browser.engine}: desktop receipt changed preregistered refresh target`);
  }
  invariant(receipt.mobileBindings === undefined, 'desktop inventory must not fabricate mobile bindings');
  return receipt;
}

export function validateCalibrationReceipt(receipt, profile = PROFILE_PREREGISTRATION) {
  validatePreregistration(profile);
  invariant(receipt?.schemaVersion === 1, 'calibration schema mismatch');
  invariant(receipt.profileId === profile.profileId, 'calibration belongs to another profile');
  invariant(receipt.baselineRevision === profile.baseline.revision, 'calibration belongs to another baseline');
  invariant(typeof receipt.calibrationId === 'string' && receipt.calibrationId.length > 0, 'calibration identity is missing');
  invariant(receipt.attempt === 1, 'same calibration identity may not be repeated-to-green');
  invariant(Array.isArray(receipt.raw?.aa) && receipt.raw.aa.length > 0, 'A/A raw clusters are missing');
  invariant(Array.isArray(receipt.raw?.deliberate2x) && receipt.raw.deliberate2x.length > 0, 'positive-control raw clusters are missing');
  const [aaLow, aaHigh] = profile.calibration.aaNonInferiorityBand;
  invariant(Number.isFinite(receipt.aa?.lower95) && Number.isFinite(receipt.aa?.upper95), 'A/A interval is missing');
  invariant(receipt.aa.lower95 >= aaLow && receipt.aa.upper95 <= aaHigh, 'A/A calibration escaped the non-inferiority band');
  invariant(receipt.deliberate2x?.workMultiplier === 2, 'positive control is not deliberate 2x work');
  invariant(Number.isFinite(receipt.deliberate2x.lower95) && receipt.deliberate2x.lower95 >= profile.calibration.deliberateWorkDetectedLower95Min, 'positive control did not resolve deliberate extra work');
  invariant(receipt.candidateSamples === 0, 'candidate samples appeared before calibration admission');
  return receipt;
}

export function eligibleDesktopCells(inventory, calibration, profile = PROFILE_PREREGISTRATION) {
  validateDesktopInventory(inventory, profile);
  validateCalibrationReceipt(calibration, profile);
  return profile.roster
    .filter(({ class: cellClass }) => cellClass === 'desktop-browser')
    .map(({ id }) => id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validatePreregistration();
  process.stdout.write(`${JSON.stringify({ profileId: PROFILE_PREREGISTRATION.profileId, status: 'VALID' })}\n`);
}
