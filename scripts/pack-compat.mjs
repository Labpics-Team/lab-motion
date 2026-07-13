/**
 * pack-compat.mjs — consumer-contract ШИПУЕМОГО тарбола (issue #102, пункты 11–14).
 *
 * Расширяет pack:smoke (ESM/CJS) до полной матрицы совместимости потребителя:
 * тарбол собирается ОДИН раз (pnpm pack) и ставится в чистые изолированные
 * фикстуры — ESM, CJS, TypeScript (nodenext-типы), Vite (bundler-резолв exports),
 * SSR (import без DOM). Плюс — контракт Node ≥ 22 проверяется отдельным фактом.
 *
 * Зачем поверх pack:smoke: класс «tarball ставится, но у потребителя с ДРУГИМ
 * резолвером (tsc nodenext / vite) субпуть не находится / типы не подхватываются /
 * DOM-facing субпуть падает на сервере» — этого ESM/CJS-смоук не видит. Каждый
 * резолвер здесь — отдельная фикстура.
 *
 * Основные фикстуры ставят тарбол локально; tsc/vite берутся из root node_modules.
 * Единственный сетевой шаг устанавливает точный минимальный Preact peer: так
 * заявленный floor доказывается реальным импортом, а не строкой package.json.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const suppliedTarball = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);

/** Субпути с обязательным peer-фреймворком — вне consumer-контракта голого пакета. */
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

const RUNNABLE = Object.keys(pkg.exports).filter((k) => !PEER_BINDING_SUBPATHS.has(k));
const specOf = (sub) => (sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`);

/** DOM-facing субпути — их SSR-import (в Node без DOM) обязан НЕ падать. */
const DOM_FACING = ['./compositor', './compositor/stagger', './animate', './animate/native', './gestures', './projection', './a11y', './presence', './flip', './waapi']
  .filter((s) => RUNNABLE.includes(s));

const work = mkdtempSync(join(tmpdir(), 'labmotion-pack-compat-'));
let failed = false;
const log = (line) => console.log(line);
const fail = (line) => {
  failed = true;
  console.error(`FAIL: ${line}`);
};

/** Устанавливает уже собранный тарбол в чистую фикстуру (ignore-scripts, offline-friendly). */
function installFixture(name, packageJson, tarball) {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson, null, 2));
  execSync(`npm install --ignore-scripts --no-audit --no-fund "${tarball}"`, {
    cwd: dir,
    stdio: 'pipe',
  });
  return dir;
}

try {
  // ── Node ≥ 22 consumer contract (пункт 13) ────────────────────────────────
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) fail(`Node ${process.versions.node} < 22 — consumer contract нарушен`);
  if (pkg.engines?.node !== '>=22') fail(`engines.node ожидался '>=22', получено '${pkg.engines?.node}'`);
  log(`Node contract: раннер ${process.versions.node}, engines '${pkg.engines?.node}' ✓`);

  // В release-контуре путь передаётся явно: все consumer-гейты проверяют
  // ровно те байты, которые затем получают artifact и npm publish.
  let tarball;
  let tarballName;
  if (suppliedTarball !== undefined) {
    if (!suppliedTarball.endsWith('.tgz')) throw new Error('переданный файл не является tgz');
    try {
      readFileSync(suppliedTarball);
    } catch {
      throw new Error(`переданный tgz не найден: ${suppliedTarball}`);
    }
    tarball = suppliedTarball;
    tarballName = basename(suppliedTarball);
    log(`готовый tarball: ${tarballName}`);
  } else {
    execSync(`pnpm pack --pack-destination "${work}"`, { cwd: ROOT, stdio: 'pipe' });
    tarballName = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tarballName) throw new Error('pnpm pack не создал тарбол');
    tarball = join(work, tarballName);
    log(`собран tarball: ${tarballName}`);
  }

  // ── ESM-фикстура (пункт 12) ────────────────────────────────────────────────
  {
    const dir = installFixture('esm', { name: 'esm-fx', private: true, type: 'module' }, tarball);
    const probe = `
      const specs = ${JSON.stringify(RUNNABLE.map(specOf))};
      for (const s of specs) {
        const m = await import(s);
        if (Object.keys(m).length === 0) throw new Error('пустой ESM-модуль: ' + s);
      }
      const { spring } = await import('${pkg.name}');
      if (!Number.isFinite(spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1).value))
        throw new Error('ESM spring не-конечен');
      console.log('esm ok: ' + specs.length);
    `;
    writeFileSync(join(dir, 'probe.mjs'), probe);
    log(`ESM: ${execSync('node probe.mjs', { cwd: dir, encoding: 'utf8' }).trim()}`);
  }

  // ── CJS-фикстура (пункт 12) ────────────────────────────────────────────────
  {
    const dir = installFixture('cjs', { name: 'cjs-fx', private: true }, tarball);
    const probe = `
      const specs = ${JSON.stringify(RUNNABLE.map(specOf))};
      for (const s of specs) {
        const m = require(s);
        if (Object.keys(m).length === 0) throw new Error('пустой CJS-модуль: ' + s);
      }
      const { spring } = require('${pkg.name}');
      if (!Number.isFinite(spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1).value))
        throw new Error('CJS spring не-конечен');
      console.log('cjs ok: ' + specs.length);
    `;
    writeFileSync(join(dir, 'probe.cjs'), probe);
    log(`CJS: ${execSync('node probe.cjs', { cwd: dir, encoding: 'utf8' }).trim()}`);
  }

  // ── SSR-фикстура: DOM-facing субпути импортируются в Node БЕЗ DOM (пункт 12) ─
  {
    const dir = installFixture('ssr', { name: 'ssr-fx', private: true, type: 'module' }, tarball);
    const probe = `
      if (typeof window !== 'undefined' || typeof document !== 'undefined')
        throw new Error('SSR-фикстура: DOM неожиданно присутствует');
      const specs = ${JSON.stringify(DOM_FACING.map(specOf))};
      for (const s of specs) {
        const m = await import(s); // import не должен трогать window/document
        if (Object.keys(m).length === 0) throw new Error('пустой SSR-модуль: ' + s);
      }
      // Чистая аналитика доступна на сервере (для SSR-снимков/предвычислений).
      const { compileSpringLinear } = await import('${pkg.name}/compositor');
      if (!compileSpringLinear({ mass: 1, stiffness: 200, damping: 20 }).startsWith('linear('))
        throw new Error('SSR compileSpringLinear не дал linear()');
      console.log('ssr ok: ' + specs.length + ' DOM-facing субпутей без DOM');
    `;
    writeFileSync(join(dir, 'probe.mjs'), probe);
    log(`SSR: ${execSync('node probe.mjs', { cwd: dir, encoding: 'utf8' }).trim()}`);
  }

  // ── TypeScript-фикстура: nodenext-резолв exports + типы (пункт 12) ──────────
  {
    const dir = installFixture('ts', { name: 'ts-fx', private: true, type: 'module' }, tarball);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['consumer.ts'],
      }),
    );
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { spring, type SpringResult } from '${pkg.name}';\n` +
        `import { readCompositorSpring } from '${pkg.name}/compositor';\n` +
        `import { CompositorSpring, CompositorStaggerGroup, compileSpringPlan, compileStaggerPlan, type CompositorStaggerPlan } from '${pkg.name}/compositor/stagger';\n` +
        `import { animate, type AnimateControls } from '${pkg.name}/animate';\n` +
        `import { createDrag } from '${pkg.name}/gestures';\n` +
        `import { createMotionConfig } from '${pkg.name}/a11y';\n` +
        `const r: SpringResult = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);\n` +
        `const v: number = r.value + r.velocity;\n` +
        `const plan = compileSpringPlan({ spring: { mass: 1, stiffness: 200, damping: 20 }, property: 'opacity', from: 0, to: 1 });\n` +
        `const staggerPlan: CompositorStaggerPlan = compileStaggerPlan({ spring: { mass: 1, stiffness: 200, damping: 20 }, property: 'opacity', from: 0, to: 1, count: 0 });\n` +
        `const single = new CompositorSpring({ spring: { mass: 1, stiffness: 200, damping: 20 }, property: 'opacity', from: 0, to: 1 });\n` +
        `const group = new CompositorStaggerGroup({ spring: { mass: 1, stiffness: 200, damping: 20 }, property: 'opacity', from: 0, to: 1, targets: [] });\n` +
        `const read = readCompositorSpring({ mass: 1, stiffness: 200, damping: 20 }, { t: 0.1 });\n` +
        `const drag = createDrag({ inertia: false });\n` +
        `const cfg = createMotionConfig({ reducedMotion: 'system' });\n` +
        `export function use(): number { single.destroy(); group.destroy(); return v + plan.duration + staggerPlan.count + read.value + drag.x + (cfg.prefersReduced() ? 1 : 0); }\n` +
        `export type C = AnimateControls; export const a = animate;\n`,
    );
    const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execSync(`node "${tscBin}" --project tsconfig.json`, { cwd: dir, stdio: 'pipe' });
    log('TS: nodenext-резолв exports + типы прошли tsc --noEmit ✓');
  }

  // Headless API обязан типизироваться в чистом Node без lib.dom. Структурный
  // matchMedia-контракт не должен снова протечь как глобальный MediaQueryList.
  {
    const dir = installFixture('ts-headless', { name: 'ts-headless-fx', private: true, type: 'module' }, tarball);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2022',
          lib: ['ES2022'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ['consumer.ts'],
      }),
    );
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { drive, type DriveOptions } from '${pkg.name}';\n` +
        `import { createDriver, type DriverOptions } from '${pkg.name}/driver';\n` +
        `import { createDecay, type DecayOptions } from '${pkg.name}/decay';\n` +
        `import type { DragOptions } from '${pkg.name}/gestures';\n` +
        `import type { PresenceOptions } from '${pkg.name}/presence';\n` +
        `import type { FlipOptions } from '${pkg.name}/flip';\n` +
        `import type { SheetOptions } from '${pkg.name}/behaviors';\n` +
        `const matchMedia = (_query: string) => ({ matches: false });\n` +
        `const spring = { mass: 1, stiffness: 200, damping: 20 };\n` +
        `const root: DriveOptions = { from: 0, to: 1, spring, onStep() {}, matchMedia };\n` +
        `const driver: DriverOptions = { ...root };\n` +
        `const decay: DecayOptions = { from: 0, velocity: 1, matchMedia };\n` +
        `export const contracts: [DragOptions, PresenceOptions, FlipOptions, SheetOptions] | undefined = undefined;\n` +
        `drive(root); createDriver(driver); createDecay(decay);\n`,
    );
    const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execSync(`node "${tscBin}" --project tsconfig.json`, { cwd: dir, stdio: 'pipe' });
    log('TS headless: NodeNext без lib.dom и skipLibCheck прошёл ✓');
  }

  // Legacy Node10 resolver не читает package#exports. typesVersions обязан
  // направлять каждый субпуть к той же декларации, что modern resolver.
  {
    const dir = installFixture('ts-legacy', { name: 'ts-legacy-fx', private: true }, tarball);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          moduleResolution: 'node10',
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ['consumer.ts'],
      }),
    );
    writeFileSync(
      join(dir, 'consumer.ts'),
      `import { spring } from '${pkg.name}';\n` +
        `import { clamp } from '${pkg.name}/utils';\n` +
        `import { animate } from '${pkg.name}/animate/mini';\n` +
        `import { springTo } from '${pkg.name}/animate/native';\n` +
        `import { compileStaggerPlan } from '${pkg.name}/compositor/stagger';\n` +
        `export const value: number = clamp(0, 1, spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1).value);\n` +
        `export const motion = [animate, springTo, compileStaggerPlan] as const;\n`,
    );
    const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const trace = execSync(`node "${tscBin}" --project tsconfig.json --traceResolution`, {
      cwd: dir,
      encoding: 'utf8',
    }).replaceAll('\\', '/');
    for (const declaration of [
      'dist/utils/index.d.ts',
      'dist/animate/mini/index.d.ts',
      'dist/animate/native/index.d.ts',
      'dist/compositor/stagger/index.d.ts',
    ]) {
      if (!trace.includes(declaration)) fail(`TS Node10 не разрешил typesVersions: ${declaration}`);
    }
    log('TS legacy: Node10-resolver разрешил вложенные субпути через typesVersions ✓');
  }

  // Preact <=10.3.0 не экспортирует `preact/hooks` в поддерживаемой Node-форме.
  // Импортируем binding на точном заявленном floor, чтобы диапазон peer не лгал.
  {
    const dir = installFixture('preact-floor', { name: 'preact-floor-fx', private: true, type: 'module' }, tarball);
    execSync('npm install --ignore-scripts --no-audit --no-fund --save-exact preact@10.3.1', {
      cwd: dir,
      stdio: 'pipe',
    });
    const probe = `
      const binding = await import('${pkg.name}/preact');
      if (typeof binding.useSpring !== 'function' || typeof binding.useMotionValue !== 'function') {
        throw new Error('Preact binding не экспортирует публичные хуки');
      }
      console.log('preact floor ok');
    `;
    writeFileSync(join(dir, 'preact-floor.mjs'), probe);
    log(`Preact peer floor: ${execSync('node preact-floor.mjs', { cwd: dir, encoding: 'utf8' }).trim()} ✓`);
  }

  // CJS-потребитель выбирает require-ветку exports. Отдельная .cts-фикстура
  // ловит класс, невидимый ESM-проверке: декларация обязана иметь тот же
  // модульный формат, что и соответствующая runtime-ветка.
  {
    const dir = installFixture('ts-cjs', { name: 'ts-cjs-fx', private: true }, tarball);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['consumer.cts'],
      }),
    );
    writeFileSync(
      join(dir, 'consumer.cts'),
      `import { spring, type SpringResult } from '${pkg.name}';\n` +
        `import { CompositorSpring, CompositorStaggerGroup, compileSpringPlan, compileStaggerPlan } from '${pkg.name}/compositor/stagger';\n` +
        `const r: SpringResult = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);\n` +
        `const physics = { mass: 1, stiffness: 200, damping: 20 };\n` +
        `const single = new CompositorSpring({ spring: physics, property: 'opacity', from: 0, to: 1 });\n` +
        `const group = new CompositorStaggerGroup({ spring: physics, property: 'opacity', from: 0, to: 1, targets: [] });\n` +
        `export const duration: number = compileSpringPlan({ spring: physics, property: 'opacity', from: 0, to: 1 }).duration + compileStaggerPlan({ spring: physics, property: 'opacity', from: 0, to: 1, count: 0 }).count + r.value;\n` +
        `single.destroy(); group.destroy();\n`,
    );
    const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const trace = execSync(`node "${tscBin}" --project tsconfig.json --traceResolution`, {
      cwd: dir,
      encoding: 'utf8',
    }).replaceAll('\\', '/');
    for (const declaration of ['dist/index.d.cts', 'dist/compositor/stagger/index.d.cts']) {
      if (!trace.includes(declaration)) {
        fail(`TS CJS резолвит не CommonJS-декларацию: ${declaration} не найден в trace`);
      }
    }
    log('TS CJS: nodenext require-резолв exports выбрал .d.cts ✓');
  }

  // Авто-регистрирующие subpath-entries обязаны переживать tree shaking при
  // side-effect-only импорте. Иначе package#sideEffects превращает рабочий
  // прямой import в пустой consumer-бандл.
  {
    const dir = installFixture('side-effects', { name: 'side-effects-fx', private: true, type: 'module' }, tarball);
    for (const [subpath, tag] of [['wc', 'lab-spring'], ['lit', 'lab-motion-spring']]) {
      const result = await build({
        stdin: {
          contents: `import '${pkg.name}/${subpath}';`,
          resolveDir: dir,
          sourcefile: `${subpath}-consumer.js`,
        },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        minify: true,
        treeShaking: true,
        external: subpath === 'lit' ? ['lit'] : [],
        write: false,
      });
      const code = result.outputFiles[0]?.text ?? '';
      if (!code.includes(tag)) fail(`side-effect import ${subpath} вырезан tree shaking`);
    }
    log('Tree shaking: авто-регистрация wc/lit сохранена ✓');
  }

  // ── Vite-фикстура: bundler-резолв exports (пункт 12) ───────────────────────
  {
    const dir = installFixture('vite', { name: 'vite-fx', private: true, type: 'module' }, tarball);
    writeFileSync(
      join(dir, 'entry.js'),
      `import { spring } from '${pkg.name}';\n` +
        `import { animate } from '${pkg.name}/animate';\n` +
        `import { createDrag } from '${pkg.name}/gestures';\n` +
        `import { CompositorSpring, CompositorStaggerGroup, compileSpringPlan, compileStaggerPlan } from '${pkg.name}/compositor/stagger';\n` +
        `export const out = [typeof spring, typeof animate, typeof createDrag, typeof CompositorSpring, typeof CompositorStaggerGroup, typeof compileSpringPlan, typeof compileStaggerPlan];\n`,
    );
    writeFileSync(
      join(dir, 'vite.config.mjs'),
      `export default { logLevel: 'error', build: { lib: { entry: 'entry.js', formats: ['es'], fileName: 'bundle' }, write: true, minify: false } };\n`,
    );
    const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    execSync(`node "${viteBin}" build --config vite.config.mjs`, { cwd: dir, stdio: 'pipe' });
    // Артефакт сборки должен существовать и содержать резолвленные субпути.
    const outDir = join(dir, 'dist');
    const built = readdirSync(outDir).find((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    if (!built) fail('Vite не выдал ES-бандл');
    else log('Vite: bundler-резолв выбранных публичных субпутей + сборка ✓');
  }
} catch (error) {
  fail(
    error?.stdout?.toString?.() ||
      error?.stderr?.toString?.() ||
      error?.message ||
      String(error),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('pack-compat: FAIL');
  process.exit(1);
}
console.log('pack-compat: PASS');
