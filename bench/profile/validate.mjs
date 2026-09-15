import { PROFILE_PREREGISTRATION } from './preregistration.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_CONTROLS = [
  'absence-empty-raf',
  'native-waapi-equivalent-transform',
  'equal-linear-tween',
  'identical-serialized-plan-executor',
  'lab-motion-no-compiler',
  'aa-null',
  'deliberate-2x-work',
];
const REQUIRED_CELLS = [
  'desktop-chromium', 'desktop-firefox', 'desktop-webkit',
  'android-60', 'android-120', 'ios-60', 'ios-120',
];
const REQUIRED_COMPETITORS = Object.freeze({
  motion: '12.42.2',
  gsap: '3.15.0',
  animejs: '4.5.0',
  playwright: '1.61.1',
  esbuild: '0.28.1',
  pngjs: '7.0.0',
});
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

function exactObject(value, expected, label) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(Object.keys(expected).sort()), `${label} keys drifted`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    invariant(value[key] === expectedValue, `${label}.${key} drifted`);
  }
}

function uniqueStrings(values, label) {
  invariant(Array.isArray(values) && values.length > 0, `${label} must be non-empty`);
  invariant(values.every((value) => typeof value === 'string' && value.length > 0), `${label} contains invalid value`);
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
  invariant(baseline.packageManager === 'pnpm@11.11.0', 'package manager drifted');
  invariant(baseline.nodeRange === '>=22', 'Node range drifted');
  for (const key of ['compareManifestBlob', 'compareLockBlob', 'methodologyBlob', 'benchmarkRunnerBlob']) {
    invariant(SHA40.test(baseline[key]), `${key} must be exact blob SHA`);
  }
  exactObject(baseline.competitors, REQUIRED_COMPETITORS, 'competitors');

  invariant(profile.oldCostVector?.kind === 'hard-ceilings-not-current-measurements', 'old costs must remain ceilings, not observations');
  exactObject(profile.oldCostVector.gzipBytes, REQUIRED_COSTS, 'oldCostVector.gzipBytes');

  invariant(Array.isArray(profile.scenes) && profile.scenes.length === 2, 'exactly two heavy scenes are required');
  const sceneIds = profile.scenes.map(({ id }) => id);
  uniqueStrings(sceneIds, 'scene ids');
  invariant(new Set(profile.scenes.map(({ family }) => family)).size === 2, 'heavy scenes must use different families');
  invariant(JSON.stringify(sceneIds) === JSON.stringify(['collection-reorder-100', 'direct-manipulation-sheet']), 'heavy scene set drifted');
  for (const scene of profile.scenes) {
    invariant(Number.isInteger(scene.viewport?.width) && scene.viewport.width > 0, `${scene.id}: invalid viewport width`);
    invariant(Number.isInteger(scene.viewport?.height) && scene.viewport.height > 0, `${scene.id}: invalid viewport height`);
    invariant(Number.isFinite(scene.dpr) && scene.dpr > 0, `${scene.id}: invalid DPR`);
    invariant(Array.isArray(scene.scheduleMs) && scene.scheduleMs.length >= 4, `${scene.id}: schedule underspecified`);
    invariant(scene.scheduleMs.every((value, index, all) => Number.isFinite(value) && value >= 0 && (index === 0 || value > all[index - 1])), `${scene.id}: schedule must be strictly increasing`);
    uniqueStrings(scene.operations, `${scene.id} operations`);
    uniqueStrings(scene.requiredOutcomes, `${scene.id} outcomes`);
    invariant(typeof scene.dominantRemovableCost === 'string' && scene.dominantRemovableCost.length > 0, `${scene.id}: removable cost missing`);
  }

  invariant(JSON.stringify(profile.controls) === JSON.stringify(REQUIRED_CONTROLS), 'control matrix drifted');
  invariant(Array.isArray(profile.roster) && JSON.stringify(profile.roster.map(({ id }) => id)) === JSON.stringify(REQUIRED_CELLS), 'roster drifted');
  for (const cell of profile.roster) {
    invariant(cell.candidateEligible === false, `${cell.id}: preregistration cannot pre-authorize candidate data`);
    invariant(cell.refreshHz === 60 || cell.refreshHz === 120, `${cell.id}: refresh target invalid`);
    if (cell.class === 'physical-mobile') {
      invariant(cell.availability === 'unavailable' && cell.binding === null, `${cell.id}: missing mobile cell must stay explicitly unavailable`);
      invariant(cell.affectedMetrics?.includes('M-04') && cell.affectedMetrics?.includes('M-05'), `${cell.id}: affected metrics hidden`);
      invariant(!/throttle|emulat/i.test(String(cell.reason)), `${cell.id}: desktop emulation cannot substitute for hardware`);
    } else {
      invariant(cell.class === 'desktop-browser', `${cell.id}: unknown cell class`);
      invariant(['chromium', 'firefox', 'webkit'].includes(cell.engine), `${cell.id}: unknown engine`);
      invariant(cell.availability === 'bind-from-inventory-receipt', `${cell.id}: exact browser build must come from receipt`);
    }
  }

  const stats = profile.statistics;
  invariant(stats?.independentUnit === 'run-block', 'sampling unit drifted');
  invariant(stats.neverTreatAsIndependent?.includes('frame') && stats.neverTreatAsIndependent?.includes('channel'), 'dependent frames/channels became participant count');
  invariant(stats.confidenceLevel === 0.95 && stats.familyAlpha === 0.05, 'confidence family drifted');
  invariant(stats.multiplicity === 'Holm', 'multiplicity law drifted');
  invariant(stats.bootstrapIterations === 10000 && stats.bootstrapKind === 'paired-cluster', 'bootstrap law drifted');
  invariant(stats.practicalRelativeThreshold === 0.05 && stats.targetPower === 0.8, 'effect/power policy drifted');
  invariant(Number.isSafeInteger(stats.orderSeed) && Number.isSafeInteger(stats.bootstrapSeed), 'seeds are not fixed');
  invariant(stats.minimumIndependentBlocks >= 20 && stats.maximumIndependentBlocks >= stats.minimumIndependentBlocks, 'block bounds invalid');
  invariant(/null\/control pilot/.test(stats.sampleCountRule) && />= 0\.80/.test(stats.sampleCountRule), 'sample-count/MDE rule missing');
  invariant(/no optional stopping/.test(stats.stoppingRule), 'optional stopping is not forbidden');
  invariant(stats.m04.scalarChannels === 100 && stats.m04.ownCpuP99MsPerFrameMax === 0.5, 'M-04 CPU threshold drifted');
  invariant(stats.m04.fullScenario120HzMissedFrameUpper95Max === 0.001, 'M-04 missed-frame threshold drifted');
  invariant(stats.m05.candidateToBestComparatorUpper95Max === 0.5, 'M-05 threshold drifted');
  invariant(JSON.stringify(stats.m05.requiredSceneIds) === JSON.stringify(sceneIds), 'M-05 scenes drifted');

  invariant(profile.calibration?.requiredBeforeCandidate === true, 'calibration must precede candidate data');
  invariant(JSON.stringify(profile.calibration.aaNonInferiorityBand) === JSON.stringify([0.95, 1.05]), 'A/A band drifted');
  invariant(profile.calibration.deliberateWorkMultiplier === 2, 'positive-control multiplier drifted');
  invariant(profile.calibration.deliberateWorkDetectedLower95Min === 1.5, 'positive-control resolution drifted');
  invariant(/new calibration identity/.test(profile.calibration.sameExperimentRetryPolicy), 'repeat-to-green is not fenced');

  const observation = profile.observationPolicy;
  invariant(observation?.keepEverySample && observation.keepFailures && observation.keepStalls && observation.keepMalformedReceipts, 'observation policy drops evidence');
  invariant(observation.forcedGcDuringTiming === false, 'forced GC during timing is forbidden');
  invariant(['cpu', 'paint', 'compositor'].every((claim) => observation.traceRequiredForClaims.includes(claim)), 'trace claim classes drifted');
  invariant(observation.separateDenominators.length >= 10, 'denominators collapsed');
  return profile;
}

export function validateDesktopInventory(receipt, profile = PROFILE_PREREGISTRATION) {
  validatePreregistration(profile);
  invariant(receipt?.schemaVersion === 1, 'desktop inventory schema mismatch');
  invariant(receipt.profileId === profile.profileId, 'inventory belongs to another profile');
  invariant(receipt.baselineRevision === profile.baseline.revision, 'inventory belongs to another baseline');
  invariant(typeof receipt.generatedAt === 'string' && !Number.isNaN(Date.parse(receipt.generatedAt)), 'inventory timestamp invalid');
  for (const key of ['platform', 'release', 'arch', 'node']) {
    invariant(typeof receipt.host?.[key] === 'string' && receipt.host[key].length > 0, `host.${key} missing`);
  }
  invariant(Array.isArray(receipt.browsers) && JSON.stringify(receipt.browsers.map(({ engine }) => engine)) === JSON.stringify(['chromium', 'firefox', 'webkit']), 'desktop receipt must bind exactly Chromium/Firefox/WebKit');
  for (const browser of receipt.browsers) {
    invariant(typeof browser.version === 'string' && browser.version.length > 0, `${browser.engine}: version missing`);
    invariant(SHA256.test(browser.executableSha256), `${browser.engine}: executable SHA-256 missing`);
    invariant(typeof browser.userAgent === 'string' && browser.userAgent.length > 0, `${browser.engine}: UA missing`);
    invariant(browser.refreshTargetHz === 60, `${browser.engine}: refresh target drifted`);
  }
  invariant(receipt.mobileBindings === undefined, 'desktop receipt fabricated mobile hardware');
  return receipt;
}

export function validateCalibrationReceipt(receipt, profile = PROFILE_PREREGISTRATION) {
  validatePreregistration(profile);
  invariant(receipt?.schemaVersion === 1, 'calibration schema mismatch');
  invariant(receipt.profileId === profile.profileId && receipt.baselineRevision === profile.baseline.revision, 'calibration provenance mismatch');
  invariant(typeof receipt.calibrationId === 'string' && receipt.calibrationId.length > 0, 'calibration identity missing');
  invariant(receipt.attempt === 1, 'same calibration identity may not repeat-to-green');
  invariant(Array.isArray(receipt.raw?.aa) && receipt.raw.aa.length > 0, 'A/A raw clusters missing');
  invariant(Array.isArray(receipt.raw?.deliberate2x) && receipt.raw.deliberate2x.length > 0, 'positive-control raw clusters missing');
  const [aaLow, aaHigh] = profile.calibration.aaNonInferiorityBand;
  invariant(Number.isFinite(receipt.aa?.lower95) && Number.isFinite(receipt.aa?.upper95), 'A/A interval missing');
  invariant(receipt.aa.lower95 >= aaLow && receipt.aa.upper95 <= aaHigh, 'A/A escaped non-inferiority band');
  invariant(receipt.deliberate2x?.workMultiplier === 2, 'positive control is not 2x work');
  invariant(Number.isFinite(receipt.deliberate2x.lower95) && receipt.deliberate2x.lower95 >= profile.calibration.deliberateWorkDetectedLower95Min, 'positive control unresolved');
  invariant(receipt.candidateSamples === 0, 'candidate data appeared before calibration admission');
  return receipt;
}

export function eligibleDesktopCells(inventory, calibration, profile = PROFILE_PREREGISTRATION) {
  validateDesktopInventory(inventory, profile);
  validateCalibrationReceipt(calibration, profile);
  return profile.roster.filter(({ class: kind }) => kind === 'desktop-browser').map(({ id }) => id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validatePreregistration();
  process.stdout.write(`${JSON.stringify({ profileId: PROFILE_PREREGISTRATION.profileId, status: 'VALID' })}\n`);
}
