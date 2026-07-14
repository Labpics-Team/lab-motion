/**
 * size-gate.mjs — размерный гейт @labpics/motion
 *
 * Две метрики, обе жёсткие (превышение или отсутствующий dist-файл → exit 1):
 *
 * 1. ШИПНУТЫЙ вес: канонический gzip и Brotli начального статического ESM-графа каждого
 *    subpath (entry + recursive local imports, каждый HTTP-файл сжат отдельно).
 *    Это то, что качает CDN/raw-потребитель. Регрессионный порог остаётся на gzip; Brotli —
 *    независимая наблюдаемая метрика, чтобы оптимизация не подгонялась под один кодек.
 *    Список subpath-точек выводится АВТОМАТИЧЕСКИ из package.json → "exports";
 *    каждый subpath имеет hard ceiling, отдельные capability-пути — более узкий.
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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative, sep as pathSeparator } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build, buildSync } from 'esbuild';
import {
  canonicalGzip,
  observationalBrotli,
} from './compression-oracle.mjs';

// Compression-политика вынесена в узкий SSOT: сравнительный стенд использует
// те же байты gzip, не импортируя esbuild, пороги и остальной размерный гейт.

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

// Один потолок закрывает один runtime-граф в двух представлениях: shipped
// ./animate + shared frame и типичный consumer bundle. Прежние 11 200 B были
// только снимком первой реализации и конфликтовали с производственным
// SurfaceBatch: +~0.7 KB дают 3–5× на 1000 независимых вызовах. Предел 12 000 B
// зафиксирован от обязательного production-факта 11 938 B с запасом 62 B
// (0.52%). Это регрессионный budget, не конкурентное утверждение: сравнения
// живут в воспроизводимом benchmark-report. Обе формы обязаны оставаться внутри
// одного потолка, а массовый perf-контракт не даёт купить размер замедлением.
export const FULL_ANIMATE_GATE_BYTES = 12_000;

// Consumer-rebundle ядра после стабильных кодов ошибок и изоляции listener-
// сбоев. Физический shipped-граф при этом уменьшился и по-прежнему ограничен
// CORE_GATE_BYTES; 2 330 B — узкий предел только для повторной минификации
// namespace-сценария, а не новый бюджет самого entry.
export const FULL_CORE_CONSUMER_GATE_BYTES = 2330;

// Публичный platform-trusted WAAPI entry. 1024 B — продуктовая граница,
// утверждённая владельцем до реализации; она не выводится из текущего факта.
export const NANO_GATE_BYTES = 1024;

// Совместный импорт одиночного и группового compositor API. Оба физических
// entry отдельно остаются под прежними 6 450 B; 6 600 B ловят раздувание их
// общего consumer-графа, не смешивая его с file-level потолком.
export const COMPOSITOR_CAPABILITY_GATE_BYTES = 6600;

// Точечные (bespoke) пороги субпутей — жёстче общего SUBPATH_GATE_BYTES там, где
// это осмысленно. ./utils — семь чистых скалярных примитивов + сегментный движок;
// факт после первой сборки 1197 gz, люфт ~15%. Отдельный порог не даёт будущему
// раздуванию прятаться под щедрым общим зонтом 4608 (тот же класс, что ловит
// CORE_GATE_BYTES для ядра). Поднимать только осознанно.
export const BESPOKE_SUBPATH_GATES = {
  './utils': 1400,
  // Базовый compositor не несёт групповой оркестратор. Старый потолок сохранён:
  // capability-split не имеет права маскировать регрессию повышением порога.
  './compositor': 6450,
  // Групповой фасад самодостаточен и включает только нужные ему базовые план и
  // контроллер. Порог равен прежнему полному compositor-контракту, не новому факту.
  './compositor/stagger': 6450,
  // Native-only springTo: runtime spring-план + строгая WAAPI-граница,
  // custom linear() либо WebKit adaptive keyframes, explicit transform/opacity
  // и controls без rAF fallback. Hard ceiling совпадает
  // с главным consumer-сценарием: лёгкий путь обязан оставаться < 3.5 KB gzip.
  './animate/native': 3500,
  // ./tokens — motion-токены (SSOT labui): duration/easing/spring/staggerGap +
  // distanceScale + springFromDurationBounce (каноническая пара ДС (duration,bounce)
  // → SpringParams; тянет validateSpringParams ядра, чтобы выход ГАРАНТИРОВАННО
  // оседал). Изинг `standard` специализирован под дефолтную кривую; ещё три
  // именованные кривые используют общий решатель cubic-bezier. Вызовы пресетов
  // PURE-аннотированы, поэтому соседние функциональные срезы не платят за конвертер.
  // Гарантия — СУБПУТЬ-изоляция: точный sideEffects-allowlist не удерживает ./tokens,
  // ядро не растёт (full-core сценарий это и стережёт). Порог — регрессионный
  // потолок всего субпути; поднимать его можно только осознанным решением.
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
  // ./animate — одно-строчный DOM-фасад. Порог выше
  // общего 4608 НЕ потому, что фасад «раздут», а потому, что при splitting:false
  // самодостаточный субпуть НЕСЁТ КОПИИ композируемых подсистем (общий порог
  // калибровался по субпутям с 1-2 зависимостями). Фасад включает движок значений,
  // compositor-подмножество, токены, stagger, два пути исполнения и контролы;
  // изинг по умолчанию при этом разделяет специальную функцию с ./tokens.
  // Потребитель, который composит вручную (ядро+value+compositor), платит то же —
  // фасад не добавляет физики. Число ниже — регрессионный потолок, не описание
  // текущего веса: фактический размер каждый запуск вычисляет из артефакта.
  // Дедуп через splitting/shared chunks — отдельное архитектурное решение
  // Даниила на весь пакет, не этого субпутя. Поднимать только осознанно.
  './animate': FULL_ANIMATE_GATE_BYTES,
  // ./animate/mini — ЛЁГКИЙ срез animate поверх адаптерного реестра кодеков/
  // адаптеров (registry.ts): transform-компоненты + opacity + CSS-переменные,
  // spring/tween в ЕДИНОМ прогресс-пространстве (внутренний unchecked sampler), delay/
  // stagger, контролы, reduced-motion снап. Расширение — РЕГИСТРАЦИЕЙ кодека, не
  // ростом switch. Граница поставки: mini НЕ импортирует full-набор/compositor-
  // компилятор — граф не тянет ./value (цвета) и compileSpringPlan (доказано
  // import-cost сценарием 'mini-one-liner' ниже: ~5.2 KB против ~10.9 KB full).
  // Потолок 5120 — headline эпика «≤ 5 KB» (первый потолок), НЕ от щедрого люфта.
  // Хронология факта/порога:
  //   2026-07-10: факт первой сборки 5050 gz (shipped, terser) → порог 5120.
  //   ЧЕСТНАЯ ГРАНИЦА: compositor-offload (WAAPI через compileSpringPlan) в mini
  //   НЕ включён — floor «compositor+codecs+registry+frame» = 5186 gz БЕЗ движка,
  //   физически не под 5120. mini гонит transform/opacity аналитической замкнутой
  //   формой на main-потоке + reduced-motion детект; полный WAAPI-путь — в ./animate.
  //   Подъём порога — только решением владельца (это и есть класс, что гейт ловит).
  './animate/mini': 5120,
  // To-only individual properties + spring->linear() + native Animation controls.
  // Отдельный hard gate не разрешает новому entry спрятаться под общим 4608 B.
  './nano': NANO_GATE_BYTES,
  // ./behaviors — headless state machines типовых мобильных взаимодействий
  // (bottom sheet / drag-to-dismiss / carousel / pull-to-refresh) поверх
  // ПЕРЕИСПОЛЬЗУЕМЫХ примитивов: createVelocityTracker (./gestures), createDecay
  // (./decay, проекция момента), solveSpring ядра (доводка value→target),
  // токены ./tokens (дефолтные пружины). splitting:false ⇒ субпуть несёт срез
  // velocity-tracker (+ trimSlidingWindow), decay и solver — честная цена
  // самодостаточного субпутя; ничего не дублировано (импорты, не копии).
  // Хронология факта/порога (дисциплина ./compositor: порог ОТ ФАКТА):
  //   2026-07-10: факт первой сборки 4475 gz shipped → порог 4600 (~2.8% люфт).
  //   ИМЕННОЙ потолок ТЕСНЕЕ общего SUBPATH_GATE_BYTES (4608): субпуть сидит
  //   вплотную к общему зонту, и точечный порог — ровно тот регрессионный класс,
  //   что общий 4608 бы пропустил на +130 gz. Люфт скромный (не 4%) осознанно:
  //   рост тут — новая capability, не шум минификатора. Поднимать только осознанно.
  './behaviors': 4600,
};

/**
 * Потребительские сценарии: код — то, что реально пишет потребитель;
 * gate — потолок от замера 2026-07-02 (+~4% люфт). `%DIST%` подставляется
 * абсолютным путём dist/index.js.
 */
export const IMPORT_COST_SCENARIOS = [
  {
    name: 'nano spring-to',
    code: `import { animate } from '%DIST%/../nano/index.js'; console.log(animate('.hero', { translate: '240px', opacity: 1 }).length);`,
    gate: NANO_GATE_BYTES,
  },
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
    // Каталогизированная runtime-граница отклоняет shaped, но неизвестные LM-коды;
    // физический root-entry при этом остаётся под отдельным CORE_GATE_BYTES.
    gate: 1660,
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
    gate: FULL_CORE_CONSUMER_GATE_BYTES,
  },
  {
    // Типичный потребитель одиночных и групповых compositor-переходов обязан
    // брать их из одного capability-entry и не платить за два prebundle-графа.
    name: 'compositor-stagger capability',
    code: `import { CompositorSpring, CompositorStaggerGroup, compileSpringPlan, compileStaggerPlan } from '%DIST%/../compositor/stagger/index.js'; console.log(CompositorSpring, CompositorStaggerGroup, compileSpringPlan, compileStaggerPlan);`,
    gate: COMPOSITOR_CAPABILITY_GATE_BYTES,
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
    // ПРАВДА потребительской цены фасада. Отгрузочный gz субпутя ./animate —
    // двойной счёт: при splitting:false субпуть
    // несёт копии value/compositor/tokens/stagger. Реальная цена в бандле
    // потребителя ПОСЛЕ его tree-shake — вот этот сценарий; именно ЕГО число
    // публикуется в отчёте. Скачок сценария = регрессия tree-shakeability фасада.
    name: 'animate-one-liner (фасад)',
    code: `import { animate } from '%DIST%/../animate/index.js'; console.log(typeof animate('.hero', { x: 240, opacity: 1 }).pause);`,
    // Фасад статически тянет функциональный граф из-за диспетчеризации свойств;
    // порог остаётся стражем полного пути, а лёгкие случаи обслуживают mini/native.
    gate: FULL_ANIMATE_GATE_BYTES,
  },
  {
    // ПРАВДА потребительской цены лёгкого среза + СТРАЖ границы поставки: mini
    // не тянет full. Если бы mini импортировал full-набор (./value цвета) или
    // compileSpringPlan (компилятор пружина→linear()), число скакнуло бы к ~10 KB
    // (порядок full-фасада). Держится ~5.2 KB ⇒ граф mini замкнут на минимум:
    // unchecked spring sampler (замкнутая форма) + числовой/var кодеки + DOM-адаптер +
    // ./frame. Скачок сценария = регрессия границы (mini потянул full/compositor).
    name: 'animate-mini-one-liner',
    code: `import { animate } from '%DIST%/../animate/mini/index.js'; console.log(typeof animate('.hero', { x: 240, opacity: 1 }).pause);`,
    // Бюджет < 5 KB — контракт лёгкого среза. Он ловит не только full-импорты,
    // но и скрытые eager-side-effects: mini не компилирует WAAPI linear(), значит не должен
    // платить за его LRU-кэш. Baseline 5287 B обязан пасть до прохода этого гейта.
    gate: 5000,
  },
  {
    // Capability-specialized native WAAPI-путь: explicit [from,to], отдельный
    // WAAPI-эффект на CSS-канал, без value registry/tokens/frame/main-thread fallback.
    name: 'animate-native-springTo',
    code: `import { springTo } from '%DIST%/../animate/native/index.js'; console.log(typeof springTo(el, { x: [0, 240] }).cancel);`,
    gate: 3500,
  },
  {
    // ПРАВДА потребительской цены поведения + СТРАЖ переиспользования: одна
    // фабрика ./behaviors должна тянуть ТОЛЬКО срез velocity-tracker+decay+solver,
    // а не весь пакет. Если бы behaviors утянул ./compositor-компилятор или
    // ./value, число скакнуло бы к порядку full-фасада (~10 KB).
    name: 'behaviors-sheet-one-liner',
    code: `import { createBottomSheet } from '%DIST%/../behaviors/index.js'; const s = createBottomSheet({ snapPoints: [0, 300] }); s.pointerDown({ x: 0, y: 0, t: 0 }); console.log(typeof s.cancel);`,
    // Факт первой сборки 2026-07-10: 3542 gz + ~4% люфт. Заметно < shipped 4475 —
    // машинное доказательство, что одна фабрика трясётся (не тянет весь субпуть).
    gate: 3700,
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
    return {
      name: scenario.name,
      gzBytes: canonicalGzip(out).length,
      brBytes: observationalBrotli(out).length,
      rawBytes: out.length,
      gate: scenario.gate,
    };
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
/**
 * Начальная CDN-передача ESM — entry плюс рекурсивное замыкание СТАТИЧЕСКИХ
 * относительных импортов. Каждый файл сжимается отдельно, как отдельный HTTP-
 * ответ; dynamic import не входит до фактического вызова, bare peer imports
 * принадлежат приложению, а не этому npm-пакету.
 */
export function measureEsmTransfer(importPath, root) {
  const normalizedEntry = importPath.replaceAll('\\', '/');
  const entryAbsolute = resolve(root, normalizedEntry);
  if (!existsSync(entryAbsolute)) {
    const error = new Error(`ESM entry отсутствует: ${importPath}`);
    error.code = 'ENOENT';
    throw error;
  }
  const distRoot = realpathSync(resolve(root, 'dist'));
  const assertInsideDist = (name) => {
    const absolute = resolve(root, name);
    const physical = realpathSync(absolute);
    const fromDist = relative(distRoot, physical);
    if (fromDist.startsWith(`..${pathSeparator}`) || fromDist === '..' || isAbsolute(fromDist)) {
      throw new Error(`ESM shipped graph вышел за границу dist: ${name}`);
    }
  };
  assertInsideDist(normalizedEntry);
  const graph = buildSync({
    absWorkingDir: root,
    entryPoints: [normalizedEntry],
    bundle: true,
    treeShaking: false,
    packages: 'external',
    format: 'esm',
    platform: 'browser',
    write: false,
    outdir: '.size-gate-meta',
    metafile: true,
    logLevel: 'silent',
  }).metafile;
  const inputNames = Object.keys(graph.inputs);
  const entryName = inputNames.find((name) => resolve(root, name) === entryAbsolute);
  if (entryName === undefined) throw new Error(`ESM entry не найден в графе: ${importPath}`);

  const closure = new Set();
  const pending = [entryName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    assertInsideDist(name);
    closure.add(name);
    const input = graph.inputs[name];
    if (input === undefined) throw new Error(`ESM input отсутствует в metafile: ${name}`);
    for (const edge of input.imports) {
      if (
        !edge.external &&
        (edge.kind === 'import-statement' || edge.kind === 'import-rule')
      ) pending.push(edge.path);
    }
  }

  let rawBytes = 0;
  let gzBytes = 0;
  let brBytes = 0;
  let entryRawBytes = 0;
  let entryGzBytes = 0;
  let entryBrBytes = 0;
  for (const name of closure) {
    const raw = readFileSync(resolve(root, name));
    const gz = canonicalGzip(raw).length;
    const br = observationalBrotli(raw).length;
    rawBytes += raw.length;
    gzBytes += gz;
    brBytes += br;
    if (name === entryName) {
      entryRawBytes = raw.length;
      entryGzBytes = gz;
      entryBrBytes = br;
    }
  }
  return {
    rawBytes,
    gzBytes,
    brBytes,
    entryRawBytes,
    entryGzBytes,
    entryBrBytes,
    closureFiles: closure.size,
  };
}

export function measureEntries(entries, root) {
  let totalGzBytes = 0;
  let totalBrBytes = 0;
  let hasWarnings = false;

  const rows = entries.map(entry => {
    let measured;
    try {
      measured = measureEsmTransfer(entry.importPath, root);
    } catch (err) {
      hasWarnings = true;
      // Различаем "файла нет" (ожидаемо до сборки/для ещё-не-смерженных
      // subpath) от прочих ошибок (EACCES и т.п.), которые маскировать
      // нельзя — это реальный сбой окружения, не отсутствующий dist/.
      const reason = err?.code === 'ENOENT' ? 'MISSING' : `ERROR(${err?.code ?? err?.message ?? 'unknown'})`;
      return { label: entry.label, error: `${reason}: ${entry.importPath}` };
    }

    totalGzBytes += measured.gzBytes;
    totalBrBytes += measured.brBytes;
    const exceeded = entry.gate !== null && measured.gzBytes > entry.gate;
    if (exceeded) hasWarnings = true;

    return {
      label: entry.label,
      ...measured,
      gate: entry.gate,
      exceeded,
    };
  });

  return { rows, totalGzBytes, totalBrBytes, hasWarnings };
}

async function runCli() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const entries = deriveEntriesFromExports(pkg);
  const { rows, totalGzBytes, totalBrBytes, hasWarnings: measuredWarnings } = measureEntries(entries, ROOT);
  let hasWarnings = measuredWarnings;

  // ─── вывод ────────────────────────────────────────────────────────────────

  const COL = { label: 22, files: 7, raw: 10, gz: 10, br: 10 };

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);

  console.log('\n@labpics/motion — bundle size (ESM, канонический gzip-9 + Brotli-11)\n');
  console.log(
    pad('Entry', COL.label) +
    lpad('Files', COL.files) +
    lpad('Raw', COL.raw) +
    lpad('GZ', COL.gz) +
    lpad('BR', COL.br) +
    '  Status'
  );
  console.log('-'.repeat(COL.label + COL.files + COL.raw + COL.gz + COL.br + 10));

  for (const row of rows) {
    if (row.error) {
      console.log(pad(row.label, COL.label) + '  ' + row.error);
      continue;
    }

    const filesFmt = lpad(row.closureFiles, COL.files);
    const rawFmt = lpad((row.rawBytes / 1024).toFixed(2) + ' KB', COL.raw);
    const gzFmt = lpad((row.gzBytes / 1024).toFixed(2) + ' KB gz', COL.gz + 3);
    const brFmt = lpad((row.brBytes / 1024).toFixed(2) + ' KB br', COL.br + 3);

    let status = 'OK';
    if (row.exceeded) {
      status = `WARN > ${(row.gate / 1024).toFixed(1)} KB gz [OPEN ITEM]`;
    }

    console.log(pad(row.label, COL.label) + filesFmt + rawFmt + gzFmt + brFmt + '  ' + status);
  }

  console.log('-'.repeat(COL.label + COL.files + COL.raw + COL.gz + COL.br + 10));
  const totalFmt = (totalGzBytes / 1024).toFixed(2);
  const totalBrFmt = (totalBrBytes / 1024).toFixed(2);
  console.log(
    pad(`SUM COSTS (${rows.length}; shared повторён)`, COL.label + COL.files + COL.raw) +
      lpad(totalFmt + ' KB gz', COL.gz + 3) +
      lpad(totalBrFmt + ' KB br', COL.br + 3),
  );

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

  console.log('\nimport-cost потребителя (esbuild bundle+minify+gzip/Brotli против dist)\n');
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
      lpad(`${m.brBytes} B br`, COL.br) +
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
