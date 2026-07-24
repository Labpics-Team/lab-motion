# Миграция с Anime.js за 15 минут

> Роль: справка — карта переноса Anime.js v4 (`animate()`, `stagger()`, кейфреймы) на субпути `./animate` и `./stagger`: таблицы соответствий, точные сигнатуры и честные границы (loop/alternate/reversed и модули timeline/svg/text здесь нет) с обходами.

## Назначение

Страница переносит **конкретные вызовы** Anime.js v4 на два субпутя
`@labpics/motion`: одиночные переходы и кейфреймы — `./animate`, каскадные
задержки — `./stagger`. Это карта переноса вызовов, а не утверждение о
совпадении возможностей, поведения или lifecycle (полный целевой охват — в
[roadmap #106](https://github.com/Labpics-Team/lab-motion/issues/106)); чего
нет — сказано явно, с обходами. Характеристики размера здесь не приводятся:
снимок чисел даёт вывод `pnpm size` и стенд `bench/compare/size-compare.mjs`
(версия Anime.js в нём пинена), методология — [docs/benchmark.md](../benchmark.md).

Три правила, из-за которых чаще всего ломается портирование:

1. **Единицы совпадают — пересчёт не нужен.** Anime.js и `./animate`/`./stagger`
   считают время в **миллисекундах**: `duration: 300` остаётся `300`, `seek(120)`
   остаётся `seek(120)` (в отличие от миграций с Framer Motion/GSAP, где
   секунды × 1000).
2. **Опции — третий аргумент, не общий объект.** Anime v4 складывает каналы и
   параметры в ОДИН объект `animate(targets, parameters)`; здесь каналы (`props`)
   и параметры (`options`) разнесены: `animate(target, props, options)`.
3. **Дефолтный режим — пружина, не твин; изинг — функция, не строка.**
   `animate(el, { x: 100 })` у Anime — твин 1000 мс; здесь без tween-грамматики —
   пружина `spring.default` (`{ mass: 1, stiffness: 170, damping: 26 }`).
   Хотите твин — задайте `duration` (мс) и/или `ease` — JS-функцию из `./easing`
   (CSS-строки вида `'ease-out'` — грамматика `./nano`).

### animate() Anime v4 → `./animate`

| Anime.js v4 | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `animate(el, { translateX: 100 })` | `animate(el, { x: 100 })` | Anime v4 также допускает shorthand `x`; здесь шортхенды — `x`/`y` (px), `scale`/`scaleX`/`scaleY`, `rotate`/`skewX`/`skewY` (deg); ключ `transform` целиком запрещён (`LM140`) |
| `animate('.item', { … })` | `animate('.item', { … }, { … })` | селектор резолвится через `document.querySelectorAll` в момент вызова |
| `animate(el, { opacity: [0, 1], duration: 300 })` | `animate(el, { opacity: [0, 1] }, { duration: 300 })` | **мс → мс без пересчёта**; параметры уходят в третий аргумент |
| `animate(el, { x: { from: -100, to: 100 } })` | `animate(el, { x: [-100, 100] })` | пара `[from, to]`; явный from отключает C¹-подхват (старт из покоя) |
| `animate(el, { x: 100 })` (без duration) | `animate(el, { x: 100 })` | у Anime — твин 1000 мс; здесь — пружина `spring.default` |
| `{ ease: 'inOutCirc' }` | `{ ease: circInOut }` | строки → функции `./easing` (таблица ниже) |
| `{ ease: createSpring({ stiffness: 200, damping: 20 }) }` | `{ spring: { mass: 1, stiffness: 200, damping: 20 } }` | пружина — режим, не изинг; все три поля `SpringParams` обязательны; `spring` и `duration`/`ease`/`times` взаимоисключающие (`LM136`) |
| `{ delay: 100 }` | `{ delay: 100 }` | мс, `≥ 0` |
| `{ delay: stagger(50) }` | `{ stagger: 50 }` | число = gap-мс между целями |
| `{ delay: stagger(50, { start: 500 }) }` | `{ delay: 500, stagger: 50 }` | базовая задержка складывается с офсетом каждой цели |
| `{ onComplete: cb }` | `{ onComplete: cb }` | один раз, когда ВСЕ цели осели естественно (не `cancel`) |
| `const a = animate(…); a.pause(); a.play()` | то же | `play()` после естественного завершения НЕ перезапускает |
| `a.seek(120)` | `a.seek(120)` | мс у обоих; здесь write-only (getter'а `currentTime` нет), пауза сохраняется |
| `await a` / `a.then(…)` | то же | контролы thenable; `finished` доступен отдельным Promise |
| `a.cancel()` | `a.cancel()` (алиас `a.stop()`) | остановка в текущей позе; `finished` резолвится |
| `a.revert()` | прямого эквивалента нет | возврат к исходным значениям / чистка inline-стиля — на вас |
| CSS-переменные | `animate(el, { '--x': ['0px', '100px'] })` | пара с явным юнитом |

### Кейфреймы Anime v4 → N-keyframe кортежи

| Anime.js v4 | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `x: [0, 120, -40, 0]` (массив значений) | `x: [0, 120, -40, 0]` | кортеж ≥ 3 стопов — все стопы явные; offsets равномерные либо `options.times` |
| `keyframes: { '0%': { x: 0 }, '40%': { x: 120 }, '100%': { x: 0 } }` | `{ x: [0, 120, 0] }` + `times: [0, 0.4, 1]` | проценты → доли `[0, 1]`; `times` один на вызов |
| `x: [{ to: 120, duration: 240 }, { to: 0, duration: 360 }]` | кортеж + `times` | per-keyframe duration → доли суммарной длительности в `times` (`240 + 360 → times: [0, 0.4, 1]`, `duration: 600`) |
| `x: [{ to: 120, ease: 'outCubic' }, { to: 0, ease: 'inCubic' }]` | `ease: [easeOut, easeIn]` | per-segment изинги: массив длиной `N − 1` |
| `keyframes: [{ x: 100 }, { y: 120 }]` (общий массив) | каналы порознь: `{ x: […], y: […] }` | при `times`/`ease[]` все каналы вызова обязаны иметь одну authored-топологию `N` (`LM168`/`LM169`); без них длины кортежей могут различаться |
| удержание значения между кадрами | повторить стоп: `x: [0, 120, 120, 0]` + `times` | одинаковые соседние стопы с разнесёнными times — плато |
| per-keyframe `delay` внутри трека | нет | `delay` один на вызов (сдвиг старта) |

Кейфрейм-кортеж — грамматика tween-движка: трек + явная `spring` отклоняется
синхронно (`LM136`); трек без `duration`/`ease` получает tween с дефолтами
(200 мс, standard) — НЕ пружину и НЕ 1000 мс Anime. Дубликаты `times` легальны
(right-biased скачок нулевой ширины).

### Изинги: строки Anime v4 → функции `./easing`

Полный каталог — [docs/reference/easing.md](../reference/easing.md). Дефолт
Anime `'out(2)'` → композиция `(t) => 1 - power(2)(1 - t)`; наш дефолт
tween-режима — standard `cubic-bezier(0.2, 0, 0, 1)`.

| Anime.js v4 | `./easing` |
|---|---|
| `'linear'` | `linear` |
| `'in(p)'` | `power(p)` (In-форма `t^p`) |
| `'out(p)'` / `'inOut(p)'` | композиции `power(p)`: Out — `(t) => 1 - power(p)(1 - t)` |
| `'inQuad' / 'outQuad' / 'inOutQuad'` | `power(2)` — In-форма; Out/InOut — композиции |
| `'inCubic' / 'outCubic' / 'inOutCubic'` | `easeIn` / `easeOut` / `easeInOut` |
| `'inQuart'`, `'inQuint'` | `power(4)`, `power(5)` |
| `'inSine' / 'outSine' / 'inOutSine'` | `sineIn` / `sineOut` / `sineInOut` |
| `'inExpo' / 'outExpo' / 'inOutExpo'` | `expoIn` / `expoOut` / `expoInOut` |
| `'inCirc' / 'outCirc' / 'inOutCirc'` | `circIn` / `circOut` / `circInOut` |
| `'inBack' / 'outBack' / 'inOutBack'` | `backIn` / `backOut` / `backInOut` |
| `'inElastic' / 'outElastic' / 'inOutElastic'` | `elastic` — фиксированная InOut-форма; амплитуда/период не параметризуются — сверяйте форму по справке |
| `'inBounce' / 'outBounce' / 'inOutBounce'` | `bounce` — InOut-гибрид Пеннера |
| `'steps(n)'` | `steps(n, 'start' \| 'end')` |
| `'cubicBezier(x1, y1, x2, y2)'` | `cubicBezier(x1, y1, x2, y2)` |
| `createSpring({ … })` как ease | режим `{ spring }`; пружина в tween/keyframe-слоте — `springAsEasing` из `./spring` |
| `'irregular(n, randomness)'` | нет (детерминизм — инвариант пакета); своя функция `t → прогресс` |

### stagger() Anime v4 → `./stagger`

Опция `stagger` в `animate` принимает число (gap, мс) или целиком
`StaggerOptions`; отдельная функция `stagger(count, options)` считает те же
задержки как чистый массив чисел — для собственной оркестрации.

| Anime.js v4 | `@labpics/motion` | Заметка |
|---|---|---|
| `delay: stagger(100)` | `{ stagger: 100 }` | мс → мс без пересчёта |
| `stagger(100, { from: 'center' })` | `{ stagger: { gap: 100, from: 'center' } }` | |
| `from: 'first' / 'last' / 'center'` | то же | плюс наш `'edges'` (края одновременно первыми) |
| `from: index` | `from: index` | округляется и клампится в `[0, count − 1]` |
| `from: 'random'` | нет | обход: standalone `stagger(count, …)` + свой shuffle, затем per-цель `delay` (пример 3) |
| `stagger(100, { start: 500 })` | `{ delay: 500, stagger: 100 }` | базовая задержка + офсеты складываются per-цель |
| `{ ease: 'inQuad' }` | `{ stagger: { easing: power(2) } }` | функция на нормированную позицию `[0, 1]` |
| `{ grid: [rows, cols] }` | `{ stagger: { grid: { columns: cols } } }` | задаются только колонки, строки выводятся из count; дистанция евклидова, `'edges'` в сетке — минимум до границы |
| `{ grid, axis: 'x' / 'y' }` | нет | осевой проекции нет |
| `{ reversed: true }` | линейный случай — `from: 'last'` | иначе: standalone-массив + `reverse()` |
| `{ modifier: fn }` | нет | обход: standalone `stagger()` → `map(fn)` → per-цель `delay` |
| `stagger('1rem')` (значения, не задержки) | нет | `stagger` здесь раздаёт только задержки (мс); значения раздавайте сами по индексу |
| — | `{ reducedMotion: true }` | наша добавка: все задержки схлопываются в 0 (у Anime аналога нет) |

### Направления и повторы: loop / alternate / reversed — честно

На `./animate` их **нет**: ни `loop`, ни `loopDelay`, ни `alternate: true`, ни
`reversed: true`, ни `onLoop`. Обходы:

- **Один alternate-период** — N-keyframe кортеж туда-обратно:
  `y: [0, 16, 0]` (при желании с `times`/per-segment `ease`).
- **Конечный `loop: n`** — цикл поверх thenable-контролов:
  `for (…) await animate(…)` (пример 3); бесконечный — `while (true)` с `await`.
- **Политики повтора как контракт** (`loop | reverse | mirror` +
  `repeatDelay`) — headless-субпуть `./keyframes`
  ([справка](../reference/timeline-keyframes.md)): значения сэмплируются под
  вашим колбэком, DOM пишете вы.
- **`reversed: true`** (проигрывание от конца) — поменять местами пару:
  `x: [to, from]`.
- **`autoplay: false`** — опции нет, старт немедленный; обход —
  `controls.pause()` сразу после вызова (по контракту `pause()` кадры не
  эмитятся) и `play()` в нужный момент.

### Чего ещё нет (охват страницы)

- **Per-канальные tween-параметры** (`x: { to: 100, duration: 500, ease }` со
  своими duration/delay на канал) — режим (`spring` ИЛИ `duration`/`ease`) один
  на вызов `animate`.
- **Function-based значения** `(target, i) => …` — нет; обход: цикл по целям
  с per-цель `delay` из standalone `stagger()`.
- **Object/attribute targets** — `animate(obj, { prop: 100 })`, HTML/SVG-атрибуты
  и path-каналы не поддержаны: фасад анимирует только CSS-стили DOM/SVG-элементов
  (`SVGElement` — допустимая цель для CSS-стилей). Headless-значения — это
  `MotionValue` корневого субпутя; draw-математика — `./svg`.
- **Колбэки кадра/фаз**: `onBegin` / `onUpdate` / `onRender` / `onLoop` — нет
  (есть только `onComplete`); значение под своим per-frame колбэком —
  `./driver` / `MotionValue`.
- **Контролы**: нет `restart` / `reverse` / `resume` / `complete` / `revert`,
  нет getters `currentTime` / `progress` / `duration` / `speed`. Есть
  `play` / `pause` / `seek` / `cancel` / `stop` + `finished`.
- **Модули Anime v4 → другие субпути** (вне охвата страницы):
  `createTimeline` → `./timeline` (грамматика позиционирования — на
  [странице GSAP](./gsap.md)); `createTimer` → `./frame` / `./driver`;
  `createDraggable` → `./gestures` + `./decay`; `onScroll` → `./scroll` /
  `./in-view`; svg (`createDrawable`, `morphTo`, `createMotionPath`) →
  `./svg` / `./svg-morph`; text/split → `./presets`; `utils` → `./utils`;
  `engine` → `./frame`; `createScope` эквивалента не имеет.

## Импорт

```ts
import { animate } from '@labpics/motion/animate';
import { stagger } from '@labpics/motion/stagger';
```

Смежные публичные пути: готовые кривые и фабрики изингов —
`@labpics/motion/easing`; `fromBounce({ duration, bounce })` для мышления в
duration/bounce — `@labpics/motion/spring`; `MotionParamError` и `type
SpringParams` — корень `@labpics/motion`.

## API

Здесь — минимум для переноса; полные страницы:
[reference/animate.md](../reference/animate.md),
[reference/stagger.md](../reference/stagger.md). Каталог LM-кодов с лечением —
[docs/errors.md](../errors.md).

### animate (`./animate`)

Единственный runtime-экспорт субпутя.

```ts
function animate(
  target: AnimateTarget,   // Element | список (Array/NodeList) | CSS-селектор (резолв в вызове)
  props: AnimateProps,     // Record<string, number | string | readonly (number | string)[]>
  options?: AnimateOptions, // по умолчанию {}
): AnimateControls;
```

`props` — каналы движения: transform-шортхенды (`x`/`y` — px;
`scale`/`scaleX`/`scaleY`; `rotate`/`skewX`/`skewY` — deg), `opacity`, любые
CSS-свойства и `--переменные`. Значение канала — цель, пара `[from, to]`
(явный `from` отключает подхват скорости) или N-keyframe кортеж длины ≥ 3.
Ключ `transform` целиком запрещён (`LM140`).

`options` (все времена — **миллисекунды**; режимы `spring` и
`duration`/`ease`/`times` взаимоисключающие — одновременно `LM136`):

| Поле | Тип | Дефолт | Семантика |
|---|---|---|---|
| `spring` | `SpringParams` | режим по умолчанию: `{ mass: 1, stiffness: 170, damping: 26 }` (SSOT токена `spring.default`) | режим пружины; валидация — транзитом `LM088`–`LM091` |
| `duration` | `number`, **мс**, конечное `> 0` (`LM137`) | `200` (токен `duration.base`), если tween выбран через `ease`/`times` | режим tween |
| `ease` | `(t: number) => number` или массив длины `N − 1` | standard `cubic-bezier(0.2, 0, 0, 1)` | JS-функция (не-функция — `LM138`); массив — per-segment изинги N-keyframe вызова (нарушение длины — `LM169`) |
| `times` | `readonly number[]` | равномерные offsets | offsets N-keyframe вызова: длина `N`, конечные, неубывающие, `times[0] = 0`, `times[N−1] = 1` (нарушение — `LM168`); дубликаты легальны (right-biased скачок) |
| `delay` | `number`, **мс**, `≥ 0` | `0` | задержка старта всем целям (`LM139`) |
| `stagger` | `number` (**мс**-gap) или `StaggerOptions` | нет | каскад для многих целей; складывается с `delay` per-цель (`LM139` при некорректном) |
| `onComplete` | `() => void` | нет | один раз, когда ВСЕ цели осели естественно (не `cancel`) |
| `requestFrame` / `matchMedia` / `now` / `setTimer` | швы | rAF / `globalThis.matchMedia` / `performance.now` / `setTimeout` | инжекция среды (детерминизм тестов, SSR, reduced-motion) |

Возврат — агрегированные контролы (thenable: `await animate(…)` ≡
`await animate(…).finished`):

```ts
interface AnimateControls extends PromiseLike<void> {
  readonly finished: Promise<void>; // резолв при завершении всех целей (естественном ИЛИ cancel/stop)
  play(): void;                     // возобновить после pause(); завершённое не перезапускает
  pause(): void;                    // заморозить (кадры не эмитятся)
  seek(tMs: number): void;          // мс; write-only; пауза сохраняется; нефинитное игнорируется
  cancel(): void;                   // остановить в текущей позе; finished резолвится
  stop(): void;                     // алиас cancel()
}
```

Повторный `animate` того же элемента/канала — прерывание с C¹-подхватом
(value и velocity), кроме явного `from`.

Бросает `MotionParamError` рано, ДО записей в стиль: `LM156` (options не
объект), `LM151` (props не объект-запись), `LM136` (конфликт режимов, включая
трек + явная пружина), `LM137` (duration), `LM138` (ease не функция), `LM169`
(длина ease-массива ≠ числу сегментов), `LM168` (times/топология), `LM139`
(delay/stagger), `LM088`–`LM091` (валидация `SpringParams`), `LM149` (селектор
без `document`), `LM146`/`LM147` (контейнер/элемент целей), `LM140` (whole
`transform`), `LM141` (битая пара/кортеж), `LM142` (нефинитное число),
`LM143`/`LM144` (тип/синтаксис CSS-значения), `LM150` (непредставимый импульс
подхвата), `LM157` (реентрантная смена владельца).

### stagger (`./stagger`)

Единственный runtime-экспорт субпутя.

```ts
function stagger(count: number, options?: StaggerOptions): number[];

interface StaggerOptions {
  gap?: number;                       // мс; дефолт 50; неконечный/отрицательный → дефолт
  from?: 'first' | 'last' | 'center' | 'edges' | number; // дефолт 'first'; число клампится в [0, count−1]
  easing?: (t: number) => number;     // на нормированную позицию [0, 1]; дефолт identity
  grid?: { columns: number };         // 2D-дистанции по сетке (строки выводятся из count)
  reducedMotion?: boolean;            // дефолт false; true → все задержки 0
}
```

Чистая функция: `(count, options)` → массив из `count` конечных
неотрицательных задержек (**мс**). `count` — положительное конечное целое;
`0`/отрицательное/не-конечное → `[]`, `1` → `[0]`; сверхбольшой `count`
клампится к пределу 100 000 (не зануляется). **Не бросает никогда**: NaN/∞ на
любом входе (включая выход `easing`) зажимается к 0. Zero-DOM: `reducedMotion`
определяет вызывающий (`matchMedia('(prefers-reduced-motion: reduce)')`) —
сама функция DOM не читает.

### Type-only экспорты

- `./animate`: `AnimatableElement`, `AnimateTarget`, `AnimatePropValue`,
  `AnimateProps`, `AnimateOptions`, `AnimateControls`.
- `./stagger`: `StaggerOptions`, `StaggerFrom`, `StaggerGridOptions`.

## Контракты

- **SSR-safe.** Импорт обоих субпутей не трогает `window`/`document`:
  `./stagger` — zero-DOM целиком; `./animate` резолвит селектор и читает
  capability целей только в момент вызова.
- **Reduced-motion — смена характера, не выключение.** `./animate`: мгновенная
  запись финальных значений без кадров (единая снап-политика пакета; завершение
  считается естественным — `onComplete` вызывается); `./stagger` при
  `reducedMotion: true`: задержки схлопываются в 0 — элементы анимируются
  одновременно. Предпочтение читается один раз на вызов.
- **Финитность.** `./animate` бросает `MotionParamError` на не-конечных входах
  рано, ДО записей в стиль — NaN/∞ не эмитятся никогда; `./stagger` вместо
  бросков зажимает ошибочные значения к 0.
- **Детерминизм.** Время — только через инжектируемые швы (`requestFrame` /
  `now` / `setTimer`); `stagger` — чистая функция: одинаковые входы →
  бит-идентичные массивы на любой платформе.

## Примеры

One-liner Anime v4 → `./animate` (мс без пересчёта; опции — третий аргумент):

```ts
// Было (Anime.js v4):
//   import { animate, stagger } from 'animejs';
//   animate('.card', { translateX: 240, opacity: [0, 1],
//     duration: 300, ease: 'outCubic', delay: stagger(50) });
import { animate } from '@labpics/motion/animate';
import { easeOut } from '@labpics/motion/easing';

await animate(
  '.card',
  { x: 240, opacity: [0, 1] },
  { duration: 300, ease: easeOut, stagger: 50 },
);

// Без tween-грамматики режим — пружина spring.default (у Anime был бы твин 1000 мс).
await animate('.card', { scale: 1.05 });
```

Кейфреймы с per-keyframe duration/ease → кортеж + `times` + `ease[]`; пружина
`createSpring` → режим `{ spring }`:

```ts
// Было: animate(el, { x: [{ to: 120, duration: 240, ease: 'outCubic' },
//                         { to: -40, duration: 180, ease: 'linear' },
//                         { to: 0,  duration: 180, ease: 'inOutCubic' }] });
import { animate } from '@labpics/motion/animate';
import { easeInOut, easeOut, linear } from '@labpics/motion/easing';

const card = document.querySelector('.card') as HTMLElement;

await animate(card, { x: [0, 120, -40, 0] }, {
  duration: 600,                    // сумма per-keyframe длительностей
  times: [0, 0.4, 0.7, 1],          // 240/600, (240+180)/600, 1
  ease: [easeOut, linear, easeInOut], // N − 1 сегментов
});

// Было: animate(el, { x: 240, ease: createSpring({ stiffness: 200, damping: 20 }) })
await animate(card, { x: 240 }, { spring: { mass: 1, stiffness: 200, damping: 20 } });
```

Сетка от центра, обход `from: 'random'` собственным shuffle и обход `loop`
конечным циклом поверх thenable:

```ts
// Было: animate('.grid .cell', { scale: [0, 1],
//   delay: stagger(40, { grid: [5, 6], from: 'center', ease: 'inQuad' }) });
import { animate } from '@labpics/motion/animate';
import { power } from '@labpics/motion/easing';
import { stagger } from '@labpics/motion/stagger';

const cells = [...document.querySelectorAll('.grid .cell')] as HTMLElement[];

const delays = stagger(cells.length, {
  gap: 40, from: 'center', grid: { columns: 6 }, easing: power(2),
});

// Обход from: 'random' — перемешать готовый массив задержек (Fisher–Yates).
for (let i = delays.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [delays[i], delays[j]] = [delays[j]!, delays[i]!];
}

await Promise.all(
  cells.map((cell, i) =>
    animate(cell, { scale: [0, 1] }, { duration: 250, delay: delays[i] }).finished,
  ),
);

// Обход loop: 3 + alternate — конечный цикл, период — кортеж туда-обратно.
for (let i = 0; i < 3; i++) {
  await animate(cells[0]!, { y: [0, 16, 0] }, { duration: 400 });
}
```

Смежные страницы: [Framer Motion / Motion](./framer-motion.md),
[GSAP](./gsap.md) (там же — `createTimeline` для `anime.createTimeline`);
точные справки субпутей — [animate](../reference/animate.md),
[stagger](../reference/stagger.md), [easing](../reference/easing.md).
