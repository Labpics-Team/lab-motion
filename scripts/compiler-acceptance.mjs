/**
 * compiler-acceptance.mjs — приёмочный гейт компиляторного среза (#208).
 *
 * Заявление среза: build-time lowering статических вызовов —
 * (1) `animate(el, { opacity: N })` из '@labpics/motion/nano' → precomputed-
 * артефакт + hoisted-импорт приватного executor '@labpics/motion/compiler/
 * runtime'; (2) `animate(el, { width: [w0, w1] }, { layout: 'project' })`
 * из '@labpics/motion/animate' → сертифицированный НА СБОРКЕ артефакт
 * (позитивность, reciprocal-бюджет ≤0.25 px) + приватный surface-executor
 * '@labpics/motion/surface' (код executor'а ≤1 KB gz; total — решётка от
 * факта, см. SURFACE_*_MAX_GZ). Тогда в БАНДЛ ПОТРЕБИТЕЛЯ не
 * попадает ни spring-solver, ни MotionProgram V1 parser, ни compiler-ядро,
 * ни полный фасад. Бандл строго меньше.
 *
 * Гейт делает это заявление воспроизводимым фактом, а не текстом описания: один
 * и тот же fixture собирается РЕАЛЬНЫМ Vite дважды (с плагином motionCompiler()
 * и без) и сверяется по МОДУЛЬНОМУ ГРАФУ, по content-fingerprint солвера и по
 * gzip-весу. Плюс positive controls: динамические формы и onFrame обязаны
 * оставить плагин no-op'ом (иначе гейт мерил бы тавтологию, а не элиминацию).
 *
 * Заземление на dist: alias публичных субпутей → реальные dist-артефакты
 * (те же байты, что получит npm-потребитель). Плагин берётся из собранного
 * dist/compiler/vite. Сборка детерминирована, без сети.
 */

import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const TMP = resolve(ROOT, 'scripts', '.compiler-acceptance-tmp');

/** Alias публичных субпутей на реальные dist-артефакты (байты потребителя). */
const ALIAS = {
  '@labpics/motion/nano': resolve(DIST, 'nano/index.js'),
  '@labpics/motion/compiler/runtime': resolve(DIST, 'compiler/runtime/index.js'),
  '@labpics/motion/animate': resolve(DIST, 'animate/index.js'),
  '@labpics/motion/surface': resolve(DIST, 'surface/index.js'),
};

/** dist-модуль (не entry, не bare peer) в графе — нормализованный к dist-relative id. */
function distModules(chunk) {
  // Vite сообщает id с '/', а resolve() на Windows даёт '\': без нормализации
  // startsWith никогда не совпадёт и граф dist-модулей будет ложно пустым.
  const distSlash = DIST.replaceAll('\\', '/');
  return Object.keys(chunk.modules)
    .map((id) => id.replaceAll('\\', '/'))
    .filter((id) => id.startsWith(distSlash))
    .map((id) => id.slice(distSlash.length + 1));
}

// Плагин грузится динамически в run() ПОСЛЕ проверки существования dist:
// статический импорт из ../dist упал бы раньше дружелюбной диагностики.
let motionCompiler;

/** Один Vite-build fixture'а: возвращает entry-chunk {code, distModules}.
 * entryName — общий путь entry для байтово-сравниваемых пар (rolldown
 * вшивает путь entry в вывод: разные пути ломают no-op-сравнение). */
async function buildFixture(name, code, withPlugin, entryName = name) {
  const entry = resolve(TMP, `${entryName}.js`);
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
// Surface-вызов полного фасада: статические концы + явный layout:'project' —
// единственная форма, которую плагин обязан понизить в surface-executor.
const SURFACE = `import { animate } from '@labpics/motion/animate';
export function play(el) { return animate(el, { width: [240, 360] }, { layout: 'project' }); }`;
// Динамические концы — вне скоупа: корректный runtime path обязан остаться.
const SURFACE_DYNAMIC = `import { animate } from '@labpics/motion/animate';
export function play(el, w) { return animate(el, { width: [240, w] }, { layout: 'project' }); }`;
// onFrame требует observer-час runtime-пути: lowering запрещён семантикой.
const SURFACE_ONFRAME = `import { animate } from '@labpics/motion/animate';
export function play(el) { return animate(el, { width: [240, 360] }, { layout: 'project', onFrame: (f) => f }); }`;

/** Fingerprint spring-солвера: замкнутая форма тянет Math.exp/cos/sin/sqrt. */
const SPRING_MATH = /Math\.(?:exp|cos|sin|sqrt)/;
const RUNTIME_MODULE = 'compiler/runtime/index.js';
const NANO_MODULE = 'nano/index.js';
const ANIMATE_MODULE = 'animate/index.js';
const SURFACE_MODULE = 'surface/index.js';
/**
 * Размерные гейты surface-lowering (хронология от факта):
 * 1. EXECUTOR ≤1 KB gzip — жёсткий гейт КОДА (спека «surface observer ≤1 KB»):
 *    dist/surface/index.js без артефактных данных. Факт 2026-08-05: 1024 B gz.
 * 2. TOTAL — решётка от факта: executor + сертифицированный артефакт (P/Q
 *    serialization — сам payload доказательства ≤0.25 px; физически не сжимаем
 *    ниже без отказа от сертификата). Факт 2026-08-05: 2003 B gz → решётка 2048.
 *    История ужатия: 2743 → 2187 (blend-A вынесена из артефакта в executor) →
 *    2003 (микроужатия executor'а до 1024 B gz).
 */
const SURFACE_EXECUTOR_MAX_GZ = 1024;
const SURFACE_COMPILED_MAX_GZ = 2048;

const failures = [];
const notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

async function run() {
  if (!existsSync(DIST)) {
    console.error('compiler-acceptance: dist отсутствует — сначала pnpm build');
    process.exit(1);
  }
  ({ motionCompiler } = await import('../dist/compiler/vite/index.js'));
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

    // ── Surface lowering: layout:'project' реально стирает фасад ───────────────
    const surfaceBaseline = await buildFixture('surface-uncompiled', SURFACE, false, 'surface');
    const surfaceCompiled = await buildFixture('surface-compiled', SURFACE, true, 'surface');
    // Контроль fixture'а: surface-вызов ДЕЙСТВИТЕЛЬНО тянет полный фасад из
    // dist. Без него все ассерты ниже вакуумно проходят на пустом графе.
    check(
      surfaceBaseline.modules.includes(ANIMATE_MODULE),
      `surface-fixture не тянет ${ANIMATE_MODULE} (alias не разрешился, ассерты вакуумны): ${surfaceBaseline.modules.join(', ')}`,
    );
    check(
      SPRING_MATH.test(surfaceBaseline.code),
      'surface-baseline не содержит spring-математику — fixture не доказывает рантаймовый путь',
    );
    // Erasure: compiled-граф несёт ТОЛЬКО приватный surface-executor.
    check(
      surfaceCompiled.modules.includes(SURFACE_MODULE),
      `compiled surface не тянет executor ${SURFACE_MODULE}: ${surfaceCompiled.modules.join(', ')}`,
    );
    check(
      !surfaceCompiled.modules.includes(ANIMATE_MODULE),
      `compiled surface всё ещё несёт фасад ${ANIMATE_MODULE}: ${surfaceCompiled.modules.join(', ')}`,
    );
    const surfaceExtra = surfaceCompiled.modules.filter((m) => m !== SURFACE_MODULE);
    check(
      surfaceExtra.length === 0,
      `compiled surface-граф несёт лишние dist-модули (ожидался только executor): ${surfaceExtra.join(', ')}`,
    );
    check(
      !SPRING_MATH.test(surfaceCompiled.code),
      'compiled surface содержит spring-математику — солвер не элиминирован',
    );
    // Артефакт на месте: precomputed linear()-тройка и pseudo-tree-эффекты.
    check(
      /linear\(/.test(surfaceCompiled.code),
      'compiled surface не содержит precomputed linear()-артефакт',
    );
    check(
      surfaceCompiled.code.includes('::view-transition-group('),
      'compiled surface не содержит 5 CSS-effects псевдодерева',
    );
    // Относительный размер: compiled строго меньше полного фасада.
    const surfaceBaselineGz = gzipSync(surfaceBaseline.code).length;
    const surfaceCompiledGz = gzipSync(surfaceCompiled.code).length;
    check(
      surfaceCompiledGz < surfaceBaselineGz,
      `compiled surface (${surfaceCompiledGz} B gz) не меньше uncompiled (${surfaceBaselineGz} B gz)`,
    );
    // Абсолютные гейты: (1) код executor'а ≤1 KB gz независимо от данных;
    // (2) total-решётка от факта (executor + certified-артефакт вызова).
    const executorGz = gzipSync(readFileSync(resolve(DIST, SURFACE_MODULE))).length;
    check(
      executorGz <= SURFACE_EXECUTOR_MAX_GZ,
      `surface-executor ${executorGz} B gz превышает гейт кода ${SURFACE_EXECUTOR_MAX_GZ} B gz`,
    );
    check(
      surfaceCompiledGz <= SURFACE_COMPILED_MAX_GZ,
      `compiled surface ${surfaceCompiledGz} B gz превышает решётку ${SURFACE_COMPILED_MAX_GZ} B gz`,
    );
    notes.push(
      `surface lowering: uncompiled ${surfaceBaselineGz} B gz → compiled ${surfaceCompiledGz} B gz ` +
      `(−${surfaceBaselineGz - surfaceCompiledGz} B, −${((1 - surfaceCompiledGz / surfaceBaselineGz) * 100).toFixed(1)}%; ` +
      `executor ${executorGz}/${SURFACE_EXECUTOR_MAX_GZ} B gz, total-решётка ${SURFACE_COMPILED_MAX_GZ} B gz)`,
    );
    notes.push(`граф compiled surface: ${surfaceCompiled.modules.join(', ') || '(только entry)'}`);

    // ── No-op контроли surface: динамика и onFrame остаются runtime path ────
    const surfaceDynamic = await buildFixture('surface-dynamic', SURFACE_DYNAMIC, true, 'surface-dyn');
    check(
      surfaceDynamic.modules.includes(ANIMATE_MODULE) && !surfaceDynamic.modules.includes(SURFACE_MODULE),
      `плагин ошибочно понизил динамический surface-вызов (граф: ${surfaceDynamic.modules.join(', ')})`,
    );
    const surfaceOnFrame = await buildFixture('surface-onframe', SURFACE_ONFRAME, true, 'surface-of');
    check(
      surfaceOnFrame.modules.includes(ANIMATE_MODULE) && !surfaceOnFrame.modules.includes(SURFACE_MODULE),
      `плагин ошибочно понизил surface-вызов с onFrame (граф: ${surfaceOnFrame.modules.join(', ')})`,
    );
    notes.push('surface no-op контроль: динамические концы и onFrame сохранили рантаймовый путь');
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
