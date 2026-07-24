/**
 * size-compare.mjs — воспроизводимое сравнение import-cost эквивалентных
 * one-liner сценариев против Motion (mini/hybrid), GSAP и Anime.js v4.
 *
 * Методология — ТА ЖЕ, что у merge-гейта scripts/size-gate.mjs: сценарий
 * бандлится esbuild (bundle + minify, ESM, splitting) против УСТАНОВЛЕННЫХ
 * пакетов (конкуренты — пиненные версии этого workspace; lab-motion — свежий
 * dist, те же байты, что уйдут npm-потребителю), сжимается каноническим
 * gzip-оракулом пакета. Никаких чисел из чужих README.
 *
 * Сценарий у всех один по ПРОДУКТОВОМУ НАМЕРЕНИЮ: сдвинуть и проявить один
 * элемент («move + fade», дефолт-класс продуктового перехода). Формы вызова —
 * идиоматические для каждой библиотеки; это сравнение цены типового вызова,
 * не утверждение о совпадении возможностей (у defensive ./animate и hybrid
 * Motion контракты шире, чем у nano/mini — см. колонку contract).
 *
 * Compiled-строка lab-motion собирается РЕАЛЬНЫМ Vite с плагином
 * motionCompiler() (как приёмочный гейт scripts/compiler-acceptance.mjs):
 * это цена, которую платит потребитель с включённым build-time lowering.
 *
 * Запуск:  cd bench/compare && pnpm install --frozen-lockfile && node size-compare.mjs
 * Выход:   таблица в stdout + size-compare.report.json (версии, ревизия,
 *          методология — provenance для docs/benchmark.md).
 */

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGzip } from '../../scripts/compression-oracle.mjs';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(HERE, '..', '..');
const DIST = resolve(ROOT, 'dist');
const TMP = resolve(HERE, '.size-compare-tmp');

/** lab-motion резолвится в свежий dist (байты npm-потребителя). */
const LAB_ALIAS = {
  '@labpics/motion/nano': resolve(DIST, 'nano/index.js'),
  '@labpics/motion/animate': resolve(DIST, 'animate/index.js'),
  '@labpics/motion/compiler/runtime': resolve(DIST, 'compiler/runtime/index.js'),
};

/**
 * Эквивалентные сценарии «move + fade одного элемента». el — внешняя
 * переменная (globalThis), чтобы бандл не платил за создание элемента.
 */
const SCENARIOS = [
  {
    id: 'lab-compiled',
    label: 'lab-motion nano + compiler',
    contract: 'compile-time артефакт: native WAAPI, spring precomputed',
    kind: 'vite-compiled',
    code: `import { animate } from '@labpics/motion/nano';
export const play = (el) => animate(el, { translate: '240px', opacity: 1 });`,
  },
  {
    id: 'lab-nano',
    label: 'lab-motion ./nano',
    contract: 'runtime: native WAAPI + spring→linear() на лету',
    kind: 'esbuild',
    code: `import { animate } from '@labpics/motion/nano';
globalThis.play = (el) => animate(el, { translate: '240px', opacity: 1 });`,
  },
  {
    id: 'lab-animate',
    label: 'lab-motion ./animate (full)',
    contract: 'defensive runtime: C¹-подхват, fallback, hostile-host, N-keyframes',
    kind: 'esbuild',
    code: `import { animate } from '@labpics/motion/animate';
globalThis.play = (el) => animate(el, { x: 240, opacity: 1 });`,
  },
  {
    id: 'motion-mini',
    label: 'motion/mini (Motion One)',
    contract: 'runtime: native WAAPI, без main-thread движка',
    kind: 'esbuild',
    code: `import { animate } from 'motion/mini';
globalThis.play = (el) => animate(el, { transform: 'translateX(240px)', opacity: 1 });`,
  },
  {
    id: 'motion-hybrid',
    label: 'motion (hybrid animate)',
    contract: 'hybrid runtime: main-thread значения + WAAPI',
    kind: 'esbuild',
    code: `import { animate } from 'motion';
globalThis.play = (el) => animate(el, { x: 240, opacity: 1 });`,
  },
  {
    id: 'animejs',
    label: 'anime.js v4',
    contract: 'main-thread движок',
    kind: 'esbuild',
    code: `import { animate } from 'animejs';
globalThis.play = (el) => animate(el, { translateX: 240, opacity: 1 });`,
  },
  {
    id: 'gsap',
    label: 'GSAP core',
    contract: 'main-thread движок + timeline-ядро',
    kind: 'esbuild',
    code: `import { gsap } from 'gsap';
globalThis.play = (el) => gsap.to(el, { x: 240, opacity: 1 });`,
  },
];

async function measureEsbuild(code) {
  const result = await build({
    absWorkingDir: HERE,
    stdin: { contents: code, resolveDir: HERE, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    alias: LAB_ALIAS,
    write: false,
    logLevel: 'silent',
  });
  const bytes = result.outputFiles[0].contents;
  return { raw: bytes.length, gz: canonicalGzip(bytes).length };
}

/** Реальный Vite + motionCompiler(): та же схема, что compiler-acceptance. */
async function measureViteCompiled(code) {
  const { motionCompiler } = await import(resolve(DIST, 'compiler/vite/index.js'));
  const entry = resolve(TMP, 'compiled-entry.js');
  writeFileSync(entry, code);
  const result = await viteBuild({
    root: HERE,
    logLevel: 'silent',
    configFile: false,
    resolve: { alias: LAB_ALIAS },
    plugins: [motionCompiler()],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'x' },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((o) => o.type === 'chunk' && o.isEntry) ?? output[0];
  const bytes = Buffer.from(chunk.code);
  return { raw: bytes.length, gz: canonicalGzip(bytes).length };
}

function packageVersion(name) {
  return JSON.parse(
    readFileSync(resolve(HERE, 'node_modules', name, 'package.json'), 'utf8'),
  ).version;
}

async function run() {
  if (!existsSync(DIST)) {
    console.error('size-compare: dist отсутствует — сначала pnpm build в корне');
    process.exit(1);
  }
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const rows = [];
  try {
    for (const scenario of SCENARIOS) {
      const measured = scenario.kind === 'vite-compiled'
        ? await measureViteCompiled(scenario.code)
        : await measureEsbuild(scenario.code);
      rows.push({ ...scenario, ...measured });
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }

  rows.sort((a, b) => a.gz - b.gz);
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log('\nimport-cost эквивалентного move+fade one-liner (esbuild bundle+minify, канонический gzip)\n');
  console.log(pad('Сценарий', 30) + lpad('gz', 10) + lpad('raw', 10) + '  Контракт');
  console.log('-'.repeat(88));
  for (const row of rows) {
    console.log(
      pad(row.label, 30) + lpad(`${row.gz} B`, 10) + lpad(`${row.raw} B`, 10) +
      `  ${row.contract}`,
    );
  }

  const report = {
    generatedFor: JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    node: process.version,
    esbuild: packageVersion('esbuild'),
    competitors: {
      motion: packageVersion('motion'),
      animejs: packageVersion('animejs'),
      gsap: packageVersion('gsap'),
    },
    methodology:
      'Один продуктовый сценарий (move+fade одного элемента), идиоматическая форма каждой библиотеки; ' +
      'esbuild bundle+minify (ESM, browser), канонический gzip-оракул пакета; lab-motion — из свежего dist, ' +
      'конкуренты — из установленных пиненных пакетов. Сравнение цены типового вызова, не паритета возможностей.',
    rows: rows.map(({ id, label, gz, raw, contract }) => ({ id, label, gz, raw, contract })),
  };
  // НЕ results/: тот каталог — под парным контрактом runtime-отчётов
  // (validateBenchmarkReportPair); size-отчёт — отдельный класс артефакта.
  writeFileSync(resolve(HERE, 'size-compare.report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\nreport → bench/compare/size-compare.report.json (revision ' + report.revision.slice(0, 8) + ')');
}

run().catch((error) => {
  console.error('size-compare: внутренняя ошибка —', error);
  process.exit(1);
});
