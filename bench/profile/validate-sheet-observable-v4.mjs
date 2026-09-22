import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SHEET_OBSERVABLE_V4 } from './sheet-observable-v4-preregistration.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 sheet-observable-v4 velocity validation: ${message}`);
}

function assertVelocityHandoff(before, after, direction) {
  invariant(Number.isFinite(before.velocity), 'interrupt velocity must be finite');
  invariant(before.velocity !== 0, 'interrupt velocity must be non-zero');
  invariant(Math.sign(before.velocity) === direction, 'interrupt velocity must preserve the directed motion');
  invariant(Number.isFinite(after.velocity), 'retarget velocity must be finite');
  invariant(after.velocity === before.velocity, 'retarget must preserve the full scalar velocity exactly at the C1 boundary');
}

function expectReject(fn, label) {
  try {
    fn();
  } catch {
    return label;
  }
  throw new Error(`velocity oracle negative control survived: ${label}`);
}

export function validateSheetObservableV4Velocity(receipt, contract = SHEET_OBSERVABLE_V4) {
  invariant(receipt?.status === 'PASS', 'candidate receipt is not PASS');
  invariant(receipt?.baselineRevision === contract.baselineRevision, 'baseline revision drifted');
  invariant(Array.isArray(receipt?.engines) && receipt.engines.length === 3, 'engine roster drifted');

  const controls = Object.freeze({
    zeroVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: 0 }, { velocity: 0 }, contract.expected.movementDirection),
      'zero-velocity-handoff',
    ),
    reverseVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: -1 }, { velocity: -1 }, contract.expected.movementDirection),
      'reverse-velocity-handoff',
    ),
    discontinuousVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: 1 }, { velocity: 2 }, contract.expected.movementDirection),
      'discontinuous-velocity-handoff',
    ),
  });

  for (const engine of receipt.engines) {
    invariant(engine.status === 'PASS', `${engine.engine}: probe did not pass`);
    assertVelocityHandoff(engine.atInterrupt, engine.afterInterrupt, contract.expected.movementDirection);
  }

  return {
    schemaVersion: 1,
    status: 'PASS',
    node: contract.node,
    probeId: contract.id,
    baselineRevision: contract.baselineRevision,
    harnessRevision: receipt.harnessRevision,
    productionRuntimePackageDeltaBytes: 0,
    invariant: 'M-06 full velocity preservation at the interruption/retarget boundary',
    engines: receipt.engines.map((engine) => ({
      engine: engine.engine,
      version: engine.version,
      atInterruptVelocity: engine.atInterrupt.velocity,
      afterInterruptVelocity: engine.afterInterrupt.velocity,
      status: 'PASS',
    })),
    controls,
  };
}

async function main() {
  const receiptPath = process.argv[2];
  const outputPath = process.argv[3];
  invariant(receiptPath && outputPath, 'CLI requires <receipt.json> <validation.json>');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const validation = validateSheetObservableV4Velocity(receipt);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: validation.status, outputPath })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
