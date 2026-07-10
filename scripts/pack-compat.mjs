/**
 * pack-compat.mjs — consumer-contract ШИПУЕМОГО тарбола (issue #102, пункты 11–14).
 *
 * Расширяет pack:smoke (ESM/CJS) до полной матрицы совместимости потребителя:
 * тарбол собирается ОДИН раз (pnpm pack) и ставится в чистые изолированные
 * фикстуры — ESM, CJS, TypeScript (nodenext-типы), Vite (bundler-резолв exports),
 * SSR (import без DOM). Плюс — контракт Node ≥ 18 проверяется отдельным фактом.
 *
 * Зачем поверх pack:smoke: класс «tarball ставится, но у потребителя с ДРУГИМ
 * резолвером (tsc nodenext / vite) субпуть не находится / типы не подхватываются /
 * DOM-facing субпуть падает на сервере» — этого ESM/CJS-смоук не видит. Каждый
 * резолвер здесь — отдельная фикстура.
 *
 * Zero-config сеть: тарбол ставится `npm install` из локального файла (у пакета
 * нет runtime-зависимостей, peer'ы optional). tsc/vite берутся из root node_modules
 * (не тянутся из сети). Node ≥ 18 — раннер этого скрипта.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

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
const DOM_FACING = ['./compositor', './animate', './gestures', './projection', './a11y', './presence', './flip', './waapi']
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
  // ── Node ≥ 18 consumer contract (пункт 13) ────────────────────────────────
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node ${process.versions.node} < 18 — consumer contract нарушен`);
  if (pkg.engines?.node !== '>=18') fail(`engines.node ожидался '>=18', получено '${pkg.engines?.node}'`);
  log(`Node contract: раннер ${process.versions.node}, engines '${pkg.engines?.node}' ✓`);

  // ── Тарбол ОДИН раз (пункт 11) ─────────────────────────────────────────────
  execSync(`pnpm pack --pack-destination "${work}"`, { cwd: ROOT, stdio: 'pipe' });
  const tarballName = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarballName) throw new Error('pnpm pack не создал тарбол');
  const tarball = join(work, tarballName);
  log(`tarball: ${tarballName}`);

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
        `import { compileSpringPlan, readCompositorSpring } from '${pkg.name}/compositor';\n` +
        `import { animate, type AnimateControls } from '${pkg.name}/animate';\n` +
        `import { createDrag } from '${pkg.name}/gestures';\n` +
        `import { createMotionConfig } from '${pkg.name}/a11y';\n` +
        `const r: SpringResult = spring({ mass: 1, stiffness: 200, damping: 20 }, 0.1);\n` +
        `const v: number = r.value + r.velocity;\n` +
        `const plan = compileSpringPlan({ spring: { mass: 1, stiffness: 200, damping: 20 }, property: 'opacity', from: 0, to: 1 });\n` +
        `const read = readCompositorSpring({ mass: 1, stiffness: 200, damping: 20 }, { t: 0.1 });\n` +
        `const drag = createDrag({ inertia: false });\n` +
        `const cfg = createMotionConfig({ reducedMotion: 'system' });\n` +
        `export function use(): number { return v + plan.duration + read.value + drag.x + (cfg.prefersReduced() ? 1 : 0); }\n` +
        `export type C = AnimateControls; export const a = animate;\n`,
    );
    const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execSync(`node "${tscBin}" --project tsconfig.json`, { cwd: dir, stdio: 'pipe' });
    log('TS: nodenext-резолв exports + типы прошли tsc --noEmit ✓');
  }

  // ── Vite-фикстура: bundler-резолв exports (пункт 12) ───────────────────────
  {
    const dir = installFixture('vite', { name: 'vite-fx', private: true, type: 'module' }, tarball);
    writeFileSync(
      join(dir, 'entry.js'),
      `import { spring } from '${pkg.name}';\n` +
        `import { animate } from '${pkg.name}/animate';\n` +
        `import { createDrag } from '${pkg.name}/gestures';\n` +
        `import { compileSpringPlan } from '${pkg.name}/compositor';\n` +
        `export const out = [typeof spring, typeof animate, typeof createDrag, typeof compileSpringPlan];\n`,
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
    else log('Vite: bundler-резолв всех субпутей + сборка ✓');
  }
} catch (error) {
  fail(error?.stderr?.toString?.() || error?.message || String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('pack-compat: FAIL');
  process.exit(1);
}
console.log('pack-compat: PASS');
