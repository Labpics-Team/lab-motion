/**
 * pack-smoke.mjs — smoke-тест ШИПУЕМОГО АРТЕФАКТА (не исходников).
 *
 * Класс: «exports/files в тарболе битые у потребителя» — сьют этого не видит
 * (он импортирует src/), size-gate меряет dist/ на месте. Здесь же проверяется
 * ровно то, что получит npm-потребитель: `pnpm pack` → установка тарбола в
 * чистый временный проект → ESM-import и CJS-require реальных субпутей.
 *
 * Беззависимые субпути проверяются исполнением; биндинги (react/svelte/...)
 * требуют peer-рантаймов — для них проверяется наличие файлов exports-триады
 * в распакованном тарболе (структурная гарантия без установки 9 фреймворков).
 *
 * Выход 0 = артефакт цел; любой сбой = exit 1 (громко, в CI).
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Биндинги требуют peer-фреймворк — исполняемо их не проверить в голом node
// (для них остаётся структурная проверка триад ниже). ВСЁ ОСТАЛЬНОЕ из exports
// выводится автоматически и ОБЯЗАНО импортироваться: новый субпуть попадает
// в исполняемую проверку сам, drift-точки ручного списка не существует.
const BINDING_SUBPATHS = new Set(['./react', './svelte', './vue', './lit', './solid', './preact', './angular', './wc', './qwik']);

const work = mkdtempSync(join(tmpdir(), 'labmotion-pack-smoke-'));
let failed = false;
const log = (line) => console.log(line);

try {
  log(`pack-smoke: рабочая директория ${work}`);
  execSync(`pnpm pack --pack-destination "${work}"`, { cwd: ROOT, stdio: 'pipe' });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack не создал тарбол');
  log(`pack-smoke: тарбол ${tarball}`);

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  // npm устанавливает из файла оффлайн; --ignore-scripts — least privilege.
  execSync(`npm install --ignore-scripts --no-audit --no-fund "${join(work, tarball)}"`, {
    cwd: app,
    stdio: 'pipe',
  });

  // 1. Исполняемые субпути: ESM-import + базовый вызов ядра.
  const runnable = Object.keys(pkg.exports).filter((k) => !BINDING_SUBPATHS.has(k));
  const esmProbe = `
    const names = ${JSON.stringify(runnable)};
    for (const sub of names) {
      const spec = sub === '.' ? '${pkg.name}' : '${pkg.name}/' + sub.slice(2);
      const m = await import(spec);
      if (Object.keys(m).length === 0) throw new Error('пустой модуль: ' + spec);
    }
    const { spring } = await import('${pkg.name}');
    const r = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);
    if (!Number.isFinite(r.value)) throw new Error('spring вернул не-конечное');
    console.log('ESM OK: ' + names.length + ' субпутей, spring(0.1)=' + r.value.toFixed(4));
  `;
  writeFileSync(join(app, 'esm.mjs'), esmProbe);
  log(execSync('node esm.mjs', { cwd: app, encoding: 'utf8' }).trim());

  // 2. CJS-require ядра (условие require в exports).
  const cjsProbe = `
    const { spring } = require('${pkg.name}');
    const r = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);
    if (!Number.isFinite(r.value)) throw new Error('CJS spring вернул не-конечное');
    console.log('CJS OK: spring(0.1)=' + r.value.toFixed(4));
  `;
  writeFileSync(join(app, 'cjs.cjs'), cjsProbe);
  log(execSync('node cjs.cjs', { cwd: app, encoding: 'utf8' }).trim());

  // 3. Структурная проверка ВСЕХ exports-субпутей (включая биндинги):
  //    каждая объявленная триада types/import/require существует в артефакте.
  const installedRoot = join(app, 'node_modules', ...pkg.name.split('/'));
  let checked = 0;
  for (const [key, value] of Object.entries(pkg.exports)) {
    for (const cond of ['types', 'import', 'require']) {
      const rel = value[cond];
      if (!rel) { failed = true; log(`FAIL: exports['${key}'].${cond} отсутствует`); continue; }
      if (!existsSync(join(installedRoot, rel))) {
        failed = true;
        log(`FAIL: файл артефакта отсутствует: ${key} → ${rel}`);
      }
      checked++;
    }
  }
  log(`структура OK: ${checked} файлов exports-триад на месте`);

  // 4. LICENSE и README обязаны попасть в артефакт.
  for (const f of ['LICENSE', 'README.md', 'package.json']) {
    if (!existsSync(join(installedRoot, f))) { failed = true; log(`FAIL: ${f} не в артефакте`); }
  }

  // 5. Sourcemaps НЕ имеют права попасть в артефакт: sourcesContent раскрывает
  //    полные исходники приватного репо (прецедент @labpics/colors — без карт).
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
  const maps = walk(installedRoot).filter((f) => f.endsWith('.map'));
  if (maps.length > 0) {
    failed = true;
    log(`FAIL: sourcemaps в артефакте (${maps.length} шт.): ${maps[0]}`);
  } else {
    log('sourcemaps: отсутствуют в артефакте ✓');
  }
} catch (err) {
  failed = true;
  console.error('pack-smoke: сбой —', err?.stderr?.toString?.() || err?.message || err);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('pack-smoke: FAIL');
  process.exit(1);
}
console.log('pack-smoke: PASS');
