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

import { execSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

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
  execSync(`pnpm pack --pack-destination "${work}"`, { cwd: ROOT, stdio: 'pipe' });
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack не создал тарбол');
  log(`pack-smoke: тарбол ${tarball}`);

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
  );

  // npm устанавливает из локального файла; lifecycle пакета не нужен для проверки
  // уже собранного артефакта и не должен исполнять произвольные scripts.
  execSync(`npm install --ignore-scripts --no-audit --no-fund "${join(work, tarball)}"`, {
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

  // 3. Каждая объявленная exports-триада обязана существовать в артефакте.
  const installedRoot = join(app, 'node_modules', ...pkg.name.split('/'));
  let checked = 0;
  for (const [key, value] of Object.entries(pkg.exports)) {
    for (const condition of ['types', 'import', 'require']) {
      const relativePath = value[condition];
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
  log(`структура OK: ${checked} файлов exports-триад на месте`);

  // 4. Package metadata, license и README входят в npm-артефакт.
  for (const file of ['LICENSE', 'README.md', 'package.json']) {
    if (!existsSync(join(installedRoot, file))) {
      failed = true;
      log(`FAIL: ${file} не в артефакте`);
    }
  }

  // 5. Sourcemaps исключены package#files-контрактом: потребитель получает только
  // исполняемый dist и declarations, без лишнего веса и второго набора исходников.
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  const maps = walk(installedRoot).filter((file) => file.endsWith('.map'));
  if (maps.length > 0) {
    failed = true;
    log(`FAIL: sourcemaps в артефакте (${maps.length} шт.): ${maps[0]}`);
  } else {
    log('sourcemaps: отсутствуют в артефакте ✓');
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
