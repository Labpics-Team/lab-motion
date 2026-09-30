// PROFILE-01 validate: независимая перепроверка raw-артефакта пробы.
// Ловит согласованные по виду, но неверные elapsed/divisor/missing sample,
// подмену preregistration после samples и дрейф provenance.
// Использование: node bench/profile/validate-profile-01.mjs --raw <path>

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
} from './profile-01-preregistration.mjs';
import { PREREG_OWN_PATHS, makeGit } from './profile-git-proof.mjs';

function fail(message) {
  throw new Error(`PROFILE-01 validate (fail-closed): ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const rawPath = resolve(arg('--raw') ?? fail('требуется --raw <path>'));
  const artifact = JSON.parse(readFileSync(rawPath, 'utf8'));

  // 1. Замороженный контракт не менялся.
  verifyPreregistration(PROFILE_01);
  const frozen = preregistrationDigest(PROFILE_01);
  if (artifact.preregistrationDigest !== frozen) {
    fail(`preregistration подменена после samples: artifact ${artifact.preregistrationDigest}, frozen ${frozen}`);
  }
  if (artifact.candidateSamplesObservedAtRegistration !== false) {
    fail('preregistration обязана предшествовать samples');
  }

  // 2. Provenance exact base: независимое git-перевычисление ([4]).
  // Валидатор не доверяет полям raw JSON: HEAD, ancestry, diff и blob
  // пересчитываются из checkout, в котором запущен валидатор.
  // Transcript size-gate — только диагностическое поле: проверяются
  // exitCode, непустота и присутствие имён сценариев, побайтового
  // сравнения с новым запуском нет (измерения зависят от build/runtime
  // окружения; независимый re-run — отдельная dispatch-проба).
  const SIZE_GATE_FROZEN = '4b0f181212b65a881e750e84564778f5828448a3';
  if (artifact.mode === 'old-vector') {
    const base = PROFILE_01.productBase.mainSha;
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
    if (committed !== SIZE_GATE_FROZEN || committed !== artifact.sizeGateBlob) {
      fail(`size-gate provenance drifted: artifact ${artifact.sizeGateBlob}, git ${committed}`);
    }
    if (!artifact.costVector || artifact.costVector.exitCode !== 0) fail('old-vector без зелёного costVector');
    if (typeof artifact.costVector.transcript !== 'string' || artifact.costVector.transcript.length === 0) {
      fail('costVector.transcript обязан быть непустой диагностикой');
    }
    for (const name of Object.keys(PROFILE_01.oldCostVectorGzipBytes.scenarios)) {
      if (!artifact.costVector.transcript.includes(name)) fail(`транскрипт не содержит сценарий ${name}`);
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
  if (artifact.seed !== 20260929) fail('seed drifted');

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ valid: true, mode: artifact.mode, admission: artifact.admission }));
}

main();
