/**
 * compiler-acceptance.mjs — приёмочный гейт компиляторного среза (#208).
 *
 * Заявление среза: build-time lowering статического `animate(el, { opacity: N })`
 * из '@labpics/motion/nano' заменяет вызов на инъекцию precomputed-артефакта +
 * hoisted-импорт приватного executor '@labpics/motion/compiler/runtime'. Тогда
 * в БАНДЛ ПОТРЕБИТЕЛЯ не попадает ни spring-solver, ни MotionProgram V1 parser,
 * ни compiler-ядро — только крошечный WAAPI-executor. Бандл строго меньше.
 *
 * Гейт делает это заявление воспроизводимым фактом, а не текстом описания: один
 * и тот же fixture собирается РЕАЛЬНЫМ Vite дважды (с плагином motionCompiler()
 * и без) и сверяется по МОДУЛЬНОМУ ГРАФУ, по content-fingerprint солвера и по
 * gzip-весу. Плюс positive control: fixture с ДИНАМИЧЕСКОЙ opacity обязан
 * оставить плагин no-op'ом (иначе гейт мерил бы тавтологию, а не элиминацию).
 *
 * Заземление на dist: alias '@labpics/motion/nano' и '.../compiler/runtime' →
 * реальные dist-артефакты (те же байты, что получит npm-потребитель). Плагин
 * берётся из собранного dist/compiler/vite. Сборка детерминирована, без сети.
 */

import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { motionCompiler } from '../dist/compiler/vite/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const TMP = resolve(ROOT, 'scripts', '.compiler-acceptance-tmp');

/** Alias публичных субпутей на реальные dist-артефакты (байты потребителя). */
const ALIAS = {
  '@labpics/motion/nano': resolve(DIST, 'nano/index.js'),
  '@labpics/motion/compiler/runtime': resolve(DIST, 'compiler/runtime/index.js'),
};

/** dist-модуль (не entry, не bare peer) в графе — нормализованный к dist-relative id. */
function distModules(chunk) {
  return Object.keys(chunk.modules)
    .filter((id) => id.startsWith(DIST))
    .map((id) => id.slice(DIST.length + 1).replaceAll('\\', '/'));
}

/** Один Vite-build fixture'а: возвращает entry-chunk {code, distModules}. */
async function buildFixture(name, code, withPlugin) {
  const entry = resolve(TMP, `${name}.js`);
  writeFileSync(entry, code);
  const result = await build({
    root: ROOT,
    logLevel: 'silent',
    configFile: false,
    resolve: { alias: ALIAS },
    plugins: withPlugin ? [motionCompiler()] : [],
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: name },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((o) => o.type === 'chunk' && o.isEntry) ?? output[0];
  return { code: chunk.code, modules: distModules(chunk) };
}

// Статическая opacity — единственная форма в скоупе lowering (#208 §core).
const LOWERABLE = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }`;
// Динамическая opacity — вне скоупа: плагин обязан отказать (positive control).
const DYNAMIC = `import { animate } from '@labpics/motion/nano';
export function play(el, v) { return animate(el, { opacity: v }); }`;

/** Fingerprint spring-солвера: замкнутая форма тянет Math.exp/cos/sin/sqrt. */
const SPRING_MATH = /Math\.(?:exp|cos|sin|sqrt)/;
const RUNTIME_MODULE = 'compiler/runtime/index.js';
const NANO_MODULE = 'nano/index.js';

const failures = [];
const notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

async function run() {
  if (!existsSync(DIST)) {
    console.error('compiler-acceptance: dist отсутствует — сначала pnpm build');
    process.exit(1);
  }
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  try {
    const baseline = await buildFixture('lowerable-uncompiled', LOWERABLE, false);
    const compiled = await buildFixture('lowerable-compiled', LOWERABLE, true);
    const control = await buildFixture('dynamic-compiled', DYNAMIC, true);

    // ── Контроль fixture'а: без плагина путь ДЕЙСТВИТЕЛЬНО рантаймовый ─────────
    // (иначе «элиминация» ничего не значит — нечего было элиминировать).
    check(
      baseline.modules.includes(NANO_MODULE),
      `baseline не тянет ${NANO_MODULE} (fixture не исполняет рантаймовый путь): ${baseline.modules.join(', ')}`,
    );
    check(
      SPRING_MATH.test(baseline.code),
      'baseline не содержит spring-математику — fixture не доказывает наличие солвера в рантайме',
    );

    // ── (b/c) Элиминация: compiled-граф без солвера/парсера/ядра ──────────────
    check(
      compiled.modules.includes(RUNTIME_MODULE),
      `compiled не тянет executor ${RUNTIME_MODULE}: ${compiled.modules.join(', ')}`,
    );
    // Несущий структурный инвариант: единственный dist-модуль compiled-графа —
    // приватный executor. Ни nano, ни solver, ни motion-program, ни compiler/core.
    const compiledExtra = compiled.modules.filter((m) => m !== RUNTIME_MODULE);
    check(
      compiledExtra.length === 0,
      `compiled-граф несёт лишние dist-модули (ожидался только executor): ${compiledExtra.join(', ')}`,
    );
    check(
      !SPRING_MATH.test(compiled.code),
      'compiled содержит spring-математику — солвер не элиминирован',
    );
    // Артефакт на месте: precomputed linear() как литерал (не вычисление).
    check(
      /linear\(/.test(compiled.code),
      'compiled не содержит precomputed linear()-артефакт',
    );

    // ── (d) Относительный размер: compiled строго меньше uncompiled ───────────
    const baselineGz = gzipSync(baseline.code).length;
    const compiledGz = gzipSync(compiled.code).length;
    check(
      compiledGz < baselineGz,
      `compiled (${compiledGz} B gz) не меньше uncompiled (${baselineGz} B gz)`,
    );
    notes.push(
      `размер: uncompiled ${baselineGz} B gz → compiled ${compiledGz} B gz ` +
      `(−${baselineGz - compiledGz} B, −${((1 - compiledGz / baselineGz) * 100).toFixed(1)}%)`,
    );

    // ── Positive control: динамическая opacity — плагин no-op ─────────────────
    check(
      control.modules.includes(NANO_MODULE) && !control.modules.includes(RUNTIME_MODULE),
      `плагин ошибочно понизил динамический вызов (граф: ${control.modules.join(', ')})`,
    );
    notes.push(`no-op контроль: динамическая opacity сохранила рантаймовый путь (${NANO_MODULE})`);
    notes.push(`граф compiled: ${compiled.modules.join(', ') || '(только entry)'}`);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

run().then(() => {
  for (const note of notes) console.log(`  ${note}`);
  if (failures.length > 0) {
    console.error('compiler-acceptance: FAIL');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('compiler-acceptance: PASS — solver/parser/compiler элиминированы из бандла потребителя');
}).catch((error) => {
  console.error('compiler-acceptance: внутренняя ошибка —', error);
  process.exit(1);
});
