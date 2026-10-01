import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// PROFILE-01 proof-plane preregistration.
// This file derives the next observation deadline only from the frozen scene,
// frozen spring law, convergence law and virtual-clock contract. It does not
// execute a browser or read candidate measurements.

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 sheet-observable-v4 preregistration: ${message}`);
}

const baselineRevision = 'fe11daa407de396fad952be7679650f63dabd4dd';
const sourceBlobs = Object.freeze({
  behaviors: 'fa06548f592eddd7acd2c1121be26c1a86512718',
  gestures: 'a0b97661beece0ff1a7dce33203c8f921e4ac35d',
  slidingWindow: 'e1c3131a891ab9299b0746417d7e93ca98b190cc',
  decay: 'e6219f1d7d011375bbf93f699f659ebf80aeff7d',
  tokens: '854358d3d060c7f047736bacb142ab41cd62c27d',
  motionDefaults: '56cf7a0c8e9875a240ba5b1eb43271026261beaf',
  solver: '60beb917e3f56539de918b135a24d79a6472aef8',
  spring: '36d16e1b70abde88e0f044a0715739866d38cc01',
  constants: '1d743b382ef21f3b0633da21602af517cb1f7ec2',
});

const frameStepMs = 16;
const convergenceThreshold = 0.005;
const spring = Object.freeze({ mass: 1, stiffness: 170, damping: 26 });
const snapPoints = Object.freeze([0, 300, 600]);
const timelinePrefix = Object.freeze([
  Object.freeze({ kind: 'down', atMs: 0, y: 0 }),
  Object.freeze({ kind: 'move', atMs: 160, y: 80 }),
  Object.freeze({ kind: 'move', atMs: 320, y: 180 }),
  Object.freeze({ kind: 'move', atMs: 480, y: 260 }),
  Object.freeze({ kind: 'up', atMs: 520, y: 300 }),
  Object.freeze({ kind: 'interrupt', atMs: 700, snapIndex: 1 }),
]);

// Exact underdamped branch from frozen src/internal/solver.ts. The source blob
// is pinned above; the derivation is intentionally independent from browser state.
function solvePinnedSpring(t, v0) {
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const zeta = spring.damping / (2 * spring.mass * omega0);
  invariant(zeta < 1, 'frozen default spring left the preregistered underdamped branch');
  if (t <= 0) return { value: 0, velocity: v0 };
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega0 * t);
  const cosD = Math.cos(omegaD * t);
  const sinD = Math.sin(omegaD * t);
  const B = (v0 - zeta * omega0) / omegaD;
  const mode = B * sinD - cosD;
  return {
    value: 1 + decay * mode,
    velocity: decay * (-zeta * omega0 * mode + omegaD * (sinD + B * cosD)),
  };
}

// Exact non-zero-v0 upper-bound branch from frozen src/spring.ts.
function settleTimeUpperBoundPinned(v0) {
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const alpha = spring.damping / (2 * spring.mass);
  const omega2 = omega0 * omega0;
  const delta = omega2 - alpha * alpha;
  const split = Math.sqrt(Math.abs(delta));
  const envelopeRate = delta >= 0 ? alpha : omega2 / (alpha + split);
  if (!(envelopeRate > 0)) return Infinity;
  const stableExponent =
    (8 * Math.log(
      Math.max(
        envelopeRate + (8 * Math.abs(v0 - alpha)) / Math.E,
        envelopeRate * Math.abs(v0) +
          (8 * Math.abs(omega2 - alpha * v0)) / Math.E,
      ) /
        (envelopeRate * convergenceThreshold),
    )) / 7;
  if (delta === 0) return stableExponent / envelopeRate;
  const modalAmplitude =
    delta > 0
      ? Math.max(
          Math.hypot(1, (v0 - alpha) / split),
          Math.hypot(v0, (omega2 - alpha * v0) / split),
        )
      : Math.max(
          1,
          Math.abs((v0 - alpha) / split),
          Math.abs(v0),
          Math.abs((omega2 - alpha * v0) / split),
        );
  return Math.min(
    stableExponent,
    Math.log(modalAmplitude / convergenceThreshold),
  ) / envelopeRate;
}

const FORMULA_SOURCE_SHA256 = Object.freeze({
  solvePinnedSpring: 'c1650306cc7dca667a3ccb27b6018e8dde20aa8584ea61ac453a94a2e4cdbf23',
  settleTimeUpperBoundPinned: 'a005afa7778ed2dbaf9b2c655f7fae6dfda5b62cafb47796f233c1e2f4920406',
});
const BASELINE_SOLVER_WITNESSES = Object.freeze([
  'const zeta = c / (2 * m * omega0);',
  'const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);',
  'const B = (v0 - zeta * omega0) / omegaD;',
  'const mode = B * sinD - cosD;',
  'decay * (-zeta * omega0 * mode + omegaD * (sinD + B * cosD));',
]);
const BASELINE_SETTLE_WITNESSES = Object.freeze([
  'const envelopeRate = delta >= 0 ? alpha : omega2 / (alpha + split);',
  'if (!(envelopeRate > 0)) return Infinity;',
  'if (delta === 0) return stableExponent / envelopeRate;',
  'Math.log(modalAmplitude / CONVERGENCE_THRESHOLD),',
  ') / envelopeRate;',
]);

function formulaSourceSha256(fn) {
  return createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');
}

export function verifyPinnedFormulaCorrespondence(solverSource, springSource) {
  invariant(typeof solverSource === 'string' && solverSource.length > 0, 'baseline solver source is required');
  invariant(typeof springSource === 'string' && springSource.length > 0, 'baseline spring source is required');
  const solverHelperSha256 = formulaSourceSha256(solvePinnedSpring);
  const settleHelperSha256 = formulaSourceSha256(settleTimeUpperBoundPinned);
  invariant(
    solverHelperSha256 === FORMULA_SOURCE_SHA256.solvePinnedSpring,
    `local pinned solver formula drifted (${solverHelperSha256})`,
  );
  invariant(
    settleHelperSha256 === FORMULA_SOURCE_SHA256.settleTimeUpperBoundPinned,
    `local pinned settle formula drifted (${settleHelperSha256})`,
  );
  for (const witness of BASELINE_SOLVER_WITNESSES) {
    invariant(solverSource.includes(witness), `baseline solver formula witness missing: ${witness}`);
  }
  for (const witness of BASELINE_SETTLE_WITNESSES) {
    invariant(springSource.includes(witness), `baseline settle formula witness missing: ${witness}`);
  }
  return Object.freeze({ solverHelperSha256, settleHelperSha256 });
}

function deriveDeadline() {
  const moves = timelinePrefix.filter(({ kind }) => kind === 'move');
  const up = timelinePrefix.find(({ kind }) => kind === 'up');
  const interrupt = timelinePrefix.find(({ kind }) => kind === 'interrupt');
  invariant(moves.length === 3 && up && interrupt, 'frozen scene shape drifted');

  // pointerUp contributes only the velocity sample. The public sheet value at
  // release is the last pointerMove value, 260 px.
  const releaseFromPx = moves[moves.length - 1].y;
  const releaseTargetPx = snapPoints[2];
  const releaseVelocityPxPerSec =
    (up.y - moves[moves.length - 1].y) /
    ((up.atMs - moves[moves.length - 1].atMs) / 1000);
  invariant(releaseVelocityPxPerSec === 1000, 'frozen release velocity drifted');

  // The runner's first timestamped callback anchors lastTs without advancing
  // elapsed. With a 16 ms virtual clock that anchor is 536 ms, so the exact
  // analytic elapsed at the 700 ms interruption is 164 ms.
  const releaseAnchorMs = up.atMs + frameStepMs;
  const releaseElapsedSec = (interrupt.atMs - releaseAnchorMs) / 1000;
  invariant(releaseElapsedSec === 0.164, 'release elapsed law drifted');

  const releaseRange = releaseTargetPx - releaseFromPx;
  const releaseV0 = releaseVelocityPxPerSec / releaseRange;
  const releaseAtInterrupt = solvePinnedSpring(releaseElapsedSec, releaseV0);
  const interruptValuePx = releaseFromPx + releaseAtInterrupt.value * releaseRange;
  const interruptVelocityPxPerSec = releaseAtInterrupt.velocity * releaseRange;

  const interruptTargetPx = snapPoints[interrupt.snapIndex];
  const interruptRange = interruptTargetPx - interruptValuePx;
  invariant(interruptRange !== 0, 'interruption range degenerated');
  const interruptV0 = interruptVelocityPxPerSec / interruptRange;

  const settleBoundSec = settleTimeUpperBoundPinned(interruptV0);
  invariant(Number.isFinite(settleBoundSec) && settleBoundSec > 0, 'derived settle bound is not finite');

  // Runner callback #1 after snapTo anchors lastTs and contributes zero elapsed.
  // Use the first grid point strictly greater than the analytic upper bound so
  // the runtime's strict `< threshold` convergence check cannot be satisfied
  // only by equality at the mathematical boundary.
  const strictSettleIntervals = Math.floor((settleBoundSec * 1000) / frameStepMs) + 1;
  const terminalAtMs =
    interrupt.atMs + frameStepMs + strictSettleIntervals * frameStepMs;

  invariant(terminalAtMs === 1548, `derived terminal deadline drifted (${terminalAtMs})`);

  return Object.freeze({
    releaseFromPx,
    releaseTargetPx,
    releaseVelocityPxPerSec,
    releaseAnchorMs,
    releaseElapsedSec,
    interruptValuePx,
    interruptVelocityPxPerSec,
    interruptTargetPx,
    interruptRange,
    interruptV0,
    settleBoundSec,
    strictSettleIntervals,
    terminalAtMs,
  });
}

const derivation = deriveDeadline();

export const SHEET_OBSERVABLE_V4 = Object.freeze({
  schemaVersion: 1,
  id: 'r11-profile-sheet-observable-v4-20260922',
  node: 'PROFILE-01',
  registeredAt: '2026-09-22',
  candidateSamplesObservedAtRegistration: false,
  baselineRevision,
  sourceBlobs,
  predecessor: Object.freeze({
    head: '484ececb493fbb81acf7725444a931c47b3ca666',
    run: 35708030265,
    artifact: 10685965697,
    artifactSha256: 'f58d4f87053dfb78298d1fe36f5fae4cc28634b9568cd6c46828beaf3e50c243',
    verdict: 'NO-GO: the frozen 1000 ms hard deadline is below the independently derived convergence horizon',
  }),
  premiseChange: Object.freeze({
    fact: 'the frozen solver/default/convergence blobs independently imply a strict terminal observation deadline of 1548 ms for the frozen interruption scene',
    scheduler: 'keep the deterministic 16 ms virtual frame clock from v3',
    movementOracle: 'keep public-value delta movement/velocity observation from v3',
    terminalOracle: 'observe the exact terminal state with zero queued frame work at the derived 1548 ms boundary; never drain or execute work after it',
    antiTuning: '1548 ms is derived before this successor owns any browser sample; no result-driven retiming is allowed',
  }),
  viewport: Object.freeze({ width: 390, height: 844 }),
  dpr: 2,
  snapPoints,
  frameStepMs,
  convergenceThreshold,
  spring,
  derivation,
  timeline: Object.freeze([
    ...timelinePrefix,
    Object.freeze({ kind: 'terminal-observation', atMs: derivation.terminalAtMs }),
  ]),
  expected: Object.freeze({
    releaseInputVelocityPxPerSec: 1000,
    releaseTargetSnapIndex: 2,
    movementDirection: 1,
    terminal: Object.freeze({ phase: 'settle', value: 300, snapIndex: 1, velocity: 0 }),
  }),
  decision: Object.freeze({
    pass: 'Chromium, Firefox and WebKit all preserve observable forward movement and C0 interruption, then reach the exact terminal state with an empty scheduler no later than the independently derived 1548 ms deadline',
    fail: 'any engine violates movement/interruption semantics, misses the terminal state, or still owns queued frame work at the derived deadline',
    retry: 'forbidden without another independently justified premise-changing fact; no retiming or threshold tuning from probe results',
  }),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(SHEET_OBSERVABLE_V4, null, 2)}\n`);
}
