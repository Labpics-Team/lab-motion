# ./scroll и ./in-view — скролл-привязка и появление во вьюпорте

> Роль: справка — публичный API экспорт-субпутей `./scroll` (headless-математика scroll-linked прогресса, скорости и in-view на структурных входах) и `./in-view` (нативный DOM-adapter появления во вьюпорте поверх IntersectionObserver).

## Назначение

Два субпутя закрывают одну задачу с двух сторон:

- **`./scroll`** — ЧИСТАЯ математика (архитектура как у `./gestures`): scroll-linked прогресс страницы/контейнера и target-с-офсетами в семантике Motion, in-view машина класса IntersectionObserver, оценка скорости скролла и scrub-клей к scrubbable-объектам (`timeline.seek`/`totalDuration`). DOM-метрики (`scrollTop`/`scrollHeight`/`clientHeight`/`getBoundingClientRect`) снимает и передаёт ПОТРЕБИТЕЛЬ; ось (x/y) выбирается тем, какие метрики переданы. Пиннинг — CSS `position: sticky`, движку код не нужен; hw-accel ScrollTimeline — отдельный WAAPI-скоуп, не здесь.
- **`./in-view`** — imperative shell: геометрию и планирование делает браузерный `IntersectionObserver`, модуль лишь владеет одним observer от вызова `inView()` до `stop()`. Ничего не читает из DOM при импорте (путь импорта SSR-safe); сам вызов требует browser host.

Инварианты `./scroll` (закреплены в JSDoc и коде):

- **SC1. CSS-safe.** Любой выход конечен; прогресс всегда ∈ [0, 1].
- **SC2. Zero-DOM/SSR-safe.** Ни `window`, ни `document` — нигде.
- **SC3. Детерминизм.** Время только из входных точек `{t}` — ни wall-clock, ни `Math.random`.
- **SC4. Zero runtime deps.**

Единицы субпутя `./scroll`: длины и позиции — **пиксели**, время сэмплов `t` и окно `windowSec` — **секунды** (например `e.timeStamp / 1000`), скорость — **px/s**.

Внимание на коллизию имён: оба субпутя экспортируют типы `InViewAmount` и `InViewOptions`, но это РАЗНЫЕ типы. В `./scroll` опции структурные (числовой `margin` в px, колбэки `onEnter`/`onLeave`), в `./in-view` — нативные (`root`, строковый `rootMargin`). При совместном импорте используйте `import type { ... as ... }`.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Оба субпутя tree-shakeable — в корневой бандл не входят.

## Импорт

```ts
import {
  scrollProgress,
  resolveTargetProgress,
  createScrollVelocity,
  createInView,
  createScrollObserver,
  scrubBinding,
  type ScrollMetrics,
  type ScrollOffsetPair,
  type ScrollObserverOptions,
} from '@labpics/motion/scroll';

import {
  inView,
  MotionParamError,
  type InViewTarget,
  type InViewOptions,
  type InViewStop,
} from '@labpics/motion/in-view';
```

## API — `./scroll`

### scrollProgress

```ts
function scrollProgress(pos: number, contentLength: number, viewportLength: number): number;
```

Прогресс скролла [0, 1] по позиции и длинам: `pos / (contentLength − viewportLength)` с клампом. Все аргументы — px. Нескроллируемый контент (`contentLength <= viewportLength`), вырожденный или невалидный диапазон → `0` (паритет Motion: «нечего скроллить» = путь не начат). `NaN` в любом входе гасится стражем конечности (SC1). Бросает: ничего.

### resolveTargetProgress

```ts
type ScrollEdgeAnchor = 'start' | 'center' | 'end' | number | `${number}px`;

interface ScrollOffsetPair {
  target: ScrollEdgeAnchor;
  viewport: ScrollEdgeAnchor;
}

interface ScrollMetrics {
  pos: number;            // текущая позиция скролла, px
  contentLength: number;  // полная длина контента, px
  viewportLength: number; // длина вьюпорта скроллера, px
}

function resolveTargetProgress(
  metrics: ScrollMetrics,
  target: { start: number; size: number },
  offsets: readonly [ScrollOffsetPair, ScrollOffsetPair],
): number;
```

Прогресс [0, 1] прохождения target через viewport между двумя офсет-парами (семантика Motion: `['start end', 'end start']` = «от входа снизу до выхода сверху»). `target.start` — в **координатах контента** (абсолютный px), `target.size` — размер по оси.

Разрешение анкера в px от начала измеряемого отрезка длиной `len`: `'start'` → `0`; `'center'` → `len / 2`; `'end'` → `len`; число — доля, клампится в [0, 1] и умножается на `len`; `'<n>px'` — `parseFloat`, буквальные пиксели (могут быть отрицательными). Каждая пара задаёт позицию скролла, при которой анкер target совпадает с анкером viewport: `pos = target.start + anchorTarget − anchorViewport`. Прогресс — нормализация `metrics.pos` между этими двумя позициями. Вырожденный или перевёрнутый диапазон → ступенька `0/1` без `NaN` (`pos > p0` → `1`, иначе `0`). Бросает: ничего.

### createScrollVelocity

```ts
interface ScrollSample {
  pos: number; // px
  t: number;   // секунды
}

interface ScrollVelocityTracker {
  push(s: ScrollSample): void;
  velocity(): number; // px/s
  reset(): void;
}

function createScrollVelocity(windowSec?: number): ScrollVelocityTracker;
```

1D-оценщик скорости скролла по скользящему окну. `windowSec` — окно в **секундах**, дефолт `0.1`; неконечное или `<= 0` значение заменяется дефолтом. `velocity()` = `(последний − первый в окне) / Δt`, px/s; всегда конечна; меньше двух сэмплов в окне или `Δt <= 0` → `0`. Правило окна (общее с `./gestures`): при событиях реже окна удерживается последняя пара сэмплов — скорость через разрыв остаётся честной средней, а не ложным нулём. Бросает: ничего.

### createInView

```ts
type InViewAmount = 'some' | 'all' | number;

interface InViewOptions {
  amount?: InViewAmount; // дефолт 'some'
  margin?: number;       // px; дефолт 0; отрицательное сужает вьюпорт
  onEnter?: () => void;
  onLeave?: () => void;
}

interface InViewUpdate {
  targetStart: number;    // позиция target в КООРДИНАТАХ ВЬЮПОРТА (как rect.top), px
  targetSize: number;     // px
  viewportLength: number; // px
}

interface InViewRecognizer {
  update(m: InViewUpdate): void;
  readonly inView: boolean;
}

function createInView(options?: InViewOptions): InViewRecognizer;
```

Headless-машина видимости (математика класса IntersectionObserver) с однократными `onEnter`/`onLeave` на смену состояния. Видимая часть target считается в расширенном вьюпорте `[-margin, viewportLength + margin]`; порог:

- `'some'` (дефолт) — виден любой пиксель (`visible > 0`);
- `'all'` — target целиком (`size > 0 && visible >= size`);
- число — доля размера, клампится в [0, 1] (`size > 0 && visible >= amount × size`); неконечное число → дефолт `'some'`.

`targetSize` клампится в `>= 0`; неконечный `margin` → `0`. `inView` — текущее состояние (getter). Бросает: ничего.

### createScrollObserver

```ts
interface ScrollProgressInfo {
  velocity: number; // px/s, по скользящему окну
  pos: number;      // px
}

interface ScrollObserverOptions {
  offset?: readonly [ScrollOffsetPair, ScrollOffsetPair]; // включает target-режим прогресса
  amount?: InViewAmount;  // порог in-view (только target-режим); дефолт 'some'
  margin?: number;        // px, расширение вьюпорта для in-view; дефолт 0
  windowSec?: number;     // секунды, окно оценки скорости; дефолт 0.1
  onProgress?: (progress: number, info: ScrollProgressInfo) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}

interface ScrollObserverUpdate extends ScrollMetrics {
  t?: number;           // время кадра, секунды (напр. e.timeStamp / 1000) — для скорости
  targetStart?: number; // позиция target в координатах ВЬЮПОРТА СКРОЛЛЕРА, px
  targetSize?: number;  // размер target по оси, px
}

interface ScrollObserver {
  update(m: ScrollObserverUpdate): void;
}

function createScrollObserver(options?: ScrollObserverOptions): ScrollObserver;
```

Оркестратор: прогресс + скорость + enter/leave одним `update`-каналом. Композиция `createScrollVelocity` + `createInView` + функций прогресса. Поведение `update`:

- `t` задан → сэмпл уходит в трекер скорости; без `t` НОВЫЙ сэмпл не записывается — `velocity` продолжает отдавать значение окна по прежним timestamped-сэмплам.
- `targetStart` и `targetSize` оба числа → обновляется in-view машина (`onEnter`/`onLeave` по `amount`/`margin`).
- `onProgress` задан: при наличии target-метрик **и** `offset` — прогресс по `resolveTargetProgress` (наблюдатель сам переводит `targetStart` из координат вьюпорта в координаты контента: `contentStart = pos + targetStart`); иначе — прогресс страницы по `scrollProgress`. Вторым аргументом приходит `{ velocity, pos }`.

`targetStart` — в координатах вьюпорта СКРОЛЛЕРА: для скролла окна — `rect.top` / `rect.left`; для контейнерного скроллера — разность `targetRect.top − containerRect.top` (голый `rect.top` даёт координаты вьюпорта браузера и для контейнера неверен). Бросает: ничего.

### scrubBinding

```ts
interface ScrubTarget {
  totalDuration: number;
  seek(t: number): void;
}

function scrubBinding(target: ScrubTarget): (progress: number) => void;
```

Клей «прогресс → seek»: маппит [0, 1] в виртуальное время цели — `seek(clamp01(progress) × totalDuration)`. Вход клампится: `NaN` → `0`, за пределами [0, 1] → края (SC1). Единицы виртуального времени — единицы цели; для `createTimeline` из `./timeline` это **секунды**. Возвращаемая функция подходит прямо в `onProgress`: `createScrollObserver({ onProgress: scrubBinding(tl) })`. Бросает: ничего.

### Type-only экспорты `./scroll`

`ScrollEdgeAnchor`, `ScrollOffsetPair`, `ScrollMetrics`, `ScrollSample`, `ScrollVelocityTracker`, `InViewAmount`, `InViewOptions`, `InViewUpdate`, `InViewRecognizer`, `ScrollProgressInfo`, `ScrollObserverOptions`, `ScrollObserverUpdate`, `ScrollObserver`, `ScrubTarget`.

## API — `./in-view`

### inView

```ts
type InViewAmount = 'some' | 'all' | number;
type InViewTarget = Element | string | ArrayLike<Element>;
type InViewLeaveHandler = (entry?: IntersectionObserverEntry) => void;
type InViewEnterHandler = (
  target: Element,
  entry: IntersectionObserverEntry,
) => void | InViewLeaveHandler;

interface InViewOptions {
  root?: Element | Document | null; // корень IntersectionObserver; null/undefined = viewport
  margin?: string;                  // нативный rootMargin, напр. '0px 0px -20%'; дефолт '0px'
  amount?: InViewAmount;            // 'some' (дефолт) | 'all' | доля [0, 1]
}

type InViewStop = () => void;

function inView(
  target: InViewTarget,
  onEnter: InViewEnterHandler,
  options?: InViewOptions,
): InViewStop;
```

Наблюдает snapshot целей через один нативный `IntersectionObserver`. `target` — `Element`, CSS-селектор или конечный array-like (включая `NodeList`); список снимается ровно один раз при вызове и дедуплицируется в исходном порядке; верхний предел — `100 000` целей (общий target-budget DOM-входов пакета). Пустой список целей (например селектор без совпадений) → observer не создаётся, возвращается no-op `stop`.

`amount` маппится в нативный `threshold`: `'some'` и числовой `0` → настоящее native intersection (`threshold: 0`, любой пиксель), `'all'` → `1`, доля — как есть. Enter засчитывается при `isIntersecting` и (`threshold === 0` или `intersectionRatio >= threshold`).

Семантика enter/leave:

- `onEnter(target, entry)` вызывается на вход target. **Вернул `InViewLeaveHandler`** → target остаётся под наблюдением; на natural leave обработчик вызывается с записью `entry`, после чего цикл enter/leave может повторяться. **Вернул `undefined`** → one-shot для этого target: он снимается с наблюдения; когда все цели one-shot-завершены, observer отключается сам.
- `stop()` идемпотентен: отключает observer и выполняет все ещё активные leave-cleanup ровно один раз, каждый — с `undefined` (terminal stop отличим от natural leave, куда приходит запись).
- Возврат из `onEnter` не-`undefined` и не-функции → `MotionParamError` `LM156`; исключение из `onEnter`/leave-cleanup перебрасывается (первая ошибка батча), при этом one-shot-release target всё равно выполняется.

Бросает `MotionParamError` (коды — [docs/errors.md](../errors.md)):

- `LM146` — некорректный контейнер целей (не Element/строка/ограниченный array-like; `length` не безопасное целое `>= 0` или больше предела).
- `LM147` — некорректный элемент списка целей (не `Element`), либо передан одиночный узел, не являющийся `Element`.
- `LM149` — селектор либо нативный DOM-host недоступен или нарушил контракт: нет `document`/`querySelectorAll`/`IntersectionObserver`, host вернул некорректные записи, синхронная доставка до `observe()` (hostile polyfill), сбой `observe`/`unobserve`/`disconnect`. Может быть брошен и из `stop()`, и асинхронно из observer-callback.
- `LM156` — options/callback не по контракту: `onEnter` не функция, `options` не объект, некорректные `root`/`margin`/`amount`, невалидный возврат `onEnter`; сюда же нормализуется нативный DOM `SyntaxError` парсера `rootMargin` при явно переданном `margin` (грамматика — забота вызывающего, не host-сбой).

### MotionParamError

```ts
type MotionParamErrorCode = `LM${Digit}${Digit}${Digit}`;

class MotionParamError extends Error {
  readonly name: 'MotionParamError';
  readonly code: MotionParamErrorCode;
  constructor(messageOrCode: string);
}
```

Класс ошибки экспортируется из физического `./in-view` entry рядом с `inView` — чтобы `instanceof` против ошибок этого субпутя работал корректно. `message` содержит только код: входные значения не отражаются в runtime-строку — ветвление строится по `code`. Конструктор совместим со строкой: строка-код из непрерывного каталога [docs/errors.md](../errors.md) → `code` равен ей; любая другая строка → `code = 'LM000'` (внешний конструктор).

### Type-only экспорты `./in-view`

`MotionParamErrorCode`, `InViewAmount`, `InViewTarget`, `InViewLeaveHandler`, `InViewEnterHandler`, `InViewOptions`, `InViewStop`.

## Контракты

- **SSR-safe.** `./scroll` — zero-DOM целиком (SC2): ни `window`, ни `document` ни на пути импорта, ни в вызовах — безопасен на сервере и в воркерах. `./in-view` ничего не читает из DOM при импорте; сам вызов `inView()` требует browser host (`document` для селектора, `IntersectionObserver`), иначе `MotionParamError` `LM149`.
- **Финитность (SC1).** Все выходы `./scroll` конечны при любом IEEE-754 входе: `NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE` до участия в арифметике; прогресс всегда клампится в [0, 1]; вырожденные диапазоны дают `0` или ступеньку `0/1`, не `NaN`.
- **Детерминизм (SC3).** `./scroll` читает время только из входных `{t}` — идентичная последовательность `update`/`push` даёт идентичные выходы.
- **Владение observer.** `inView()` снимает target/options ровно один раз и владеет одним `IntersectionObserver` до `stop()`; terminal-переход публикуется до host/user cleanup — реентерабельный `stop()` и поздние доставки видят no-op; leave-cleanup выполняются ровно один раз.
- **Исключения.** Публичный путь `./scroll` не содержит `throw` — валидация forgiving (кламп/дефолт/ноль). LM-коды субпутя `./in-view`: `LM146`, `LM147`, `LM149`, `LM156` — каталог в [docs/errors.md](../errors.md).
- **Reduced-motion.** Оба субпутя ничего не анимируют сами — только измеряют и сигналят; применение движения и реакция на `prefers-reduced-motion` целиком на стороне вызывающего (см. `./a11y`).

## Примеры

Прогресс-бар чтения страницы: страничный режим `createScrollObserver`, потребитель снимает метрики в обработчике скролла:

```ts
import { createScrollObserver } from '@labpics/motion/scroll';

const bar = document.querySelector('.progress-bar') as HTMLElement;

const observer = createScrollObserver({
  onProgress: (p, info) => {
    bar.style.transform = `scaleX(${p})`;
    bar.dataset.fast = String(Math.abs(info.velocity) > 2000); // px/s
  },
});

window.addEventListener(
  'scroll',
  (e) => {
    const doc = document.documentElement;
    observer.update({
      pos: doc.scrollTop,
      contentLength: doc.scrollHeight,
      viewportLength: doc.clientHeight,
      t: e.timeStamp / 1000, // секунды — для оценки скорости
    });
  },
  { passive: true },
);
```

Scrub таймлайна прохождением секции через вьюпорт (семантика Motion `['start end', 'end start']`): прогресс [0, 1] маппится в виртуальное время `createTimeline` (секунды) через `scrubBinding`:

```ts
import { createScrollObserver, scrubBinding } from '@labpics/motion/scroll';
import { createTimeline } from '@labpics/motion/timeline';

const hero = document.querySelector('.hero') as HTMLElement;

const tl = createTimeline({
  segments: [
    {
      from: 0,
      to: 360,
      duration: 1, // секунды виртуального времени; скраб маппит [0,1] на весь totalDuration
      onStep: (deg) => {
        hero.style.transform = `rotate(${deg}deg)`;
      },
    },
  ],
});
tl.pause(); // временем владеет скролл, не rAF-плеер

const observer = createScrollObserver({
  offset: [
    { target: 'start', viewport: 'end' }, // 'start end' — target входит снизу
    { target: 'end', viewport: 'start' }, // 'end start' — target выходит сверху
  ],
  onProgress: scrubBinding(tl),
});

window.addEventListener(
  'scroll',
  (e) => {
    const doc = document.documentElement;
    const rect = hero.getBoundingClientRect();
    observer.update({
      pos: doc.scrollTop,
      contentLength: doc.scrollHeight,
      viewportLength: doc.clientHeight,
      t: e.timeStamp / 1000,
      targetStart: rect.top,   // скроллер — окно: rect.top уже в координатах его вьюпорта
      targetSize: rect.height,
    });
  },
  { passive: true },
);
```

Появление карточек через нативный `./in-view`: enter запускает WAAPI-анимацию, возвращённый leave-cleanup включает повтор при каждом входе; `LM149` отличает headless-окружение:

```ts
import { inView, MotionParamError } from '@labpics/motion/in-view';

let stop: () => void = () => {};
try {
  stop = inView(
    '.card',
    (target) => {
      const el = target as HTMLElement;
      el.animate(
        [
          { opacity: 0, transform: 'translateY(16px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 300, easing: 'ease-out', fill: 'both' },
      );
      // Вернуть cleanup → повтор на каждый вход; вернуть undefined → one-shot.
      return () => {
        el.style.opacity = '0';
      };
    },
    { amount: 0.5, margin: '0px 0px -10%' }, // нативный rootMargin: enter на полвысоты, чуть раньше низа
  );
} catch (error) {
  if (error instanceof MotionParamError && error.code === 'LM149') {
    // Нет IntersectionObserver/host — показать контент без анимации.
    document.querySelectorAll('.card').forEach((el) => {
      (el as HTMLElement).style.opacity = '1';
    });
  } else {
    throw error;
  }
}

// Позже (unmount): отключить observer, активные leave-cleanup выполнятся с undefined.
// stop();
```
