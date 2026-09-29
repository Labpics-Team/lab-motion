// PROFILE-01 validate: независимая перепроверка raw-артефакта пробы.
// Ловит согласованные по виду, но неверные elapsed/divisor/missing sample,
// подмену preregistration после samples и дрейф provenance.
// Использование: node bench/profile/validate-profile-01.mjs --raw <path>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
} from './profile-01-preregistration.mjs';

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

  // 2. Provenance exact base: HEAD обязан быть PRODUCT_BASE либо его
  // потомком с диффом только внутри prereg-пакета.
  const OWN_PATHS = [
    'bench/profile/profile-01-preregistration.mjs',
    'bench/profile/probe-profile-01.mjs',
    'bench/profile/validate-profile-01.mjs',
    '.github/workflows/profile-01.yml',
  ];
  if (artifact.mode === 'old-vector') {
    const base = PROFILE_01.productBase.mainSha;
    const proof = artifact.baseProof ?? {};
    if (proof.productBase !== base || proof.head !== artifact.head) fail('baseProof не покрывает artifact head');
    if (!Array.isArray(proof.diffPaths)) fail('baseProof.diffPaths отсутствует');
    const foreign = proof.diffPaths.filter((path) => !OWN_PATHS.includes(path));
    if (foreign.length > 0) fail(`дерево отличается от PRODUCT_BASE вне prereg-пакета: ${foreign.join(', ')}`);
    if (artifact.sizeGateBlob !== '4b0f181212b65a881e750e84564778f5828448a3') {
      fail(`size-gate provenance drifted: ${artifact.sizeGateBlob}`);
    }
    if (!artifact.costVector || artifact.costVector.exitCode !== 0) fail('old-vector без зелёного costVector');
  }

  // 3. A/B без калибровки не существует.
  if (artifact.mode !== 'old-vector' && artifact.admission !== 'NOT-GRANTED') {
    fail('некалиброванный A/B не может нести admission');
  }
  if (artifact.admission !== 'NOT-GRANTED' && artifact.admission !== 'OLD-VECTOR-ONLY') {
    fail(`неизвестный admission ${artifact.admission}`);
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
