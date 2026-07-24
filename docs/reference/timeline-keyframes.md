# ./timeline и ./keyframes — секвенции и семплеры keyframes

> Роль: справка — публичные API экспорт-субпутей `./timeline` (оркестратор tween-сегментов `createTimeline()`) и `./keyframes` (мульти-точечная анимация `keyframes()` и чистый семплер `sampleKeyframes()`).

## Назначение

Оба субпутя — headless zero-DOM домен единого виртуального времени. `./timeline` компонует несколько tween-сегментов (`from → to`) вдоль общей шкалы с offset/at-позиционированием, метками (labels), seek/progress. `./keyframes` интерполирует одно значение через N ≥ 2 опорных точек с явными или авто-распределёнными долями `times`, per-сегментным easing и политиками повтора `loop | reverse | mirror` с `repeatDelay`. Оба возвращают управляемый thenable-хендл (`await` резолвится при завершении) и переиспользуют один и тот же инжектируемый clock-seam (`requestFrame`), что и `./driver`/`./spring`.

**Единицы: секунды виртуального времени** — `duration`, `offset`, `at`, `repeatDelay`, `time`, `totalDuration` везде в секундах, не в миллисекундах. Timestamps `requestAnimationFrame` (миллисекунды) конвертируются внутри; при отсутствии timestamp шаг фиксированный — 1/60 с.

Инварианты обоих модулей (закреплены в JSDoc и коде):

- **Zero runtime deps** — внешних npm-зависимостей нет.
- **CSS-safe финитность** — эмитируемые значения всегда конечны (`NaN`/`Infinity` запрещены), включая overflow-края и враждебный выход пользовательского easing.
- **Детерминизм** — clock инжектируется (`requestFrame`); одинаковый seam → идентичный (для `./keyframes` — бит-идентичный) вывод. Нет `Date.now`/`Math.random` на верхнем уровне.
- **Reduced-motion — переключение ХАРАКТЕРА** — мгновенный snap к финалу, НЕ hard-off.
- **Domain purity / SSR-safe** — никаких `querySelector`/`document`/`window` внутри ядра и на пути импорта; `matchMedia` — структурная инъекция.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Оба субпутя tree-shakeable.

## Импорт

```ts
import {
  createTimeline,
  type TimelineOptions,
  type TimelineControls,
  type SegmentConfig,
  type SegmentValue,
  type MatchMediaResult,
} from '@labpics/motion/timeline';

import {
  keyframes,
  sampleKeyframes,
  type KeyframesOptions,
  type KeyframesControls,
  type KeyframesRepeatType,
  type EasingFn,
} from '@labpics/motion/keyframes';
```

## API

### createTimeline (`./timeline`)

```ts
interface SegmentConfig {
  from: number;                          // конечное число
  to: number;                            // конечное число
  duration: number;                      // секунды; > 0, конечная
  offset?: number;                       // секунды после конца предыдущего; >= 0; дефолт 0
  at?: number | string;                  // абсолютное время или позиция; переопределяет offset
  easing?: (t: number) => number;        // дефолт — линейная идентичность
  onStep?: (value: number) => void;      // per-сегментный колбэк
}

interface SegmentValue {
  index: number;                         // индекс в opts.segments
  value: number;                         // текущее конечное значение
}

interface TimelineOptions {
  segments: readonly SegmentConfig[];    // обязательный, непустой
  onStep?: (values: readonly SegmentValue[]) => void;
  requestFrame?: (cb: (ts?: number) => void) => number;
  matchMedia?: (query: string) => MatchMediaResult;   // { matches: boolean }
  labels?: Record<string, number | string>;
}

function createTimeline(opts: TimelineOptions): TimelineControls;
```

Создаёт управляемый таймлайн из последовательности tween-сегментов. Воспроизведение начинается немедленно; для старта на паузе вызовите `pause()` сразу после создания (до первого raf-колбэка). Хендл thenable: `await createTimeline(opts)` резолвится при завершении.

Позиционирование сегмента:

- `at` (абсолютное) переопределяет `offset`, если заданы оба. Число — абсолютное виртуальное время (конечное, `>= 0`). Строка — позиция: имя зарегистрированной метки | `'<'` (старт предыдущего сегмента) | `'>'` (конец предыдущего) | `'+=N'` / `'-=N'` (конец предыдущего ± N секунд) | `'label+=N'` / `'label-=N'` (время метки ± N; неизвестная метка — база `0`). Нераспознанная строка → `0`.
- `offset` — задержка (секунды) после конца предыдущего сегмента. По умолчанию `0` → сегменты идут последовательно.
- `easing` — нормализованное время `0..1 → 0..1`; выход зашивается guard'ом конечности (`NaN → 0`, `±Infinity → ±Number.MAX_VALUE`).
- Семантика значения сегмента: до `startTime` → `from`; после `endTime` → `to`; внутри — tween `from + (to − from) × easing(t)` с финальным finiteness-guard (неконечный результат → snap к `to`).

Опции таймлайна:

- `onStep` — глобальный колбэк: массив `SegmentValue` всех сегментов на каждом шаге (буфер переиспользуется между кадрами — не сохраняйте ссылку). При reduced-motion вызывается однократно с финальными значениями.
- `requestFrame` — injectable-заменитель `requestAnimationFrame`. Возврат `0` — non-draining конвенция: цикл переходит на `setTimeout`-fallback (для тестов с виртуальным временем). Не задан → нативный `requestAnimationFrame`, при его отсутствии — `setTimeout`.
- `matchMedia` — источник `prefers-reduced-motion`; в браузере — `window.matchMedia.bind(window)`. `undefined` = SSR / нет предпочтений (reduce = false). Тип структурный (`{ matches: boolean }`), не DOM `MediaQueryList`.
- `labels` — предварительные метки. При создании регистрируются только записи-числа (конечные, `>= 0`); строковые значения в этой опции игнорируются — строковые позиции добавляйте через `controls.label()`.

Возврат — `TimelineControls`:

```ts
interface TimelineControls {
  readonly totalDuration: number;        // секунды; max(endTime) по сегментам; конечна, >= 0
  readonly time: number;                 // текущее виртуальное время (секунды)
  readonly progress: number;             // [0, 1]; 1 = все сегменты завершены
  play(): void;                          // no-op если играет или завершён
  pause(): void;                         // no-op если завершён
  seek(t: number | string): void;
  complete(): void;                      // snap всех сегментов к to + resolve
  cancel(): void;                        // стоп в текущей позиции + resolve (эмитирует текущие значения)
  label(name: string, at?: number | string): void;
  then(onfulfilled?, onrejected?): Promise<...>;  // thenable
}
```

- `seek(t)` — число: `t < 0 → 0`, `NaN` → no-op, `+Infinity` → `complete()`; иначе кламп в `[0, totalDuration]` и эмит значений. Строка: перемотка к метке; неизвестная метка → no-op.
- `label(name, at?)` — регистрирует/обновляет метку. `at` не задан или неконечен → текущее время; число → `max(0, at)`; строка → время существующей метки (иначе текущее время).
- Safety-cap: жёсткий предел 100 000 кадров (внутренняя константа `MAX_FRAMES`) — fail-safe от зависания; при срабатывании таймлайн останавливается в ТЕКУЩЕЙ позиции (как `cancel`), не выдавая бейлаут за natural-complete.

Бросает `MotionParamError` (`error.code` — LM-код, каталог — [docs/errors.md](../errors.md)):

| Код | Условие |
| --- | --- |
| `LM102` | `from` неконечен |
| `LM103` | `to` неконечен |
| `LM104` | `duration` неположительна или неконечна |
| `LM105` | числовой `at` неконечен или `< 0` |
| `LM106` | `offset` неконечен или `< 0` |
| `LM107` | `segments` пуст или отсутствует |

### keyframes (`./keyframes`)

```ts
type EasingFn = (t: number) => number;
type KeyframesRepeatType = 'loop' | 'reverse' | 'mirror';

interface KeyframesOptions {
  values: readonly number[];             // длина >= 2, все конечны
  duration?: number;                     // секунды ОДНОГО цикла; > 0, конечна; дефолт 1
  times?: readonly number[];             // доли [0,1]; дефолт — авто i / (n - 1)
  easing?: EasingFn | readonly EasingFn[];   // на все сегменты или по одному; дефолт — линейная
  repeat?: number;                       // ДОПОЛНИТЕЛЬНЫЕ повторы; целое 0…2147483647 | Infinity; дефолт 0
  repeatType?: KeyframesRepeatType;      // дефолт 'loop'
  repeatDelay?: number;                  // секунды между циклами; >= 0; дефолт 0
  onStep?: (value: number) => void;
  requestFrame?: (cb: (ts?: number) => void) => number;
  matchMedia?: (query: string) => MatchMediaResult;
}

function keyframes(opts: KeyframesOptions): KeyframesControls;
```

Создаёт управляемую keyframes-анимацию. Начинает воспроизведение немедленно (если не reduced-motion). Семантика опций:

- `times` — доли `[0, 1]` для каждого значения: длина равна `values.length`, неубывающие, `times[0] === 0`, `times[last] === 1`, все конечны. Не задано → равномерное авто-распределение.
- `easing` — одна функция применяется ко всем сегментам; массив — по одному easing на сегмент, длина строго `values.length - 1`. Выход любого easing зашивается finiteness-guard'ом (`NaN → 0`, `±Infinity → ±MAX_VALUE`).
- `repeat` — число ДОПОЛНИТЕЛЬНЫХ повторов после первого проигрывания: `0` (дефолт) = один раз, `Infinity` = бесконечно.
- `repeatType`: `'loop'` — каждый цикл заново от `values[0]` к `values[last]`; `'reverse'` — нечётный цикл воспроизводит track и easing назад; `'mirror'` — нечётный цикл меняет порядок `values`, сохраняя easing вперёд.
- `repeatDelay` — пауза между циклами (секунды); значение держится на конце цикла. Задержка существует только МЕЖДУ итерациями.
- Ошибки пользовательского `onStep` изолируются (`try/catch`) — frame-loop и Promise остаются работоспособны.

Возврат — `KeyframesControls`:

```ts
interface KeyframesControls {
  readonly totalDuration: number;        // секунды всей последовательности повторов
  readonly time: number;                 // секунды от начала первого цикла
  readonly progress: number;             // прогресс ТЕКУЩЕГО цикла [0,1]; после завершения — 1
  play(): void;
  pause(): void;
  seek(t: number): void;
  complete(): void;                      // snap к values[last] + resolve
  cancel(): void;                        // стоп в текущей позиции + resolve
  then(onfulfilled?, onrejected?): Promise<...>;  // thenable
}
```

- `totalDuration` = `duration` при `repeat === 0`, иначе `repeat × (duration + repeatDelay) + duration`; `Infinity` при `repeat === Infinity` (метаданные, НЕ эмитируемое значение — инвариант финитности на это поле не распространяется; соответствует WAAPI `activeDuration`).
- `progress` — прогресс текущей итерации, не всей последовательности (при `repeat === Infinity` общий прогресс не определён по построению).
- `seek(t)`: `t < 0 → 0`, `NaN` → no-op; `+Infinity` завершает конечный schedule (`complete()`), но при `repeat === Infinity` бросает `LM166`. Для бесконечного schedule перемотка на время, требующее номера итерации выше точного binary64 integer domain (`> Number.MAX_SAFE_INTEGER`), также даёт `LM166`.
- Естественное завершение (конечный schedule): финальное значение учитывает направление — `values[last]` для `'loop'` либо чётного `repeat`; `values[0]` для нечётного `repeat` с `'reverse'`/`'mirror'`. Явный `complete()` всегда снэпит к `values[last]` (совпадает с reduced-motion контрактом).
- Границы итераций half-open: точная промежуточная граница начинает следующую итерацию; закрыт только конечный терминал.
- Реентерабельность: управляющий вызов (`seek`/`cancel`/`complete`) изнутри easing получает одну отложенную выборку; дальнейшие вложенные вызовы из той же выборки игнорируются (защита от рекурсии/livelock).
- Safety-cap 100 000 кадров: конечный schedule останавливается в текущей позиции (не natural-complete); бесконечный — счётчик сбрасывается, воспроизведение продолжается.

Бросает `MotionParamError`:

| Код | Условие |
| --- | --- |
| `LM033` | `values` отсутствует или длина < 2 |
| `LM034` | элемент `values` неконечен |
| `LM035` | длина `times` не совпадает с `values` |
| `LM036` | отметка `times` неконечна |
| `LM037` | `times` убывают |
| `LM038` | `times[0] !== 0` |
| `LM039` | `times[last] !== 1` |
| `LM040` | длина массива `easing` ≠ числу сегментов |
| `LM041` | `duration` неположительна или неконечна |
| `LM042` | `repeat` не целое `0…2147483647` и не `Infinity` |
| `LM043` | `repeatType` не `'loop' | 'reverse' | 'mirror'` |
| `LM044` | `repeatDelay` неконечна или `< 0` |
| `LM161` | repeat-расписание численно непредставимо в binary64 |
| `LM163` | `easing` (скаляр или элемент массива) не функция |
| `LM165` | `requestFrame` задан, но не функция |
| `LM166` | выборка бесконечного schedule за пределами точного integer-domain итераций (в т.ч. `seek(Infinity)` при `repeat === Infinity`) |

### sampleKeyframes (`./keyframes`)

```ts
function sampleKeyframes(
  values: readonly number[],
  times: readonly number[],
  easings: readonly EasingFn[],
  p: number,
): number;
```

Чистая stateless-функция: интерполирует значение по опорным точкам при нормализованном прогрессе `p` (обычно `[0, 1]`, но защищена от враждебных входов). Экспортирована отдельно от `keyframes()` для прямого использования: статичная выборка кадра без frame-loop, differential-oracle тесты, SSR-рендер стартовой позы.

Контракт:

- Предусловия НЕ валидируются заново (hot path) — вызывающий обязан обеспечить `values.length >= 2`, `times.length === values.length`, `easings.length === values.length - 1` (внутри `keyframes()` это гарантирует компиляция опций). Результат при этом ВСЕГДА конечное число.
- `p <= times[0]` → `values[0]`; `p >= times[last]` → `values[last]`.
- Совпадающие соседние `times` (сегмент нулевой ширины) → мгновенный переход к `values[i + 1]` без деления на ноль.
- Overflow (`values[i+1] − values[i]` неконечен) → snap к `values[i + 1]` — та же дисциплина, что overflow-guard таймлайна.

Не бросает.

### Type-only экспорты

`./timeline`: `MatchMediaResult` (`{ matches: boolean }` — структурный подвид `MediaQueryList`), `SegmentConfig`, `SegmentValue`, `TimelineOptions`, `TimelineControls`.

`./keyframes`: `EasingFn`, `KeyframesRepeatType`, `MatchMediaResult` (собственное объявление субпутя), `KeyframesOptions`, `KeyframesControls`.

## Контракты

- **SSR-safe.** Нет обращений к `window`/`document` при импорте. `matchMedia` — опциональная инъекция; без неё reduce = false. При отсутствии `requestAnimationFrame` цикл работает на `setTimeout`.
- **Reduced-motion (CHARACTER-switch).** При `matchMedia('(prefers-reduced-motion: reduce)').matches` — синхронный однократный snap к финалу с резолвом Promise: таймлайн эмитит `to` всех сегментов, keyframes — `values[last]` (repeat/направление игнорируются: «reduced» значит «покажи финал сразу», а не «просчитай все итерации»). Это смена характера, НЕ hard-off. Бросающий `matchMedia` трактуется как reduce = false.
- **Финитность (CSS-safe).** Каждое эмитируемое значение конечно: выход easing зашивается guard'ом (`NaN → 0`, `±Infinity → ±Number.MAX_VALUE`), переполнение диапазона `to − from` / `values[i+1] − values[i]` → snap к конечной точке сегмента. Исключение — метаданное поле `KeyframesControls.totalDuration`, которое равно `Infinity` при `repeat: Infinity`.
- **Детерминизм.** Часы инжектируются через `requestFrame`; при одинаковом seam вывод воспроизводим (keyframes — бит-идентичен). `sampleKeyframes` — чистая функция: идентичный вход → идентичный выход.
- **Надёжность завершения.** `await` резолвится при любом завершении (complete/cancel/natural); резолв гарантирован даже если пользовательский `onStep` бросает на финальном эмите. `complete()`/`cancel()` идемпотентны; все вызовы после завершения — no-op.

## Примеры

Появление карточки: два сегмента, одновременный старт через позицию `'<'`, уважение reduced-motion, `await` завершения:

```ts
import { createTimeline } from '@labpics/motion/timeline';
import { easeOut } from '@labpics/motion/easing';

const card = document.querySelector('.card') as HTMLElement;

const tl = createTimeline({
  matchMedia: window.matchMedia.bind(window), // reduce → мгновенный snap к финалу
  segments: [
    {
      from: 24, to: 0, duration: 0.3, easing: easeOut, // секунды
      onStep: (y) => { card.style.transform = `translateY(${y}px)`; },
    },
    {
      from: 0, to: 1, duration: 0.25, at: '<', // старт вместе с предыдущим сегментом
      onStep: (o) => { card.style.opacity = String(o); },
    },
  ],
});

await tl; // резолвится при complete/cancel/natural
console.log(tl.progress); // 1
```

Пульсация с зеркальными повторами: три опорные точки, per-сегментные easing, пауза между циклами:

```ts
import { keyframes } from '@labpics/motion/keyframes';
import { easeInOut, easeOut } from '@labpics/motion/easing';

const badge = document.querySelector('.badge') as HTMLElement;

const pulse = keyframes({
  values: [1, 1.15, 1],
  times: [0, 0.4, 1],                 // пик на 40% цикла
  easing: [easeOut, easeInOut],       // по одному на сегмент: length = values.length - 1
  duration: 0.6,                      // секунды одного цикла
  repeat: 3,                          // ещё 3 цикла после первого
  repeatType: 'mirror',
  repeatDelay: 0.2,                   // пауза между циклами (секунды)
  matchMedia: window.matchMedia.bind(window),
  onStep: (s) => { badge.style.transform = `scale(${s})`; },
});

console.log(pulse.totalDuration);     // 3 * (0.6 + 0.2) + 0.6 = 3 (секунды)
await pulse;
```

Статичная выборка кадра без frame-loop (SSR / poster-поза) — чистый `sampleKeyframes`:

```ts
import { sampleKeyframes, type EasingFn } from '@labpics/motion/keyframes';

const values = [0, 120, 80] as const;
const times = [0, 0.5, 1] as const;
const linear: EasingFn = (t) => t;
const easings: readonly EasingFn[] = [linear, linear]; // values.length - 1

// Поза на 25% трека: внутри первого сегмента 0 → 120.
const at25 = sampleKeyframes(values, times, easings, 0.25); // 60

// Края клампятся: p <= 0 → values[0], p >= 1 → values[last].
const start = sampleKeyframes(values, times, easings, -1);  // 0
const end = sampleKeyframes(values, times, easings, 2);     // 80
```
