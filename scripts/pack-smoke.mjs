/**
 * pack-smoke.mjs — smoke-тест ШИПУЕМОГО АРТЕФАКТА (не исходников).
 *
 * Класс: «exports/files в тарболе битые у потребителя» — сьют этого не видит
 * (он импортирует src/), size-gate меряет dist/ на месте. Здесь же проверяется
 * ровно то, что получит npm-потребитель: `pnpm pack` → установка тарбола в
 * чистый временный проект → ESM-import и CJS-require реальных субпутей.
 *
 * Субпути с обязательным peer-фреймворком проверяются структурно. Все остальные,
 * включая zero-dependency Web Component binding, обязаны исполняться в ESM и CJS.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);

// Только entries, которые действительно требуют внешний peer во время импорта.
// `./wc` zero-dependency и обязан проходить исполняемый consumer-smoke.
const PEER_BINDING_SUBPATHS = new Set([
  './react',
  './svelte',
  './vue',
  './lit',
  './solid',
  './preact',
  './angular',
  './qwik',
]);

const work = mkdtempSync(join(tmpdir(), 'labmotion-pack-smoke-'));
let failed = false;
const log = (line) => console.log(line);

try {
  log(`pack-smoke: рабочая директория ${work}`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (pkg.engines?.node !== '>=22' || nodeMajor < 22) {
    throw new Error(
      `Node-контракт нарушен: раннер ${process.versions.node}, engines ${String(pkg.engines?.node)}`,
    );
  }
  let tarballPath;
  let tarball;
  if (suppliedTarball !== undefined) {
    if (!existsSync(suppliedTarball) || !suppliedTarball.endsWith('.tgz')) {
      throw new Error(`переданный tgz не найден: ${suppliedTarball}`);
    }
    tarballPath = suppliedTarball;
    tarball = basename(suppliedTarball);
    log(`pack-smoke: проверяется готовый тарбол ${tarball}`);
  } else {
    execSync(`pnpm pack --pack-destination "${work}"`, { cwd: ROOT, stdio: 'pipe' });
    tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error('pnpm pack не создал тарбол');
    tarballPath = join(work, tarball);
    log(`pack-smoke: собран тарбол ${tarball}`);
  }

  // Release job доверяет этому манифесту при переносе tgz через artifact.
  // Прогон на реальном pack не даёт release-only скрипту сгнить между версиями.
  const manifest = join(work, 'release-manifest.json');
  const releaseOutput = execFileSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'check-release-artifact.mjs'),
      tarballPath,
      `v${pkg.version}`,
      '0'.repeat(40),
      manifest,
    ],
    { encoding: 'utf8' },
  );
  if (!releaseOutput.includes(`package_identity=${pkg.name}@${pkg.version}`)) {
    throw new Error('release-манифест не подтвердил идентичность пакета');
  }
  log('release-манифест OK');

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
  );

  // npm устанавливает из локального файла; lifecycle пакета не нужен для проверки
  // уже собранного артефакта и не должен исполнять произвольные scripts.
  execSync(`npm install --ignore-scripts --no-audit --no-fund "${tarballPath}"`, {
    cwd: app,
    stdio: 'pipe',
  });

  const runnable = Object.keys(pkg.exports).filter((key) => !PEER_BINDING_SUBPATHS.has(key));

  // 1. Все независимые entries через ESM import.
  const esmProbe = `
    const names = ${JSON.stringify(runnable)};
    for (const sub of names) {
      const spec = sub === '.' ? '${pkg.name}' : '${pkg.name}/' + sub.slice(2);
      const module = await import(spec);
      if (Object.keys(module).length === 0) throw new Error('пустой ESM-модуль: ' + spec);
    }
    const { spring } = await import('${pkg.name}');
    const result = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);
    if (!Number.isFinite(result.value)) throw new Error('ESM spring вернул не-конечное');
    console.log('ESM OK: ' + names.length + ' entries');
  `;
  writeFileSync(join(app, 'esm.mjs'), esmProbe);
  log(execSync('node esm.mjs', { cwd: app, encoding: 'utf8' }).trim());

  // 2. Те же независимые entries через CJS require. Наличие файла недостаточно:
  // неверная interop-обёртка или транзитивный ESM-only import ломаются только здесь.
  const cjsProbe = `
    const names = ${JSON.stringify(runnable)};
    for (const sub of names) {
      const spec = sub === '.' ? '${pkg.name}' : '${pkg.name}/' + sub.slice(2);
      const module = require(spec);
      if (Object.keys(module).length === 0) throw new Error('пустой CJS-модуль: ' + spec);
    }
    const { spring } = require('${pkg.name}');
    const result = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);
    if (!Number.isFinite(result.value)) throw new Error('CJS spring вернул не-конечное');
    console.log('CJS OK: ' + names.length + ' entries');
  `;
  writeFileSync(join(app, 'cjs.cjs'), cjsProbe);
  log(execSync('node cjs.cjs', { cwd: app, encoding: 'utf8' }).trim());

  // 3. Обе runtime-ветки и соответствующие им декларации обязаны существовать.
  // Плоский общий types-путь здесь запрещён: CJS и ESM имеют разные форматы.
  const installedRoot = join(app, 'node_modules', ...pkg.name.split('/'));
  let checked = 0;
  for (const [key, value] of Object.entries(pkg.exports)) {
    const targets = {
      'import.types': value.import?.types,
      'import.default': value.import?.default,
      'require.types': value.require?.types,
      'require.default': value.require?.default,
    };
    for (const [condition, relativePath] of Object.entries(targets)) {
      if (!relativePath) {
        failed = true;
        log(`FAIL: exports['${key}'].${condition} отсутствует`);
        continue;
      }
      if (!existsSync(join(installedRoot, relativePath))) {
        failed = true;
        log(`FAIL: файл артефакта отсутствует: ${key} → ${relativePath}`);
      }
      checked++;
    }
  }
  log(`структура OK: ${checked} условных export-целей на месте`);

  // 4. Package metadata, license и README входят в npm-артефакт.
  for (const file of ['LICENSE', 'README.md', 'package.json']) {
    if (!existsSync(join(installedRoot, file))) {
      failed = true;
      log(`FAIL: ${file} не в артефакте`);
    }
  }

  // 5. Карты исключены package#files-контрактом. Runtime-файлы также не должны
  // ссылаться на отсутствующие карты: такая ссылка превращается в 404 в DevTools.
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  const maps = walk(installedRoot).filter((file) => file.endsWith('.map'));
  if (maps.length > 0) {
    failed = true;
    log(`FAIL: sourcemaps в артефакте (${maps.length} шт.): ${maps[0]}`);
  }
  const runtimeFiles = walk(installedRoot).filter((file) => /\.(?:c?js|mjs)$/.test(file));
  const danglingReferences = runtimeFiles.filter((file) =>
    /[#@]\s*sourceMappingURL=/.test(readFileSync(file, 'utf8')),
  );
  if (danglingReferences.length > 0) {
    failed = true;
    log(`FAIL: runtime ссылается на отсутствующую sourcemap: ${danglingReferences[0]}`);
  }
  if (maps.length === 0 && danglingReferences.length === 0) {
    log('sourcemaps: карты и битые ссылки отсутствуют ✓');
  }
} catch (error) {
  failed = true;
  console.error(
    'pack-smoke: сбой —',
    error?.stderr?.toString?.() || error?.message || error,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('pack-smoke: FAIL');
  process.exit(1);
}
console.log('pack-smoke: PASS');
