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
import { parseBenchmarkDocumentationState } from '../bench/compare/report-contract.mjs';

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

  const installedRoot = join(app, 'node_modules', ...pkg.name.split('/'));
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  // Пол читается ИЗ АРХИВА, а не из констант скрипта: смысл проверки в том,
  // что раннер удовлетворяет тому, что реально отгружено. Minor обязателен —
  // граница `require(esm)` проходит внутри major 22 (22.12), и пол вида
  // «>=22» молча пустил бы 22.0, где CJS-потребитель получил бы ERR_REQUIRE_ESM.
  const floorMatch = /^>=(\d+)\.(\d+)$/.exec(installedPackage.engines?.node ?? '');
  if (floorMatch === null) {
    throw new Error(`архив содержит неканонический engines.node: ${String(installedPackage.engines?.node)}`);
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const floorMajor = Number(floorMatch[1]);
  const floorMinor = Number(floorMatch[2]);
  if (
    !Number.isSafeInteger(nodeMajor) || !Number.isSafeInteger(nodeMinor)
    || nodeMajor < floorMajor || (nodeMajor === floorMajor && nodeMinor < floorMinor)
  ) {
    throw new Error(`Node ${process.versions.node} ниже отгруженного floor ${installedPackage.engines.node}`);
  }
  log(`Node contract: архив ${installedPackage.engines.node}, раннер ${process.versions.node} ✓`);

  const runnable = Object.keys(installedPackage.exports).filter((key) => !PEER_BINDING_SUBPATHS.has(key));

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

  // 3. Публичный frame, фасад ./animate и zero-dependency binding обязаны разделять один
  // scheduler ИМЕННО после pack/install. Source-тест не ловит дублирование,
  // которое создаёт сборщик при `splitting: false`: три entry могли пройти все
  // тесты, но поставить три native rAF на одном экране.
  const sharedFrameProbe = (moduleKind) => `
    const queue = [];
    let requests = 0;
    globalThis.requestAnimationFrame = (cb) => {
      queue.push(cb);
      requests++;
      return requests;
    };

    ${moduleKind === 'esm'
      ? `const { frame } = await import('${pkg.name}/frame');
    const { animate } = await import('${pkg.name}/animate');
    const { createLabSpringElementClass } = await import('${pkg.name}/wc');`
      : `const { frame } = require('${pkg.name}/frame');
    const { animate } = require('${pkg.name}/animate');
    const { createLabSpringElementClass } = require('${pkg.name}/wc');`}

    const values = new Map([['opacity', '0']]);
    const target = {
      style: {
        getPropertyValue: (name) => values.get(name) ?? '',
        setProperty: (name, value) => values.set(name, value),
      },
    };
    class Base {
      style = {};
      getAttribute() { return null; }
    }

    // animate первым — иначе «получилось 1» было бы верно и для фасада,
    // который не планирует ничего (см. пробу смешанного графа ниже).
    animate(target, { opacity: 1 });
    if (requests !== 1) {
      throw new Error('animate не поставил кадр: rAF получено ' + requests + ', проба вакуумна');
    }
    frame.update(() => {});
    const Host = createLabSpringElementClass(Base);
    const host = new Host();
    host.connectedCallback();
    host.attributeChangedCallback('target', '0', '1');

    if (requests !== 1) {
      throw new Error('frame singleton раздвоен: ожидался 1 rAF, получено ' + requests);
    }
    if (queue.length === 0) throw new Error('очередь кадров пуста — гасить нечего, проба вакуумна');
    frame.cancelAll();
    queue.shift()();
    if (requests !== 1) throw new Error('cancelAll не погасил общий scheduler');
    console.log('${moduleKind.toUpperCase()} shared frame OK: 3 consumers → 1 rAF');
  `;
  writeFileSync(join(app, 'shared-frame.mjs'), sharedFrameProbe('esm'));
  log(execSync('node shared-frame.mjs', { cwd: app, encoding: 'utf8' }).trim());
  writeFileSync(join(app, 'shared-frame.cjs'), sharedFrameProbe('cjs'));
  log(execSync('node shared-frame.cjs', { cwd: app, encoding: 'utf8' }).trim());

  // 3b. СМЕШАННЫЙ ГРАФ в ОДНОМ процессе. Пробы выше гоняют ESM и CJS порознь,
  // поэтому дублирование модуля им не видно: у каждой свой процесс и свой
  // экземпляр по определению. Реальное же приложение почти всегда смешанное —
  // ESM-код приложения импортирует пакет, а какая-нибудь CJS-зависимость его
  // же требует. При двухформатной поставке (условные ветки import/require)
  // такой граф получал ДВА экземпляра модульного состояния: два кадровых
  // цикла, два реестра animate, два rAF на кадр — и cancelAll из одной
  // половины не гасил вторую. Одноформатная поставка исключает это по
  // построению, и вот проверка, что исключает на самом деле, а не на словах.
  const mixedGraphProbe = `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);

    const queue = [];
    let requests = 0;
    globalThis.requestAnimationFrame = (cb) => { queue.push(cb); requests++; return requests; };

    // Одна и та же цель, два способа подключения: тождество обязано совпасть.
    const required = require('${pkg.name}/frame');
    const imported = await import('${pkg.name}/frame');
    if (required.frame !== imported.frame) {
      throw new Error('дубль экземпляра: require и import дали РАЗНЫЕ frame');
    }

    // И то же самое через потребителя: фасад подключён импортом, планировщик —
    // require. Один rAF означает один общий цикл на весь смешанный граф.
    //
    // ПОРЯДОК ЗДЕСЬ СУЩЕСТВЕНЕН. Если сначала дёрнуть frame.update(), счётчик
    // уже равен 1, и проба «получилось 1» прошла бы даже когда animate не
    // планирует НИЧЕГО. Поэтому первым идёт animate — и требование requests===1
    // сразу после него означает «фасад реально поставил кадр», а не «промолчал».
    const { animate } = await import('${pkg.name}/animate');
    const values = new Map([['opacity', '0']]);
    const target = {
      style: {
        getPropertyValue: (name) => values.get(name) ?? '',
        setProperty: (name, value) => values.set(name, value),
      },
    };
    animate(target, { opacity: 1 });
    if (requests !== 1) {
      throw new Error('import-половина не поставила кадр: rAF получено ' + requests + ', проба была бы вакуумной');
    }
    // Теперь планировщик со стороны require. Счётчик обязан ОСТАТЬСЯ 1:
    // 2 означало бы второй независимый цикл, то есть второй экземпляр модуля.
    required.frame.update(() => {});
    if (requests !== 1) {
      throw new Error('смешанный граф раздвоил scheduler: ожидался 1 rAF, получено ' + requests);
    }
    // cancelAll со стороны require обязан гасить работу, поставленную со
    // стороны import: при двух экземплярах он погасил бы только свою половину.
    if (queue.length === 0) throw new Error('очередь кадров пуста — гасить нечего, проба вакуумна');
    required.frame.cancelAll();
    queue.shift()();
    if (requests !== 1) throw new Error('cancelAll из require-половины не погасил import-половину');
    console.log('MIXED graph OK: require+import → 1 экземпляр, 1 rAF');
  `;
  writeFileSync(join(app, 'mixed-graph.mjs'), mixedGraphProbe);
  log(execSync('node mixed-graph.mjs', { cwd: app, encoding: 'utf8' }).trim());

  // 4. Единственная пара целей на субпуть обязана существовать. Условных веток
  // больше нет: одна цель — один экземпляр модуля у любого потребителя.
  let checked = 0;
  for (const [key, value] of Object.entries(installedPackage.exports)) {
    for (const condition of ['types', 'default']) {
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
    // Ветка require не должна воскреснуть: она вернула бы второй экземпляр
    // модульного состояния (кадровый цикл, реестр animate) тому же процессу.
    for (const forbidden of ['import', 'require']) {
      if (value[forbidden] !== undefined) {
        failed = true;
        log(`FAIL: exports['${key}'] содержит условную ветку ${forbidden} — поставка снова двухформатная`);
      }
    }
  }
  log(`структура OK: ${checked} export-целей на месте`);

  // 5. Метаданные и документы, на которые ссылается README, должны доехать
  // до потребителя без отдельного источника истины вне npm-артефакта.
  for (const file of [
    'LICENSE',
    'README.md',
    'package.json',
    'docs/errors.md',
    'docs/benchmark.md',
    'docs/recipes.md',
    // #91/#96: документация и машиночитаемый API — часть артефакта.
    'docs/README.md',
    'docs/getting-started.md',
    'docs/reference/animate.md',
    'docs/migration/framer-motion.md',
    'docs/explanations/compositor-model.md',
    'api-manifest.json',
    'llms.txt',
  ]) {
    if (!existsSync(join(installedRoot, file))) {
      failed = true;
      log(`FAIL: ${file} не в артефакте`);
    }
  }
  const installedErrors = join(installedRoot, 'docs', 'errors.md');
  if (existsSync(installedErrors)
    && readFileSync(installedErrors, 'utf8') !== readFileSync(join(ROOT, 'docs', 'errors.md'), 'utf8')) {
    failed = true;
    log('FAIL: docs/errors.md в артефакте расходится с каталогом исходников');
  }
  const installedBenchmark = join(installedRoot, 'docs', 'benchmark.md');
  if (existsSync(installedBenchmark)
    && readFileSync(installedBenchmark, 'utf8') !== readFileSync(join(ROOT, 'docs', 'benchmark.md'), 'utf8')) {
    failed = true;
    log('FAIL: docs/benchmark.md в артефакте расходится с методологией исходников');
  }
  if (existsSync(installedBenchmark)) {
    const benchmarkDocument = readFileSync(installedBenchmark, 'utf8');
    try {
      const evidence = parseBenchmarkDocumentationState(benchmarkDocument, installedPackage);
      log(`benchmark evidence: ${evidence.kind === 'none' ? 'claims отсутствуют' : evidence.stem} ✓`);
    } catch (error) {
      failed = true;
      log(`FAIL: пакетная методология: ${error?.message ?? String(error)}`);
    }
  }
  const installedRecipes = join(installedRoot, 'docs', 'recipes.md');
  if (existsSync(installedRecipes)
    && readFileSync(installedRecipes, 'utf8') !== readFileSync(join(ROOT, 'docs', 'recipes.md'), 'utf8')) {
    failed = true;
    log('FAIL: docs/recipes.md в артефакте расходится с исходником');
  }

  // 6. Карты исключены package#files-контрактом. Runtime-файлы также не должны
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

  // package#imports работает в Node/bundler, но голый browser/CDN ESM не читает
  // package.json при загрузке URL. Собранная ESM-ветка обязана ссылаться на
  // общий scheduler относительным URL; иначе import('/dist/animate') падает.
  const browserBareFrame = runtimeFiles.filter(
    (file) => file.endsWith('.js') && /["']#frame["']/.test(readFileSync(file, 'utf8')),
  );
  if (browserBareFrame.length > 0) {
    failed = true;
    log(`FAIL: ESM не импортируется напрямую из browser/CDN: ${browserBareFrame[0]}`);
  } else {
    log('browser/CDN ESM: общий frame использует относительные URL ✓');
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
