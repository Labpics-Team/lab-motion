// PROFILE-01 probe: исполняемый измерительный стенд.
// Запуск ТОЛЬКО на штатных self-hosted runners (de-04 первым по CI-контракту),
// никогда в песочнице и никогда на платных GitHub-hosted runners.
// Fail-closed: невалидная калибровка или несоответствие frozen-контракта
// останавливают admission, а не дают «зелёный» результат.
// Использование: node bench/profile/probe-profile-01.mjs --mode old-vector|aa|ab --cells desktop|all --out <dir>

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
} from './profile-01-preregistration.mjs';
import { PREREG_OWN_PATHS, makeGit } from './profile-git-proof.mjs';

function fail(message) {
  throw new Error(`PROFILE-01 probe (fail-closed): ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const git = makeGit(fail);

function runSizeGate(repoRoot) {
  // scripts/size-gate.mjs не имеет --json: сырьём является точный stdout
  // плюс exit code. Требует собранный dist (pnpm build) — только self-hosted.
  try {
    const transcript = execFileSync('node', ['scripts/size-gate.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, transcript };
  } catch (error) {
    return { exitCode: error?.status ?? 1, transcript: String(error?.stdout ?? error?.message ?? error) };
  }
}

function writeArtifact(outDir, artifact, head, digest) {
  const rawPath = join(outDir, `profile-01-${artifact.mode}-${head.slice(0, 12)}.json`);
  writeFileSync(rawPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const rawDigest = createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rawPath, rawDigest, preregistrationDigest: digest, admission: artifact.admission }));
}

// Post-measurement отказ обязан сначала Persist артефакт с причиной
// (OBSERVATION_POLICY: failures сохраняются с digest), затем fail.
// Pre-measurement отказы (ancestry/blob/diff до runSizeGate) остаются
// fail-fast без артефакта: измерения ещё не было.
function persistAndFail(outDir, artifact, head, digest, reason) {
  artifact.finishedAtUtc = new Date().toISOString();
  artifact.admission = 'NOT-GRANTED';
  artifact.rejection = reason;
  writeArtifact(outDir, artifact, head, digest);
  fail(reason);
}

function main() {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const mode = arg('--mode') ?? fail('требуется --mode old-vector|aa|ab');
  if (!['old-vector', 'aa', 'ab'].includes(mode)) fail(`неизвестный --mode ${mode}`);
  const cells = arg('--cells') ?? 'desktop';
  const outDir = resolve(arg('--out') ?? join(tmpdir(), 'profile-01-raw'));
  mkdirSync(outDir, { recursive: true });

  // 1. Frozen-контракт обязан проходить самопроверку до любых samples.
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
    cellsUnproven: [],
    rawControls: {},
    calibration: {},
    costVector: null,
    admission: 'NOT-GRANTED',
    rejection: null,
  };

  if (mode === 'old-vector') {
    const base = PROFILE_01.productBase.mainSha;
    if (!git.ancestor(repoRoot, base)) fail(`old-vector требует HEAD, выросший из PRODUCT_BASE ${base}`);
    const sizeGateBlob = git.blob(repoRoot, 'HEAD', 'scripts/size-gate.mjs');
    if (sizeGateBlob !== '4b0f181212b65a881e750e84564778f5828448a3') {
      fail(`size-gate provenance drifted: ${sizeGateBlob}`);
    }
    // [0] Рабочая копия обязана совпадать с коммитом: иначе runSizeGate
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
    artifact.costVector = runSizeGate(repoRoot);
    if (artifact.costVector.exitCode !== 0) {
      persistAndFail(outDir, artifact, head, digest, `старый cost vector не зелёный на PRODUCT_BASE (exit ${artifact.costVector.exitCode})`);
    }
    for (const [name, gate] of Object.entries(PROFILE_01.oldCostVectorGzipBytes.scenarios)) {
      if (!artifact.costVector.transcript.includes(`${name} `) && !artifact.costVector.transcript.includes(name)) {
        persistAndFail(outDir, artifact, head, digest, `транскрипт size-gate не содержит сценарий ${name}`);
      }
    }
    artifact.cellsMeasured.push('desktop-size-vector');
  }

  // 3. Клетки устройств: измеряется только прикреплённое железо.
  // Физические Android/iOS без device-lab конфига — affected cells, не success.
  const deviceLab = process.env.PROFILE_01_DEVICE_LAB ?? '';
  if (cells === 'all' && deviceLab === '') {
    for (const cell of PROFILE_01.affectedCellsMissingHw) {
      artifact.cellsUnproven.push({ cell: cell.cell, reason: 'no attached device lab; affected cell, admission blocked', blocks: cell.blocks });
    }
    artifact.cellsUnproven.push({ cell: 'android-mid-60', reason: 'no attached device lab', blocks: 'A/B admission Android-клеток' });
    artifact.cellsUnproven.push({ cell: 'ios-60', reason: 'no attached device lab', blocks: 'A/B admission iOS-клеток' });
  }

  // 4. Калибровка: A/A и deliberate 2×work обязаны быть явными.
  // Детализация timing-калибровки — в browser-фазе на self-hosted runner;
  // без пройденной калибровки admission не выдаётся (см. ниже).
  artifact.calibration = { aa: 'PENDING', positive2x: 'PENDING' };

  // 5. Fail-closed итог: без зелёной калибровки admission запрещён.
  // Отклонённые aa/ab обязаны Persist failure-артефакт до fail ([2]):
  // OBSERVATION_POLICY требует сохранять failures с digest.
  if (mode !== 'old-vector') {
    persistAndFail(outDir, artifact, head, digest, 'aa/ab режимы требуют зелёной browser-калибровки на self-hosted runner; локальный запуск запрещён');
  }
  const ready = mode === 'old-vector' && artifact.costVector !== null;
  artifact.finishedAtUtc = new Date().toISOString();
  artifact.admission = ready ? 'OLD-VECTOR-ONLY' : 'NOT-GRANTED';
  if (!ready) {
    persistAndFail(outDir, artifact, head, digest, 'old-vector не готов: costVector отсутствует');
  }

  writeArtifact(outDir, artifact, head, digest);
}

main();
