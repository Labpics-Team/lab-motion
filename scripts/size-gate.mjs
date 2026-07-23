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
 *    его бандлер). Статическое замыкание entry считается initial, достижимые
 *    dynamic chunks — lazy, а total включает оба среза ровно один раз. Initial
 *    и total — независимые жёсткие бюджеты; без явного scenario.totalGate оба
 *    ограничены прежним gate. Поэтому import() не может превратить регрессию в
 *    ложное «похудение», как при старом чтении result.outputFiles[0].
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
// 12 000 → 12 760 (2026-07-22, #205): +~700 gz — N-keyframe tracks (кортежи
// ≥3 + times + per-segment ease[]) в фасаде: everyday-грамматика всего поля
// (Framer/GSAP/anime). Рост НЕ раздувание: один pure track-модуль
// (right-biased просмотр с out-scratch, ноль аллокаций в кадре), tuple-ветка
// parseProps и валидация топологии; дешёвые шейвы сняты ДО подъёма (−20 gz),
// дедупа в графе фасада не существует (sample-keyframes несёт repeat/reverse-
// семантики ./keyframes и добавил бы вес). Факт 12 694 + ~0.5% люфт — та же
// дисциплина, что 11 938 → 12 000. Подъём — решение владельца по делегации.
// 12 760 → 12 700 (2026-07-22, порт шейв-пакетов worktree-охоты): parseProps
// группирует по GroupKey без второго прохода, transform-state и commitSnap
// инлайн, дискретная ветка interpolateParsed делегирует сериализацию ./value.
// Затяжка ВНИЗ по факту 12 632 + ~0.5% люфт — поведение бит-в-бит (вся
// матрица зелёная), ослаблением не является.
// 12 700 → 12 620 (2026-07-22, охота по curve/segmenter: прямой LM016,
// компакция cache-store, kept.map, дедуп endpoint/explicit-кадров):
// факт 12 560 + ~0.5%.
// 12 620 → 12 530 (2026-07-22, охота-2b + SSOT groupValueAt: один сериализатор
// групповой поверхности вместо 4 веток waapi/_write/writeSnap/hold; попутные
// выигрыши consumers-среза): факт 12 470 + ~0.5%.
export const FULL_ANIMATE_GATE_BYTES = 12_530;

// Consumer-rebundle ядра после стабильных кодов ошибок и изоляции listener-
// сбоев. Физический shipped-граф при этом уменьшился и по-прежнему ограничен
// CORE_GATE_BYTES; 2 330 B — узкий предел только для повторной минификации
// namespace-сценария, а не новый бюджет самого entry.
export const FULL_CORE_CONSUMER_GATE_BYTES = 2330;

// Публичный platform-trusted WAAPI entry. 1024 B — продуктовая граница,
// утверждённая владельцем до реализации; она не выводится из текущего факта.
export const NANO_GATE_BYTES = 1024;

// Нативный IntersectionObserver-адаптер: два независимых exact-ратчета от
// первой завершённой реализации 2026-07-17. Shipped-порог ловит физическое
// раздувание самодостаточного entry при splitting:false; consumer-порог —
// потерю tree-shakeability типичного вызова. Люфт намеренно нулевой: новая
// capability ещё не имеет исторического шума, повышать только по факту решения.
export const IN_VIEW_GATE_BYTES = 1839;
// 1907 → 1908 (2026-07-22, #218): +1 B gzip — строка нового кода каталога
// LM167 в общем errors-модуле сместила словарь кодека; сам in-view не менялся.
// Решение владельца: exact-ратчет переставлен ПО ФАКТУ, люфт остаётся нулевым.
// 1908 → 1830 (2026-07-22, охота-2b: дедуп instanceOf/badLength/LM156-хелперов,
// recordHostFailure в releaseOneShot, NOOP_STOP): факт 1819 + ~0.5%.
export const IN_VIEW_CONSUMER_GATE_BYTES = 1830;

// Совместный импорт одиночного и группового compositor API. Оба физических
// entry отдельно остаются под прежними 6 450 B; 6 600 B ловят раздувание их
// общего consumer-графа, не смешивая его с file-level потолком.
// 6 600 → 6 510 (2026-07-22, компенсированный #223 + двойная охота): закон
// maxValueError/горизонта (+~130) полностью профинансирован шейвами
// (stagger→compileSpringPlan(options), спред-carrier, прямой LM016 без
// пересчёта, слияние reduced/compositor-хвоста handoffToLive и др.);
// затяжка вниз по факту 6 477 + ~0.5%.
export const COMPOSITOR_CAPABILITY_GATE_BYTES = 6510;

// Совместный consumer-граф ./animate + базового spring-компилятора. Exact
// clean-base 7968d161 (2026-07-16): 12 494 B gz; потолок равен факту без люфта,
// чтобы локальная оптимизация одного entry не покупалась дублированием между
// двумя реально совместимыми capability.
// 12 494 → 13 340 (2026-07-22, #205): рост тем же track-срезом фасада (см.
// FULL_ANIMATE_GATE_BYTES); факт 13 275 + ~0.5% люфт, дублирования между
// capability не добавлено (compositor-граф не тронут).
// 13 340 → 13 290 (2026-07-22, порт шейв-пакетов): затяжка вниз по факту
// 13 226 + ~0.5% люфт — тот же срез фасада, compositor-граф не тронут.
// 13 290 → 13 230 (2026-07-22, #223 + двойная охота): факт 13 166 + ~0.5%.
// 13 230 → 13 130 (2026-07-22, охота-2b + groupValueAt): факт 13 064 + ~0.5%.
export const ANIMATE_COMPOSITOR_MIXED_GATE_BYTES = 13_130;

// Точечные (bespoke) пороги субпутей — жёстче общего SUBPATH_GATE_BYTES там, где
// это осмысленно. ./utils — семь чистых скалярных примитивов + сегментный движок;
// факт после первой сборки 1197 gz, люфт ~15%. Отдельный порог не даёт будущему
// раздуванию прятаться под щедрым общим зонтом 4608 (тот же класс, что ловит
// CORE_GATE_BYTES для ядра). Поднимать только осознанно.
export const BESPOKE_SUBPATH_GATES = {
  // 1400 → 1100 (2026-07-22): факт 1055 — затяжка по факту (~4%).
  './utils': 1100,
  // Build-tool entry (#208): Vite-адаптер lowering НАМЕРЕННО несёт канонический
  // MotionProgram V1 parser + nano spring SSOT — это цена доверенного артефакта
  // на стороне СБОРКИ, браузеру она не поставляется никогда (в bundle попадает
  // только ./compiler/runtime). Хронология: 2026-07-19 факт первой сборки
  // 5261 gz → порог 5470 (~4% люфт, «порог ОТ ФАКТА»); в тот же день
  // adversarial-ревью добавило сортировку правок, байтовую верификацию
  // тривиа-зон и полный line-collapse sourcemap → факт 5355 gz (в пороге).
  // 2026-07-22 (#221): факт 6285 gz — рост НЕ раздувание, а новая capability:
  // статическая экстракция полных NanoProps/NanoOptions (props/spring/delay/
  // stagger/reducedMotion) и multi-track V1-кандидат (escaped-каналы +
  // webCssOpaque) с полной обратной проекцией. Порог 6540 (~4% люфт, ОТ ФАКТА).
  './compiler/vite': 6540,
  // Единственный БРАУЗЕРНЫЙ compiler-артефакт: private executor compiled-nano
  // вызовов. Exact-ратчет от факта (канон ./in-view, люфт нулевой): новая
  // capability не прячется под общим потолком 4608 — рост только решением.
  // 2026-07-19: факт 341 gz. 2026-07-22 (#221): факт 365 gz — generic-артефакт
  // {f,d,e,y,g,r} (multi-prop кадр, delay+stagger·index, explicit-reduced) —
  // ратчет переставлен по факту, люфт остаётся нулевым.
  // 2026-07-23: факт 390 gz — ревью-фикс контракта onfinish (одно решение,
  // два среза): чистка commitStyles/cancel отложена микротаском ПОСЛЕ рассылки
  // finish (пользовательские listeners видят finished-состояние), guard по
  // playState (replay из хендлера не затаптывается) и перевзвод reject на
  // ТЕКУЩИЙ finished-цикл (replay+cancel оседает, не вечный pending/unhandled).
  // Рост частично оплачен шейвами (?? для r, прямой return). Паритет C4.
  './compiler/runtime': 390,
  // Базовый compositor не несёт групповой оркестратор. Старый потолок сохранён:
  // capability-split не имеет права маскировать регрессию повышением порога.
  // 6450 → 6250 (2026-07-22): факт 6082 — затяжка по факту (~2.7%).
  // 6250 → 6090 (2026-07-22, #223+охота): факт 6 062 + ~0.5%.
  './compositor': 6090,
  // Групповой фасад самодостаточен и включает только нужные ему базовые план и
  // контроллер. Порог равен прежнему полному compositor-контракту, не новому факту.
  './compositor/stagger': 6450,
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
  //   5750 → 5350 (2026-07-22): факт 5202 после стабильной pole-формы #226 —
  //   ратчет затянут по факту (~3%).
  './projection': 5350,
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
  //   7450 → 7000 (2026-07-22): факт 6840 — затяжка по факту (~2.3%).
  './smart': 7000,
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
  // To-only individual properties + spring->linear() + native Animation controls.
  // Отдельный hard gate не разрешает новому entry спрятаться под общим 4608 B.
  './nano': NANO_GATE_BYTES,
  // Native IntersectionObserver capability; exact first-implementation ratchet.
  './in-view': IN_VIEW_GATE_BYTES,
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
  //   4600 → 4150 (2026-07-22): факт 4045 после #226/#218 — затяжка по факту.
  // 4150 → 3380 (2026-07-22, охота-2b): shipped 3343 после среза токен-графа.
  './behaviors': 3380,
};

/**
 * Потребительские сценарии: код — то, что реально пишет потребитель;
 * gate ограничивает initial, optional totalGate — весь split-граф (без него
 * равен gate). `%DIST%` подставляется абсолютным путём dist/index.js.
 */
export const IMPORT_COST_SCENARIOS = [
  {
    name: 'nano spring-to',
    code: `import { animate } from '%DIST%/../nano/index.js'; console.log(animate('.hero', { translate: '240px', opacity: 1 }).length);`,
    gate: NANO_GATE_BYTES,
  },
  {
    // Реальный минимальный вызов capability обязан оставаться изолированным от
    // animate/scroll и не скрываться под общим потолком физического субпутя.
    name: 'in-view one-liner',
    code: `import { inView } from '%DIST%/../in-view/index.js'; console.log(typeof inView('.card', () => () => {}));`,
    gate: IN_VIEW_CONSUMER_GATE_BYTES,
  },
  {
    name: 'only-spring',
    code: `import { spring } from '%DIST%'; console.log(spring({mass:1,stiffness:200,damping:20}, 0.1).value);`,
    // 920 → 645 (2026-07-22): pole-space #226 + разделение границ #218
    // сняли settle-бюджет из чистого spring() — факт 625 (−21%). Ратчет
    // затянут ПО ФАКТУ (~3% люфта): выигрыш математики зафиксирован гейтом.
    gate: 645,
  },
  {
    // Страж tree-shake геометрии от драйвера/DOM: чистая функция projectAt не
    // должна тянуть солвер и адаптер. Скачок числа = геометрия потянула драйвер.
    name: 'projection-core-only',
    code: `import { projectAt } from '%DIST%/../projection/index.js'; console.log(projectAt({first:{x:0,y:0,width:1,height:1},last:{x:0,y:0,width:1,height:1}}, null, 0.5).sx);`,
    // 2026-07-10: факт первой сборки 655 gz → порог 720 (~10%, ОТ ФАКТА).
    // 720 → 700 (2026-07-22): факт 679 — затяжка по факту (~3%).
    gate: 700,
  },
  {
    // Правда потребительской цены DOM-однострочника (капчур → мутация → play).
    name: 'projection-dom-one-liner',
    code: `import { createDomProjection } from '%DIST%/../projection/index.js'; const p = createDomProjection(); p.capture([]); p.play(); p.cancel(); console.log(p.playing);`,
    // 2026-07-10: факт первой сборки 4899 gz → порог 5350 (~9%, ОТ ФАКТА).
    // 2026-07-10 (позже): факт 5536 gz → порог 5750 (~4%).
    // 5750 → 5350 (2026-07-22): факт 5202 после #226 — затяжка по факту (~3%).
    gate: 5350,
  },
  {
    name: 'only-MotionValue',
    code: `import { MotionValue } from '%DIST%'; const m = new MotionValue({initial:0, spring:{mass:1,stiffness:200,damping:20}}); m.onChange(v=>console.log(v)); m.setTarget(1);`,
    // 1600→1620 (M2): +~14 gz за opts.initialVelocity — засев скорости рождения,
    // НЕОБХОДИМЫЙ для C¹-хендоффа compositor→live (нет иного публичного seam'а;
    // дублировать rAF-цикл MotionValue в handoff = запрещённый coupled-дубль). Факт 1606.
    // Каталогизированная runtime-граница отклоняет shaped, но неизвестные LM-коды;
    // физический root-entry при этом остаётся под отдельным CORE_GATE_BYTES.
    // 1660 → 1650 (2026-07-22): факт 1619 после #226/#218 — затяжка по факту.
    gate: 1650,
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
    // Cross-entry страж: фасад и прямой spring-компилятор часто сосуществуют;
    // их суммарная цена не выводится из двух изолированных сценариев.
    name: 'animate + compositor',
    code: `import { animate } from '%DIST%/../animate/index.js'; import { compileSpringLinear } from '%DIST%/../compositor/index.js'; console.log(typeof animate('.hero', { x: 240, opacity: 1 }).pause, typeof compileSpringLinear);`,
    gate: ANIMATE_COMPOSITOR_MIXED_GATE_BYTES,
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
    // 340 → 300 (2026-07-22): факт 290 — затяжка по факту (~3.4%).
    gate: 300,
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
    // порог — страж полного пути. Линейка из двух входов: лёгкий case = ./nano
    // (собственный hard gate выше), перестройка фасада (эпик nano-core) получит
    // сценарий «animate без допов» с порогом от факта первой реализации.
    gate: FULL_ANIMATE_GATE_BYTES,
  },
  {
    // N-keyframe consumer ratchet (#205): типовой keyframe-вызов дизайнера.
    // Первый принятый факт 2026-07-22: фиксируется ОТ ФАКТА ниже.
    // 12 760 → 12 730 (2026-07-22, порт шейв-пакетов): факт 12 663 + ~0.5%.
    // 12 730 → 12 650 (2026-07-22, #223+охота): факт 12 590 + ~0.5%.
    // 12 650 → 12 560 (2026-07-22, охота-2b + groupValueAt): факт 12 501 + ~0.5%.
    name: 'animate-keyframes (N-track)',
    code: `import { animate } from '%DIST%/../animate/index.js'; console.log(typeof animate('.dot', { x: [0, 120, -40, 0], opacity: [0, 1, 1, 0] }, { duration: 800, times: [0, 0.25, 0.75, 1] }).pause);`,
    gate: 12_560,
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
    // 3700 → 3250 (2026-07-22): факт 3147 после #226/#218 — затяжка по факту.
    // 3250 → 2440 (2026-07-22, охота-2b): непьюр bezierToken() в ./tokens тянул
    // весь cubic-bezier-солвер в КАЖДЫЙ behaviors-бандл; DEFAULT_SPRING/локальный
    // snappy + внутренний decayRest-шов срезали граф. Факт 2415 + ~1%.
    gate: 2440,
  },
];

const SCENARIO_OUTDIR = '.size-gate-scenario';
const SCENARIO_ENTRY_SOURCE = '__lab_motion_size_scenario__.mjs';

// Заморожено по Metafile.outputs.imports из pinned esbuild 0.28.1. Новый kind
// требует явного решения о static/dynamic семантике, иначе гейт падает закрыто.
const ESBUILD_OUTPUT_IMPORT_KINDS = new Set([
  'entry-point',
  'import-statement',
  'require-call',
  'dynamic-import',
  'require-resolve',
  'import-rule',
  'composes-from',
  'url-token',
  'file-loader',
]);

/**
 * Разбирает output-граф esbuild без зависимости от порядка outputFiles.
 * Initial — только статическое замыкание сценарного entry; lazy — всё, что
 * достижимо после первого dynamic-import. Set-ы делают общий chunk одним
 * физическим transfer, даже если на него ссылаются несколько lazy entry.
 */
export function measureScenarioOutputGraph(result, { absWorkingDir, outdir, entryPoint }) {
  const outputs = result?.metafile?.outputs;
  if (!outputs || typeof outputs !== 'object') {
    throw new Error('scenario metafile.outputs отсутствует');
  }
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length === 0) {
    throw new Error('scenario outputFiles отсутствует или пуст');
  }

  // outputFiles у esbuild физикализует symlink-префиксы (например /var →
  // /private/var). Канонический ID относительно realpath(outdir) одинаков для
  // metafile, outputFiles, macOS symlink-префиксов и Windows-разделителей.
  const workingDir = realpathSync(absWorkingDir);
  const outputRoot = resolve(workingDir, outdir);
  const expectedEntryPoint = isAbsolute(entryPoint)
    ? resolve(entryPoint)
    : resolve(workingDir, entryPoint);
  const outputId = (name, description) => {
    if (typeof name !== 'string') throw new Error(`${description} не содержит path`);
    const fromRoot = relative(outputRoot, resolve(workingDir, name));
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${pathSeparator}`) ||
      isAbsolute(fromRoot)
    ) throw new Error(`${description} вышел за границу scenario outdir: ${name}`);
    return fromRoot.split(pathSeparator).join('/');
  };

  const nodes = new Map();
  for (const [name, metadata] of Object.entries(outputs)) {
    const id = outputId(name, `scenario metafile output ${name}`);
    if (nodes.has(id)) {
      throw new Error(`scenario metafile содержит неоднозначный output: ${name}`);
    }
    nodes.set(id, metadata);
  }
  if (nodes.size === 0) throw new Error('scenario metafile.outputs пуст');

  const files = new Map();
  for (const file of result.outputFiles) {
    if (!(file?.contents instanceof Uint8Array)) {
      throw new Error('scenario outputFile не содержит path/contents');
    }
    const id = outputId(file.path, `scenario outputFile ${file.path}`);
    if (files.has(id)) {
      throw new Error(`scenario outputFiles содержит дубликат: ${file.path}`);
    }
    files.set(id, file.contents);
  }

  const withoutFile = [...nodes.keys()].find((id) => !files.has(id));
  if (withoutFile) throw new Error(`scenario output отсутствует в outputFiles: ${withoutFile}`);
  const withoutNode = [...files.keys()].find((id) => !nodes.has(id));
  if (withoutNode) throw new Error(`scenario output отсутствует в metafile: ${withoutNode}`);

  const entryPointMatches = (value) => {
    if (typeof value !== 'string') return false;
    if (isAbsolute(value)) return resolve(value) === expectedEntryPoint;
    return resolve(workingDir, value) === expectedEntryPoint;
  };
  const entryCandidates = [...nodes.entries()]
    .filter(([, metadata]) => entryPointMatches(metadata.entryPoint));
  if (entryCandidates.length === 0) {
    throw new Error(`scenario entryPoint не найден в metafile: ${entryPoint}`);
  }
  if (entryCandidates.length > 1) {
    throw new Error(`scenario entryPoint неоднозначен в metafile: ${entryPoint}`);
  }
  const entryId = entryCandidates[0][0];

  const targetId = (path, description) => {
    const id = outputId(path, description);
    if (!nodes.has(id)) throw new Error(`${description} указывает на отсутствующий output`);
    return id;
  };
  const edgesOf = (id) => {
    const node = nodes.get(id);
    if (!Array.isArray(node?.imports)) throw new Error(`scenario imports отсутствует: ${id}`);
    const edges = [];
    for (const edge of node.imports) {
      if (!edge || typeof edge !== 'object' || typeof edge.path !== 'string') {
        throw new Error(`scenario import edge повреждён: ${id}`);
      }
      if (edge.external !== undefined && typeof edge.external !== 'boolean') {
        throw new Error(`scenario import external должен быть boolean: ${id}`);
      }
      if (typeof edge.kind !== 'string' || !ESBUILD_OUTPUT_IMPORT_KINDS.has(edge.kind)) {
        throw new Error(`scenario import kind неизвестен: ${String(edge.kind)}`);
      }
      if (edge.external === true) continue;
      edges.push({
        target: targetId(edge.path, `scenario import ${edge.path}`),
        dynamic: edge.kind === 'dynamic-import',
      });
    }
    if (node.cssBundle !== undefined) {
      if (typeof node.cssBundle !== 'string') {
        throw new Error(`scenario cssBundle повреждён: ${id}`);
      }
      edges.push({
        target: targetId(node.cssBundle, `scenario cssBundle ${node.cssBundle}`),
        dynamic: false,
      });
    }
    return edges;
  };

  const collect = (seeds, found, excluded, deferDynamic) => {
    const deferred = [];
    const pending = [...seeds];
    while (pending.length > 0) {
      const id = pending.pop();
      if (excluded?.has(id) || found.has(id)) continue;
      found.add(id);
      for (const edge of edgesOf(id)) {
        if (deferDynamic && edge.dynamic) deferred.push(edge.target);
        else pending.push(edge.target);
      }
    }
    return deferred;
  };
  const initial = new Set();
  const lazySeeds = collect([entryId], initial, null, true);
  const lazy = new Set();
  collect(lazySeeds, lazy, initial, false);

  if (initial.size + lazy.size !== nodes.size) {
    const unreachable = [...nodes.keys()]
      .filter((id) => !initial.has(id) && !lazy.has(id));
    throw new Error(`scenario graph содержит недостижимые outputs: ${unreachable.join(', ')}`);
  }

  const aggregate = (paths) => {
    let rawBytes = 0;
    let gzBytes = 0;
    let brBytes = 0;
    for (const id of paths) {
      const contents = files.get(id);
      rawBytes += contents.length;
      gzBytes += canonicalGzip(contents).length;
      brBytes += observationalBrotli(contents).length;
    }
    return { rawBytes, gzBytes, brBytes, files: paths.size };
  };
  const initialSize = aggregate(initial);
  const lazySize = aggregate(lazy);

  return {
    // Старые aliases означают initial: действующие пороги не меняют смысл.
    rawBytes: initialSize.rawBytes,
    gzBytes: initialSize.gzBytes,
    brBytes: initialSize.brBytes,
    initialFiles: initialSize.files,
    lazyRawBytes: lazySize.rawBytes,
    lazyGzBytes: lazySize.gzBytes,
    lazyBrBytes: lazySize.brBytes,
    lazyFiles: lazySize.files,
    totalRawBytes: initialSize.rawBytes + lazySize.rawBytes,
    totalGzBytes: initialSize.gzBytes + lazySize.gzBytes,
    totalBrBytes: initialSize.brBytes + lazySize.brBytes,
    totalFiles: initialSize.files + lazySize.files,
  };
}

export function evaluateScenarioBudget(measurement) {
  const { gzBytes, gate, totalGzBytes, totalGate } = measurement ?? {};
  if (
    ![gzBytes, gate, totalGzBytes, totalGate].every(Number.isFinite) ||
    gzBytes < 0 || totalGzBytes < gzBytes || gate <= 0 || totalGate <= 0
  ) {
    throw new Error('scenario budget measurement неполон или некорректен');
  }
  const initialExceeded = gzBytes > gate;
  const totalExceeded = totalGzBytes > totalGate;
  return {
    initialExceeded,
    totalExceeded,
    exceeded: initialExceeded || totalExceeded,
  };
}

/**
 * Меряет один сценарий: esbuild stdin (без временных файлов) → split+minify ESM
 * → initial/lazy/total. Ошибка сборки или неполный output-граф НЕ маскируется —
 * возвращается error, гейт падает громко.
 */
export async function measureScenario(scenario, distIndexPath) {
  // Прямые слэши: esbuild принимает абсолютный путь как спецификатор,
  // но не file://-URL; бэкслэши Windows ломают парсинг строки-импорта.
  const code = scenario.code.replaceAll('%DIST%', distIndexPath.replace(/\\/g, '/'));
  const totalGate = scenario.totalGate ?? scenario.gate;
  try {
    const absWorkingDir = realpathSync(dirname(distIndexPath));
    const entryPoint = resolve(absWorkingDir, SCENARIO_ENTRY_SOURCE);
    const result = await build({
      absWorkingDir,
      stdin: {
        contents: code,
        resolveDir: absWorkingDir,
        loader: 'js',
        sourcefile: entryPoint,
      },
      bundle: true,
      minify: true,
      format: 'esm',
      splitting: true,
      metafile: true,
      outdir: SCENARIO_OUTDIR,
      write: false,
      logLevel: 'silent',
    });
    return {
      name: scenario.name,
      ...measureScenarioOutputGraph(result, {
        absWorkingDir,
        outdir: SCENARIO_OUTDIR,
        entryPoint,
      }),
      gate: scenario.gate,
      totalGate,
    };
  } catch (err) {
    return {
      name: scenario.name,
      error: String(err?.message ?? err).split('\n')[0],
      gate: scenario.gate,
      totalGate,
    };
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
    const budget = evaluateScenarioBudget(m);
    if (budget.exceeded) hasWarnings = true;
    const failures = [];
    if (budget.initialExceeded) failures.push(`initial ${m.gzBytes} B > ${m.gate} B`);
    if (
      budget.totalExceeded &&
      (m.totalGzBytes !== m.gzBytes || m.totalGate !== m.gate)
    ) failures.push(`total ${m.totalGzBytes} B > ${m.totalGate} B`);
    const deferred = m.lazyFiles > 0
      ? `; lazy ${m.lazyGzBytes} B gz/${m.lazyBrBytes} B br (${m.lazyFiles} files), total ${m.totalGzBytes} B gz/${m.totalBrBytes} B br (порог ${m.totalGate})`
      : '';
    console.log(
      pad(m.name, COL.label) +
      lpad(`${m.gzBytes} B gz`, COL.gz) +
      lpad(`${m.brBytes} B br`, COL.br) +
      `  ${budget.exceeded ? `РЕГРЕССИЯ ${failures.join(', ')} (найди раздувший коммит; порог не поднимать без решения Даниила)` : `OK (порог ${m.gate})`}${deferred}`
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
