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
import {
  PROFILE_01,
  preregistrationDigest,
  verifyPreregistration,
} from './profile-01-preregistration.mjs';

function fail(message) {
  throw new Error(`PROFILE-01 probe (fail-closed): ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    fail('git недоступен для доказательства provenance');
  }
}

function gitBlob(cwd, rev, path) {
  try {
    return execFileSync('git', ['rev-parse', `${rev}:${path}`], { cwd, encoding: 'utf8' }).trim();
  } catch {
    fail(`git не смог доказать blob ${path}@${rev}`);
  }
}

function gitDiffNames(cwd, base, head) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${base}`, `${head}`], { cwd, encoding: 'utf8' });
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    fail(`git не смог доказать эквивалентность дерева ${base}..${head}`);
  }
}

function isAncestor(cwd, base) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Измеряемое дерево обязано совпадать с PRODUCT_BASE везде, кроме самих
// файлов preregistration-пакета. Это позволяет снимать old-vector на
// PR-ветке, выросшей из PRODUCT_BASE, с доказанной эквивалентностью.
const PREREG_OWN_PATHS = Object.freeze([
  'bench/profile/profile-01-preregistration.mjs',
  'bench/profile/probe-profile-01.mjs',
  'bench/profile/validate-profile-01.mjs',
  '.github/workflows/profile-01.yml',
]);

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

function main() {
  const repoRoot = resolve(join(new URL('.', import.meta.url).pathname, '..', '..'));
  const mode = arg('--mode') ?? fail('требуется --mode old-vector|aa|ab');
  if (!['old-vector', 'aa', 'ab'].includes(mode)) fail(`неизвестный --mode ${mode}`);
  const cells = arg('--cells') ?? 'desktop';
  const outDir = resolve(arg('--out') ?? join(tmpdir(), 'profile-01-raw'));
  mkdirSync(outDir, { recursive: true });

  // 1. Frozen-контракт обязан проходить самопроверку до любых samples.
  verifyPreregistration(PROFILE_01);
  const digest = preregistrationDigest(PROFILE_01);

  // 2. Точный base/provenance.
  const head = gitHead(repoRoot);
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
  };

  if (mode === 'old-vector') {
    const base = PROFILE_01.productBase.mainSha;
    if (!isAncestor(repoRoot, base)) fail(`old-vector требует HEAD, выросший из PRODUCT_BASE ${base}`);
    const sizeGateBlob = gitBlob(repoRoot, 'HEAD', 'scripts/size-gate.mjs');
    if (sizeGateBlob !== '4b0f181212b65a881e750e84564778f5828448a3') {
      fail(`size-gate provenance drifted: ${sizeGateBlob}`);
    }
    const diffPaths = head === base ? [] : gitDiffNames(repoRoot, base, head);
    const foreign = diffPaths.filter((path) => !PREREG_OWN_PATHS.includes(path));
    if (foreign.length > 0) fail(`измеряемое дерево отличается от PRODUCT_BASE вне prereg-пакета: ${foreign.join(', ')}`);
    artifact.sizeGateBlob = sizeGateBlob;
    artifact.baseProof = { productBase: base, head, diffPaths };
    artifact.costVector = runSizeGate(repoRoot);
    if (artifact.costVector.exitCode !== 0) {
      fail(`старый cost vector не зелёный на PRODUCT_BASE (exit ${artifact.costVector.exitCode})`);
    }
    for (const [name, gate] of Object.entries(PROFILE_01.oldCostVectorGzipBytes.scenarios)) {
      if (!artifact.costVector.transcript.includes(`${name} `) && !artifact.costVector.transcript.includes(name)) {
        fail(`транскрипт size-gate не содержит сценарий ${name}`);
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
  const ready = mode === 'old-vector' && artifact.costVector !== null;
  artifact.finishedAtUtc = new Date().toISOString();
  artifact.admission = ready ? 'OLD-VECTOR-ONLY' : 'NOT-GRANTED';
  if (mode !== 'old-vector') {
    fail('aa/ab режимы требуют зелёной browser-калибровки на self-hosted runner; локальный запуск запрещён');
  }

  const rawPath = join(outDir, `profile-01-${mode}-${head.slice(0, 12)}.json`);
  writeFileSync(rawPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const rawDigest = createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rawPath, rawDigest, preregistrationDigest: digest, admission: artifact.admission }));
}

main();
