# ./flip — FLIP layout-анимации

> Роль: справка — публичный API экспорт-субпутя `./flip`: чистая FLIP-математика (`computeFlip`, `flipAt`, `correctRadius`, `counterScale`) и headless-драйвер `createFlip` пружинного «доезда» layout-перестановки.

## Назначение

Субпуть `./flip` реализует layout-анимацию по технике FLIP (First-Last-Invert-Play): элемент уже стоит на **новом** месте в потоке документа, а визуально «доезжает» со старого чистым `transform` — без reflow на каждом кадре. Плюс коррекция scale-искажений: `correctRadius` держит визуально постоянный `border-radius` под масштабом, `counterScale` снимает искажение дочернего элемента обратным масштабом.

Архитектура headless: измерения (`getBoundingClientRect`) делает **потребитель** — до и после перестановки DOM — и передаёт два прямоугольника; движок отдаёт числа transform'а в `onStep`. Ноль DOM внутри модуля. Кадровый шов (`requestFrame`) и `matchMedia` инжектируются.

Инварианты модуля (закреплены в JSDoc и коде):

- **F1. CSS-safe.** Все числа transform'а конечны: `NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE`, деление на вырожденный размер → нейтральный fallback, `-0` схлопывается в `+0`.
- **F2. Zero-DOM / SSR-safe.** Ни DOM, ни `window` на пути импорта; платформенные швы `requestFrame`/`matchMedia` — только через опции.
- **F3. Детерминизм.** Время — только из `ts` кадра (мс) либо фиксированного шага `1/60` с, когда шов не дал timestamp. Ни wall-clock, ни `Math.random`.
- **F4. Reduced-motion — переключение ХАРАКТЕРА.** Под `prefers-reduced-motion: reduce` — снап в identity без единого кадра: элемент просто оказывается на новом месте, `onRest` вызывается. Не hard-off всей логики.
- **F5. Zero runtime deps; transform-origin `'0 0'`.** Формулы `dx`/`sx` выведены для верхнего-левого origin — потребитель обязан выставить `transform-origin: 0 0` на анимируемом элементе.

Честный **вложенный** FLIP (дерево узлов, потомки и радиусы не искажаются по построению) — отдельный субпуть `@labpics/motion/projection`; он переиспользует `correctRadius` отсюда живым вызовом.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Субпуть tree-shakeable — в корневой бандл не входит.

## Импорт

```ts
import {
  computeFlip,
  flipAt,
  correctRadius,
  counterScale,
  createFlip,
  type FlipRect,
  type FlipInversion,
  type FlipTransform,
  type FlipOptions,
  type FlipControls,
} from '@labpics/motion/flip';
```

## API

### computeFlip

```ts
interface FlipRect {
  readonly x: number;      // px
  readonly y: number;      // px
  readonly width: number;  // px
  readonly height: number; // px
}

interface FlipInversion {
  readonly dx: number; // px: смещение из last в first
  readonly dy: number; // px
  readonly sx: number; // масштаб из last в first
  readonly sy: number;
}

function computeFlip(first: FlipRect, last: FlipRect): FlipInversion;
```

Инверсия First→Last: transform, визуально возвращающий элемент с `last` на `first` (для `transform-origin: 0 0`, F5). `FlipRect` — срез `getBoundingClientRect` (все поля — px).

- `dx = first.x − last.x`, `dy = first.y − last.y`.
- `sx = first.width / last.width`, `sy = first.height / last.height`; вырожденный знаменатель (`0`/`NaN`) → fallback `1` (F1).
- Все выходы проходят страж конечности: `NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE`.

Бросает: ничего.

### flipAt

```ts
interface FlipTransform {
  readonly tx: number; // px
  readonly ty: number; // px
  readonly sx: number;
  readonly sy: number;
}

function flipAt(inv: FlipInversion, p: number): FlipTransform;
```

Transform на прогрессе `p ∈ [0, 1]`: `p = 0` — полная инверсия (визуально first), `p = 1` — identity (элемент на своём новом месте). Линейная интерполяция: `tx = dx·(1−p)`, `sx = sx + (1−sx)·p`. `p` клампится в `[0, 1]`; `NaN` → `0`. Выходы конечны, `-0` схлопнут в `+0` (в CSS `-0px` валиден, но грязен).

Бросает: ничего.

### correctRadius

```ts
function correctRadius(radius: number, sx: number, sy: number): { x: number; y: number };
```

Коррекция `border-radius` под текущий масштаб: чтобы радиус **выглядел** постоянным (`radius` px) при `scale(sx, sy)`, применить `${x}px / ${y}px`. Возвращает `x = radius / sx`, `y = radius / sy`; нулевой/`NaN` масштаб → fallback `radius`; `radius` проходит страж конечности.

Бросает: ничего.

### counterScale

```ts
function counterScale(sx: number, sy: number): { sx: number; sy: number };
```

Обратный масштаб для дочернего элемента: родитель скейлится `(sx, sy)` — ребёнок с `scale(1/sx, 1/sy)` не искажается. Нулевой/`NaN` масштаб → fallback `1`.

Бросает: ничего.

### createFlip

```ts
interface FlipOptions {
  spring?: SpringParams;                 // { mass, stiffness, damping }; дефолт { mass: 1, stiffness: 200, damping: 24 }
  requestFrame?: RequestFrameFn;         // (cb: (ts?: number) => void) => number; ts в мс
  matchMedia?: MatchMediaLike;           // (query: string) => { matches: boolean }
  onStep?: (t: FlipTransform) => void;   // числа transform'а на каждом кадре (F1: всегда конечны)
  onRest?: () => void;                   // полёт завершён; ровно один раз на play
  clamp?: boolean;                       // дефолт true
}

interface FlipControls {
  play(first: FlipRect, last: FlipRect): void;
  cancel(): void;
  readonly playing: boolean;
  readonly progress: number; // [0, 1]; 1 — покой/identity
}

function createFlip(options?: FlipOptions): FlipControls;
```

Создаёт контроллер FLIP-полётов: нормированная пружина `0 → 1` поверх инверсии `computeFlip(first, last)`, синхронные колбэки.

Параметры:

- `spring` — пружина «доезда», `SpringParams` (`{ mass, stiffness, damping }`, тип из корня `@labpics/motion`; конструкторы удобных параметризаций — [./spring](./spring.md)). Дефолт `{ mass: 1, stiffness: 200, damping: 24 }`. Валидируется **один раз и рано**, в самом `createFlip` — не поздним исключением из кадра и не молча под reduced-motion; тик зовёт unchecked-солвер.
- `requestFrame` — инжектируемый кадровый шов (`window.requestAnimationFrame.bind(window)` в браузере); `ts` колбэка — **миллисекунды**. Без шва полёт невозможен честно: `play` синхронно эмитит инверсию, затем сразу identity и `onRest` (важно для SSR/тестов). Шов, вернувший handle `0` (non-draining), страхуется `setTimeout(…, 0)`.
- `matchMedia` — инжектируемый детект `prefers-reduced-motion: reduce` (F4). Не функция или бросает → трактуется как «нет предпочтения».
- `onStep` — числа transform'а на каждом кадре; всегда конечны (F1).
- `onRest` — identity достигнута; вызывается ровно один раз на `play` (после `cancel` — не вызывается).
- `clamp` — клэмп прогресса к `[0, 1]`. Дефолт `true` (легаси). `false` — честная пружина: overshoot доезда (`p > 1`) эмитится в transform (упругий FLIP). Публичный `progress` клампится в `[0, 1]` всегда, независимо от режима. (Смежный `./projection` по умолчанию живёт с `clamp: false` — осознанное отличие.)

Поведение `play(first, last)`:

- Первый кадр — **синхронно** на полной инверсии (`p = 0`): без мигания элемента на новом месте.
- Повторный `play` в полёте перехватывает его: кадры прежнего полёта инертны (generation-инвалидация).
- Под reduced-motion (F4): `playing = false`, синхронный `onStep` c identity, `onRest` — ноль кадров.
- Время: дельты `ts` кадров (мс), отрицательные дельты клампятся к `0`; кадр без `ts` — фиксированный шаг `1/60` с (F3).
- Сходимость: `|1 − value| < 1e-3` и `|velocity| < 1e-3` нормированной пружины, либо потолок `2000` кадров (страховка от вечного цикла). На завершении — `onStep` с точным identity (`p = 1`) и `onRest`.

`cancel()` глушит полёт без `onRest`; `playing` становится `false`, `progress` замирает на текущем значении.

Бросает: `MotionParamError` из `validateSpringParams` — `LM088` (mass), `LM089` (stiffness), `LM090` (damping), `LM091` (время оседания вне бюджета frame-loop). Свод кодов — [docs/errors.md](../errors.md). Всё остальное forgiving (клампы/fallback'и, F1).

### Type-only экспорты

- `FlipRect` — `{ x, y, width, height }` (px), срез `getBoundingClientRect`.
- `FlipInversion` — `{ dx, dy, sx, sy }`, инверсия First→Last.
- `FlipTransform` — `{ tx, ty, sx, sy }`, значения transform'а на кадре.
- `FlipOptions` — опции `createFlip`.
- `FlipControls` — контроллер (`play`, `cancel`, `playing`, `progress`).

Типы швов (`SpringParams`, `RequestFrameFn`) экспортируются из корня `@labpics/motion`; `matchMedia` дак-тайпится под `window.matchMedia` без требования `lib.dom`.

## Контракты

- **SSR-safe / zero-DOM (F2).** Импорт и вся математика не трогают DOM/`window`; без инжектированного `requestFrame` `play` детерминированно завершается identity + `onRest` — сервер не падает и не виснет.
- **Финитность (F1).** Каждый эмитированный `FlipTransform` конечен при любом IEEE-754 входе: вырожденные размеры (`0×0`, `display: none`) дают масштаб-fallback `1`, `NaN` → `0`, `-0` → `+0`.
- **Reduced-motion (F4).** Смена характера, не hard-off: снап в identity без кадров, `onRest` вызывается — жизненный цикл потребителя не ломается. Невалидная пружина бросает и под reduce (валидация в `createFlip`, до детекта).
- **Детерминизм (F3).** Идентичная последовательность `ts` → идентичная последовательность кадров; чистые функции (`computeFlip`/`flipAt`/`correctRadius`/`counterScale`) бит-детерминированы.
- **Ровно один `onRest` на `play`.** Перехват (`play` в полёте) и `cancel` не дают ни второго `onRest`, ни кадров-призраков прежнего полёта.
- **Ограниченность.** Потолок `2000` кадров на полёт — вечный цикл исключён; порог сходимости `1e-3` по значению и скорости.

## Примеры

Базовый FLIP: измерить → переставить DOM → измерить → `play`:

```ts
import { createFlip } from '@labpics/motion/flip';

const el = document.querySelector('.card') as HTMLElement;
el.style.transformOrigin = '0 0'; // F5: формулы выведены для origin '0 0'

const fl = createFlip({
  requestFrame: (cb) => requestAnimationFrame(cb),
  matchMedia: window.matchMedia.bind(window), // reduced-motion → снап без кадров
  onStep: (t) => {
    el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`;
  },
  onRest: () => {
    el.style.transform = '';
  },
});

const first = el.getBoundingClientRect();
el.classList.toggle('is-expanded'); // layout-перестановка: класс/порядок/размер
const last = el.getBoundingClientRect();
fl.play(first, last);
```

Упругий FLIP (`clamp: false`) с коррекцией scale-искажений — радиус визуально постоянен, аватар не растягивается:

```ts
import { createFlip, correctRadius, counterScale } from '@labpics/motion/flip';

const card = document.querySelector('.card') as HTMLElement;
const avatar = document.querySelector('.card .avatar') as HTMLElement;
card.style.transformOrigin = '0 0';
avatar.style.transformOrigin = '0 0';

const RADIUS = 8; // px — желаемый ВИЗУАЛЬНЫЙ радиус на всё время полёта

const fl = createFlip({
  spring: { mass: 1, stiffness: 300, damping: 22 },
  clamp: false, // честная пружина: overshoot уходит в transform
  requestFrame: (cb) => requestAnimationFrame(cb),
  matchMedia: window.matchMedia.bind(window),
  onStep: (t) => {
    card.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`;
    const r = correctRadius(RADIUS, t.sx, t.sy);
    card.style.borderRadius = `${r.x}px / ${r.y}px`;
    const c = counterScale(t.sx, t.sy);
    avatar.style.transform = `scale(${c.sx}, ${c.sy})`;
  },
  onRest: () => {
    card.style.transform = '';
    card.style.borderRadius = `${RADIUS}px`;
    avatar.style.transform = '';
  },
});

const first = card.getBoundingClientRect();
card.classList.toggle('is-expanded');
const last = card.getBoundingClientRect();
fl.play(first, last);
```

Собственный тайминг поверх чистой математики — `computeFlip` + `flipAt` без драйвера:

```ts
import { computeFlip, flipAt } from '@labpics/motion/flip';
import { easeOut } from '@labpics/motion/easing';

const el = document.querySelector('.chip') as HTMLElement;
el.style.transformOrigin = '0 0';

const first = el.getBoundingClientRect();
el.classList.add('is-moved');
const last = el.getBoundingClientRect();

const inv = computeFlip(first, last);
const DURATION_MS = 250;
const start = performance.now();

const frame = (now: number): void => {
  const p = Math.min(1, (now - start) / DURATION_MS);
  const t = flipAt(inv, easeOut(p)); // p клампится в [0, 1] внутри flipAt
  el.style.transform =
    p < 1 ? `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})` : '';
  if (p < 1) requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```
