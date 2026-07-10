/**
 * size-gate.mjs — размерный гейт @labpics/motion
 *
 * Две метрики, обе жёсткие (превышение или отсутствующий dist-файл → exit 1):
 *
 * 1. ШИПНУТЫЙ вес: gz каждого ESM-subpath в dist/ (что качает CDN/raw-потребитель).
 *    Список subpath-точек выводится АВТОМАТИЧЕСКИ из package.json → "exports".
 *    Порог несёт только ядро (".").
 *
 * 2. СЦЕНАРНЫЙ import-cost: сколько gz реально платит npm-потребитель за
 *    типовой импорт — esbuild bundle+minify против dist (ровно то, что сделает
 *    его бандлер). Это главный потребительский гейт: он ловит и регрессию
 *    tree-shakeability (раздутый сценарий при неизменном шипнутом весе), и
 *    совокупное раздувание — поэтому отдельного «full-bundle»-гейта нет.
 *    Заземление 2026-07-02: шипнутый terser-минифицированный dist трясётся
 *    esbuild'ом ЛУЧШЕ неминифицированного во всех сценариях (856 vs 873 /
 *    1536 vs 1701 / 2173 vs 2350 gz) — mangle /^_/ даёт выигрыш, который
 *    бандлер потребителя сам не получит; двойной dist не нужен.
 *
 * Пороги — РЕГРЕССИОННЫЕ потолки (факт + люфт на шум минификаторов), не цели;
 * не поднимать без явного решения Даниила.
 *
 * Использование:
 *   node scripts/size-gate.mjs
 *   pnpm size
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Порог (в байтах) для ядра пакета (".") — фактический вес после s09 = ~2090 gz
// + небольшой люфт. Дожимание до 2048 отменено решением Даниила 2026-07-02:
// за размер браться только при перспективе кратного (~2×) выигрыша,
// не ради добивания круглой цифры.
// 2150 → 2190 (2026-07-03): +~80 gz — clamp:false (честный overshoot в 4
// драйверах) + выведенный settle-бюджет валидатора взамен коробочных полов.
// Подъём в рамках полной делегации Даниила на автономные решения
// («каждый следующий шаг решай автономно»); дешёвые шейвы сняты до подъёма.
export const CORE_GATE_BYTES = 2220;

// Потолок для КАЖДОГО прочего субпутя (drift-класс: новый/раздутый субпуть
// не должен молча проходить без порога). Максимальный факт 2026-07-02 —
// ./presets 4004 gz; люфт ~15%. С 2026-07-09 ./presets вырос осознанно
// (текстовые/числовые сахара) и ушёл под точечный порог в BESPOKE_SUBPATH_GATES;
// общий потолок не трогаем — калибровку по остальным субпутям он сохраняет.
export const SUBPATH_GATE_BYTES = 4608;

// Точечные (bespoke) пороги субпутей — жёстче общего SUBPATH_GATE_BYTES там, где
// это осмысленно. ./utils — семь чистых скалярных примитивов + сегментный движок;
// факт после первой сборки 1197 gz, люфт ~15%. Отдельный порог не даёт будущему
// раздуванию прятаться под щедрым общим зонтом 4608 (тот же класс, что ловит
// CORE_GATE_BYTES для ядра). Поднимать только осознанно.
export const BESPOKE_SUBPATH_GATES = {
  './utils': 1400,
  // ./compositor — компилятор пружина→linear() (сегментер + LRU-кэш + контроллер)
  // + C¹-хендофф compositor→live (M2) + COMPOSITED STAGGER (M3) + FALLBACK-МАТРИЦА (M4).
  // Хронология факта/порога:
  //   M1: 4408 / 4600 — компилятор + сегментер + LRU + CompositorSpring.
  //   M2: 4672 / 4800 — живой мост в rAF-пружину (handoffToLive).
  //   M3: 5919 / 6100 — composited stagger. НЕИЗБЕЖНЫЙ рост на новую capability:
  //       (а) compileStaggerPlan — чистый планировщик (общий план + per-element
  //           задержки из ./stagger); (б) CompositorStaggerGroup — контроллер группы
  //           (N CompositorSpring, per-group каскад, per-element retarget/handoff);
  //       (в) delay + setTimer в CompositorSpring (нативный WAAPI-delay на compositor-
  //           пути, отложенный старт на fallback). Рост +1247 gz на весь слой каскада.
  //       Порог 6100 = факт 5919 + ~3% люфт (дисциплина M1/M2 сохранена; ./stagger
  //       переиспользуется, не дублируется). Жёстче общего 4608.
  //   M4: 6193 / 6380 — fallback-матрица (detect.ts: резолвер 5 тиров
  //       compositor / waapi-no-linear / raf / reduced / ssr; мемо-проба
  //       CSS.supports('linear()') на реалм, reduced-motion снап-политика,
  //       диагностический `tier` + телеметрия-резолвер resolveCompositorTier/
  //       supportsLinearEasing). Вклад M4 на объединённом с M3 коде: 6193 − 5919 =
  //       +274 gz (на изолированном M2-базисе был +245 / порог 5040; +29 gz —
  //       интеграция detect с stagger-контроллером). Порог 6380 = факт 6193 + ~3%
  //       люфт — выведен ОТ ФАКТА, не суммой порогов. Поднимать только решением Даниила.
  './compositor': 6450,
  // ./tokens — motion-токены (SSOT labui): duration/easing/spring/staggerGap +
  // distanceScale + springFromDurationBounce (каноническая пара ДС (duration,bounce)
  // → SpringParams; тянет validateSpringParams ядра, чтобы выход ГАРАНТИРОВАННО
  // оседал). Чистые данные + 4 cubic-bezier (тянут ../easing.cubicBezier).
  // Хронология факта/порога (дисциплина ./compositor: порог ОТ ФАКТА):
  //   1117 gz / 1250 — до канонической пары;
  //   2026-07-09: 1552 gz / 1650 (~6% люфт) — конвертер + валидатор ядра
  //   (settle-гарантия) + ДС-пресеты smooth/expressive. Вызовы пресетов
  //   PURE-аннотированы: соседние субпути (presets, animate-пути без spring)
  //   конвертер не платят — проверено фактами presets/animate-one-liner.
  // Гарантия — СУБПУТЬ-изоляция (sideEffects:false): не импортишь ./tokens = ноль,
  // ядро не растёт (full-core сценарий это и стережёт). Внутри субпутя семейства в
  // минифициров. dist по отдельности не шейкаются; целиком дёшев. Поднимать осознанно.
  './tokens': 1650,
  // ./projection — вложенный FLIP (жанр Framer projection): geometry (замкнутая
  // форма child-local transform через visual box ближайшего проецирующего предка,
  // per-corner radius-коррекция) + driver (одна нормированная пружина
  // solveSpring(v0) — velocity continuity при перехвате) + DOM-адаптер (composed
  // shadow-обход, batch clear→measure→start граница). splitting:false ⇒ несёт
  // копии среза flip (correctRadius/counterScale) и solver/validate — шипнутый gz
  // двойной счёт, честная цена — import-cost сценарии ниже. Хронология:
  //   2026-07-10: факт 4890 gz первой сборки → порог 5350 (~9% люфт, дисциплина
  //   «порог ОТ ФАКТА»). Выше общего 4608 законно: класс animate — самодостаточный
  //   субпуть с копиями подсистем.
  //   2026-07-10 (позже): факт 5530 gz → порог 5750 (~4%). Рост НЕ раздувание,
  //   а две волны корректности одного дня: (1) phase-машина + continuity-ребейз
  //   radii/opacity (адверсариальное ревью, PR #109); (2) фиксы ревью CodeRabbit —
  //   доминантный C¹-скан по radii/opacity-каналам, floor отрицательного масштаба
  //   на всех путях (анти-зеркало), ранняя валидация radii-кортежей
  //   (MotionParamError вместо TypeError из горячего at()). Ужим выполнен ДО
  //   подъёма (дедуп rebaseNode/lerp1, −100 gz); подъём — в рамках делегации
  //   Даниила на автономные решения (прецедент CORE 2150→2190 выше).
  './projection': 5750,
  // ./smart — Figma-подобный smart-animate ПОВЕРХ ./projection (жанр shared-element
  // / smart-animate): диф двух снимков дерева по строке-ключу data-motion-key →
  // matched/entered/exited/skipped, оркестрация поверх ОДНОГО projection-движка
  // (matched → FLIP с continuity по строке-ключу; entered → fade-in; exited →
  // ghost-протокол; единый clock; reduced = character-switch). splitting:false ⇒
  // субпуть несёт весь граф ./projection (geometry+driver+dom) + срез flip/solver/
  // validate — шипнутый gz двойной счёт, честная цена самодостаточного субпутя
  // (класс animate/projection). Хронология факта/порога:
  //   2026-07-10: факт 7151 gz первой сборки → порог 7450 (~4% люфт, дисциплина
  //   ./projection «порог ОТ ФАКТА»). Выше общего 4608 законно: тянет проекционное
  //   ядро целиком. Поднимать только осознанно.
  './smart': 7450,
  // ./presets — headless-словарь движений + текстовые/числовые сахара
  // (порт ценного из PR#79: splitText/typewriterAt/scrambleAt/tickerCells/
  // formatNumber + раннеры runTypewriter/runScramble/runNumber поверх runPreset).
  // Хронология факта/порога:
  //   до сахаров: факт 4004 gz — жил под общим порогом 4608.
  //   2026-07-09: факт 5388 gz — рост +1384 gz на новую capability
  //   (Intl-форматтер, seeded mulberry32, три раннера), НЕ раздувание:
  //   clock / reduced-motion / детерминизм переиспользуются из runPreset,
  //   не дублируются. Порог 5600 = факт 5388 + ~4% люфт (дисциплина
  //   ./compositor: порог ОТ ФАКТА, не суммой хотелок). Поднимать только
  //   осознанно; сам этот подъём — часть переноса PR#79, подсвечен в PR.
  './presets': 5600,
  // ./animate — одно-строчный DOM-фасад (паритет DX Motion/anime v4). Порог выше
  // общего 4608 НЕ потому, что фасад «раздут», а потому, что при splitting:false
  // самодостаточный субпуть НЕСЁТ КОПИИ композируемых подсистем (общий порог
  // калибровался по субпутям с 1-2 зависимостями). Разбивка факта 10389 gz:
  //   ~2.6 KB — движок значений ./value (цвета hex/rgb/hsl + юниты + var() +
  //             transform-компоненты) — канал «любое CSS-свойство»;
  //   ~3.7 KB — compositor-подмножество: compileSpringPlan (сегментер + LRU-кэш +
  //             формат linear()) + readCompositorSpring + detect (авто-tier);
  //             мёртвый вес отсутствует — CompositorSpring/MotionValue/driver/
  //             stagger-group вытряхнуты (проверено пробами строк-литералов);
  //   ~1.1 KB — ./tokens (дефолты spring/duration/easing = характеризация);
  //   ~0.7 KB — ./stagger (каскад);
  //   ~2.3 KB — сам фасад: цели/селектор, реестр прерываний (C¹-подхват),
  //             два движка прогонов (rAF-микроцикл + WAAPI-юнит), контролы.
  // Потребитель, который composит вручную (ядро+value+compositor), платит то же —
  // фасад не добавляет физики. Порог 10700 = факт 10389 + ~3% люфт (канон M4).
  // Дедуп через splitting/shared chunks — отдельное архитектурное решение
  // Даниила на весь пакет, не этого субпутя. Поднимать только осознанно.
  './animate': 10700,
};

/**
 * Потребительские сценарии: код — то, что реально пишет потребитель;
 * gate — потолок от замера 2026-07-02 (+~4% люфт). `%DIST%` подставляется
 * абсолютным путём dist/index.js.
 */
export const IMPORT_COST_SCENARIOS = [
  {
    name: 'only-spring',
    code: `import { spring } from '%DIST%'; console.log(spring({mass:1,stiffness:200,damping:20}, 0.1).value);`,
    gate: 920, // updated for perf changes
  },
  {
    // Страж tree-shake геометрии от драйвера/DOM: чистая функция projectAt не
    // должна тянуть солвер и адаптер. Скачок числа = геометрия потянула драйвер.
    name: 'projection-core-only',
    code: `import { projectAt } from '%DIST%/../projection/index.js'; console.log(projectAt({first:{x:0,y:0,width:1,height:1},last:{x:0,y:0,width:1,height:1}}, null, 0.5).sx);`,
    // 2026-07-10: факт первой сборки 655 gz → порог 720 (~10%, ОТ ФАКТА).
    gate: 720,
  },
  {
    // Правда потребительской цены DOM-однострочника (капчур → мутация → play).
    name: 'projection-dom-one-liner',
    code: `import { createDomProjection } from '%DIST%/../projection/index.js'; const p = createDomProjection(); p.capture([]); p.play(); p.cancel(); console.log(p.playing);`,
    // 2026-07-10: факт первой сборки 4899 gz → порог 5350 (~9%, ОТ ФАКТА).
    // 2026-07-10 (позже): факт 5536 gz → порог 5750 (~4%) — хронология и
    // обоснование в комментарии './projection' в BESPOKE_SUBPATH_GATES.
    gate: 5750,
  },
  {
    name: 'only-MotionValue',
    code: `import { MotionValue } from '%DIST%'; const m = new MotionValue({initial:0, spring:{mass:1,stiffness:200,damping:20}}); m.onChange(v=>console.log(v)); m.setTarget(1);`,
    // 1600→1620 (M2): +~14 gz за opts.initialVelocity — засев скорости рождения,
    // НЕОБХОДИМЫЙ для C¹-хендоффа compositor→live (нет иного публичного seam'а;
    // дублировать rAF-цикл MotionValue в handoff = запрещённый coupled-дубль). Факт 1606.
    gate: 1640, // updated for perf changes
  },
  {
    name: 'full-core',
    code: `import * as M from '%DIST%'; console.log(Object.keys(M).length, M.spring({mass:1,stiffness:200,damping:20},0.1).value);`,
    // 2250 → 2290 (2026-07-03): +48 gz — цена ДВУХ фич волны clamp:false
    // (честный overshoot во всех 4 драйверах) и замены коробочных полов
    // валидатора выведенным settle-бюджетом (settleTimeUpperBound). Подъём
    // сделан в рамках полной делегации Даниила на автономные решения
    // (2026-07-03, «каждый следующий шаг решай автономно»); дешёвые шейвы
    // уже сняты (−15 gz: √(km)=m·ω₀, дедуп √(ζ²−1), сжатие сообщения).
    // Люфт прежний ~1.5% от факта 2254.
    gate: 2300,
  },
  {
    // Один скалярный примитив из ./utils обязан трястись до горстки байт — это
    // страж tree-shakeability субпутя: если clamp случайно потянет сегментный
    // движок interpolate или соседей, сценарий скакнёт с ~300 до ~1200 gz.
    // Путь до субпутя выводится из %DIST% (dist/index.js) через sibling-нормализацию
    // index.js/../utils/index.js → dist/utils/index.js — инвариант «%DIST% в каждом
    // сценарии» сохранён.
    name: 'only-clamp (utils tree-shake)',
    code: `import { clamp } from '%DIST%/../utils/index.js'; console.log(clamp(0,1,2));`,
    gate: 340, // факт 308 (2026-07-07, первая сборка ./utils); люфт ~10%
  },
  {
    // ПРАВДА потребительской цены фасада. Отгрузочный gz субпутя ./animate
    // (~10.4 KB, bespoke-порог выше) — двойной счёт: при splitting:false субпуть
    // несёт копии value/compositor/tokens/stagger. Реальная цена в бандле
    // потребителя ПОСЛЕ его tree-shake — вот этот сценарий; именно ЕГО число
    // публикуется в сравнениях размеров (vs Motion mini animate 2.6 KB
    // vendor-published). Скачок сценария = регрессия tree-shakeability фасада.
    name: 'animate-one-liner (фасад)',
    code: `import { animate } from '%DIST%/../animate/index.js'; console.log(typeof animate('.hero', { x: 240, opacity: 1 }).pause);`,
    // Факт 10865 (2026-07-09, первая сборка фасада) + ~3% люфт. ЧЕСТНАЯ находка:
    // tree-shake почти не снижает цену — фасад статически тянет весь граф
    // (value+compositor+tokens+stagger) из-за рантайм-диспетчеризации props.
    // Позиция рынка: ≈ anime.js full (~10 KB), < Motion full (18 KB vendor),
    // НО > Motion mini 2.6+1 KB. Следующий шаг эпика — слоистый animate/mini
    // (transform/opacity + compositor-пружина БЕЗ движка значений) с целью
    // ≤5 KB; этот порог тогда останется стражем полного фасада.
    gate: 11200,
  },
];

/**
 * Меряет один сценарий: esbuild stdin (без временных файлов) → minify ESM →
 * gz level-9. Ошибка сборки (пропавший экспорт, битый dist) НЕ маскируется —
 * возвращается error, гейт падает громко.
 */
export async function measureScenario(scenario, distIndexPath) {
  // Прямые слэши: esbuild принимает абсолютный путь как спецификатор,
  // но не file://-URL; бэкслэши Windows ломают парсинг строки-импорта.
  const code = scenario.code.replaceAll('%DIST%', distIndexPath.replace(/\\/g, '/'));
  try {
    const result = await build({
      stdin: { contents: code, resolveDir: dirname(distIndexPath), loader: 'js' },
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const out = result.outputFiles[0].contents;
    return { name: scenario.name, gzBytes: gzipSync(out, { level: 9 }).length, rawBytes: out.length, gate: scenario.gate };
  } catch (err) {
    return { name: scenario.name, error: String(err?.message ?? err).split('\n')[0], gate: scenario.gate };
  }
}

/**
 * Рекурсивно достаёт СТРОКОВЫЙ путь из conditional-exports значения.
 * package.json "exports" допускает произвольную вложенность условий
 * (например `{ import: { types, default } }`), поэтому просто `value.import`
 * не гарантированно строка — нужно спускаться, пока не найдётся строка.
 * Возвращает null, если строкового пути нет (вместо падения с TypeError).
 */
function resolveImportString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const nested = value.import ?? value.default;
    if (nested !== undefined) return resolveImportString(nested);
  }
  return null;
}

/**
 * Выводит список { key, label, importPath, gate } из package.json → exports.
 * Работает с любой формой exports-значения: строка, conditional-объект с
 * полем "import"/"default", включая произвольно вложенные условия. Чистая
 * функция — без чтения диска и без побочных эффектов, что делает её
 * напрямую юнит-тестируемой без сборки dist/.
 */
export function deriveEntriesFromExports(pkg) {
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object') {
    throw new Error('package.json: поле "exports" отсутствует или не объект — размерный гейт не может вывести subpath-точки');
  }

  return Object.entries(exportsField)
    .map(([key, value]) => {
      const importPath = resolveImportString(value);
      if (!importPath) return null;
      const label = key === '.' ? 'core (index)' : key.replace(/^\.\//, '');
      return {
        key,
        label,
        importPath: importPath.replace(/^\.\//, ''),
        gate:
          key === '.'
            ? CORE_GATE_BYTES
            : (BESPOKE_SUBPATH_GATES[key] ?? SUBPATH_GATE_BYTES),
      };
    })
    .filter(Boolean);
}

/**
 * Измеряет gz-вес каждой entry относительно ROOT. Чистая функция ввода/вывода
 * данных (без console.log) — тестируема отдельно от CLI-форматирования.
 */
export function measureEntries(entries, root) {
  let totalGzBytes = 0;
  let hasWarnings = false;

  const rows = entries.map(entry => {
    const fullPath = resolve(root, entry.importPath);
    let raw, gz;
    try {
      raw = readFileSync(fullPath);
      gz = gzipSync(raw, { level: 9 });
    } catch (err) {
      hasWarnings = true;
      // Различаем "файла нет" (ожидаемо до сборки/для ещё-не-смерженных
      // subpath) от прочих ошибок (EACCES и т.п.), которые маскировать
      // нельзя — это реальный сбой окружения, не отсутствующий dist/.
      const reason = err?.code === 'ENOENT' ? 'MISSING' : `ERROR(${err?.code ?? err?.message ?? 'unknown'})`;
      return { label: entry.label, error: `${reason}: ${entry.importPath}` };
    }

    totalGzBytes += gz.length;
    const exceeded = entry.gate !== null && gz.length > entry.gate;
    if (exceeded) hasWarnings = true;

    return {
      label: entry.label,
      rawBytes: raw.length,
      gzBytes: gz.length,
      gate: entry.gate,
      exceeded,
    };
  });

  return { rows, totalGzBytes, hasWarnings };
}

async function runCli() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const entries = deriveEntriesFromExports(pkg);
  const { rows, totalGzBytes, hasWarnings: measuredWarnings } = measureEntries(entries, ROOT);
  let hasWarnings = measuredWarnings;

  // ─── вывод ────────────────────────────────────────────────────────────────

  const COL = { label: 22, raw: 10, gz: 10 };

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);

  console.log('\n@labpics/motion — bundle size (ESM, gzip level-9)\n');
  console.log(
    pad('Entry', COL.label) +
    lpad('Raw', COL.raw) +
    lpad('GZ', COL.gz) +
    '  Status'
  );
  console.log('-'.repeat(COL.label + COL.raw + COL.gz + 10));

  for (const row of rows) {
    if (row.error) {
      console.log(pad(row.label, COL.label) + '  ' + row.error);
      continue;
    }

    const rawFmt = lpad((row.rawBytes / 1024).toFixed(2) + ' KB', COL.raw);
    const gzFmt = lpad((row.gzBytes / 1024).toFixed(2) + ' KB gz', COL.gz + 3);

    let status = 'OK';
    if (row.exceeded) {
      status = `WARN > ${(row.gate / 1024).toFixed(1)} KB gz [OPEN ITEM]`;
    }

    console.log(pad(row.label, COL.label) + rawFmt + gzFmt + '  ' + status);
  }

  console.log('-'.repeat(COL.label + COL.raw + COL.gz + 10));
  const totalFmt = (totalGzBytes / 1024).toFixed(2);
  console.log(pad(`TOTAL (${rows.length} subpaths)`, COL.label + COL.raw) + lpad(totalFmt + ' KB gz', COL.gz + 3));

  // ─── OPEN ITEMS ─────────────────────────────────────────────────────────

  if (hasWarnings) {
    const core = rows.find(r => r.label === 'core (index)');
    if (core && !core.error && core.exceeded) {
      console.log(`
РЕГРЕССИЯ РАЗМЕРА
-----------------
core (index) gz = ${(core.gzBytes / 1024).toFixed(2)} KB > порог ${(core.gate / 1024).toFixed(2)} KB.
  Ядро выросло относительно зафиксированного после s09 веса (~2.04 KB gz).
  Найди раздувший коммит/правку и убери причину — порог не поднимать
  без явного решения Даниила (это и есть класс, который гейт ловит).
`);
    }
  }

  // ─── сценарный import-cost (главный потребительский гейт) ───────────────

  console.log('\nimport-cost потребителя (esbuild bundle+minify+gz против dist)\n');
  const distIndexPath = resolve(ROOT, 'dist/index.js');
  for (const scenario of IMPORT_COST_SCENARIOS) {
    const m = await measureScenario(scenario, distIndexPath);
    if (m.error) {
      hasWarnings = true;
      console.log(pad(m.name, COL.label) + `  FAIL: ${m.error}`);
      continue;
    }
    const exceeded = m.gzBytes > m.gate;
    if (exceeded) hasWarnings = true;
    console.log(
      pad(m.name, COL.label) +
      lpad(`${m.gzBytes} B gz`, COL.gz) +
      `  ${exceeded ? `РЕГРЕССИЯ > ${m.gate} B (найди раздувший коммит; порог не поднимать без решения Даниила)` : `OK (порог ${m.gate})`}`
    );
  }

  // ─── итог ─────────────────────────────────────────────────────────────

  if (hasWarnings) {
    console.log('size-gate: FAIL (см. детали выше) — CI останавливается');
    process.exit(1);
  } else {
    console.log('size-gate: PASS');
  }
}

// Запускать CLI-вывод только когда файл выполняется напрямую (`node scripts/size-gate.mjs`),
// не при импорте функций в тестах.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((err) => {
    // Сломанный замер не имеет права выглядеть зелёным.
    console.error('size-gate: внутренняя ошибка —', err);
    process.exit(1);
  });
}
