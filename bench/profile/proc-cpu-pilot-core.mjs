import {
  PROC_CPU_PREREGISTRATION as DESIGN,
  validateProcCpuPreregistration,
} from './proc-cpu-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 proc-cpu pilot: ${message}`);
}

export class ProcCpuFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 proc-cpu pilot: ${message}`);
    this.name = 'ProcCpuFailure';
    this.evidence = evidence;
  }
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

function frozenCount(map, sceneId, label) {
  const value = map[sceneId];
  invariant(Number.isSafeInteger(value) && value > 0, `${sceneId}: frozen ${label} missing`);
  return value;
}

function observationFrom(raw, sceneId, run, workMultiplier, token, position) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  const label = `${sceneId}/run-${run}/${position}`;
  invariant(raw?.semantic === true, `${label}: semantic oracle failed`);
  invariant(raw.isolationToken === token, `${label}: pair token drifted`);
  invariant(raw.position === position, `${label}: pair position drifted`);
  invariant(Number.isFinite(raw.browserCgroupCpuMs) && raw.browserCgroupCpuMs >= 0, `${label}: invalid browser-cgroup CPU time`);
  invariant(typeof raw.browserCgroupCpuUs === 'string' && /^[0-9]+$/u.test(raw.browserCgroupCpuUs), `${label}: CPU microsecond receipt missing`);
  invariant(Object.is(Number(BigInt(raw.browserCgroupCpuUs)) / 1000, raw.browserCgroupCpuMs), `${label}: CPU ms/us mismatch`);
  invariant(typeof raw.cgroupId === 'string' && raw.cgroupId.startsWith('lab-motion-profile-'), `${label}: cgroup identity missing`);
  invariant(Number.isSafeInteger(raw.rootPid) && raw.rootPid > 1, `${label}: browser root pid missing`);
  for (const memberSet of [raw.cgroupMembersAtLaunch, raw.cgroupMembersBefore, raw.cgroupMembersAfter]) {
    invariant(Array.isArray(memberSet) && memberSet.length > 0 && memberSet.every((pid) => Number.isSafeInteger(pid) && pid > 1), `${label}: cgroup membership evidence missing`);
    invariant(memberSet.includes(raw.rootPid), `${label}: browser root escaped cgroup membership`);
  }
  invariant(Number.isFinite(raw.enclosingWallMs) && raw.enclosingWallMs >= 0, `${label}: invalid enclosing wall-time`);
  invariant(Number.isFinite(raw.warmupWallMs) && raw.warmupWallMs >= 0, `${label}: warmup wall diagnostic invalid`);
  invariant(raw.logicalUnits === logicalUnits, `${label}: logical-unit count drifted`);
  invariant(raw.batchCalls === batchCalls, `${label}: live-batch count drifted`);
  invariant(raw.warmupLogicalUnits === warmupLogicalUnits, `${label}: warmup count drifted`);
  invariant(raw.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(raw.physicalExecutions === logicalUnits * workMultiplier, `${label}: formal work count drifted`);
  if (raw.browserCgroupCpuMs < DESIGN.measurement.minimumCpuMsPerArm) {
    throw new ProcCpuFailure('formal arm did not clear frozen cgroup-CPU floor', {
      sceneId, run, position, workMultiplier,
      browserCgroupCpuMs: raw.browserCgroupCpuMs,
      minimumCpuMsPerArm: DESIGN.measurement.minimumCpuMsPerArm,
    });
  }
  return {
    run,
    samples: [raw.browserCgroupCpuMs / logicalUnits],
    browserCgroupCpuMs: raw.browserCgroupCpuMs,
    browserCgroupCpuUs: raw.browserCgroupCpuUs,
    cgroupId: raw.cgroupId,
    cgroupMembersAtLaunch: raw.cgroupMembersAtLaunch,
    cgroupMembersBefore: raw.cgroupMembersBefore,
    cgroupMembersAfter: raw.cgroupMembersAfter,
    rootPid: raw.rootPid,
    enclosingWallMs: raw.enclosingWallMs,
    warmupWallMs: raw.warmupWallMs,
    logicalUnits,
    physicalExecutions: raw.physicalExecutions,
    batchCalls,
    warmupLogicalUnits,
    workMultiplier,
    processLifecycle: raw.processLifecycle,
    isolationToken: token,
    pairOrdinal: raw.pairOrdinal,
    position,
    browserVersion: raw.browserVersion,
    semantic: true,
  };
}

export async function acquireProcCpuBlock(measureFreshPair, sceneId, run, pairKind, order) {
  validateProcCpuPreregistration();
  invariant(typeof measureFreshPair === 'function', 'measureFreshPair must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(Number.isSafeInteger(run) && run >= 0, 'run identity invalid');
  invariant(pairKind === 'aa' || pairKind === 'deliberate2x', 'pair kind invalid');

  const expectedOrders = pairKind === 'aa' ? ['AB', 'BA'] : ['SD', 'DS'];
  invariant(expectedOrders.includes(order), `${pairKind}: order ${order} is not preregistered`);
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');

  const arms = pairKind === 'aa'
    ? (order === 'AB'
      ? [{ key: 'a', workMultiplier: 1 }, { key: 'b', workMultiplier: 1 }]
      : [{ key: 'b', workMultiplier: 1 }, { key: 'a', workMultiplier: 1 }])
    : (order === 'SD'
      ? [{ key: 'single', workMultiplier: 1 }, { key: 'doubled', workMultiplier: 2 }]
      : [{ key: 'doubled', workMultiplier: 2 }, { key: 'single', workMultiplier: 1 }]);

  const result = await measureFreshPair({
    sceneId,
    run,
    pairKind,
    order,
    arms,
    logicalUnits,
    batchCalls,
    warmupLogicalUnits,
  });

  invariant(result?.semantic === true, `${sceneId}/run-${run}/${pairKind}: pair semantic oracle failed`);
  invariant(result.processLifecycle === 'launch-server-paired-arms-close', `${sceneId}/run-${run}/${pairKind}: fresh-pair lifecycle receipt missing`);
  invariant(typeof result.isolationToken === 'string' && result.isolationToken.length >= 16, `${sceneId}/run-${run}/${pairKind}: pair isolation token missing`);
  invariant(Number.isSafeInteger(result.pairOrdinal) && result.pairOrdinal > 0, `${sceneId}/run-${run}/${pairKind}: pair ordinal missing`);
  invariant(typeof result.browserVersion === 'string' && result.browserVersion.length > 0, `${sceneId}/run-${run}/${pairKind}: browser version missing`);
  invariant(typeof result.cgroupId === 'string' && result.cgroupId.startsWith('lab-motion-profile-'), `${sceneId}/run-${run}/${pairKind}: pair cgroup identity missing`);
  invariant(Number.isFinite(result.pairEnclosingWallMs) && result.pairEnclosingWallMs >= 0, `${sceneId}/run-${run}/${pairKind}: invalid pair wall-time`);
  if (result.pairEnclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerPair) {
    throw new ProcCpuFailure('formal pair exceeded enclosing wall bound', {
      sceneId,
      run,
      pairKind,
      pairEnclosingWallMs: result.pairEnclosingWallMs,
      maximumEnclosingWallMsPerPair: DESIGN.measurement.maximumEnclosingWallMsPerPair,
    });
  }
  invariant(Array.isArray(result.observations) && result.observations.length === 2, `${sceneId}/run-${run}/${pairKind}: pair observations missing`);

  const byKey = {};
  for (let position = 0; position < arms.length; position++) {
    const arm = arms[position];
    const raw = result.observations[position];
    invariant(raw?.key === arm.key, `${sceneId}/run-${run}/${pairKind}: observed arm order drifted`);
    invariant(raw.processLifecycle === result.processLifecycle, `${sceneId}/run-${run}/${pairKind}/${arm.key}: lifecycle drifted`);
    invariant(raw.pairOrdinal === result.pairOrdinal, `${sceneId}/run-${run}/${pairKind}/${arm.key}: pair ordinal drifted`);
    invariant(raw.browserVersion === result.browserVersion, `${sceneId}/run-${run}/${pairKind}/${arm.key}: browser version drifted`);
    invariant(raw.cgroupId === result.cgroupId, `${sceneId}/run-${run}/${pairKind}/${arm.key}: cgroup identity drifted inside pair`);
    byKey[arm.key] = observationFrom(raw, sceneId, run, arm.workMultiplier, result.isolationToken, position);
  }

  return {
    order,
    isolationToken: result.isolationToken,
    pairOrdinal: result.pairOrdinal,
    browserVersion: result.browserVersion,
    cgroupId: result.cgroupId,
    pairEnclosingWallMs: result.pairEnclosingWallMs,
    observations: byKey,
  };
}

export async function acquireProcCpuControls(measureFreshPair, sceneId, options = {}) {
  validateProcCpuPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const orderSeed = options.orderSeed ?? DESIGN.controls.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { orders: [], pairTokens: [], a: [], b: [] };
  const deliberate2x = { orders: [], pairTokens: [], single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    const aaOrder = nextOrder() ? 'AB' : 'BA';
    const aaPair = await acquireProcCpuBlock(measureFreshPair, sceneId, run, 'aa', aaOrder);
    aa.orders.push(aaOrder);
    aa.pairTokens.push(aaPair.isolationToken);
    aa.a.push(aaPair.observations.a);
    aa.b.push(aaPair.observations.b);

    const deliberateOrder = nextOrder() ? 'SD' : 'DS';
    const deliberatePair = await acquireProcCpuBlock(measureFreshPair, sceneId, run, 'deliberate2x', deliberateOrder);
    deliberate2x.orders.push(deliberateOrder);
    deliberate2x.pairTokens.push(deliberatePair.isolationToken);
    deliberate2x.single.push(deliberatePair.observations.single);
    deliberate2x.doubled.push(deliberatePair.observations.doubled);
  }

  return { aa, deliberate2x };
}

function validateObservation(entry, sceneId, run, workMultiplier, label, expectedToken, expectedPosition, browserVersion) {
  const logicalUnits = frozenCount(DESIGN.measurement.logicalUnitsByScene, sceneId, 'logical-unit count');
  const batchCalls = frozenCount(DESIGN.measurement.liveBatchCallsByScene, sceneId, 'live-batch count');
  const warmupLogicalUnits = frozenCount(DESIGN.measurement.warmupLogicalUnitsByScene, sceneId, 'warmup count');
  invariant(entry?.run === run && entry.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(entry.samples?.length === 1 && Number.isFinite(entry.samples[0]) && entry.samples[0] > 0, `${label}: exactly one positive sample required`);
  invariant(entry.processLifecycle === 'launch-server-paired-arms-close', `${label}: lifecycle receipt drifted`);
  invariant(entry.isolationToken === expectedToken, `${label}: pair token mismatch`);
  invariant(entry.position === expectedPosition, `${label}: position drifted`);
  invariant(entry.browserVersion === browserVersion, `${label}: browser version drifted`);
  invariant(entry.logicalUnits === logicalUnits, `${label}: logical-unit count drifted`);
  invariant(entry.batchCalls === batchCalls, `${label}: live-batch count drifted`);
  invariant(entry.warmupLogicalUnits === warmupLogicalUnits, `${label}: warmup work drifted`);
  invariant(entry.workMultiplier === workMultiplier, `${label}: work multiplier drifted`);
  invariant(entry.physicalExecutions === logicalUnits * workMultiplier, `${label}: formal work count drifted`);
  invariant(entry.browserCgroupCpuMs >= DESIGN.measurement.minimumCpuMsPerArm, `${label}: cgroup-CPU floor escaped`);
  invariant(typeof entry.browserCgroupCpuUs === 'string' && /^[0-9]+$/u.test(entry.browserCgroupCpuUs), `${label}: CPU microsecond receipt missing`);
  invariant(Object.is(Number(BigInt(entry.browserCgroupCpuUs)) / 1000, entry.browserCgroupCpuMs), `${label}: CPU ms/us mismatch`);
  invariant(typeof entry.cgroupId === 'string' && entry.cgroupId.startsWith('lab-motion-profile-'), `${label}: cgroup identity drifted`);
  invariant(Number.isSafeInteger(entry.rootPid) && entry.rootPid > 1, `${label}: browser root pid drifted`);
  for (const memberSet of [entry.cgroupMembersAtLaunch, entry.cgroupMembersBefore, entry.cgroupMembersAfter]) {
    invariant(Array.isArray(memberSet) && memberSet.length > 0 && memberSet.every((pid) => Number.isSafeInteger(pid) && pid > 1), `${label}: cgroup membership drifted`);
    invariant(memberSet.includes(entry.rootPid), `${label}: browser root missing from cgroup membership`);
  }
  invariant(Number.isFinite(entry.enclosingWallMs) && entry.enclosingWallMs >= 0, `${label}: arm wall-time invalid`);
  invariant(Number.isFinite(entry.warmupWallMs) && entry.warmupWallMs >= 0, `${label}: warmup wall diagnostic invalid`);
  invariant(Object.is(entry.samples[0], entry.browserCgroupCpuMs / logicalUnits), `${label}: sample/raw CPU mismatch`);
}

function validatePair(group, sceneId, run, leftName, rightName, leftMultiplier, rightMultiplier, allowedOrders, label, tokens, cgroupIds, browserVersion) {
  const order = group.orders[run];
  invariant(allowedOrders.includes(order), `${label}: unregistered order`);
  const token = group.pairTokens[run];
  invariant(typeof token === 'string' && token.length >= 16, `${label}: pair token missing`);
  invariant(!tokens.has(token), `${label}: pair isolation token reused across run-blocks`);
  tokens.add(token);
  const cgroupId = group[leftName][run]?.cgroupId;
  invariant(cgroupId === group[rightName][run]?.cgroupId, `${label}: pair arms escaped dedicated cgroup`);
  invariant(!cgroupIds.has(cgroupId), `${label}: dedicated cgroup reused across run-blocks`);
  cgroupIds.add(cgroupId);
  const firstKey = order[0] === 'A' ? 'a' : order[0] === 'B' ? 'b' : order[0] === 'S' ? 'single' : 'doubled';
  const secondKey = firstKey === leftName ? rightName : leftName;
  const positions = { [firstKey]: 0, [secondKey]: 1 };
  validateObservation(group[leftName][run], sceneId, run, leftMultiplier, `${label}/${leftName}`, token, positions[leftName], browserVersion);
  validateObservation(group[rightName][run], sceneId, run, rightMultiplier, `${label}/${rightName}`, token, positions[rightName], browserVersion);
}

export function buildProcCpuPilotReceipt({ inventory, calibration, preregRevision, harnessRevision, cells, pilotEnclosingWallMs, generatedAt = new Date().toISOString() }) {
  validateProcCpuPreregistration();
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'preregRevision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be exact SHA');
  invariant(Number.isFinite(pilotEnclosingWallMs) && pilotEnclosingWallMs >= 0 && pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt,
    candidateSamples: 0,
    pilotEnclosingWallMs,
    inventorySha256: pairedLogReceiptSha256(inventory),
    calibrationSha256: pairedLogReceiptSha256(calibration),
    design: DESIGN,
    cells,
  };
}

export function finalizeProcCpuPilotReceipt(receipt) {
  validateProcCpuPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(Number.isFinite(receipt.pilotEnclosingWallMs) && receipt.pilotEnclosingWallMs >= 0 && receipt.pilotEnclosingWallMs <= DESIGN.measurement.maximumPilotWallMs, 'whole-pilot wall bound escaped');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256) && /^[0-9a-f]{64}$/u.test(receipt.calibrationSha256), 'content addresses missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
  const tokens = new Set();
  const cgroupIds = new Set();
  const [aaLow, aaHigh] = DESIGN.controls.aaBand;
  for (let cellIndex = 0; cellIndex < output.cells.length; cellIndex++) {
    const cell = output.cells[cellIndex];
    const engine = DESIGN.engines[cellIndex];
    invariant(cell?.id === `desktop-${engine}` && cell.engine === engine, `${engine}: cell identity drifted`);
    invariant(typeof cell.browserVersion === 'string' && cell.browserVersion.length > 0, `${engine}: browser version missing`);
    invariant(JSON.stringify(cell.scenes?.map(({ id }) => id)) === JSON.stringify(DESIGN.sceneIds), `${engine}: scene matrix drifted`);
    for (let sceneIndex = 0; sceneIndex < cell.scenes.length; sceneIndex++) {
      const scene = cell.scenes[sceneIndex];
      const label = `${cell.id}/${scene.id}`;
      const groups = [
        ['aa', scene.raw?.aa, 'a', 'b', 1, 1, ['AB', 'BA']],
        ['deliberate2x', scene.raw?.deliberate2x, 'single', 'doubled', 1, 2, ['SD', 'DS']],
      ];
      for (const [groupName, group, leftName, rightName, leftMultiplier, rightMultiplier, orders] of groups) {
        invariant(Array.isArray(group?.orders) && group.orders.length === DESIGN.controls.runBlocks, `${label}/${groupName}: order receipts missing`);
        invariant(Array.isArray(group?.pairTokens) && group.pairTokens.length === DESIGN.controls.runBlocks, `${label}/${groupName}: pair-token receipts missing`);
        invariant(Array.isArray(group[leftName]) && group[leftName].length === DESIGN.controls.runBlocks, `${label}/${groupName}: left block count drifted`);
        invariant(Array.isArray(group[rightName]) && group[rightName].length === DESIGN.controls.runBlocks, `${label}/${groupName}: right block count drifted`);
        for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
          validatePair(group, scene.id, run, leftName, rightName, leftMultiplier, rightMultiplier, orders, `${label}/${groupName}/run-${run}`, tokens, cgroupIds, cell.browserVersion);
        }
      }
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  const expectedPairs = DESIGN.engines.length * DESIGN.sceneIds.length * DESIGN.controls.runBlocks * 2;
  invariant(tokens.size === expectedPairs, 'pair-process isolation-token cardinality drifted');
  invariant(cgroupIds.size === expectedPairs, 'dedicated-cgroup cardinality drifted');
  output.processIsolation = {
    kind: 'fresh-browser-server-process-and-cgroup-per-paired-run-block',
    uniquePairTokens: tokens.size,
    uniqueCgroupIds: cgroupIds.size,
    formalArmsPerPair: 2,
  };
  return output;
}
