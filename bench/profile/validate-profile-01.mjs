// PROFILE-01 validate: независимая перепроверка raw-артефакта пробы.
// Повторяет размерные измерения; не удостоверяет время исторического запуска
// и не выдаёт допуска производительности или человеческой оценки.
// Использование: node bench/profile/validate-profile-01.mjs --raw <path>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
  unmeasuredCells,
} from './profile-01-preregistration.mjs';
import { PREREG_OWN_PATHS, makeGit } from './profile-git-proof.mjs';
import { measureOldVector, validateReplayedVector } from './profile-measurement.mjs';

function fail(message) {
  throw new Error(`PROFILE-01 validate (fail-closed): ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const rawPath = resolve(arg('--raw') ?? fail('требуется --raw <path>'));
  const artifact = JSON.parse(readFileSync(rawPath, 'utf8'));
  if (artifact.node !== 'PROFILE-01' || artifact.revision !== 'r11' ||
      !['old-vector', 'aa', 'ab'].includes(artifact.mode)) fail('неверный вид артефакта');
  if (!isDeepStrictEqual(artifact.cellsUnproven, unmeasuredCells(artifact.cells))) {
    fail('неизмеренные клетки потеряны или подменены');
  }
  const expectedMeasured = artifact.admission === 'OLD-VECTOR-ONLY' ? ['desktop-size-vector'] : [];
  if (!isDeepStrictEqual(artifact.cellsMeasured, expectedMeasured)) fail('неверный набор измеренных клеток');

  // 1. Замороженный контракт не менялся.
  verifyPreregistration(PROFILE_01);
  const frozen = preregistrationDigest(PROFILE_01);
  if (artifact.preregistrationDigest !== frozen) {
    fail(`preregistration не совпадает: artifact ${artifact.preregistrationDigest}, frozen ${frozen}`);
  }
  if (artifact.candidateSamplesObservedAtRegistration !== false) {
    fail('preregistration обязана предшествовать samples');
  }

  // Происхождение исходников пересчитывается независимо через Git.
  // Валидатор не доверяет полям raw JSON: HEAD, ancestry, diff и blob
  // пересчитываются из checkout, в котором запущен валидатор.
  // Записанный exitCode не удостоверяет измерение. После проверки Git повторяем
  // сборку и существующий size-gate; сравниваем данные, а не формат console.log.
  if (artifact.mode === 'old-vector') {
    const base = PROFILE_01.productBase.sourceSha;
    const proof = artifact.baseProof ?? {};
    if (proof.productBase !== base || proof.head !== artifact.head) fail('baseProof не покрывает artifact head');
    if (!Array.isArray(proof.diffPaths)) fail('baseProof.diffPaths отсутствует');
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const git = makeGit(fail);
    const currentHead = git.head(repoRoot);
    if (currentHead !== artifact.head) {
      fail(`валидатор запущен не на artifact head: checkout ${currentHead}, artifact ${artifact.head}`);
    }
    if (!git.ancestor(repoRoot, base)) fail(`artifact head не вырос из PRODUCT_BASE ${base}`);
    const recomputed = currentHead === base ? [] : git.diffNames(repoRoot, base, currentHead);
    const asSet = (paths) => JSON.stringify([...paths].sort());
    if (asSet(recomputed) !== asSet(proof.diffPaths)) {
      fail(`baseProof.diffPaths не совпадает с git: artifact [${proof.diffPaths.join(', ')}], git [${recomputed.join(', ')}]`);
    }
    const foreign = recomputed.filter((path) => !PREREG_OWN_PATHS.includes(path));
    if (foreign.length > 0) fail(`дерево отличается от PRODUCT_BASE вне prereg-пакета: ${foreign.join(', ')}`);
    const committed = git.blob(repoRoot, artifact.head, 'scripts/size-gate.mjs');
    if (committed !== PROFILE_01.productBase.sizeGateBlob || committed !== artifact.sizeGateBlob) {
      fail(`size-gate provenance drifted: artifact ${artifact.sizeGateBlob}, git ${committed}`);
    }
    if (artifact.admission === 'OLD-VECTOR-ONLY') {
      validateReplayedVector(artifact.costVector, await measureOldVector(repoRoot));
    }
  }

  // 3. A/B без калибровки не существует.
  if (artifact.mode !== 'old-vector' && artifact.admission !== 'NOT-GRANTED') {
    fail('некалиброванный A/B не может нести admission');
  }
  if (artifact.admission !== 'NOT-GRANTED' && artifact.admission !== 'OLD-VECTOR-ONLY') {
    fail(`неизвестный admission ${artifact.admission}`);
  }
  // Отклонённый артефакт обязан нести причину: NOT-GRANTED без rejection
  // означает потерянный failure (OBSERVATION_POLICY нарушена).
  if (artifact.admission === 'NOT-GRANTED') {
    if (typeof artifact.rejection !== 'string' || artifact.rejection.length === 0) {
      fail('NOT-GRANTED артефакт обязан содержать непустой rejection');
    }
  } else if (artifact.rejection !== null && artifact.rejection !== undefined) {
    fail('успешный артефакт не должен нести rejection');
  }

  // 4. Affected cells обязаны быть перечислены, а не молча пропущены.
  if (!Array.isArray(artifact.cellsUnproven)) fail('cellsUnproven обязан быть списком');
  if (!Array.isArray(artifact.cellsMeasured)) fail('cellsMeasured обязан быть списком');

  // 5. Времена и seed фиксированы.
  if (!Number.isFinite(Date.parse(artifact.startedAtUtc ?? ''))) fail('startedAtUtc отсутствует');
  if (!Number.isFinite(Date.parse(artifact.finishedAtUtc ?? ''))) fail('finishedAtUtc отсутствует');
  if (Date.parse(artifact.finishedAtUtc) < Date.parse(artifact.startedAtUtc)) fail('время окончания предшествует началу');
  if (artifact.seed !== 20260929) fail('seed drifted');

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ valid: true, mode: artifact.mode, admission: artifact.admission,
    verification: artifact.admission === 'OLD-VECTOR-ONLY' ? 'independent-size-remeasurement' : 'recorded-refusal-only' }));
}

await main();
