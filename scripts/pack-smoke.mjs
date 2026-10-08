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
  const floorMatch = /^>=(\d+)$/.exec(installedPackage.engines?.node ?? '');
  if (floorMatch === null) {
    throw new Error(`архив содержит неканонический engines.node: ${String(installedPackage.engines?.node)}`);
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const floor = Number(floorMatch[1]);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < floor) {
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
    const { spring } = await import('${pkg.name}/driver');
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
    const { spring } = require('${pkg.name}/driver');
    const result = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);
    if (!Number.isFinite(result.value)) throw new Error('CJS spring вернул не-конечное');
    console.log('CJS OK: ' + names.length + ' entries');
  `;
  writeFileSync(join(app, 'cjs.cjs'), cjsProbe);
  log(execSync('node cjs.cjs', { cwd: app, encoding: 'utf8' }).trim());

  // Самодостаточный follow-entry проверяется после pack/install в обоих форматах.
  const followProbe = (kind) => `
    globalThis.CSS = { supports: () => true };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { vendor: '', userAgent: 'Chromium' } });
    const { createCompositorFollow } = ${kind === 'esm'
      ? `await import('${pkg.name}/compositor/follow')`
      : `require('${pkg.name}/compositor/follow')`};
    const animations = [];
    let frames = 0;
    let written;
    const owner = createCompositorFollow({
      spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'opacity', from: 0, to: 100,
      target: { animate() { const a = { currentTime: 16, cancelled: false, cancel() { this.cancelled = true; } }; animations.push(a); return a; } },
      apply(value) { written = value; }, now: () => 0, requestFrame: () => ++frames,
      matchMedia: () => ({ matches: false }),
    });
    owner.start();
    for (let turn = 1; turn <= 2; turn++) {
      const value = owner.beginFollow(turn);
      if (!Number.isFinite(value) || written !== value || !animations.at(-1).cancelled) throw new Error('follow pickup failed');
      owner.follow(value + 20, turn + 0.02);
      owner.settle(100 * (turn + 1), turn + 0.02);
    }
    if (animations.length !== 3 || frames !== 0) throw new Error('native repeat became live');
    owner.destroy();
    if (animations.some((a) => !a.cancelled)) throw new Error('follow owner leaked');
    console.log('follow ${kind}: native repeat + terminal cleanup OK');
  `;
  for (const kind of ['esm', 'cjs']) {
    const file = kind === 'esm' ? 'follow.mjs' : 'follow.cjs';
    writeFileSync(join(app, file), followProbe(kind));
    log(execSync(`node ${file}`, { cwd: app, encoding: 'utf8' }).trim());
  }

  // Публичное наследование должно работать с теми же именами, что обещают типы.
  for (const kind of ['esm', 'cjs']) {
    const probe = `
      for (const sub of ['compositor', 'compositor/stagger']) {
        const { CompositorSpring } = ${kind === 'esm' ? `await import('${pkg.name}/' + sub)` : `require('${pkg.name}/' + sub)`};
        class PublicSpring extends CompositorSpring {
          readValue() { return this.value; }
          stop() { super.stop(); }
        }
        const owner = new PublicSpring({
          spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'opacity',
          from: 7, to: 9, apply() {}, matchMedia: () => ({ matches: true }),
        });
        if (owner.readValue() !== 7) throw new Error('subclass value');
        owner.start();
        owner.retarget(11);
        if (owner.readValue() !== 11) throw new Error('subclass retarget');
        owner.stop(); owner.destroy();
      }
      console.log('public subclass ${kind} OK');
    `;
    const file = kind === 'esm' ? 'subclass.mjs' : 'subclass.cjs';
    writeFileSync(join(app, file), probe);
    log(execSync(`node ${file}`, { cwd: app, encoding: 'utf8' }).trim());
  }

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

    frame.update(() => {});
    animate(target, { opacity: 1 });
    const Host = createLabSpringElementClass(Base);
    const host = new Host();
    host.connectedCallback();
    host.attributeChangedCallback('target', '0', '1');

    if (requests !== 1) {
      throw new Error('frame singleton раздвоен: ожидался 1 rAF, получено ' + requests);
    }
    frame.cancelAll();
    queue.shift()?.(0);
    if (requests !== 1) throw new Error('cancelAll не погасил общий scheduler');
    console.log('${moduleKind.toUpperCase()} shared frame OK: 3 consumers → 1 rAF');
  `;
  writeFileSync(join(app, 'shared-frame.mjs'), sharedFrameProbe('esm'));
  log(execSync('node shared-frame.mjs', { cwd: app, encoding: 'utf8' }).trim());
  writeFileSync(join(app, 'shared-frame.cjs'), sharedFrameProbe('cjs'));
  log(execSync('node shared-frame.cjs', { cwd: app, encoding: 'utf8' }).trim());

  // 4. Обе runtime-ветки и соответствующие им декларации обязаны существовать.
  // Плоский общий types-путь здесь запрещён: CJS и ESM имеют разные форматы.
  let checked = 0;
  for (const [key, value] of Object.entries(installedPackage.exports)) {
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

  // 5. Публичная документация является частью npm-артефакта. README задаёт
  // вход в неё, package#files задаёт опубликованную поверхность.
  const sourceReadme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const readmeDocs = [...new Set(
    [...sourceReadme.matchAll(/\]\((docs\/[^)#]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]),
  )].sort();
  const declaredDocs = (installedPackage.files ?? [])
    .filter((file) => typeof file === 'string' && /^docs\/[^*]+\.md$/.test(file))
    .sort();

  for (const file of ['LICENSE', 'README.md', 'package.json', ...declaredDocs]) {
    if (!existsSync(join(installedRoot, file))) {
      failed = true;
      log(`FAIL: ${file} не в артефакте`);
    }
  }

  for (const file of readmeDocs) {
    if (!declaredDocs.includes(file)) {
      failed = true;
      log(`FAIL: README ссылается на ${file}, но package#files его не публикует`);
    }
  }

  for (const file of declaredDocs) {
    const installedDocument = join(installedRoot, file);
    const sourceDocument = join(ROOT, file);
    if (!existsSync(sourceDocument)) {
      failed = true;
      log(`FAIL: package#files объявляет отсутствующий исходный документ ${file}`);
      continue;
    }
    if (
      existsSync(installedDocument)
      && readFileSync(installedDocument, 'utf8') !== readFileSync(sourceDocument, 'utf8')
    ) {
      failed = true;
      log(`FAIL: ${file} в артефакте расходится с исходником`);
    }
  }

  const installedBenchmark = join(installedRoot, 'docs', 'benchmark.md');
  const installedMotionContract = join(installedRoot, 'docs', 'motion-conformance.md');
  if (existsSync(installedMotionContract)
    && readFileSync(installedMotionContract, 'utf8') !== readFileSync(join(ROOT, 'docs', 'motion-conformance.md'), 'utf8')) {
    failed = true;
    log('FAIL: docs/motion-conformance.md в артефакте расходится с контрактом исходников');
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
