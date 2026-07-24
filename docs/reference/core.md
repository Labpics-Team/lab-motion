# Ядро `.` — MotionValue, drive и корневой экспорт

> Роль: справка — полный API корневого экспорта `@labpics/motion`: чистые солверы `spring`/`tween`, валидаторы границ, драйвер `drive`, headless-значение `MotionValue`, ошибка `MotionParamError`.

## Назначение

Корневой субпуть `.` — ядро движка: чистая математика движения без DOM, окна и
глобальных часов. Слои внутри ядра:

- **L1 (чистые функции)** — `spring` (аналитическое замкнутое решение пружины),
  `tween` (линейная интерполяция), валидаторы `validateSpringPhysics` /
  `validateSpringParams`.
- **L3 (исполнители)** — `drive` (одноразовый декларативный прогон from→to) и
  `MotionValue` (ретаргетируемое реактивное значение с C¹-подхватом скорости).
- **Граница домена** — `MotionParamError` с машинным кодом `code` (каталог —
  [docs/errors.md](../errors.md)).

Runtime-поверхность корня запинена контрактным тестом
(`test/api-surface-pin.test.ts`, инвариант 6) и состоит ровно из семи имён:
`spring`, `tween`, `drive`, `MotionValue`, `MotionParamError`,
`validateSpringParams`, `validateSpringPhysics`. Веса артефактов — только из
воспроизводимых прогонов: см. [docs/benchmark.md](../benchmark.md) и `pnpm size`.

## Импорт

ESM и CJS (ветка `"."` в `exports` package.json):

```typescript
import {
  spring,
  tween,
  drive,
  MotionValue,
  MotionParamError,
  validateSpringParams,
  validateSpringPhysics,
  type SpringParams,
  type SpringResult,
  type DriveOptions,
  type MotionValueOptions,
  type RequestFrameFn,
  type MotionParamErrorCode,
} from '@labpics/motion';
```

## API

### `spring(params, t)`

```ts
function spring(params: SpringParams, t: number): SpringResult;

interface SpringParams {
  readonly mass: number;      // кг, конечное > 0
  readonly stiffness: number; // Н/м, конечное > 0
  readonly damping: number;   // Н·с/м, конечное ≥ 0; 0 = незатухающая
}

interface SpringResult {
  readonly value: number;    // нормализованная позиция [0..~1]; underdamped может слегка перелетать 1
  readonly velocity: number; // скорость в единицах позиции в секунду
}
```

Чистая выборка пружины «из покоя к цели» (нормализовано: from=0, to=1;
масштабирование в свои единицы — на стороне вызывающего). Замкнутая
аналитическая форма для всех трёх режимов (underdamped / critical / overdamped).

- `t` — время в **секундах**, ≥ 0 (типичный кадровый шаг ≈ 0.016 с при 60 fps).
- Граница — **только физическая** (`validateSpringPhysics`): чистому сэмплеру
  не нужен frame-loop, поэтому вычислимы сколь угодно медленные и незатухающие
  (ζ=0) системы.
- Выход всегда конечен: defensive-страж отсекает NaN/±Infinity плавающей точки
  (NaN трактуется как покой в старте, 0).

Бросает: `LM088` (mass), `LM089` (stiffness), `LM090` (damping) — синхронно.

### `tween(from, to, t)`

```ts
function tween(from: number, to: number, t: number): number;
```

Линейная интерполяция при нормализованном `t ∈ [0, 1]` (безразмерный прогресс,
не время). Гарантии:

- `t ≤ 0` → ровно `from`; `t ≥ 1` → ровно `to` (точно, без дрейфа плавающей точки).
- Численно стабильная форма `from + (to - from) * t`; при переполнении разности
  (`|from|+|to| > Number.MAX_VALUE`) — fallback на двухточечную форму
  `from*(1-t) + to*t`, конечную для всех `t ∈ (0,1)`.
- Выход конечен при конечных входах. Ничего не бросает.

### `validateSpringPhysics(p)`

```ts
function validateSpringPhysics(p: SpringParams): void;
```

Физическая граница домена: конечные `mass > 0`, `stiffness > 0`, `damping ≥ 0` —
и ничего больше. Возврат `void`; невалидный вход — `MotionParamError`:
`LM088` / `LM089` / `LM090`. Это граница чистого `spring()`.

### `validateSpringParams(p)`

```ts
function validateSpringParams(p: SpringParams): void;
```

Граница **автономного frame-loop-исполнителя** (`drive`, `MotionValue`,
фасады): `validateSpringPhysics` плюс единый выведенный критерий — аналитическая
верхняя граница времени оседания пружины из покоя обязана помещаться в бюджет
кадра-капа `MAX_FRAMES · FIXED_DT_S` (2000 кадров × 1/60 с ≈ 33.3 с). Иначе
rAF-цикл исполнителя не завершился бы в своём lifecycle.

Бросает: `LM088` / `LM089` / `LM090` (физика), `LM091` (время оседания
превышает бюджет). Вызывается исполнителями на их стороне — до Promise и до
первого кадра; для чистой выборки `spring()` вызывать её не нужно.

### `drive(opts)`

```ts
function drive(opts: DriveOptions): Promise<void>;

interface DriveOptions {
  readonly from: number;                     // старт (единицы потребителя); конечное
  readonly to: number;                       // цель; конечное
  readonly spring: SpringParams;
  readonly onStep: (value: number) => void;  // каждый шаг; при reduce — не более одного вызова (с to)
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  readonly clamp?: boolean | undefined;           // default true
  readonly initialVelocity?: number | undefined;  // default 0; единицы value/с
}
```

Одноразовый прогон `from → to` на пружине (ретаргет не поддерживается — для
ретаргета есть `MotionValue`). Возвращает `Promise<void>`, разрешающийся по
достижении `to`; Promise **никогда не отклоняется** — все ошибки бросаются
синхронно, до его создания и до планирования кадров.

Параметры:

- `from`, `to` — конечные числа; последний `onStep` — ровно `to`.
  `from === to` → синхронный resolve без вызова `onStep`.
- `matchMedia` — инжектируемый seam reduced-motion. В браузере передайте
  `window.matchMedia.bind(window)`; `undefined` (SSR/Node) трактуется как
  «нет предпочтения» — драйвер продолжает без throw. Бросивший `matchMedia`
  также трактуется как «нет предпочтения».
- `requestFrame` — инжектируемая замена `requestAnimationFrame`: получает
  колбэк, возвращает handle. По умолчанию — глобальный `requestAnimationFrame`,
  а при его отсутствии (Node) — `setTimeout`-шим с шагом `1/60 · 1000` мс.
  Колбэк может получить timestamp (`DOMHighResTimeStamp`, **миллисекунды**) —
  тогда время ведётся по нему; без timestamp шаг фиксированный, `1/60` с.
  Handle `0` — конвенция non-draining step-clock в тестах: ставится
  `setTimeout(0)`-fallback, чтобы Promise не деадлочился.
- `clamp` — default `true`: CSS-safe клэмп в `[from, to]` + монотонизация к `to`
  (overshoot underdamped-пружины поглощается; нужно физически ограниченным
  свойствам вроде opacity). `false` — «честная пружина»: overshoot/bounce
  эмитится по аналитической траектории; финальный эмит всё равно ровно `to`.
- `initialVelocity` — начальная скорость v0 в единицах value/с (C¹-хендофф от
  жеста/decay/прерванного полёта). Default 0 — рождение из покоя.

Поведение: reduced-motion проверяется **однажды, на входе** — при
предпочтении reduce цикл солвера не стартует вовсе: один `onStep(to)` и
синхронный resolve, `requestFrame` не вызывается. Тот же короткий путь — при
непредставимом диапазоне (`|from|+|to|` переполняет `Number.MAX_VALUE`).
Сходимость — относительный порог 0.5% от диапазона (позиция и скорость),
страховочный потолок — 2000 кадров.

Бросает (синхронно, до Promise): `LM023` (неконечный `from`), `LM024`
(неконечный `to`), `LM025` (неконечный `initialVelocity`), плюс
`LM088`–`LM091` от `validateSpringParams`.

### `MotionValue`

```ts
class MotionValue {
  constructor(opts: MotionValueOptions);
  get value(): number;                              // текущее значение; всегда конечно
  get velocity(): number;                           // текущая скорость, единицы value/с; в покое ровно 0
  onChange(cb: (value: number) => void): () => void; // подписка; возврат — отписка
  setTarget(target: number): void;                  // анимировать к цели (smooth pickup)
  snapTo(target: number): void;                     // мгновенно, минуя физику
  stop(): void;                                     // остановить цикл, слушатели сохранены
  destroy(): void;                                  // остановить и очистить слушателей
}

interface MotionValueOptions {
  readonly initial: number;                       // конечное начальное значение
  readonly spring: SpringParams;
  readonly requestFrame?: RequestFrameFn | undefined; // default: глобальный rAF | setTimeout-шим (Node)
  readonly clamp?: boolean | undefined;               // default true
  readonly initialVelocity?: number | undefined;      // default 0; единицы value/с
}

type RequestFrameFn = (cb: (ts?: number) => void) => number;
```

Headless-реактивное число: держит значение и анимирует его к цели пружиной.
Ключевое отличие от `drive` — **ретаргет**: `setTarget()` в полёте наследует
текущую скорость как начальное условие нового прогона (замкнутая форма с
произвольным v0), поэтому первая производная непрерывна — без рывка.

- `constructor` — валидирует `initial` и `initialVelocity` (`LM045` при
  NaN/±Infinity) и `spring` (`LM088`–`LM091`) синхронно, до единого кадра.
  `initialVelocity` нужен C¹-хендоффу (compositor→live, жест, decay): первый
  `setTarget()` подхватит эту скорость штатным smooth pickup.
- `value` — всегда конечно. `velocity` — аналитическая скорость траектории
  солвера (не производная клэмпнутого выхода): именно её должен наследовать
  приёмник хендоффа; в покое — ровно 0.
- `onChange(cb)` — регистрирует слушателя и **немедленно** доставляет ему
  текущее значение; возвращает функцию отписки. Если `cb` бросил на первичной
  доставке — регистрация откатывается и ошибка пробрасывается. Слушатель,
  бросивший во время прогона, удаляется из подписок (соседям кадр доставляется),
  первая ошибка пробрасывается наружу; сам ран остаётся живым.
- `setTarget(target)` — `target` конечный (`LM045`). Уже в покое ровно на
  `target` → no-op без эмита. No-op после `destroy()`.
- `snapTo(target)` — мгновенная установка, минуя пружину: прерывает живой ран,
  ресинхронизирует состояние, скорость = 0, эмитит `target`. Идемпотентность:
  `snapTo` в покое ровно на `target` — no-op **без** эмита (нельзя опираться на
  него как на форсированный re-render). `LM045` при неконечном `target`; no-op
  после `destroy()`. Именно `snapTo` подпирает reduced-motion-переключение
  ХАРАКТЕРА движения во фреймворк-биндингах: значение достигает цели, просто
  без пружинных кадров.
- `stop()` — останавливает кадровый цикл, не разрушая инстанс: слушатели
  сохранены, следующий `setTarget()` возобновляет анимацию (сценарий
  disconnect/reconnect хоста).
- `destroy()` — остановка + очистка слушателей; по контракту no-op после
  `destroy()` — только `setTarget()` и `snapTo()` (они проверяют флаг
  разрушения). `onChange()` такой проверки **не** делает: и после `destroy()`
  он регистрирует callback, немедленно синхронно доставляет ему текущее
  значение и возвращает рабочую функцию отписки — т.е. наблюдаемо не no-op.

Кадровый контур — тот же, что у `drive`: инжектируемый `requestFrame`,
timestamp в миллисекундах или фиксированный шаг `1/60` с, handle `0` →
`setTimeout(0)`-fallback, относительный порог сходимости 0.5% от диапазона,
потолок 2000 кадров (страхует только застывший host-clock; при живом времени
большой переносимый v0 вправе оседать дольше rest-бюджета).

### `MotionParamError`

```ts
class MotionParamError extends Error {
  override readonly name: 'MotionParamError';
  readonly code: MotionParamErrorCode; // стабильный машинный код `LM<цифра><цифра><цифра>`
  constructor(messageOrCode: string);
}
```

Единственный тип ошибки, который ловят потребители, чтобы отличить невалидный
вход от бага. Ошибки движка несут в `message` только код; ветвление стройте по
`e.code`. Совместимый строковый конструктор: строка, не являющаяся кодом
каталога, даёт `code === 'LM000'`. Причины и исправления всех кодов —
[docs/errors.md](../errors.md).

### Type-only экспорты

`MotionParamErrorCode`, `SpringParams`, `SpringResult`, `DriveOptions`,
`RequestFrameFn`, `MotionValueOptions` — стираются при компиляции, runtime-цены
не имеют.

## Контракты

- **SSR-safe.** Ядро не читает DOM/window/document: `matchMedia` и
  `requestFrame` — инжектируемые seam-ы. `drive` с `matchMedia: undefined`
  работает без throw (reduce=false); дефолтный `requestFrame` делает поздний
  lookup глобального rAF и в Node падает на `setTimeout`-шим. `spring`/`tween`
  чисты — пригодны в любом рантайме.
- **Reduced-motion.** `drive` проверяет предпочтение однажды, на границе входа;
  при reduce солвер-цикл не входится никогда: один `onStep(to)`, синхронный
  resolve. `MotionValue` сам media-query не читает — reduced-motion-политика
  биндингов реализуется через `snapTo` (характер меняется, движение не
  выключается грубо).
- **Финитность (CSS-safe, инвариант 2).** NaN/±Infinity не эмитятся никогда:
  все числовые входы валидируются fail-fast (LM-коды выше) до Promise и кадров;
  неконечное промежуточное значение внутри цикла даёт снап в (конечный)
  `to`/`target`; `spring` клэмпит выход в конечное.
- **Детерминизм (инвариант 3).** `spring`/`tween` — чистые функции: одинаковые
  входы → бит-в-бит одинаковый выход. `drive`/`MotionValue` не читают глобальных
  часов — время приходит только через инжектированный `requestFrame`.
- **Единицы.** Время `spring` — секунды; `t` у `tween` — безразмерный прогресс
  [0,1]; скорости (`velocity`, `initialVelocity`) — единицы значения в секунду;
  timestamp колбэка `requestFrame` — миллисекунды (`DOMHighResTimeStamp`).
- **Одноразовость `drive` / ретаргетируемость `MotionValue`.** `drive` не
  ретаргетится (один прогон — один Promise); `MotionValue.setTarget` в полёте
  даёт C¹-непрерывный подхват скорости.

## Примеры

### MotionValue: пружина к значению с ретаргетом

```typescript
import { MotionValue } from '@labpics/motion';

const card = document.querySelector('.card') as HTMLElement;

const x = new MotionValue({
  initial: 0,
  spring: { mass: 1, stiffness: 200, damping: 20 },
  requestFrame: requestAnimationFrame.bind(window),
});

const unsubscribe = x.onChange((v) => {
  card.style.transform = `translateX(${v}px)`; // v всегда конечен
});

x.setTarget(240); // плавно едем к 240
x.setTarget(80);  // ретаргет в полёте: скорость подхвачена, рывка нет

// teardown
unsubscribe();
x.destroy();
```

### drive: одноразовый прогон с reduced-motion и типизированной ошибкой

```typescript
import { drive, MotionParamError } from '@labpics/motion';

const panel = document.querySelector('.panel') as HTMLElement;

try {
  await drive({
    from: 0,
    to: 1,
    spring: { mass: 1, stiffness: 200, damping: 24 },
    matchMedia: window.matchMedia.bind(window),        // при reduce: один onStep(1), sync resolve
    requestFrame: requestAnimationFrame.bind(window),
    onStep: (v) => { panel.style.opacity = String(v); },
  });
  // Promise разрешён: последний onStep был ровно 1
} catch (e) {
  if (e instanceof MotionParamError) {
    console.error(e.code); // напр. 'LM091' — пружина не оседает в бюджет; см. docs/errors.md
  } else {
    throw e;
  }
}
```

### Чистая выборка: spring + tween без DOM и часов (SSR/тесты)

```typescript
import { spring, tween, type SpringParams } from '@labpics/motion';

const params: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

// Детерминированная функция времени: одинаковый t → одинаковое число.
function xAt(tSeconds: number): number {
  const { value } = spring(params, tSeconds); // value — нормализованный прогресс 0→1
  return tween(0, 240, value);                // масштаб в единицы потребителя (px)
}

console.log(xAt(0), xAt(0.1), xAt(1));
```
