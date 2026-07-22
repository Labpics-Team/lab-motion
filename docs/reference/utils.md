# ./utils — скалярные примитивы

> Роль: справка — публичный API экспорт-субпутя `./utils`: чистые числовые примитивы `clamp`/`mix`/`wrap`/`snap`/`mapRange`/`interpolate`/`pipe`.

## Назначение

Субпуть `./utils` — L1-домен чистой числовой математики отображения значений: те примитивы, что лежат в ядре Framer Motion и GSAP — скалярный ремап (`mapRange`, аналог Framer `transform` для одного сегмента), N-стоповый кусочный маппер (`interpolate`), ограничение диапазона (`clamp`), циклическая обёртка (`wrap`), привязка к сетке/набору (`snap`), тотальный lerp (`mix`) и композиция слева направо (`pipe`). Без DOM, без часов, без `window` и глобального состояния.

Все аргументы и результаты — безразмерные числа; миллисекунды этот модуль не знает — шкалы времени и координат остаются заботой вызывающего.

Инварианты модуля (закреплены в JSDoc и тестах):

- **U1. CSS-safe финитность.** Каждый ЧИСЛОВОЙ выход всегда конечен (никогда `NaN`/`±Infinity`) для **любого** IEEE-754 значения на входе — вне диапазона, `NaN`, `±Infinity`, `-0`, субнормальные. Страж — приватный `clampFinite`, зеркалящий `spring.ts`: `NaN → 0`, `+Infinity → Number.MAX_VALUE`, `-Infinity → -Number.MAX_VALUE`. Единственное исключение — `pipe`: структурный комбинатор без собственного клампа (финитность — контракт каждой стадии; конвейер из этих примитивов конечен по транзитивности).
- **U2. Ранняя валидация конфига.** Невалидный КОНФИГ (границы, шаг, остановки) бросает `MotionParamError` синхронно на границе. Хвостовой аргумент-ЗНАЧЕНИЕ никогда не бросает — он укрепляется `clampFinite`.
- **U3. Детерминизм и чистота.** Идентичные входы → бит-идентичные выходы; ноль runtime-зависимостей (импортируется только `MotionParamError`), без `Math.random`, `Date.now`, часов и DOM. Массивы конфига снапшотятся на фабрике — возвращённый маппер иммунен к последующей мутации массивов вызывающим.
- **U4. Бит-точные эндпоинты.** `mix`/`mapRange`/`interpolate` разрешают точные эндпоинты без float-дрейфа (короткие замыкания, а не `a + (b − a)·1`).
- **U5. Изоляция для tree-shake.** Приватные помощники инлайнены (без кросс-субпутевых импортов); `mapRange` не проходит через сегментный движок `interpolate`; дефолтный миксер `interpolate` — приватный `lerp`, не публичный `mix` — импорт одного символа остаётся горсткой байт.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  clamp,
  mix,
  wrap,
  snap,
  mapRange,
  interpolate,
  pipe,
  type EasingFunction,
  type Mixer,
  type InterpolateOptions,
} from '@labpics/motion/utils';
```

`MotionParamError` (класс брошенных ошибок с полем `code`) экспортируется корневым субпутём `@labpics/motion`.

## API

Конвенция curried config-first (`clamp`, `wrap`, `snap`, `mapRange`): вызов без хвостового `value` возвращает переиспользуемый маппер `(value: number) => number`; вызов с `value` вычисляет сразу. Валидация конфига в обоих вариантах происходит эагерно, в момент вызова фабрики.

### clamp

```ts
function clamp(min: number, max: number): (value: number) => number;
function clamp(min: number, max: number, value: number): number;
```

Ограничивает `value` диапазоном `[min, max]` = `min(max, max(min, value))` (паритет Framer/GSAP).

- `min`, `max` — границы (безразмерные). Единственное исключение из правила конечного конфига: границы `±Infinity` РАЗРЕШЕНЫ (идиома одностороннего клампа `clamp(0, Infinity, v)`); бросает только `NaN`.
- `min > max` детерминированно даёт `max` (`Math.min` побеждает) — как у Framer.
- `value` проходит `clampFinite` до И после `min`/`max`, поэтому даже бесконечные границы держат выход конечным.

Бросает: `LM111` — `min` или `max` равно `NaN`.

### mix

```ts
function mix(from: number, to: number, progress: number): number;
```

Неклампящая линейная интерполяция `from + (to − from) · progress`. `progress` НЕ ограничен `[0, 1]` — экстраполяция является фичей. Эндпоинты бит-точны через короткое замыкание (`progress === 0` → `from`, `progress === 1` → `to`). Все три аргумента проходят `clampFinite`: `NaN`-прогресс → `0` → возвращается `from`; `±Infinity`-прогресс → `±Number.MAX_VALUE` → экстраполяция с последующим клампом; вырожденный `mix(5, 5, Infinity)` → `5`.

`mix` — каноническая форма `Mixer<number>`: передаётся в `interpolate` как `{ mixer: mix }`. Не бросает. Не каррирован (прямая 3-аргументная форма — та же, что у миксеров `./value`).

### wrap

```ts
function wrap(min: number, max: number): (value: number) => number;
function wrap(min: number, max: number, value: number): number;
```

Циклически заворачивает `value` в полуоткрытый диапазон `[min, max)` через двойное модуло, исправляющее JS `%` (знак делимого) до математического положительного модуло — отрицательные и огромные значения заворачиваются корректно. Эндпоинт `max` складывается в `min` (полуоткрытость). Вырожденный диапазон (`min === max`) коротко замыкается в `min` (обходит `% 0` → `NaN`). Канонический случай предполагает `min < max`.

Бросает: `LM110` — `min` или `max` не конечно (`NaN` или `±Infinity`): для модуло требуется конечный диапазон.

### snap

```ts
function snap(target: number | readonly number[]): (value: number) => number;
function snap(target: number | readonly number[], value: number): number;
```

Привязывает `value` к сетке или к набору. Два режима, диспетчеризация по `Array.isArray`:

- **INCREMENT** (`target: number`): `round(value / increment) · increment`. `Math.round` округляет половину к `+Infinity` (`round(2.5) = 3`, `round(-2.5) = -2`) — паритет GSAP. Отрицательные шаги легальны (та же решётка, что у `|increment|`).
- **TARGETS** (`target: readonly number[]`): ближайший элемент массива по `|value − target|`; ничьи разрешаются в пользу первой (наименьший индекс) цели. Массив снапшотится на фабрике — маппер иммунен к последующей мутации (U3).

Аргумент-значение проходит `clampFinite` и никогда не бросает.

Бросает: `LM110` — шаг не конечен или элемент целей не конечен; `LM112` — пустой массив целей; `LM113` — нулевой шаг.

### mapRange

```ts
function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): (value: number) => number;
function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  value: number,
): number;
```

Ремапит `value` из `[inMin, inMax]` на `[outMin, outMax]`, БЕЗ клампа (за пределами входного диапазона экстраполирует — клампить это работа `interpolate` или композиции с `clamp`). Аналог GSAP `mapRange`. Эндпоинты бит-точны; вырожденный входной диапазон (`inMin === inMax`) даёт `outMin` (обходит `/ 0`). STANDALONE — не проходит через сегментный движок `interpolate`, поэтому импорт одного `mapRange` tree-shake'ится до нескольких байт (U5).

Бросает: `LM110` — любая из четырёх границ не конечна.

### interpolate

```ts
interface InterpolateOptions<T> {
  readonly clamp?: boolean;                                  // дефолт true
  readonly ease?: EasingFunction | readonly EasingFunction[]; // дефолт identity
  readonly mixer?: Mixer<T>;                                 // дефолт приватный числовой lerp
}

function interpolate(
  input: readonly number[],
  output: readonly number[],
  options?: InterpolateOptions<number>,
): (v: number) => number;
function interpolate<T>(
  input: readonly number[],
  output: readonly T[],
  options: InterpolateOptions<T> & { mixer: Mixer<T> },
): (v: number) => T;
```

Фабрика маппера `(v) => value` из N брейкпоинтов (Framer `transform` / GSAP array-interp). `input` обязан строго возрастать при `input.length === output.length >= 2`. Запрос `v`:

1. `v` проходит `clampFinite` → `x`.
2. При `clamp` (дефолт `true`) и `x` на/за краем возвращается выход эндпоинта напрямую, без вызова ease/mixer (числовые эндпоинты проходят `clampFinite` для U1; нечисловые `T` — дословно).
3. Находится содержащий сегмент `k`; локальный прогресс `p = (x − input[k]) / (input[k+1] − input[k])` (при `clamp: false` `p` может быть `< 0` или `> 1` — экстраполяция). Длинные шкалы ищутся бинарным поиском за O(log N), короткие — линейным циклом.
4. `p` изингуется (`ease` — одна функция на все сегменты или массив длины `input.length − 1`, сегмент `k` изингуется `ease[k]`), затем значение производится `mixer(output[k], output[k+1], easedP)`.
5. Числовые выходы проходят `clampFinite` (U1); выход кастомного миксера — его собственный контракт финитности (например, `mixColor` из `./value` CSS-safe).

Интерьерные брейкпоинты разрешаются как `p = 0` правого сегмента → бит-точный `output[k]`, когда `ease(0) === 0` и `mixer(a, b, 0) === a` (выполняется для домашних изингов и дефолта). Эквивалент Framer `transform(input, output, opts)`, когда ease/mixer ЯКОРИТ эндпоинты (`ease(0)=0`, `ease(1)=1`, `mixer(a,b,0)=a`, `mixer(a,b,1)=b`); неякорящий кастомный ease/mixer расходится только на двух клампированных ВНЕШНИХ эндпоинтах, которые коротко замыкаются без его применения (цена бит-точности U4) — интерьерные брейкпоинты применяют его по-прежнему.

`input`/`output` снапшотятся на фабрике — возвращённый маппер чист относительно последующей мутации массивов вызывающим (U3). Миксер — единственный шов для нечислового выхода (цвета, строки).

Бросает (эагерно, на фабрике): `LM114` — длины `input`/`output` различаются; `LM115` — меньше двух остановок; `LM110` — неконечный элемент `input` или (только числовой путь, без миксера) неконечный элемент `output`; `LM116` — `input` не строго возрастает; `LM117` — длина массива `ease` не равна числу сегментов; `LM118` — элемент `ease` не функция. Возвращённый маппер никогда не бросает.

### pipe

```ts
function pipe<A, B>(f1: (a: A) => B): (a: A) => B;
function pipe<A, B, C>(f1: (a: A) => B, f2: (b: B) => C): (a: A) => C;
function pipe<A, B, C, D>(f1: (a: A) => B, f2: (b: B) => C, f3: (c: C) => D): (a: A) => D;
function pipe<T>(...fns: Array<(value: T) => T>): (value: T) => T;
```

Композиция слева направо: `pipe(f, g, h)(v) === h(g(f(v)))`. `pipe()` — тождественная функция. Гетерогенные перегрузки (арность 1–3) дают точный кросс-типовый вывод; гомогенный `<T>(...fns)` покрывает остальное. Структурный комбинатор — НЕ применяет `clampFinite` (финитность — контракт каждой стадии; см. U1-исключение). Не бросает.

### Type-only экспорты

- `EasingFunction` — `(t: number) => number`, форма кривой субпутя `./easing`.
- `Mixer<T>` — `(from: T, to: T, t: number) => T`; 3-аргументная ПРЯМАЯ форма, так что `mixColor(from, to, t)` из `./value` подставляется как `{ mixer: mixColor }` без адаптера; сам `mix` — валидный `Mixer<number>`.
- `InterpolateOptions<T>` — опции `interpolate`: `clamp?`, `ease?`, `mixer?` (см. выше).

## Контракты

- **SSR-safe / zero-DOM.** Модуль не трогает DOM, `window`, часы и глобальное состояние — безопасен на сервере и в воркерах.
- **Финитность (U1).** Каждый числовой выход конечен для любого IEEE-754 входа; схема клампа: `NaN → 0`, `+Infinity → Number.MAX_VALUE`, `-Infinity → -Number.MAX_VALUE`. Исключение — `pipe` (финитность по транзитивности стадий).
- **Ранние ошибки (U2).** Конфиг бросает `MotionParamError` с полем `code` (`LM110`–`LM118`) синхронно на границе; аргумент-значение и возвращённые мапперы не бросают никогда. Полный каталог с лечением — [docs/errors.md](../errors.md).
- **Детерминизм (U3).** Чистые функции: идентичный вход → бит-идентичный выход; массивы конфига снапшотятся; без wall-clock и `Math.random`.
- **Бит-точные эндпоинты (U4).** `mix`/`mapRange`/`interpolate` возвращают точные значения границ через короткие замыкания, а не арифметику.
- **Единицы.** Всё безразмерно; миллисекунды и пиксели существуют только на стороне вызывающего.
- **Reduced-motion.** Слой — чистая математика и `prefers-reduced-motion` не читает; уважение reduced-motion — контракт исполнителей (`drive` и выше).

## Примеры

Каррированные примитивы и `pipe`: скролл → трансформ через ремап, кламп и сетку:

```typescript
import { clamp, mapRange, pipe, snap } from '@labpics/motion/utils';

// scrollY 0..600 → translateX 0..240, экстраполяция обрезана, привязка к 8-сетке
const progressToX = pipe(
  mapRange(0, 600, 0, 240), // unclamped-ремап
  clamp(0, 240),            // обрезать экстраполяцию
  snap(8),                  // решётка с шагом 8
);

const el = document.querySelector('.card') as HTMLElement;
window.addEventListener('scroll', () => {
  el.style.transform = `translateX(${progressToX(window.scrollY)}px)`;
});
```

`interpolate`: N остановок, изинг на сегмент, ранняя ошибка по коду:

```typescript
import { MotionParamError } from '@labpics/motion';
import { easeInOut, easeOut } from '@labpics/motion/easing';
import { interpolate } from '@labpics/motion/utils';

// 0 → 1 → 0 по прогрессу [0, 0.5, 1]; свой изинг на каждый из двух сегментов
const opacity = interpolate([0, 0.5, 1], [0, 1, 0], { ease: [easeInOut, easeOut] });

opacity(0.5);  // 1 — интерьерный брейкпоинт бит-точен
opacity(-2);   // 0 — clamp: true (дефолт) держит края

try {
  interpolate([0, 1], [0]); // длины входа и выхода различаются
} catch (e) {
  if (e instanceof MotionParamError && e.code === 'LM114') {
    // выровнять длины input/output
  }
}
```

Нечисловой выход через шов `mixer`: цветовая шкала на `mixColor` из `./value`:

```typescript
import { interpolate } from '@labpics/motion/utils';
import { mixColor } from '@labpics/motion/value';

// mixColor(from, to, t) — валидный Mixer<string>: адаптер не нужен
const heat = interpolate([0, 50, 100], ['#2563eb', '#f59e0b', '#dc2626'], {
  mixer: mixColor,
});

const gauge = document.querySelector('.gauge') as HTMLElement;
gauge.style.backgroundColor = heat(72); // строка цвета между жёлтым и красным
```
