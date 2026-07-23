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

// Плагин грузится динамически в run() ПОСЛЕ проверки существования dist:
// статический импорт из ../dist упал бы раньше дружелюбной диагностики.
let motionCompiler;

/** Один Vite-build fixture'а: возвращает entry-chunk {code, distModules}. */
async function buildFixture(name, code, withPlugin, pluginOptions) {
  const entry = resolve(TMP, `${name}.js`);
  writeFileSync(entry, code);
  const result = await build({
    root: ROOT,
    logLevel: 'silent',
    configFile: false,
    resolve: { alias: ALIAS },
    plugins: withPlugin ? [motionCompiler(pluginOptions)] : [],
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

// Статическая opacity — исторический минимальный срез (#208 §core).
const LOWERABLE = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }`;
// Динамическая opacity — вне скоупа: плагин обязан отказать (positive control).
const DYNAMIC = `import { animate } from '@labpics/motion/nano';
export function play(el, v) { return animate(el, { opacity: v }); }`;
// Полный common-motion срез #220/#221: multi-prop + spring/delay/stagger.
// Северная метрика эпика: consumer fixture ≤ 5 KB gzip (initial и total —
// сборка single-chunk, поэтому один и тот же байтовый срез).
const COMMON = `import { animate } from '@labpics/motion/nano';
export function play(els) {
  return animate(els, { translate: '120px 0', scale: 1.04, rotate: 8, opacity: 1 }, {
    spring: { mass: 1, stiffness: 170, damping: 26 },
    delay: 40,
    stagger: 20,
  });
}`;
const COMMON_MOTION_CEILING_GZ = 5120;

// ── Леджер «шов+артефакт» (#237): ратчетируемые consumer-сценарии ────────────
// Именно сумма «executor-шов + инъецированные артефакты» конкурирует с
// compiled-стендами конкурентов (size-compare: 866 B gz). Exact-ратчет от
// факта (люфт нулевой, конвенция ./compiler/runtime): рост — только решением.
// Хронология: 2026-07-23 первые факты — ×1: 883 B gz (конкурентный
// compiled-стенд 866 B — разрыв 17 B, цель портфеля #238/#239), ×5 (3 уникальные
// пружины): 1516 B gz.
const LEDGER_ONE_CEILING_GZ = 883;
const LEDGER_FIVE_CEILING_GZ = 1516;
// 5 вызовов, 3 уникальные пружины (дефолт + два литеральных пресета):
// gzip-дедуп повторной пружины — часть заявления леджера.
const LEDGER_FIVE = `import { animate } from '@labpics/motion/nano';
export function play(el) {
  animate(el, { opacity: 1 });
  animate(el, { translate: '0 12px' }, { spring: { mass: 1, stiffness: 120, damping: 14 } });
  animate(el, { scale: 1.05 }, { spring: { mass: 1, stiffness: 260, damping: 28 } });
  animate(el, { rotate: 6 }, { delay: 40, stagger: 20 });
  return animate(el, { opacity: 0.5 }, { spring: { mass: 1, stiffness: 120, damping: 14 } });
}`;
// strict-smoke (#237): непониженный вызов валит сборку; маркер — пропускает.
const MARKED_DYNAMIC = `import { animate } from '@labpics/motion/nano';
export function play(el, v) { return /* @motion-runtime */ animate(el, { opacity: v }); }`;

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

    // ── (#221) Common-motion fixture: элиминация + северная метрика ≤5 KB ─────
    const commonBaseline = await buildFixture('common-uncompiled', COMMON, false);
    const commonCompiled = await buildFixture('common-compiled', COMMON, true);
    const commonExtra = commonCompiled.modules.filter((m) => m !== RUNTIME_MODULE);
    check(
      commonCompiled.modules.includes(RUNTIME_MODULE) && commonExtra.length === 0,
      `common-compiled несёт лишние dist-модули: ${commonExtra.join(', ')}`,
    );
    check(
      !SPRING_MATH.test(commonCompiled.code),
      'common-compiled содержит spring-математику — солвер не элиминирован',
    );
    check(
      /8deg/.test(commonCompiled.code) && /120px 0/.test(commonCompiled.code),
      'common-compiled не несёт канонический multi-prop артефакт',
    );
    const commonBaselineGz = gzipSync(commonBaseline.code).length;
    const commonCompiledGz = gzipSync(commonCompiled.code).length;
    check(
      commonCompiledGz < commonBaselineGz,
      `common-compiled (${commonCompiledGz} B gz) не меньше uncompiled (${commonBaselineGz} B gz)`,
    );
    check(
      commonCompiledGz <= COMMON_MOTION_CEILING_GZ,
      `common-motion fixture ${commonCompiledGz} B gz > потолка ${COMMON_MOTION_CEILING_GZ} (#220)`,
    );
    notes.push(
      `common-motion (#221): uncompiled ${commonBaselineGz} B gz → compiled ${commonCompiledGz} B gz ` +
      `(потолок ${COMMON_MOTION_CEILING_GZ}, single-chunk ⇒ initial = total)`,
    );

    // ── (#237) Леджер «шов+артефакт»: ратчетируемые ×1 и ×5 ──────────────────
    check(
      compiledGz <= LEDGER_ONE_CEILING_GZ,
      `ledger ×1 (${compiledGz} B gz) > ратчета ${LEDGER_ONE_CEILING_GZ}`,
    );
    let budget;
    const five = await buildFixture('ledger-five', LEDGER_FIVE, true, {
      onBudget: (report) => { budget = report; },
    });
    const fiveExtra = five.modules.filter((m) => m !== RUNTIME_MODULE);
    check(
      five.modules.includes(RUNTIME_MODULE) && fiveExtra.length === 0,
      `ledger ×5 несёт лишние dist-модули: ${fiveExtra.join(', ')}`,
    );
    check(!SPRING_MATH.test(five.code), 'ledger ×5 содержит spring-математику');
    const fiveGz = gzipSync(five.code).length;
    check(
      fiveGz <= LEDGER_FIVE_CEILING_GZ,
      `ledger ×5 (${fiveGz} B gz) > ратчета ${LEDGER_FIVE_CEILING_GZ}`,
    );
    check(
      budget !== undefined && budget.lowered === 5 && budget.runtimeCalls === 0,
      `квитанция onBudget неожиданна: ${JSON.stringify(budget)}`,
    );
    notes.push(
      `ledger (#237): ×1 = ${compiledGz} B gz (ратчет ${LEDGER_ONE_CEILING_GZ}), ` +
      `×5 (3 пружины) = ${fiveGz} B gz (ратчет ${LEDGER_FIVE_CEILING_GZ}); ` +
      `onBudget: lowered=${budget?.lowered}, runtime=${budget?.runtimeCalls}, artifactChars=${budget?.artifactChars}`,
    );

    // ── (#237) strict-smoke: непониженный вызов валит сборку, маркер — нет ───
    let strictError;
    try {
      await buildFixture('dynamic-strict', DYNAMIC, true, { strict: true });
    } catch (error) {
      strictError = error;
    }
    check(
      strictError !== undefined &&
        /strict: непониженный nano-вызов/.test(String(strictError?.message ?? strictError)),
      'strict-режим не остановил сборку с непониженным вызовом',
    );
    const marked = await buildFixture('marked-strict', MARKED_DYNAMIC, true, { strict: true });
    check(
      marked.modules.includes(NANO_MODULE) && !marked.modules.includes(RUNTIME_MODULE),
      `маркированный @motion-runtime вызов обязан остаться рантаймовым при strict (граф: ${marked.modules.join(', ')})`,
    );
    notes.push('strict (#237): непониженный вызов — ошибка сборки с позицией; @motion-runtime — пропуск');
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
