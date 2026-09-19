import { CROSSOVER_PREREGISTRATION as DESIGN, validateCrossoverPreregistration } from './crossover-preregistration.mjs';
import { pairedLogRatioInterval, pairedLogReceiptSha256 } from './paired-log-pilot-core.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 symmetric-crossover pilot: ${message}`);
}

export class CrossoverResolutionFailure extends Error {
  constructor(message, evidence) {
    super(`PROFILE-01 symmetric-crossover pilot: ${message}`);
    this.name = 'CrossoverResolutionFailure';
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

function expectedLogicalUnits(sceneId) {
  const units = DESIGN.measurement.logicalUnitsByScene[sceneId];
  invariant(Number.isSafeInteger(units) && units > 0, `${sceneId}: frozen logical-unit count missing`);
  return units;
}

function geometricMean(values) {
  invariant(Array.isArray(values) && values.length > 0, 'geometric mean requires values');
  let logSum = 0;
  for (const value of values) {
    invariant(Number.isFinite(value) && value > 0, 'geometric mean requires positive finite values');
    logSum += Math.log(value);
  }
  return Math.exp(logSum / values.length);
}

export async function acquireCrossoverObservation(measurePacket, sceneId, workMultiplier = 1) {
  validateCrossoverPreregistration();
  invariant(typeof measurePacket === 'function', 'measurePacket must be a function');
  invariant(DESIGN.sceneIds.includes(sceneId), `unknown scene ${sceneId}`);
  invariant(workMultiplier === 1 || workMultiplier === 2, 'work multiplier must be 1 or 2');

  const logicalUnits = expectedLogicalUnits(sceneId);
  const result = await measurePacket({ sceneId, logicalUnits, workMultiplier });
  invariant(result && result.semantic === true, `${sceneId}: packet semantic oracle failed`);
  invariant(Number.isFinite(result.ownerMs) && result.ownerMs >= 0, `${sceneId}: invalid owner-time`);
  invariant(Number.isFinite(result.enclosingWallMs) && result.enclosingWallMs >= result.ownerMs, `${sceneId}: invalid enclosing wall-time`);
  invariant(result.logicalUnits === logicalUnits, `${sceneId}: fixed logical-unit count drifted`);
  invariant(result.workMultiplier === workMultiplier, `${sceneId}: work multiplier drifted`);
  invariant(result.physicalExecutions === logicalUnits * workMultiplier, `${sceneId}: physical-work count drifted`);

  if (result.enclosingWallMs > DESIGN.measurement.maximumEnclosingWallMsPerComponent) {
    throw new CrossoverResolutionFailure('component exceeded enclosing wall bound', {
      sceneId, logicalUnits, workMultiplier, ownerMs: result.ownerMs, enclosingWallMs: result.enclosingWallMs,
      maximumEnclosingWallMsPerComponent: DESIGN.measurement.maximumEnclosingWallMsPerComponent,
    });
  }
  if (result.ownerMs < DESIGN.measurement.minimumOwnedMsPerComponent) {
    throw new CrossoverResolutionFailure('component did not clear frozen owner-time floor', {
      sceneId, logicalUnits, workMultiplier, ownerMs: result.ownerMs,
      minimumOwnedMsPerComponent: DESIGN.measurement.minimumOwnedMsPerComponent,
    });
  }

  return {
    ownerMs: result.ownerMs,
    enclosingWallMs: result.enclosingWallMs,
    logicalUnits,
    physicalExecutions: result.physicalExecutions,
    workMultiplier,
    costPerLogicalUnitMs: result.ownerMs / logicalUnits,
    semantic: true,
  };
}

function summarizeArm(run, components, workMultiplier) {
  invariant(components.length === DESIGN.crossover.replicatesPerArm, `run ${run}: crossover arm cardinality drifted`);
  const sample = geometricMean(components.map(({ costPerLogicalUnitMs }) => costPerLogicalUnitMs));
  return {
    run,
    samples: [sample],
    positions: components.map(({ position }) => position),
    components,
    ownerMs: components.reduce((sum, entry) => sum + entry.ownerMs, 0),
    enclosingWallMs: components.reduce((sum, entry) => sum + entry.enclosingWallMs, 0),
    workMultiplier,
    semantic: true,
  };
}

async function acquirePattern(measurePacket, sceneId, pattern, run) {
  const byArm = new Map();
  for (let position = 0; position < pattern.length; position++) {
    const arm = pattern[position];
    const workMultiplier = arm === 'D' ? 2 : 1;
    const observation = await acquireCrossoverObservation(measurePacket, sceneId, workMultiplier);
    const component = { position, arm, ...observation };
    const values = byArm.get(arm) ?? [];
    values.push(component);
    byArm.set(arm, values);
  }
  return byArm;
}

export async function acquireSymmetricCrossoverControls(measurePacket, sceneId, options = {}) {
  validateCrossoverPreregistration();
  const runBlocks = options.runBlocks ?? DESIGN.controls.runBlocks;
  const orderSeed = options.orderSeed ?? DESIGN.controls.orderSeed;
  invariant(Number.isSafeInteger(runBlocks) && runBlocks > 1, 'runBlocks must contain independent pairs');
  const nextOrder = orderGenerator(orderSeed);
  const aa = { patterns: [], a: [], b: [] };
  const deliberate2x = { patterns: [], single: [], doubled: [] };

  for (let run = 0; run < runBlocks; run++) {
    const aaPattern = nextOrder() ? 'ABBA' : 'BAAB';
    const aaComponents = await acquirePattern(measurePacket, sceneId, aaPattern, run);
    aa.patterns.push(aaPattern);
    aa.a.push(summarizeArm(run, aaComponents.get('A'), 1));
    aa.b.push(summarizeArm(run, aaComponents.get('B'), 1));

    const deliberatePattern = nextOrder() ? 'SDDS' : 'DSSD';
    const deliberateComponents = await acquirePattern(measurePacket, sceneId, deliberatePattern, run);
    deliberate2x.patterns.push(deliberatePattern);
    deliberate2x.single.push(summarizeArm(run, deliberateComponents.get('S'), 1));
    deliberate2x.doubled.push(summarizeArm(run, deliberateComponents.get('D'), 2));
  }
  return { aa, deliberate2x };
}

function validateComponent(component, sceneId, workMultiplier, position, label) {
  const logicalUnits = expectedLogicalUnits(sceneId);
  invariant(component?.position === position, `${label}: component position drifted`);
  invariant(component.semantic === true, `${label}: component semantic oracle failed`);
  invariant(component.logicalUnits === logicalUnits, `${label}: component logical-unit count drifted`);
  invariant(component.workMultiplier === workMultiplier, `${label}: component multiplier drifted`);
  invariant(component.physicalExecutions === logicalUnits * workMultiplier, `${label}: component physical-work count drifted`);
  invariant(Number.isFinite(component.ownerMs) && component.ownerMs >= DESIGN.measurement.minimumOwnedMsPerComponent, `${label}: component owner-time floor escaped`);
  invariant(Number.isFinite(component.enclosingWallMs) && component.enclosingWallMs >= component.ownerMs && component.enclosingWallMs <= DESIGN.measurement.maximumEnclosingWallMsPerComponent, `${label}: component wall bound escaped`);
  invariant(Object.is(component.costPerLogicalUnitMs, component.ownerMs / logicalUnits), `${label}: component normalized cost drifted`);
}

function validateCluster(cluster, sceneId, run, workMultiplier, positions, label) {
  invariant(cluster?.run === run && cluster.semantic === true, `${label}: run identity/semantic drifted`);
  invariant(Array.isArray(cluster.positions) && JSON.stringify(cluster.positions) === JSON.stringify(positions), `${label}: symmetric positions drifted`);
  invariant(Array.isArray(cluster.components) && cluster.components.length === DESIGN.crossover.replicatesPerArm, `${label}: component count drifted`);
  for (let index = 0; index < positions.length; index++) validateComponent(cluster.components[index], sceneId, workMultiplier, positions[index], `${label}/component-${index}`);
  invariant(cluster.workMultiplier === workMultiplier, `${label}: aggregate multiplier drifted`);
  invariant(cluster.samples?.length === 1, `${label}: aggregate must contain one run-block sample`);
  const expected = geometricMean(cluster.components.map(({ costPerLogicalUnitMs }) => costPerLogicalUnitMs));
  invariant(Object.is(cluster.samples[0], expected), `${label}: geometric-mean aggregate drifted`);
  invariant(Object.is(cluster.ownerMs, cluster.components.reduce((sum, entry) => sum + entry.ownerMs, 0)), `${label}: owner sum drifted`);
  invariant(Object.is(cluster.enclosingWallMs, cluster.components.reduce((sum, entry) => sum + entry.enclosingWallMs, 0)), `${label}: wall sum drifted`);
}

function armPositions(pattern, arm) {
  const positions = [];
  for (let index = 0; index < pattern.length; index++) if (pattern[index] === arm) positions.push(index);
  return positions;
}

function validateCrossoverPair(group, sceneId, leftName, rightName, leftArm, rightArm, leftMultiplier, rightMultiplier, patterns, label) {
  invariant(Array.isArray(group?.patterns) && group.patterns.length === DESIGN.controls.runBlocks, `${label}: pattern receipts missing`);
  invariant(Array.isArray(group[leftName]) && group[leftName].length === DESIGN.controls.runBlocks, `${label}: left run-block count drifted`);
  invariant(Array.isArray(group[rightName]) && group[rightName].length === DESIGN.controls.runBlocks, `${label}: right run-block count drifted`);
  for (let run = 0; run < DESIGN.controls.runBlocks; run++) {
    const pattern = group.patterns[run];
    invariant(patterns.includes(pattern), `${label}/run-${run}: unregistered crossover pattern ${pattern}`);
    const leftPositions = armPositions(pattern, leftArm);
    const rightPositions = armPositions(pattern, rightArm);
    invariant(leftPositions.length === 2 && rightPositions.length === 2, `${label}/run-${run}: arm cardinality drifted`);
    invariant(leftPositions[0] + leftPositions[1] === rightPositions[0] + rightPositions[1], `${label}/run-${run}: first-order drift balance broken`);
    validateCluster(group[leftName][run], sceneId, run, leftMultiplier, leftPositions, `${label}/run-${run}/${leftName}`);
    validateCluster(group[rightName][run], sceneId, run, rightMultiplier, rightPositions, `${label}/run-${run}/${rightName}`);
  }
}

export function buildCrossoverPilotReceipt({ inventory, preregRevision, harnessRevision, cells, generatedAt = new Date().toISOString() }) {
  validateCrossoverPreregistration();
  invariant(/^[0-9a-f]{40}$/u.test(preregRevision), 'preregRevision must be exact SHA');
  invariant(/^[0-9a-f]{40}$/u.test(harnessRevision), 'harnessRevision must be exact SHA');
  return {
    schemaVersion: 1,
    node: 'PROFILE-01',
    designId: DESIGN.id,
    preregRevision,
    harnessRevision,
    baselineRevision: DESIGN.baselineRevision,
    generatedAt,
    candidateSamples: 0,
    inventorySha256: pairedLogReceiptSha256(inventory),
    design: DESIGN,
    cells,
  };
}

export function finalizeCrossoverPilotReceipt(receipt) {
  validateCrossoverPreregistration(receipt?.design);
  invariant(receipt?.schemaVersion === 1 && receipt.node === 'PROFILE-01', 'receipt identity drifted');
  invariant(receipt.designId === DESIGN.id, 'receipt design drifted');
  invariant(receipt.baselineRevision === DESIGN.baselineRevision, 'receipt baseline drifted');
  invariant(receipt.candidateSamples === 0, 'pilot observed candidate data');
  invariant(/^[0-9a-f]{40}$/u.test(receipt.preregRevision) && /^[0-9a-f]{40}$/u.test(receipt.harnessRevision), 'receipt exact revisions missing');
  invariant(/^[0-9a-f]{64}$/u.test(receipt.inventorySha256), 'inventory digest missing');
  invariant(Array.isArray(receipt.cells) && receipt.cells.length === DESIGN.engines.length, 'desktop cell matrix missing');

  const output = structuredClone(receipt);
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
      validateCrossoverPair(scene.raw?.aa, scene.id, 'a', 'b', 'A', 'B', 1, 1, DESIGN.crossover.aaPatterns, `${label}/aa`);
      validateCrossoverPair(scene.raw?.deliberate2x, scene.id, 'single', 'doubled', 'S', 'D', 1, 2, DESIGN.crossover.deliberatePatterns, `${label}/deliberate2x`);
      const seed = DESIGN.controls.bootstrapSeed ^ Math.imul(cellIndex + 1, 0x45d9f3b) ^ Math.imul(sceneIndex + 1, 0x119de1f3);
      scene.aa = pairedLogRatioInterval(scene.raw.aa.a, scene.raw.aa.b, seed, DESIGN.controls.bootstrapIterations);
      scene.deliberate2x = pairedLogRatioInterval(scene.raw.deliberate2x.doubled, scene.raw.deliberate2x.single, seed ^ 0x2a2a2a, DESIGN.controls.bootstrapIterations);
      invariant(scene.aa.lower95 >= aaLow && scene.aa.upper95 <= aaHigh, `${label}: A/A escaped [${aaLow}, ${aaHigh}]`);
      invariant(scene.deliberate2x.lower95 >= DESIGN.controls.deliberate2xLower95Min, `${label}: deliberate-2x unresolved`);
    }
  }
  return output;
}
