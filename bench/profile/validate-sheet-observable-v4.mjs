import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SHEET_OBSERVABLE_V4 } from './sheet-observable-v4-preregistration.mjs';

const INVARIANT_PREFIX = 'PROFILE-01 sheet-observable-v4:';

function invariant(condition, message) {
  if (!condition) throw new Error(`${INVARIANT_PREFIX} ${message}`);
}

function expectReject(fn, label, expectedPrefix) {
  try {
    fn();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.startsWith(expectedPrefix)) return label;
    throw error;
  }
  throw new Error(`негативный контроль не сработал: ${label}`);
}

function nearlyEqual(actual, expected, tolerance = 1e-12) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function assertVelocityHandoff(before, after, direction) {
  invariant(Number.isFinite(before.velocity), 'скорость в точке прерывания должна быть конечной');
  invariant(before.velocity !== 0, 'скорость в точке прерывания должна быть ненулевой');
  invariant(Math.sign(before.velocity) === direction, 'скорость в точке прерывания должна сохранять направление движения');
  invariant(Number.isFinite(after.velocity), 'скорость после смены цели должна быть конечной');
  invariant(after.velocity === before.velocity, 'смена цели должна точно сохранять полную скалярную скорость на границе C1');
}

// Независимая запись того же аналитического решения для недодемпфированной пружины:
// вместо внутренней mode-переменной считаем расстояние до цели x=1-y и берём y=1-x.
function solveReferenceSpring(t, v0, spring) {
  invariant(t >= 0, 'время независимой модели пружины не может быть отрицательным');
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const alpha = spring.damping / (2 * spring.mass);
  const betaSquared = omega0 * omega0 - alpha * alpha;
  invariant(betaSquared > 0, 'замороженная пружина вышла из недодемпфированной ветви независимой модели');
  const beta = Math.sqrt(betaSquared);
  if (t === 0) return { value: 0, velocity: v0 };
  const decay = Math.exp(-alpha * t);
  const cos = Math.cos(beta * t);
  const sin = Math.sin(beta * t);
  const displacementSin = (alpha - v0) / beta;
  const displacement = decay * (cos + displacementSin * sin);
  const displacementVelocity = decay * (
    -alpha * (cos + displacementSin * sin) + beta * (-sin + displacementSin * cos)
  );
  return { value: 1 - displacement, velocity: -displacementVelocity };
}

// Независимый проверочный расчёт закона settleTimeUpperBound. Он не импортирует
// рабочие spring/solver и принимает порог явно, чтобы проверить монотонность.
function settleBoundReference(v0, spring, threshold) {
  invariant(Number.isFinite(v0), 'начальная скорость независимой модели должна быть конечной');
  invariant(Number.isFinite(threshold) && threshold > 0, 'порог сходимости независимой модели должен быть положительным');
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const alpha = spring.damping / (2 * spring.mass);
  const delta = omega0 * omega0 - alpha * alpha;
  const root = Math.sqrt(Math.abs(delta));
  const rate = delta >= 0 ? alpha : (omega0 * omega0) / (alpha + root);
  invariant(rate > 0, 'скорость сходимости независимой модели должна быть положительной');
  const firstEnvelope = rate + (8 * Math.abs(v0 - alpha)) / Math.E;
  const secondEnvelope = rate * Math.abs(v0) + (8 * Math.abs(omega0 * omega0 - alpha * v0)) / Math.E;
  const stableExponent = (8 * Math.log(Math.max(firstEnvelope, secondEnvelope) / (rate * threshold))) / 7;
  if (delta === 0) return stableExponent / rate;
  const amplitude = delta > 0
    ? Math.max(
        Math.hypot(1, (v0 - alpha) / root),
        Math.hypot(v0, (omega0 * omega0 - alpha * v0) / root),
      )
    : Math.max(
        1,
        Math.abs((v0 - alpha) / root),
        Math.abs(v0),
        Math.abs((omega0 * omega0 - alpha * v0) / root),
      );
  return Math.min(stableExponent, Math.log(amplitude / threshold)) / rate;
}

function strictGridIntervals(boundMs, frameStepMs) {
  invariant(Number.isFinite(boundMs) && boundMs >= 0, 'граница сетки не может быть отрицательной');
  invariant(Number.isFinite(frameStepMs) && frameStepMs > 0, 'шаг кадра должен быть положительным');
  return Math.floor(boundMs / frameStepMs) + 1;
}

function deriveReference(contract) {
  const moves = contract.timeline.filter(({ kind }) => kind === 'move');
  const up = contract.timeline.find(({ kind }) => kind === 'up');
  const interrupt = contract.timeline.find(({ kind }) => kind === 'interrupt');
  invariant(moves.length === 3 && up && interrupt, 'форма шкалы времени независимой модели изменилась');
  const lastMove = moves[moves.length - 1];
  const releaseFromPx = lastMove.y;
  const releaseTargetPx = contract.snapPoints[contract.expected.releaseTargetSnapIndex];
  const releaseVelocityPxPerSec = (up.y - lastMove.y) / ((up.atMs - lastMove.atMs) / 1000);
  const releaseAnchorMs = up.atMs + contract.frameStepMs;
  const releaseElapsedSec = (interrupt.atMs - releaseAnchorMs) / 1000;
  const releaseRange = releaseTargetPx - releaseFromPx;
  invariant(releaseRange !== 0, 'диапазон выпуска независимой модели выродился');
  const releaseV0 = releaseVelocityPxPerSec / releaseRange;
  const releaseAtInterrupt = solveReferenceSpring(releaseElapsedSec, releaseV0, contract.spring);
  const interruptValuePx = releaseFromPx + releaseAtInterrupt.value * releaseRange;
  const interruptVelocityPxPerSec = releaseAtInterrupt.velocity * releaseRange;
  const interruptTargetPx = contract.snapPoints[interrupt.snapIndex];
  const interruptRange = interruptTargetPx - interruptValuePx;
  invariant(interruptRange !== 0, 'диапазон прерывания независимой модели выродился');
  const interruptV0 = interruptVelocityPxPerSec / interruptRange;
  const settleBoundSec = settleBoundReference(interruptV0, contract.spring, contract.convergenceThreshold);
  const strictSettleIntervals = strictGridIntervals(settleBoundSec * 1000, contract.frameStepMs);
  const terminalAtMs = interrupt.atMs + contract.frameStepMs + strictSettleIntervals * contract.frameStepMs;
  return {
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
  };
}

const EXACT_FIELDS = Object.freeze([
  'releaseFromPx',
  'releaseTargetPx',
  'releaseVelocityPxPerSec',
  'releaseAnchorMs',
  'releaseElapsedSec',
  'interruptTargetPx',
  'strictSettleIntervals',
  'terminalAtMs',
]);
const FLOAT_FIELDS = Object.freeze([
  'interruptValuePx',
  'interruptVelocityPxPerSec',
  'interruptRange',
  'interruptV0',
  'settleBoundSec',
]);
const EXPECTED_ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);

function assertDerivation(actual, expected) {
  invariant(actual && expected, 'требуется расчёт границы');
  for (const field of EXACT_FIELDS) {
    invariant(actual[field] === expected[field], `поле расчёта ${field} изменилось (${actual[field]} != ${expected[field]})`);
  }
  for (const field of FLOAT_FIELDS) {
    invariant(nearlyEqual(actual[field], expected[field]), `поле расчёта ${field} изменилось (${actual[field]} != ${expected[field]})`);
  }
}

function validateDerivation(contract) {
  const reference = deriveReference(contract);
  assertDerivation(contract.derivation, reference);

  const gridN = 17;
  const exactGridMs = gridN * contract.frameStepMs;
  invariant(strictGridIntervals(exactGridMs - 1e-9, contract.frameStepMs) === gridN, 'закон нижней границы строгой кадровой сетки изменился');
  invariant(strictGridIntervals(exactGridMs, contract.frameStepMs) === gridN + 1, 'закон точной границы строгой кадровой сетки изменился');
  invariant(strictGridIntervals(exactGridMs + 1e-9, contract.frameStepMs) === gridN + 1, 'закон верхней границы строгой кадровой сетки изменился');

  const tighter = settleBoundReference(reference.interruptV0, contract.spring, contract.convergenceThreshold / 2);
  const looser = settleBoundReference(reference.interruptV0, contract.spring, contract.convergenceThreshold * 2);
  invariant(tighter > reference.settleBoundSec, 'более строгий порог сходимости не увеличил верхнюю границу');
  invariant(looser < reference.settleBoundSec, 'более мягкий порог сходимости не уменьшил верхнюю границу');

  for (const v0 of [-25, -5, 0, 5, 25]) {
    const state = solveReferenceSpring(0.164, v0, contract.spring);
    invariant(Number.isFinite(state.value) && Number.isFinite(state.velocity), `независимая модель не конечна для класса направления v0=${v0}`);
    invariant(Number.isFinite(settleBoundReference(v0, contract.spring, contract.convergenceThreshold)), `независимая граница сходимости не конечна для v0=${v0}`);
  }

  const controls = Object.freeze({
    settleDriftRejected: expectReject(
      () => assertDerivation({ ...contract.derivation, settleBoundSec: contract.derivation.settleBoundSec + 0.001 }, reference),
      'settle-bound-drift',
      INVARIANT_PREFIX,
    ),
    velocityDriftRejected: expectReject(
      () => assertDerivation({ ...contract.derivation, interruptVelocityPxPerSec: 0 }, reference),
      'interrupt-velocity-drift',
      INVARIANT_PREFIX,
    ),
    terminalDriftRejected: expectReject(
      () => assertDerivation({ ...contract.derivation, terminalAtMs: contract.derivation.terminalAtMs - contract.frameStepMs }, reference),
      'terminal-grid-drift',
      INVARIANT_PREFIX,
    ),
    invalidThresholdRejected: expectReject(
      () => settleBoundReference(reference.interruptV0, contract.spring, 0),
      'invalid-convergence-threshold',
      INVARIANT_PREFIX,
    ),
  });

  return { reference, controls };
}

export function validateSheetObservableV4Velocity(receipt, expectedHarnessRevision, contract = SHEET_OBSERVABLE_V4) {
  invariant(/^[0-9a-f]{40}$/.test(expectedHarnessRevision), 'ожидаемая ревизия harness должна быть точным Git SHA');
  invariant(receipt?.harnessRevision === expectedHarnessRevision, 'ревизия harness в квитанции не совпадает с проверяемой');
  invariant(receipt?.status === 'PASS', 'квитанция опыта не имеет статуса PASS');
  invariant(receipt?.baselineRevision === contract.baselineRevision, 'ревизия базовой линии изменилась');
  invariant(Array.isArray(receipt?.engines) && receipt.engines.length === EXPECTED_ENGINES.length, 'состав браузерных движков изменился');
  const engineNames = receipt.engines.map(({ engine }) => engine);
  invariant(
    new Set(engineNames).size === EXPECTED_ENGINES.length
      && EXPECTED_ENGINES.every((engine) => engineNames.includes(engine)),
    'квитанция содержит неполный, повторяющийся или неверный набор браузерных движков',
  );

  const derivation = validateDerivation(contract);
  const velocityControls = Object.freeze({
    zeroVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: 0 }, { velocity: 0 }, contract.expected.movementDirection),
      'zero-velocity-handoff',
      INVARIANT_PREFIX,
    ),
    reverseVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: -1 }, { velocity: -1 }, contract.expected.movementDirection),
      'reverse-velocity-handoff',
      INVARIANT_PREFIX,
    ),
    discontinuousVelocityRejected: expectReject(
      () => assertVelocityHandoff({ velocity: 1 }, { velocity: 2 }, contract.expected.movementDirection),
      'discontinuous-velocity-handoff',
      INVARIANT_PREFIX,
    ),
  });

  for (const engine of receipt.engines) {
    invariant(engine.status === 'PASS', `${engine.engine}: опыт не прошёл`);
    invariant(engine.terminalObservedAtMs === derivation.reference.terminalAtMs, `${engine.engine}: неверный момент терминального наблюдения`);
    invariant(engine.pendingAtDeadline === 0, `${engine.engine}: на дедлайне осталась работа в планировщике`);
    for (const [field, expected] of Object.entries(contract.expected.terminal)) {
      invariant(engine.terminal?.[field] === expected, `${engine.engine}: поле терминального состояния ${field} изменилось`);
    }
    invariant(Number.isFinite(engine.movementBefore?.velocity), `${engine.engine}: скорость первого кадра не конечна`);
    invariant(Math.sign(engine.movementBefore.velocity) === contract.expected.movementDirection, `${engine.engine}: скорость первого кадра имеет неверное направление`);
    invariant(Number.isFinite(engine.movementAfter?.velocity), `${engine.engine}: скорость движения не конечна`);
    invariant(Math.sign(engine.movementAfter.velocity) === contract.expected.movementDirection, `${engine.engine}: скорость движения имеет неверное направление`);
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
    invariant: 'M-06: полный перенос скорости на границе прерывания/смены цели и независимая проверка расчёта',
    derivation: {
      reference: derivation.reference,
      controls: derivation.controls,
    },
    engines: receipt.engines.map((engine) => ({
      engine: engine.engine,
      version: engine.version,
      firstFrameVelocity: engine.movementBefore.velocity,
      movementVelocity: engine.movementAfter.velocity,
      atInterruptVelocity: engine.atInterrupt.velocity,
      afterInterruptVelocity: engine.afterInterrupt.velocity,
      status: 'PASS',
    })),
    controls: velocityControls,
  };
}

async function main() {
  const receiptPath = process.argv[2];
  const outputPath = process.argv[3];
  const expectedHarnessRevision = process.argv[4];
  invariant(receiptPath && outputPath && expectedHarnessRevision, 'CLI требует <receipt.json> <validation.json> <harness-sha>');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const validation = validateSheetObservableV4Velocity(receipt, expectedHarnessRevision);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: validation.status, outputPath })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();