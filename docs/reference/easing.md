# ./easing — кривые изинга

> Роль: справка — публичный API экспорт-субпутя `./easing`: чистые easing-функции `(t: number) => number`, фабрики `power`/`cubicBezier`/`steps` и NE1-обёртка `normalizeEasing`.

## Назначение

Субпуть `./easing` — L1-домен чистых функций времени: каждая кривая — `(t: number) => number` без DOM, без часов, без `window` и глобального состояния. Аргумент `t` — нормализованный прогресс, безразмерный (`0` — старт, `1` — финиш); миллисекунды/секунды этот модуль не знает — шкала прогресса всегда забота вызывающего.

Инварианты модуля (закреплены в JSDoc и тестах):

- **NE1. CSS-safe финитность.** Выход всегда конечен (никогда `NaN`/`±Infinity`) для **любого** IEEE-754 входа, включая `t < 0`, `t > 1`, `NaN`, `±Infinity`, `-0`, субнормальные. Схема клампа зеркалит `clampFinite` из `spring.ts`: `NaN → 0`, `+Infinity → Number.MAX_VALUE`, `-Infinity → -Number.MAX_VALUE`.
- **NE2. Точность эндпоинтов.** Для непрерывных кривых `easing(0) === 0` и `easing(1) === 1` бит-точно; дисциплина зеркалит `tween.ts`: `t ≤ 0 → 0`, `t ≥ 1 → 1` (короткое замыкание до формулы); враждебные `t` (`NaN → 0`, `-Infinity → 0`, `+Infinity → 1`) обрабатываются первыми.
- **NE3. Теги формы.** `MONOTONIC` — неубывающая на `[0, 1]`; `OVERSHOOTING` — может выйти за `[0, 1]` (ограниченно-конечная, монотонность не утверждается); `STEPPED` — разрывная, выход конечен, непрерывность не утверждается.
- **NE4. Детерминизм и чистота.** Идентичные входы → бит-идентичные выходы; ноль runtime-зависимостей, без `Math.random`, `Date.now`, часов и DOM.
- **NE7. Ранняя валидация фабрик.** Фабрики (`power`, `cubicBezier`, `steps`) отвергают невалидные параметры через `MotionParamError` в момент конструирования — возвращённая функция никогда не возвращает `NaN`.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  // фиксированные кривые
  linear,
  easeIn, easeOut, easeInOut,
  sineIn, sineOut, sineInOut,
  expoIn, expoOut, expoInOut,
  circIn, circOut, circInOut,
  backIn, backOut, backInOut,
  anticipate,
  elastic,
  bounce,
  // фабрики
  power,
  cubicBezier,
  steps,
  // NE1-обёртка для пользовательских кривых
  normalizeEasing,
  type StepPosition,
} from '@labpics/motion/easing';
```

`MotionParamError` (класс брошенных ошибок с полем `code`) экспортируется корневым субпутём `@labpics/motion`.

## API

Все кривые и функции, возвращаемые фабриками, имеют единую форму `(t: number) => number`; `t` и результат безразмерны.

### Фиксированные кривые

Ни одна из фиксированных кривых не бросает. Все соблюдают NE1/NE2/NE4. Канон — Robert Penner (2002), для `anticipate`/`elastic` — конвенция Framer Motion / Motion One.

#### MONOTONIC (неубывающие на [0, 1])

| Экспорт | Формула на интерьере `t ∈ (0, 1)` | Характер |
| --- | --- | --- |
| `linear` | `t` | тождественная |
| `easeIn` | `t³` | медленный старт (Penner easeInCubic) |
| `easeOut` | `1 − (1−t)³` | медленный финиш (easeOutCubic) |
| `easeInOut` | `t < 0.5 ? 4t³ : 1 − (−2t+2)³/2` | S-кривая (easeInOutCubic) |
| `sineIn` | `1 − cos(t·π/2)` | мягкий разгон |
| `sineOut` | `sin(t·π/2)` | мягкое торможение |
| `sineInOut` | `−(cos(π·t) − 1)/2` | мягкая S-кривая |
| `expoIn` | `2^(10t−10)` | очень медленный старт, резкий финиш |
| `expoOut` | `1 − 2^(−10t)` | резкий старт, очень медленный финиш |
| `expoInOut` | `t < 0.5 ? 2^(20t−10)/2 : (2 − 2^(−20t+10))/2` | экспоненциальная S-кривая |
| `circIn` | `1 − √(1 − t²)` | дуга четверти окружности, медленный старт |
| `circOut` | `√(1 − (t−1)²)` | дуга, медленный финиш |
| `circInOut` | `t < 0.5 ? (1−√(1−(2t)²))/2 : (√(1−(−2t+2)²)+1)/2` | S-кривая из дуг |

#### OVERSHOOTING (могут выйти за [0, 1] на интерьере; эндпоинты точны)

| Экспорт | Формула / устройство | Выход за диапазон |
| --- | --- | --- |
| `backIn` | `c3·t³ − c1·t²`, `c1 = 1.70158`, `c3 = c1 + 1` | кратко ниже `0` у старта |
| `backOut` | `1 + c3·(t−1)³ + c1·(t−1)²` | кратко выше `1` у финиша |
| `backInOut` | половины на константе `c2 = c1·1.525` | ниже `0` у старта и выше `1` у финиша |
| `anticipate` | `t < 0.5` — масштабированный `backIn` (откат); `t ≥ 0.5` — масштабированный кубический easeOut (запуск) | уходит в минус в фазе отката |
| `elastic` | затухающая синусоида на `2^(±(20t∓10))`, период `c5 = 2π/4.5` (класс easeInOutElastic) | осцилляция ниже `0` и выше `1` |
| `bounce` | Penner easeInOutBounce: `t < 0.5` — инвертированный bounceOut, `t ≥ 0.5` — bounceOut | остаётся в `[0, 1]`, но **не монотонна** |

Для всех overshooting-кривых эндпоинты точны (NE2-исключение касается только интерьера): `f(0) === 0`, `f(1) === 1` бит-точно.

### normalizeEasing

```ts
function normalizeEasing(fn: (t: number) => number): (t: number) => number;
```

Оборачивает произвольную пользовательскую easing и укрепляет её выход до NE1: любой неконечный результат клампится (`NaN → 0`, `+Infinity → Number.MAX_VALUE`, `-Infinity → -Number.MAX_VALUE`). Для благополучных кривых (конечный выход на конечных входах) обёртка прозрачна по значению. Вход `t` не модифицируется — эндпоинт-дисциплина остаётся ответственностью `fn`. Не бросает.

### power

```ts
function power(exponent: number): (t: number) => number;
```

Фабрика параметрической полиномиальной In-кривой: `power(p)(t) = t^p` на интерьере. `p = 1` — linear, `2` — quad, `3` — cubic (эквивалент `easeIn`), `4` — quart, `5` — quint; нецелые степени — гладкое обобщение. Форма: MONOTONIC при `p > 0`.

- Параметр `exponent` — конечное число (безразмерное).
- Возвращённая функция NE1-safe для всех `t`; эндпоинты бит-точны (NE2).

Бросает: `LM028` — `exponent` не конечное число.

### cubicBezier

```ts
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number;
```

Фабрика кривой, совпадающей с CSS `cubic-bezier(x1, y1, x2, y2)` (W3C CSS Transitions Level 1 §2.2). Солвер — Newton–Raphson с bisection-фолбэком и предвычисленной таблицей сэмплов (тот же подход, что `CubicBezierTimingFunction` в Chrome). Валидация и таблица считаются один раз в фабрике; сэмпл — без аллокаций.

- `x1`, `x2` — временны́е координаты контрольных точек, обязаны лежать в `[0, 1]` (иначе x-компонента Безье немонотонна и необратима — CSS отвергает такие значения по той же причине).
- `y1`, `y2` — без ограничений (допускают overshoot).
- Диагональный fast-path: при `x1 === y1 && x2 === y2` возвращается сам `linear`.
- Возвращённая функция NE1-safe; `f(0) === 0`, `f(1) === 1` точно; детерминизм NE4.

Бросает: `LM029` — любая контрольная точка не конечна; `LM030` — `x1` или `x2` вне `[0, 1]`.

### steps

```ts
type StepPosition = 'start' | 'end';

function steps(n: number, position: StepPosition = 'end'): (t: number) => number;
```

Фабрика ступенчатой (STEPPED, разрывной) кривой, делящей прогресс на `n` дискретных шагов — зеркало CSS step-timing-function (W3C CSS Transitions Level 1 §2.3):

- `'end'` (дефолт, jump-end): `floor(t·n)/n` — прыжок в конце каждого интервала;
- `'start'` (jump-start): `min(1, ceil(t·n)/n)` — прыжок в начале каждого интервала.

Параметры: `n` — число шагов, положительное конечное целое (`n ≥ 1`); `position` — `'start' | 'end'`, дефолт `'end'`.

Эндпоинт-поведение (важное расхождение с CSS): короткое замыкание `t ≤ 0 → 0`, `t ≥ 1 → 1` применяется к **обеим** позициям, поэтому `steps(n, 'start')(0) === 0` (не `1/n`, как у CSS jump-start в нуле) — первая видимая ступень для `'start'` происходит на первом интерьерном `t > 0`. Возвращённая функция NE1-safe и детерминирована.

Бросает: `LM031` — `n` не положительное конечное целое; `LM032` — `position` не `'start'` и не `'end'`.

### Type-only экспорты

`StepPosition` — `'start' | 'end'`, позиция ступени для `steps`.

## Контракты

- **SSR-safe / zero-DOM.** Модуль не трогает DOM, `window`, часы и глобальное состояние — безопасен на сервере и в воркерах.
- **Финитность (NE1).** Любая кривая субпутя возвращает конечное число для любого IEEE-754 входа; для собственных кривых ту же гарантию даёт `normalizeEasing`.
- **Точность эндпоинтов (NE2).** Непрерывные кривые: `f(0) === 0`, `f(1) === 1` бит-точно; overshoot/осцилляция — только на интерьере.
- **Детерминизм (NE4).** Чистые функции: идентичный вход → бит-идентичный выход; ноль зависимостей, без wall-clock.
- **Ранние ошибки (NE7).** Фабрики бросают `MotionParamError` с полем `code` (`LM028`–`LM032`) в момент конструирования; возвращённые функции сами не бросают. Полный каталог с лечением — [docs/errors.md](../errors.md).
- **Reduced-motion.** Слой — чистая математика и `prefers-reduced-motion` не читает; уважение reduced-motion — контракт исполнителей (`drive` и выше).

## Примеры

Фиксированная кривая в собственном rAF-цикле (шкала времени — забота вызывающего):

```ts
import { easeInOut } from '@labpics/motion/easing';

const el = document.querySelector('.card') as HTMLElement;
const durationMs = 400; // миллисекунды — только в вашем цикле, не в кривой
const start = performance.now();

function frame(now: number): void {
  const t = Math.min((now - start) / durationMs, 1); // нормализованный прогресс
  el.style.transform = `translateX(${easeInOut(t) * 240}px)`;
  if (t < 1) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

Фабрики: CSS-совместимый Безье и ступени, ранняя ошибка по коду:

```ts
import { MotionParamError } from '@labpics/motion';
import { cubicBezier, steps } from '@labpics/motion/easing';

const standard = cubicBezier(0.4, 0, 0.2, 1); // как CSS cubic-bezier(.4,0,.2,1)
const sprite = steps(8, 'end');               // 8 дискретных кадров

console.log(standard(0.5), sprite(0.5)); // конечные числа, детерминированно

try {
  cubicBezier(1.5, 0, 0.2, 1); // x1 вне [0,1]
} catch (e) {
  if (e instanceof MotionParamError && e.code === 'LM030') {
    // временны́е координаты x1/x2 обязаны лежать в [0,1]
  }
}
```

NE1-обёртка для пользовательской кривой:

```ts
import { normalizeEasing } from '@labpics/motion/easing';

// Кривая с дефектом: при t = 1 возвращает Infinity, при NaN на входе — NaN.
const risky = (t: number): number => 1 / (1 - t) - 1;
const safe = normalizeEasing(risky);

safe(1);   // конечное число: +Infinity кламплен до Number.MAX_VALUE
safe(NaN); // 0: NaN-выход кламплен по clampFinite-семантике
safe(0.5); // 1 — благополучные значения проходят без изменений
```
