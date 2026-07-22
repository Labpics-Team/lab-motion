# ./tokens и ./presets — токены движения и пресеты

> Роль: справка — публичный API экспорт-субпутей `./tokens` (словарь примитивов движения: длительности, изинги, пружины, stagger-шаг, дистанс-скейл) и `./presets` (headless-словарь generic-анимаций: спецификации мультитрековых кейфреймов, раннер, WAAPI-конвертер, текстовые/числовые сахара).

## Назначение

**`./tokens`** — типобезопасный фундамент движения: именованные примитивы длительностей, изингов, пружин, шага stagger-каскада и полосы «травел → длительность». Здесь нет семантики ролей («кнопка-ховер», «модал-вход») — только словарь примитивов; оркестрация «роль → токен» живёт у потребителя (слой дизайн-системы labui). Вкус калиброван сдержанно: дефолты — критично-задемпфированные пружины и мягкие изинги, overshoot — строго opt-in (изинг `emphasized`, пружины `expressive`/`bounce`).

SSOT-шов с дизайн-системой: длительности, изинги и ДС-пружины `smooth`/`expressive` зеркалируют схему motion-токенов labui (CSS-контракт `--lab-motion-*`); при пересечении имён значения обязаны совпадать байт-в-байт, эталон при расхождении — labui. Движковые экстры (`spring.default`/`gentle`/`snappy`/`bounce`, `staggerGap`, `distanceScale`) — честное надмножество: таких имён в ДС-схеме нет. Значения запинены тестами как контракт.

**`./presets`** — чистые параметризованные спецификации мультитрековых кейфреймов (`PresetSpec`) без привязки к DOM: один момент времени → значение каждого трека (`scale`/`rotate`/`x`/`y`/`opacity`/`progress`). Канал `progress` — generic `0→1`, потребитель мапит его на технику (draw-on, clip-reveal, порог variable-font). Поверх словаря: единственная точка валидации `compilePreset`, горячий чистый сэмплер `samplePreset`, управляемый frame-loop `runPreset`, конвертер в данные `element.animate()` `presetToWaapi` и текстовые/числовые сахара (typewriter, scramble, счётчик, тикер).

**Единицы — важно.** Токены длительностей и `staggerGap` — **миллисекунды**; `distanceScale` возвращает **миллисекунды**. В `./presets` вся временная шкала (`PresetSpec.duration`/`delay`/`repeatDelay`, `samplePreset(_, tSeconds)`, `presetTotalDuration`, `PresetControls.time`/`totalDuration`) — **секунды**. `springFromDurationBounce` принимает **секунды**. `WaapiTiming` (выход `presetToWaapi`) — **миллисекунды** (контракт `element.animate()`).

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  duration,
  easing,
  spring,
  springFromDurationBounce,
  staggerGap,
  distanceScale,
  distanceScaleConfig,
  type DurationToken,
  type EasingTokenName,
  type SpringToken,
  type StaggerGapToken,
  type DistanceScaleConfig,
} from '@labpics/motion/tokens';

import {
  // компиляция / сэмплирование / исполнение
  compilePreset,
  presetTotalDuration,
  samplePreset,
  runPreset,
  presetToWaapi,
  // фабрики пресетов
  pulse, blink, wiggle, spin, breathe, pop, bounceY, drift, fadeSlide, drawOn,
  // текстовые/числовые сахара
  splitText, typewriterAt, scrambleAt, formatNumber, tickerCells,
  runTypewriter, runScramble, runNumber,
  type PresetSpec,
  type PresetValues,
  type PresetControls,
} from '@labpics/motion/presets';
```

`MotionParamError` (класс брошенных ошибок с полем `code`) и тип `SpringParams` экспортируются корневым субпутём `@labpics/motion`. Полный каталог LM-кодов с лечением — [docs/errors.md](../errors.md).

## API: `./tokens`

### duration

```ts
const duration: DurationTokens;
type DurationToken = keyof typeof duration; // 'instant' | 'fast' | 'base' | 'slow' | 'slower'
```

Именованная 5-ступенчатая шкала длительностей (мс). Чистые данные (`as const`), tree-shakeable, не бросает.

| Токен | мс | Назначение |
| --- | --- | --- |
| `instant` | 0 | снэп без анимации; нулевой якорь и цель reduced-motion |
| `fast` | 100 | микровзаимодействия (hover, нажатие, мелкая смена состояния) |
| `base` | 200 | дефолтный UI-переход (появление, смена состояния) |
| `slow` | 300 | крупнее и намереннее (панели, перемещения) |
| `slower` | 500 | полноэкранный / крупный переход поверхностей |

### easing

```ts
interface EasingToken {
  readonly fn: (t: number) => number; // EasingFn для rAF-путей (./keyframes, ./stagger)
  readonly css: string;               // cubic-bezier()-строка для WAAPI/CSS
}

const easing: EasingTokens;
type EasingTokenName = keyof typeof easing; // 'standard' | 'decelerate' | 'accelerate' | 'emphasized'
```

Семантические изинг-токены; каждый несёт оба представления из одного источника координат: `fn` — функция движка `t ∈ [0,1] → прогресс`, `css` — строка для `element.animate` / `transition`. Три сдержанных дефолта без overshoot + единственная кривая с overshoot (`emphasized`). Координаты запинены тестами; не бросает.

| Токен | `css` | Характер |
| --- | --- | --- |
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` | универсальный дефолт, оба конца сглажены (M3 easing-standard) |
| `decelerate` | `cubic-bezier(0, 0, 0, 1)` | «вход»: быстрый старт, мягкая посадка (M3 standard-decelerate) |
| `accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | «выход»: мягкий старт, быстрый уход (M3 standard-accelerate) |
| `emphasized` | `cubic-bezier(0.38, 1.21, 0.22, 1)` | ЕДИНСТВЕННЫЙ сдержанный overshoot (`y1 = 1.21`) — под акцент/emphasis |

`standard.fn` разделяет ссылочную идентичность с дефолтной кривой фасада (специализированный решатель ровно для этих координат); остальные три кривые — общий решатель cubic-bezier.

### springFromDurationBounce

```ts
function springFromDurationBounce(durationS: number, bounce: number): SpringParams;
```

Конвертирует каноническую пару восприятия (модель SwiftUI `Spring(duration:bounce:)` / Motion.dev; каноническая модель ДС-схемы labui) в физпараметры движка. Формулы — в точности SSOT labui:

```
ζ = 1 − bounce;  m = 1;  ω₀ = 2π / durationS;  stiffness = ω₀²;  damping = 2·ζ·ω₀
```

- `durationS` — перцептивная длительность в **секундах** (ручка дизайнера; реальное время оседания солвера может отличаться — пружина живёт по физике, не по таймеру). Обязана быть конечной и `> 0`.
- `bounce` — `[0, 1)`: `0` — критическое демпфирование (без overshoot), больше — упружее. `bounce = 1` (ζ = 0, вечный звон) в live-движке непредставим — отвергается.
- Возврат — `SpringParams` (`mass`/`stiffness`/`damping`), прогнанный через валидатор ядра (`validateSpringParams`, settle-бюджет): выход гарантированно принимается всеми путями движка.

Бросает: `LM108` — `durationS` не конечно или `≤ 0`; `LM109` — `bounce` не конечно или вне `[0, 1)`; транзитивно из валидатора ядра — `LM088`/`LM089`/`LM090` (вырождение физпараметров, напр. переполнение `ω₀²` при экстремально малом `durationS`) и `LM091` (время оседания превышает бюджет — слишком большой `durationS`).

### spring

```ts
const spring: SpringTokens;
type SpringToken = keyof typeof spring;
// 'default' | 'gentle' | 'snappy' | 'bounce' | 'smooth' | 'expressive'
```

Именованные пружинные пресеты (`SpringParams` для `./compositor` и `./value`). Все проходят валидатор ядра (settle гарантирован), запинены тестом; не бросает. Два семейства в одном словаре:

| Токен | Значение | Характер |
| --- | --- | --- |
| `default` | `{ mass: 1, stiffness: 170, damping: 26 }` | дефолт: ~критично-задемпфирован, без bounce |
| `gentle` | `{ mass: 1, stiffness: 120, damping: 30 }` | мягкий и медленный: спокойное оседание |
| `snappy` | `{ mass: 1, stiffness: 260, damping: 28 }` | быстрый и собранный: минимальный overshoot |
| `bounce` | `{ mass: 1, stiffness: 180, damping: 12 }` | OPT-IN пружинистость (underdamped, эмитит overshoot). НЕ дефолт |
| `smooth` | `springFromDurationBounce(0.35, 0)` | ДС SSOT effects: opacity/цвет, прерываемая, без overshoot |
| `expressive` | `springFromDurationBounce(0.5, 0.3)` | ДС SSOT spatial: единственный сдержанный overshoot ~4.6% |

`smooth`/`expressive` выведены из канонической пары через `springFromDurationBounce` — значения не дублируются; `default`/`gentle`/`snappy`/`bounce` — движковые экстры, в ДС-схеме их нет.

### staggerGap

```ts
const staggerGap: { readonly tight: 20; readonly normal: 40; readonly loose: 70 };
type StaggerGapToken = keyof typeof staggerGap; // 'tight' | 'normal' | 'loose'
```

Именованный базовый шаг задержки между элементами stagger-каскада (**мс**) для `./stagger` и compositor-stagger: `tight` = 20 (плотный каскад, крупные списки), `normal` = 40 (дефолт), `loose` = 70 (разрежённый, акцентные группы). Чистые данные, не бросает.

### distanceScaleConfig

```ts
interface DistanceScaleConfig {
  readonly minDistance: number; // травел (px) с минимальной длительностью
  readonly maxDistance: number; // травел (px) с максимальной длительностью (>= minDistance)
  readonly minDuration: number; // длительность при травеле <= minDistance (мс)
  readonly maxDuration: number; // длительность при травеле >= maxDistance (мс)
}

const distanceScaleConfig: DistanceScaleConfig;
// { minDistance: 0, maxDistance: 400, minDuration: duration.fast, maxDuration: duration.slow }
```

Дефолтная полоса дистанс-скейла: травел `0 → 400 px` маппится в `fast(100) → slow(300)` мс.

### distanceScale

```ts
function distanceScale(distancePx: number, config?: DistanceScaleConfig): number;
```

Материал-подобная «динамическая длительность»: длительность (**мс**) для перемещения на `distancePx` (px) — линейная интерполяция внутри полосы `config` (дефолт `distanceScaleConfig`), клэмп вне полосы. Чистая и финитная, **не бросает**: враждебный вход (`NaN`/`±Infinity`/отрицательный) сводится к `|конечному|` или границе полосы; вырожденная полоса (`maxDistance <= minDistance`) → `minDuration`.

```ts
distanceScale(0);   // 100 (minDuration)
distanceScale(200); // 200 (середина полосы)
distanceScale(999); // 300 (клэмп к maxDuration)
```

### Type-only экспорты ./tokens

`DurationTokens`, `DurationToken`, `EasingToken`, `EasingTokens`, `EasingTokenName`, `SpringTokens`, `SpringToken`, `StaggerGapToken`, `DistanceScaleConfig`.

## API: `./presets`

### Спецификация: PresetSpec / PresetTrack

```ts
type PresetProperty =
  | 'scale' | 'scaleX' | 'scaleY' | 'rotate' | 'x' | 'y' | 'opacity' | 'progress';

type PresetRepeatType = 'loop' | 'reverse' | 'mirror'; // семантика идентична ./keyframes

interface PresetTrack {
  readonly property: PresetProperty;              // уникально в рамках спеки
  readonly values: readonly number[];             // длина >= 2, каждое конечно
  readonly times?: readonly number[];             // доли [0,1]: неубывающие, [0]=0, [last]=1
  readonly easing?: EasingFn | readonly EasingFn[]; // на сегмент; массив длиной values.length-1
}

interface PresetSpec {
  readonly duration: number;          // длительность ОДНОГО цикла, секунды, > 0
  readonly tracks: readonly PresetTrack[]; // минимум один; property уникальны
  readonly delay?: number;            // секунды, >= 0; до истечения — поза t=0. Дефолт 0
  readonly repeat?: number;           // доп. циклы: целое 0…2_147_483_647 или Infinity. Дефолт 0
  readonly repeatType?: PresetRepeatType; // дефолт 'loop'
  readonly repeatDelay?: number;      // пауза между циклами, секунды, >= 0. Дефолт 0
}

type PresetValues = Partial<Record<PresetProperty, number>>; // только свойства из треков спеки
```

`times` не задан → равномерное авто-распределение; `easing` не задан → линейный на каждом сегменте.

### compilePreset

```ts
function compilePreset(spec: PresetSpec): CompiledPreset;
```

Валидирует и нормализует `PresetSpec` — **единственная точка валидации субпутя**: всё структурно невалидное падает здесь `MotionParamError` (в `message` и поле `code` — только LM-код, напр. `'LM046'`; русские описания с лечением — в каталоге [docs/errors.md](../errors.md), не в объекте ошибки), а не превращается тихо в `NaN` на кадре. Возвращает `CompiledPreset` — readonly-форму для горячего сэмплирования, брендированную маркером `__compiledPreset: true` (защита от подсовывания сырой спеки).

Бросает: `LM046` — не объект; `LM047` — невалидная `duration`; `LM048` — пустые `tracks`; `LM049` — неизвестное `property`; `LM050` — дубликат `property`; `LM051` — меньше двух `values`; `LM052` — неконечное значение; `LM053`–`LM057` — невалидные `times` (длина/конечность/порядок/края 0 и 1); `LM058` — длина массива `easing` не равна числу сегментов; `LM164` — `easing` (или его элемент) не функция; `LM059` — невалидный `delay`; `LM060` — невалидный `repeat`; `LM061` — неизвестный `repeatType`; `LM062` — невалидный `repeatDelay`; `LM161` — расписание непредставимо в binary64 (схлопывается на больших временах).

### presetTotalDuration

```ts
function presetTotalDuration(compiled: CompiledPreset): number;
```

Суммарная длительность пресета с учётом `delay`/`repeat`/`repeatDelay` (**секунды**). `Infinity` при `repeat = Infinity` — метаданные, не эмитируемое значение. Не бросает.

### samplePreset

```ts
function samplePreset(compiled: CompiledPreset, tSeconds: number): PresetValues;
```

Значения всех треков в момент `tSeconds` (секунды от нуля общей шкалы; `delay` входит в шкалу). Чистая функция без состояния и валидации — горячий путь; контракт: `compiled` получен из `compilePreset`. Хостильное время нормализуется: `NaN` и отрицательные/`-Infinity` → поза `t=0`; конечное расписание после terminal → последняя поза (yoyo-aware для `reverse`/`mirror`).

Бросает: `LM166` — бесконечное расписание (`repeat = Infinity`), у которого запрошенное время (включая `+Infinity`) требует номер итерации выше точного integer-домена binary64.

### Фабрики пресетов

Каждая фабрика возвращает **некомпилированную** `PresetSpec` — потребитель может расширить спредом (`{ ...pulse(), repeat: 2 }`) и компилирует при использовании (`runPreset`/`presetToWaapi` компилируют сами). Дефолты калиброваны сдержанно: мягкие амплитуды, identity-краевые позы (после конечной анимации элемент выглядит как статичный), тайминги ~0.5–1 с акцент / 2–3 с сюжет / ~5 с ambient-луп.

Все фабрики бросают `LM064` при невалидной `duration` (не конечна или `≤ 0`) и `LM063` при неконечном числовом параметре; специфические коды — в таблице.

| Фабрика | Сигнатура опций (дефолты) | Треки / форма | Спец-коды |
| --- | --- | --- | --- |
| `pulse(opts?)` | `{ amount?: 0.12; duration?: 0.9 }` | `scale: 1 → 1+amount → 1`, sineInOut | `LM065` — `amount <= -1` |
| `blink(opts?)` | `{ min?: 0; duration?: 1 }` | `opacity: 1 → min → 1`, `repeat: Infinity` | `LM066` — `min` вне `[0,1]` |
| `wiggle(opts?)` | `{ degrees?: 8; cycles?: 3; duration?: 0.8 }` | `rotate: 0 → +d → −d·k → … → 0`, линейное затухание; первый свинг в ПЛЮС (контракт, запинен тестом) | `LM067` — `cycles` не целое `>= 1` |
| `spin(opts?)` | `{ turns?: 1; duration?: 1 }` | `rotate: 0 → 360·turns` (отрицательный `turns` — против часовой) | — |
| `breathe(opts?)` | `{ amount?: 0.05; duration?: 2.6 }` | медленный мягкий scale-пульс, `repeat: Infinity` (ambient) | `LM068` — `amount <= -1` |
| `pop(opts?)` | `{ overshoot?: 1.18; duration?: 0.5 }` | `scale: 0 → overshoot → 1`, `times: [0, 0.7, 1]`, easing `[easeOut, sineInOut]` | `LM069` — `overshoot <= 0` |
| `bounceY(opts?)` | `{ height?: 2.5; duration?: 0.6 }` | `y: 0 → −h → 0 → −0.35·h → 0`, `times: [0, 0.3, 0.6, 0.8, 1]` | — |
| `drift(opts?)` | `{ dx?: 0; dy?: -1.5; duration?: 5 }` | плавный уход к `(dx, dy)` и возврат, `repeat: Infinity`; нулевая компонента — трек не создаётся | `LM070` — `dx` и `dy` оба нулевые |
| `fadeSlide(opts?)` | `{ dx?: 0; dy?: 4; duration?: 0.35 }` | `opacity: 0 → 1` + смещение `(dx, dy) → 0`, easeOut; нулевая компонента — трек не создаётся | — |
| `drawOn(opts?)` | `{ duration?: 1.2 }` | `progress: 0 → 1` монотонно; потребитель мапит на технику раскрытия | — |

Все `duration` в опциях фабрик — **секунды**; `degrees` — градусы; `height`/`dx`/`dy` — единицы координат потребителя (для 24px-иконки ~2–4).

### runPreset

```ts
interface RunPresetOptions {
  readonly onUpdate?: (values: PresetValues) => void;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
}

interface PresetControls {
  readonly totalDuration: number; // секунды; Infinity при repeat=∞
  readonly time: number;          // виртуальное время (секунды) от старта; delay входит в шкалу
  readonly progress: number;      // прогресс ТЕКУЩЕГО цикла [0,1]
  play(): void;                   // возобновить (no-op если играет или завершён)
  pause(): void;                  // заморозить виртуальное время
  seek(t: number): void;          // NaN → no-op; +Infinity завершает finite, для repeat=∞ — LM166
  complete(): void;               // снэп к финальной позе (repeat=∞ → нейтральная поза t=0) и резолв
  cancel(): void;                 // остановиться в текущей позиции и резолвить
  then(onfulfilled?, onrejected?): Promise<...>; // thenable: await runPreset(...)
}

function runPreset(spec: PresetSpec | CompiledPreset, opts?: RunPresetOptions): PresetControls;
```

Проигрывает пресет **одним** frame-loop'ом на все треки (один clock, один сэмпл на кадр). Начинает немедленно (если не reduced-motion). Сырая `PresetSpec` компилируется на входе; `CompiledPreset` принимается как есть.

- **Injectable seams:** `requestFrame` — заменитель `requestAnimationFrame` (virtual-time тесты); без него используется глобальный `requestAnimationFrame`, а при его отсутствии (SSR/Node) — `setTimeout`-фолбэк с фиксированным шагом 1/60 с. `matchMedia` — источник `prefers-reduced-motion`; `undefined` = SSR / нет предпочтений (`reduce = false`).
- **Reduced-motion CHARACTER-switch:** конечный `repeat` → синхронный снэп к финальной позе; `repeat = Infinity` (ambient-луп без финала) → нейтральная поза `t=0`. Поза эмитируется **ровно один раз** — потребитель получает статичную валидную позу, а не «ничего» (не hard-off).
- Ошибки пользовательского `onUpdate` изолируются — луп и промис живут дальше.
- Safety-cap кадров (100 000, идентичен keyframes/timeline): конечное расписание при срабатывании завершается в **текущей** позиции.

Бросает: коды `compilePreset` при сырой невалидной спеке; `LM165` — `requestFrame` задан, но не функция. `controls.seek` бросает `LM166` при `t = Infinity` (или времени за точным integer-горизонтом итераций) на `repeat = Infinity`.

### presetToWaapi

```ts
interface WaapiKeyframe { readonly offset: number; readonly transform?: string; readonly opacity?: number; }
interface WaapiTiming {
  readonly duration: number;   // МИЛЛИСЕКУНДЫ
  readonly delay: number;      // МИЛЛИСЕКУНДЫ
  readonly iterations: number; // repeat + 1; Infinity при repeat=∞
  readonly direction: 'normal' | 'alternate';
  readonly fill: 'both';
  readonly easing: 'linear';
}
interface WaapiProgressTrack { readonly offsets: readonly number[]; readonly values: readonly number[]; }
interface WaapiConversion {
  readonly keyframes: readonly WaapiKeyframe[];
  readonly timing: WaapiTiming;
  readonly progressTrack?: WaapiProgressTrack;
}

function presetToWaapi(spec: PresetSpec | CompiledPreset): WaapiConversion;
```

Чистый конвертер пресета в данные для `element.animate()` — headless: производит только данные, DOM-вызов делает потребитель. Семантика easing сохраняется плотной сеткой offset'ов (24 равномерных интервала ∪ точки `times` всех треков): в каждой точке значение вычислено точно, между точками WAAPI интерполирует линейно (`timing.easing: 'linear'`). `transform` собирается в фикс-порядке translate → rotate → scale; оси масштаба перемножаются: `sx = scale·scaleX`, `sy = scale·scaleY`. Канал `progress` не выражается CSS-свойством — уходит в `progressTrack`, потребитель ведёт его сам. `repeatType: 'reverse'` → `direction: 'alternate'`.

Бросает: коды `compilePreset` при сырой невалидной спеке; `LM071` — `repeat > 0` и `repeatDelay > 0` (в WAAPI нет нативного `repeatDelay`; честный отказ вместо тихо-неверной семантики — используйте `runPreset`); `LM159` — `mirror` с повтором (WAAPI `alternate` разворачивает easing — непредставимо); `LM161` — расписание численно неразличимо; `LM162` — timing или значение масштаба не конечно после перевода в мс.

### Текстовые/числовые сахара

Сахара — те же headless-пресеты: чистые мапперы «прогресс 0→1 → строка» (дисциплина `samplePreset`: горячий путь без валидации) + тонкие раннеры поверх `runPreset` — один clock, reduced-motion CHARACTER-switch и детерминизм наследуются. Дефолты длительностей — из `./tokens`.

#### splitText

```ts
type SplitMode = 'chars' | 'words';
interface GraphemeSegmenter { segment(text: string): Iterable<{ readonly segment: string }>; }

function splitText(text: string, mode?: SplitMode, segmenter?: GraphemeSegmenter): readonly string[];
```

Разбивает текст для пошагового раскрытия. `'chars'` (дефолт) — по extended grapheme clusters при наличии `Intl.Segmenter` или явного ponyfill (Intl.Segmenter структурно совместим с контрактом `GraphemeSegmenter`); в среде без сегментера — code-point fallback (суррогатные пары не рвутся). `'words'` сохраняет пробельные токены, чтобы `join('')` восстановил строку. Пустая строка → `[]`.

Бросает: `LM072` — `text` не строка; `LM073` — неизвестный режим; `LM158` — доступный/injected segmenter не создался или нарушил контракт (пустые сегменты, потери, перестановки).

#### typewriterAt

```ts
function typewriterAt(parts: readonly string[], progress: number): string;
```

Кадр печатной машинки: префикс `parts` при прогрессе `p` (безразмерный; клэмп в `[0,1]`, `NaN → 0`). Горячий путь — без валидации, не бросает.

#### scrambleAt

```ts
interface ScrambleAtOptions {
  readonly seed?: number;     // дефолт 0xdeadbeef
  readonly alphabet?: string; // дефолт латиница+цифры; Unicode-safe
}

function scrambleAt(text: string, progress: number, opts?: ScrambleAtOptions): string;
```

Скрэмбл-кадр: раскрытые глифы цели + seeded-шум в хвосте. **Чистая** функция `(text, p, seed) → строка`: RNG (mulberry32) пересоздаётся на каждый вызов, поэтому кадр не зависит от частоты кадров (реплей бит-идентичен). `p = 1` → точный `text`. Горячий путь — без валидации, не бросает.

#### formatNumber

```ts
interface NumberFormatOptions {
  readonly locales?: string | string[];       // undefined → локаль хоста
  readonly format?: Intl.NumberFormatOptions; // currency/unit/notation и т.д.
}

function formatNumber(value: number, opts?: NumberFormatOptions): string;
```

Одноразовое Intl-форматирование **конечного** числа. Бросает: `LM063` — `value` не конечно (строку `"NaN"`/`"∞"` в UI не эмитим).

#### tickerCells

```ts
function tickerCells(formatted: string): readonly string[];
```

Ячейки тикера/одометра: **все** глифы отформатированной строки (Unicode-safe, `Array.from`). «Нецифровое» намеренно не фильтруется — фильтр ломал бы локали (арабо-индийские цифры, валютные символы, группировочные пробелы). Отдельного `runTicker` нет намеренно: тикер = `runNumber` + `tickerCells`. Не бросает.

#### runTypewriter / runScramble / runNumber

```ts
interface SugarRunOptions {
  readonly duration?: number;  // секунды; дефолт у каждого раннера свой, из ./tokens
  readonly easing?: EasingFn;  // изинг прогресса; дефолт — линейный
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
}

interface TypewriterRunOptions extends SugarRunOptions {
  readonly mode?: SplitMode;              // дефолт 'chars'
  readonly segmenter?: GraphemeSegmenter; // exact Unicode ponyfill
}
interface ScrambleRunOptions extends SugarRunOptions, ScrambleAtOptions {}
interface NumberRunOptions extends SugarRunOptions, NumberFormatOptions {}

function runTypewriter(text: string, onUpdate: (partial: string) => void,
  opts?: TypewriterRunOptions): PresetControls;
function runScramble(text: string, onUpdate: (scrambled: string) => void,
  opts?: ScrambleRunOptions): PresetControls;
function runNumber(from: number, to: number, onUpdate: (formatted: string, value: number) => void,
  opts?: NumberRunOptions): PresetControls;
```

- **`runTypewriter`** — растущий префикс текста. Дефолт длительности — `staggerGap.normal` (40 мс) **на глиф**: машинка и есть стаггер по глифам, темп печати не зависит от длины текста. Reduced-motion: ровно один эмит полного текста без сегментации и кадров. Бросает: `LM074` — `onUpdate` не функция; `LM072`/`LM073` — невалидные `text`/`mode`; `LM064` — невалидная `duration`; `LM158` — нарушение контракта segmenter.
- **`runScramble`** — расшифровка к цели с seeded-шумом. Дефолт длительности — `duration.slower` из `./tokens` (в секундах раннера — 0.5 с). Фиксированный seed делает реплеи бит-идентичными. Бросает: `LM074`; `LM075` — `text` не строка; `LM063` — неконечный `seed`; `LM076` — пустой/не-строковый `alphabet`; `LM064`.
- **`runNumber`** — ведёт число `from → to`, эмитит Intl-строку и сырое значение. Форматтер создаётся один раз (конструкция `Intl.NumberFormat` дорогая — в кадровом цикле ей не место). Дефолт длительности — `duration.slow` из `./tokens` (0.3 с). Значения гарантированно конечны. Бросает: `LM074`; `LM063` — неконечные `from`/`to`; `LM064`.

Все три возвращают `PresetControls` (управление и thenable — как `runPreset`).

### Type-only экспорты ./presets

`EasingFn`, `MatchMediaResult` (реэкспорт из `./keyframes`), `PresetProperty`, `PresetRepeatType`, `PresetTrack`, `PresetSpec`, `PresetValues`, `CompiledPreset`, `PulseOptions`, `BlinkOptions`, `WiggleOptions`, `SpinOptions`, `BreatheOptions`, `PopOptions`, `BounceYOptions`, `DriftOptions`, `FadeSlideOptions`, `DrawOnOptions`, `RunPresetOptions`, `PresetControls`, `WaapiKeyframe`, `WaapiTiming`, `WaapiProgressTrack`, `WaapiConversion`, `SplitMode`, `GraphemeSegmenter`, `ScrambleAtOptions`, `NumberFormatOptions`, `SugarRunOptions`, `TypewriterRunOptions`, `ScrambleRunOptions`, `NumberRunOptions`.

## Контракты

- **SSR-safe / Zero-DOM.** `./tokens` — только данные и чистые функции. `./presets` — ни DOM, ни `window`/`document` на верхнем уровне; `runPreset` без глобального `requestAnimationFrame` уходит в `setTimeout`-фолбэк, `matchMedia` — injectable (`undefined` = SSR, reduce=false).
- **Финитность.** `distanceScale` клэмпит враждебный вход (`NaN`/`∞` → границы полосы). В `./presets` сэмплы всегда конечны: values валидированы `compilePreset`, нормализацию хостильного времени делает `samplePreset`, конечность значений гарантируют внутренние guards кейфрейм-сэмплера; `typewriterAt`/`scrambleAt` клэмпят прогресс (`NaN → 0`).
- **Детерминизм.** Токены — иммутабельные данные (`as const`); `distanceScale`, `samplePreset`, `scrambleAt` чисты: одинаковый вход → бит-идентичный выход. `runPreset` использует injectable clock (`requestFrame`-seam); RNG скрэмбла пересоздаётся на кадр — вывод не зависит от fps.
- **Reduced-motion.** Слой токенов `prefers-reduced-motion` не читает (`duration.instant = 0` — целевой якорь reduced-motion). `runPreset` и раннеры-сахара делают CHARACTER-switch: конечный `repeat` → мгновенный снэп к финальной позе; `repeat = Infinity` → нейтральная поза `t=0`; поза эмитируется ровно один раз (не hard-off).
- **Валидация на границе.** Единственные точки валидации — `compilePreset` (`./presets`) и фабрики/раннеры на входе; горячие сэмплеры проверок не делают. Все ошибки — `MotionParamError` с полем `code`; каталог с лечением — [docs/errors.md](../errors.md).
- **SSOT с labui.** Длительности, изинги и пружины `smooth`/`expressive` зеркалируют ДС-схему labui (`--lab-motion-*`); при пересечении имён значения совпадают байт-в-байт, эталон — labui. Экстры движка (`default`/`gentle`/`snappy`/`bounce`, `staggerGap`, `distanceScale`) — надмножество. Пины значений — тестами.
- **Субпуть-изоляция.** Не импортируешь `./tokens` — ядро не растёт (проверено размерным гейтом); граница размера — весь субпуть, см. [docs/benchmark.md](../benchmark.md).

## Примеры

Токены в WAAPI-переходе: `easing.*.css` + динамическая длительность по травелу:

```typescript
import { duration, easing, distanceScale } from '@labpics/motion/tokens';

const card = document.querySelector('.card') as HTMLElement;
const travelPx = 320;

card.animate(
  [{ transform: 'translateX(0px)' }, { transform: `translateX(${travelPx}px)` }],
  {
    duration: distanceScale(travelPx), // мс: линейно внутри полосы fast(100)→slow(300)
    easing: easing.standard.css,       // 'cubic-bezier(0.2, 0, 0, 1)'
    fill: 'both',
  },
);

console.log(duration.base);            // 200 (мс) — токены — просто данные
console.log(easing.decelerate.fn(0.5)); // та же кривая как функция движка
```

Пресет через управляемый frame-loop: фабрика → спред → `runPreset` (reduced-motion уважается через injectable `matchMedia`):

```typescript
import { pulse, runPreset } from '@labpics/motion/presets';

const icon = document.querySelector('.icon') as HTMLElement;

const controls = runPreset(
  { ...pulse({ amount: 0.1 }), repeat: 2 }, // фабрика возвращает PresetSpec — расширяем спредом
  {
    onUpdate: (v) => {
      icon.style.transform = `scale(${v.scale ?? 1})`;
    },
    matchMedia: typeof window !== 'undefined'
      ? window.matchMedia.bind(window) // reduced-motion → один снэп к финальной позе
      : undefined,                      // SSR: reduce=false
  },
);

controls.then(() => {
  icon.style.transform = ''; // финальная поза identity — можно снять inline-стиль
});
```

WAAPI-конвертация и числовой счётчик; ранняя ошибка по LM-коду:

```typescript
import { MotionParamError } from '@labpics/motion';
import { fadeSlide, presetToWaapi, runNumber } from '@labpics/motion/presets';

const badge = document.querySelector('.badge') as HTMLElement;

// headless-конвертер отдаёт данные; DOM-вызов делает потребитель
const { keyframes, timing } = presetToWaapi(fadeSlide({ dy: 8 }));
// timing.duration/delay — миллисекунды; каст сводит headless-тип к DOM Keyframe
badge.animate(keyframes as Keyframe[], { ...timing });

// счётчик: Intl-строка + сырое значение; дефолт длительности — duration.slow из ./tokens
runNumber(0, 1287, (formatted) => {
  badge.textContent = formatted;
}, { format: { notation: 'compact' } });

try {
  presetToWaapi({ ...fadeSlide(), repeat: 2, repeatDelay: 0.2 });
} catch (e) {
  if (e instanceof MotionParamError && e.code === 'LM071') {
    // WAAPI не имеет repeatDelay — для паузы между циклами используйте runPreset
  }
}
```
