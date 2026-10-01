// PROFILE-01 probe: исполняемый измерительный стенд.
// Измерение размера использует обычную среду CI публичного репозитория.
// Оно не доказывает задержку, частоту кадров или свойства физического устройства.
// Недействительная калибровка или расхождение с протоколом запрещают допуск.
// Использование: node bench/profile/probe-profile-01.mjs --mode old-vector|aa|ab --cells desktop|all --out <dir>

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
  unmeasuredCells,
} from './profile-01-preregistration.mjs';
import { PREREG_OWN_PATHS, makeGit } from './profile-git-proof.mjs';
import { measureOldVector } from './profile-measurement.mjs';

function fail(message) {
  throw new Error(`PROFILE-01 probe (fail-closed): ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const git = makeGit(fail);

function writeArtifact(outDir, artifact, head, digest) {
  const rawPath = join(outDir, `profile-01-${artifact.mode}-${head.slice(0, 12)}.json`);
  const rawBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(rawPath, rawBytes);
  const rawDigest = createHash('sha256').update(rawBytes).digest('hex');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rawPath, rawDigest, preregistrationDigest: digest, admission: artifact.admission }));
}

// Отказ после измерения сохраняет артефакт с причиной и хешем.
// Отказ до измерения ещё не создаёт данных для сохранения.
function persistAndFail(outDir, artifact, head, digest, reason) {
  artifact.finishedAtUtc = new Date().toISOString();
  artifact.admission = 'NOT-GRANTED';
  artifact.rejection = reason;
  writeArtifact(outDir, artifact, head, digest);
  fail(reason);
}

async function main() {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const mode = arg('--mode') ?? fail('требуется --mode old-vector|aa|ab');
  if (!['old-vector', 'aa', 'ab'].includes(mode)) fail(`неизвестный --mode ${mode}`);
  const cells = arg('--cells') ?? 'desktop';
  if (!['desktop', 'all'].includes(cells)) fail(`неизвестный --cells ${cells}`);
  const outDir = resolve(arg('--out') ?? join(tmpdir(), 'profile-01-raw'));
  mkdirSync(outDir, { recursive: true });

  // Протокол проверяется до любых измерений.
  verifyPreregistration(PROFILE_01);
  const digest = preregistrationDigest(PROFILE_01);

  // 2. Точный base/provenance.
  const head = git.head(repoRoot);
  const artifact = {
    node: 'PROFILE-01',
    revision: 'r11',
    mode,
    cells,
    preregistrationDigest: digest,
    candidateSamplesObservedAtRegistration: false,
    head,
    sizeGateBlob: null,
    baseProof: null,
    seed: 20260929,
    startedAtUtc: new Date().toISOString(),
    cellsMeasured: [],
    cellsUnproven: unmeasuredCells(cells),
    rawControls: {},
    calibration: {},
    costVector: null,
    admission: 'NOT-GRANTED',
    rejection: null,
  };

  if (mode === 'old-vector') {
    const base = PROFILE_01.productBase.sourceSha;
    if (!git.ancestor(repoRoot, base)) fail(`old-vector требует HEAD, выросший из PRODUCT_BASE ${base}`);
    const sizeGateBlob = git.blob(repoRoot, 'HEAD', 'scripts/size-gate.mjs');
    if (sizeGateBlob !== PROFILE_01.productBase.sizeGateBlob) {
      fail(`size-gate provenance drifted: ${sizeGateBlob}`);
    }
    // Рабочая копия обязана совпадать с коммитом: иначе измеритель
    // исполнит непроверенный файл, а baseProof этого не покажет.
    const workingSizeGateBlob = git.workingBlob(repoRoot, 'scripts/size-gate.mjs');
    if (workingSizeGateBlob !== sizeGateBlob) {
      fail(`рабочая копия size-gate.mjs отличается от коммита: working ${workingSizeGateBlob}, committed ${sizeGateBlob}`);
    }
    const diffPaths = head === base ? [] : git.diffNames(repoRoot, base, head);
    const foreign = diffPaths.filter((path) => !PREREG_OWN_PATHS.includes(path));
    if (foreign.length > 0) fail(`измеряемое дерево отличается от PRODUCT_BASE вне prereg-пакета: ${foreign.join(', ')}`);
    artifact.sizeGateBlob = sizeGateBlob;
    artifact.baseProof = { productBase: base, head, diffPaths };
    try {
      artifact.costVector = await measureOldVector(repoRoot);
    } catch (error) {
      persistAndFail(outDir, artifact, head, digest, `незавершённое измерение: ${error.message}`);
    }
    if (artifact.costVector.exitCode !== 0) {
      persistAndFail(outDir, artifact, head, digest, `старый cost vector не зелёный на PRODUCT_BASE (exit ${artifact.costVector.exitCode})`);
    }
    for (const name of Object.keys(PROFILE_01.oldCostVectorGzipBytes.scenarios)) {
      if (!artifact.costVector.scenarios.some((row) => row.name === name)) {
        persistAndFail(outDir, artifact, head, digest, `size-gate не содержит сценарий ${name}`);
      }
    }
    artifact.cellsMeasured.push('desktop-size-vector');
  }

  // 4. Калибровка: A/A и deliberate 2×work обязаны быть явными.
  // Детализация timing-калибровки — в отдельной browser-фазе;
  // без пройденной калибровки admission не выдаётся (см. ниже).
  artifact.calibration = { aa: 'PENDING', positive2x: 'PENDING' };

  // Без калибровки aa/ab сохраняют отказ до завершения процесса.
  if (mode !== 'old-vector') {
    persistAndFail(outDir, artifact, head, digest, 'aa/ab режимы требуют отдельной зелёной browser-калибровки');
  }
  const ready = mode === 'old-vector' && artifact.costVector !== null;
  artifact.finishedAtUtc = new Date().toISOString();
  artifact.admission = ready ? 'OLD-VECTOR-ONLY' : 'NOT-GRANTED';
  if (!ready) {
    persistAndFail(outDir, artifact, head, digest, 'old-vector не готов: costVector отсутствует');
  }

  writeArtifact(outDir, artifact, head, digest);
}

await main();
