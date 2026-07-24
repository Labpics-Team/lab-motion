# Миграция с GSAP за 15 минут

> Роль: справка — карта переноса `gsap.to`/`gsap.fromTo`/stagger/`gsap.timeline()` на субпути `./animate`, `./stagger`, `./timeline`, с честными границами (нет `gsap.from`-идиомы и plugin-экосистемы) и обходами.

## Назначение

Эта страница переносит конкретные вызовы GSAP на три субпутя `@labpics/motion`:
одиночные твины и пружины — `./animate`, каскадные задержки — `./stagger`,
секвенции — `./timeline`. Это карта переноса вызовов, а не утверждение о
совпадении возможностей или lifecycle; чего нет — сказано явно, с обходами.
Характеристики размера здесь не приводятся: снимок чисел даёт вывод `pnpm size`,
методология и сравнение с GSAP — [docs/benchmark.md](../benchmark.md).

Два правила, из-за которых чаще всего ломается портирование:

1. **Единицы времени различаются по субпутям.** `./animate` и `./stagger`
   считают в **миллисекундах** (GSAP — в секундах: `duration: 0.3` → `duration:
   300`). `./timeline` считает в **секундах** виртуального времени — здесь
   значения GSAP переносятся без пересчёта.
2. **Дефолтный режим `animate` — пружина, не твин.** `gsap.to(el, { x: 100 })`
   без `duration` — твин 0.5 c с `power1.out`; `animate(el, { x: 100 })` без
   tween-грамматики — пружина `spring.default` (`{ mass: 1, stiffness: 170,
   damping: 26 }`). Хотите твин — задайте `duration` (мс) и/или `ease`.

### gsap.to / gsap.fromTo → `./animate`

| GSAP | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `gsap.to(el, { x: 100, duration: 0.3 })` | `animate(el, { x: 100 }, { duration: 300 })` | **секунды → мс** |
| `gsap.to(el, { x: 100 })` | `animate(el, { x: 100 })` | у GSAP дефолт — твин 0.5 с; здесь — пружина `spring.default` |
| `gsap.fromTo(el, { x: 0, opacity: 0 }, { x: 100, opacity: 1, duration: 0.4 })` | `animate(el, { x: [0, 100], opacity: [0, 1] }, { duration: 400 })` | пара `[from, to]`; явный from отключает C¹-подхват (старт из покоя) |
| `gsap.to(el, { x: 100, ease: 'power2.out' })` | `animate(el, { x: 100 }, { duration: 300, ease: easeOut })` | строки-изинги → функции из `./easing` (таблица ниже) |
| `gsap.to(el, { x: 100, delay: 0.2 })` | `animate(el, { x: 100 }, { delay: 200, duration: 300 })` | мс |
| `gsap.to('.item', { y: 0, stagger: 0.06 })` | `animate('.item', { y: 0 }, { stagger: 60 })` | число = gap в мс между целями |
| `gsap.to(el, { keyframes: { x: [0, 120, -40, 0] } })` | `animate(el, { x: [0, 120, -40, 0] }, { duration: 600 })` | N-keyframe кортеж (≥ 3 стопов) + `options.times` / per-segment `ease: [...]` |
| `onComplete: () => {}` | `options.onComplete` | вызывается один раз при естественном оседании ВСЕХ целей |
| `const t = gsap.to(…); t.pause(); t.play()` | `const c = animate(…); c.pause(); c.play()` | |
| `t.progress(0.5)` | `c.seek(tMs)` | у GSAP — getter/setter доли; `seek` — write-only, абсолютные мс |
| `t.kill()` | `c.cancel()` (алиас `c.stop()`) | останавливает в текущей позиции; `finished` резолвится |
| `t.then(…)` / `await t` | `await animate(…)` ≡ `await c.finished` | контролы thenable |
| `gsap.to(el, { '--x': '100px' })` | `animate(el, { '--x': ['0px', '100px'] })` | CSS-переменная с юнитом |

Изинги: GSAP-строки → функции `@labpics/motion/easing` (полный каталог —
[docs/reference/easing.md](../reference/easing.md)):

| GSAP | `./easing` |
|---|---|
| `'none'` | `linear` |
| `'power2.in' / .out / .inOut'` (cubic) | `easeIn` / `easeOut` / `easeInOut` |
| `'power1.*'` (quad) | `power(2)` — In-форма; Out — композиция `(t) => 1 - power(2)(1 - t)` |
| `'sine.*'` | `sineIn` / `sineOut` / `sineInOut` |
| `'expo.*'` | `expoIn` / `expoOut` / `expoInOut` |
| `'circ.*'` | `circIn` / `circOut` / `circInOut` |
| `'back.*'` | `backIn` / `backOut` / `backInOut` |
| `'elastic'`, `'bounce'` | `elastic`, `bounce` (форму сверяйте по справке — параметризация иная) |
| `'steps(n)'` | `steps(n, 'start' \| 'end')` |
| CustomEase | `cubicBezier(x1, y1, x2, y2)` либо произвольная функция `t → прогресс` |

### stagger-конфиг GSAP → `./stagger`

Опция `stagger` в `animate` принимает число (gap, мс) или целиком
`StaggerOptions`; отдельная функция `stagger(count, options)` считает те же
задержки как чистый массив чисел — для собственной оркестрации.

| GSAP | `@labpics/motion` | Заметка |
|---|---|---|
| `stagger: 0.06` | `{ stagger: 60 }` | секунды → мс |
| `stagger: { each: 0.05, from: 'center' }` | `{ stagger: { gap: 50, from: 'center' } }` | `each` → `gap` (мс) |
| `from: 'start' / 'end'` | `from: 'first' / 'last'` | переименование |
| `from: 'edges'`, `from: index` | то же (`'edges'`, число) | числовой origin клампится в `[0, count−1]` |
| `stagger: { grid: [rows, cols] }` | `{ stagger: { grid: { columns } } }` | задаются только колонки; строки выводятся из count; расстояние евклидово, `'edges'` — минимум до границы сетки |
| `stagger: { ease: 'power1.in' }` | `{ stagger: { easing: power(2) } }` | функция на нормированную позицию [0, 1] |
| `stagger: { amount: 1 }` | прямого нет | обход: `gap = amountMs / (count − 1)` для линейного `from: 'first'` |
| `from: 'random'` | нет | обход: `stagger(count)` + свой shuffle массива задержек, затем per-цель `delay` (пример 3) |
| `grid: 'auto'`, `axis: 'x'/'y'` | нет | колонки задаются явно; осевой проекции нет |

### gsap.timeline() → `./timeline`

Главное отличие — честно: `createTimeline` — **headless-оркестратор числовых
сегментов**, а не секвенсор DOM-твинов. Сегмент — `from → to` (числа) с
`duration` в секундах; в DOM значения пишет ваш `onStep`. Грамматика
позиционирования при этом — паритет с GSAP position parameter.

| GSAP | `@labpics/motion/timeline` | Заметка |
|---|---|---|
| `gsap.timeline(); tl.to(el, { x: 100, duration: 0.5 })` | `createTimeline({ segments: [{ from: 0, to: 100, duration: 0.5, onStep }] })` | **секунды, без пересчёта**; DOM пишет `onStep` |
| position `1.2` (абсолютная) | `at: 1.2` | конечное число ≥ 0 |
| position `'<'` / `'>'` | `at: '<'` / `at: '>'` | старт / конец предыдущего сегмента |
| position `'+=0.2'` / `'-=0.2'` | `at: '+=0.2'` / `at: '-=0.2'` | у GSAP база — конец таймлайна, здесь — конец предыдущего сегмента (при последовательной сборке совпадают) |
| position `'intro'` / `'intro+=0.1'` | `at: 'intro'` / `at: 'intro+=0.1'` | неизвестная метка в `'label+=N'` — база 0 |
| `tl.addLabel('intro', 1)` | `labels: { intro: 1 }` при создании либо `controls.label('intro', 1)` | в опции `labels` регистрируются только числовые значения |
| `tl.seek(1.2)` / `tl.seek('intro')` | `controls.seek(1.2)` / `controls.seek('intro')` | неизвестная метка — no-op |
| `tl.pause()` / `tl.play()` | то же | таймлайн стартует сразу; для старта на паузе — `pause()` сразу после создания |
| `tl.progress()` / `tl.duration()` / `tl.time()` | `controls.progress` / `controls.totalDuration` / `controls.time` | read-only getters; запись — только `seek` |
| `tl.kill()` | `controls.cancel()` | стоп в текущей позиции + резолв Promise |
| `tl.progress(1)` | `controls.complete()` | снап всех сегментов к `to` + резолв |
| `await tl.then()` | `await controls` | thenable |

Обход для простых `tl.to(…).to(…)`-цепочек DOM-твинов: `./timeline` не
обязателен — секвенсором служит `async`/`await` поверх `./animate`
(`await animate(a, …); await animate(b, …)`; параллель — `Promise.all`).

### Чего нет — честно, с обходами

- **`gsap.from(el, { y: 16, opacity: 0 })`** (анимация ОТ значения К текущему)
  — идиомы нет: пара `[from, to]` требует явного финала. Обход: если значение
  покоя известно (обычный кейс enter-анимаций) — `animate(el, { y: [16, 0],
  opacity: [0, 1] })`; иначе прочитайте текущее значение сами
  (`getComputedStyle`) и подставьте вторым элементом пары.
- **`gsap.set(el, { x: 100 })`** — мгновенного сеттера нет; пишите стиль
  напрямую (`el.style.transform = 'translateX(100px)'`).
- **`repeat` / `yoyo` / `repeatDelay`** — нет в `./animate` и `./timeline`;
  политики повтора `loop | reverse | mirror` c `repeatDelay` — субпуть
  `./keyframes` ([справка](../reference/timeline-keyframes.md)).
- **`onUpdate`** — per-frame колбэка в `./animate` нет; значение под своим
  колбэком — `./driver` / `MotionValue` (корень) либо `onStep` в `./timeline`.
- **`timeScale` / `reverse` / `restart` / getters `time`/`duration`** — нет на
  контролах `./animate` (есть `play/pause/seek/cancel/stop`); scrubbable-контроллер
  с `reverse`/`timeScale`/`progress` для headless-значений — `./driver`.
- **Вложенные таймлайны** (`tl.add(childTl)`) — нет; композируйте сегменты в
  один `createTimeline` через `at`/метки.
- **Plugin-экосистема** — плагинов и их регистрации нет; эквиваленты по смыслу
  разнесены по субпутям: ScrollTrigger → `./scroll` + `./in-view`; Draggable /
  InertiaPlugin → `./gestures` (`createDrag`) + `./decay`; Flip → `./flip` /
  `./projection` / `./smart`; MorphSVGPlugin → `./svg-morph`
  (`interpolatePath`); DrawSVGPlugin / MotionPathPlugin → `./svg` (`drawPath`,
  `createMotionPath`); TextPlugin / SplitText / ScrambleText → `./presets`
  (`splitText`, `runTypewriter`, `runScramble`); `gsap.ticker` → `./frame`;
  `gsap.utils` (`mapRange`, `clamp`, `snap`, `wrap`, `pipe`, `interpolate`) →
  `./utils`.

## Импорт

```ts
import { animate } from '@labpics/motion/animate';
import { stagger } from '@labpics/motion/stagger';
import { createTimeline } from '@labpics/motion/timeline';
```

Смежные публичные пути: готовые кривые и фабрики изингов —
`@labpics/motion/easing`; `fromBounce({ duration, bounce })` для мышления в
duration/bounce — `@labpics/motion/spring`; `MotionParamError` и `type
SpringParams` — корень `@labpics/motion`.

## API

Здесь — минимум для переноса; полные страницы:
[reference/animate.md](../reference/animate.md),
[reference/stagger.md](../reference/stagger.md),
[reference/timeline-keyframes.md](../reference/timeline-keyframes.md). Каталог
LM-кодов с лечением — [docs/errors.md](../errors.md).

### animate (`./animate`)

```ts
function animate(
  target: AnimateTarget,   // Element | список | CSS-селектор (резолв в вызове)
  props: AnimateProps,     // x/y/scale/rotate/… , opacity, любые CSS-свойства
  options?: AnimateOptions,
): AnimateControls;
```

Все времена — **миллисекунды**. Параметры `options` (режимы `spring` и
`duration`/`ease`/`times` взаимоисключающие — одновременно `LM136`):

- `spring?: SpringParams` — режим пружины; дефолт всего вызова без
  tween-грамматики: `{ mass: 1, stiffness: 170, damping: 26 }` (токен
  `spring.default`). Валидация — транзитом `LM088`–`LM091`.
- `duration?: number` — мс, конечная, `> 0` (`LM137`); дефолт 200 (токен
  `duration.base`), если tween выбран через `ease`/`times`.
- `ease?: fn | fn[]` — функция `t∈[0,1] → прогресс` (не-функция — `LM138`);
  дефолт `easing.standard` (`cubic-bezier(0.2, 0, 0, 1)`); массив — per-segment
  изинги N-keyframe вызова длиной `N − 1` (нарушение — `LM169`).
- `times?: number[]` — offsets N-keyframe вызова: длина `N`, конечные,
  неубывающие, `0 → 1` (нарушение — `LM168`); дефолт — равномерные.
- `delay?: number` — мс, `≥ 0`, дефолт 0 (`LM139`).
- `stagger?: number | StaggerOptions` — число = gap в мс (`LM139` при
  некорректном) либо конфиг `./stagger` как есть.
- `onComplete?: () => void` — один раз при естественном оседании всех целей.
- Швы `requestFrame` / `matchMedia` / `now` / `setTimer` — детерминизм и
  reduced-motion; дефолты — платформенные.

Возврат — `AnimateControls`: `finished: Promise<void>` (резолвится при любом
завершении, не реджектится), thenable (`await animate(…)` ≡ `await
….finished`), `play()`, `pause()`, `seek(tMs)` (write-only, мс), `cancel()`,
`stop()` (алиас `cancel`). Повторный `animate` того же элемента/канала —
прерывание с C¹-подхватом (value и velocity), кроме явного from.

Бросает `MotionParamError` рано, ДО записей в стиль: `LM136`–`LM139` (режим,
duration, ease, delay/stagger), `LM140`–`LM144` (ключ `transform` целиком,
короткий массив, не-конечное число, не-строка/число в CSS-канале, неразобранный
синтаксис), `LM146`/`LM147`/`LM149` (цели/селектор), `LM150` (непредставимый
импульс подхвата), `LM151`/`LM156` (не-объект props/options), `LM157`
(реентрантная смена владельца), `LM168`/`LM169` (times/топология),
`LM088`–`LM091` (пружина).

### stagger (`./stagger`)

```ts
function stagger(count: number, options?: StaggerOptions): number[];

interface StaggerOptions {
  gap?: number;                       // мс; дефолт 50; неконечный/отрицательный → дефолт
  from?: 'first' | 'last' | 'center' | 'edges' | number; // дефолт 'first'
  easing?: (t: number) => number;     // на позицию [0,1]; дефолт identity
  grid?: { columns: number };         // 2D-дистанции по сетке
  reducedMotion?: boolean;            // дефолт false; true → все задержки 0
}
```

Чистая функция: `(count, options)` → массив из `count` конечных неотрицательных
задержек (мс). `count` — положительное конечное целое; `0`/отрицательное/не-конечное
→ `[]`, `1` → `[0]`; сверхбольшой `count` клампится к пределу 100 000 (не
зануляется). **Не бросает никогда**: NaN/∞ на любом входе (включая выход
`easing`) зажимается к 0. Zero-DOM: `reducedMotion` определяет вызывающий
(`matchMedia('(prefers-reduced-motion: reduce)')`) — сама функция DOM не читает.

### createTimeline (`./timeline`)

```ts
function createTimeline(opts: TimelineOptions): TimelineControls;

interface SegmentConfig {
  from: number;                   // конечное число
  to: number;                     // конечное число
  duration: number;               // СЕКУНДЫ; > 0, конечная
  offset?: number;                // секунды после конца предыдущего; >= 0; дефолт 0
  at?: number | string;           // абсолют | 'label' | '<' | '>' | '+=N' | '-=N' | 'label+=N'
  easing?: (t: number) => number; // дефолт — линейная идентичность
  onStep?: (value: number) => void;
}

interface TimelineOptions {
  segments: readonly SegmentConfig[];                 // обязательный, непустой
  onStep?: (values: readonly SegmentValue[]) => void; // буфер переиспользуется — не сохраняйте ссылку
  requestFrame?: (cb: (ts?: number) => void) => number;
  matchMedia?: (query: string) => MatchMediaResult;   // { matches: boolean }
  labels?: Record<string, number | string>;           // регистрируются только числа >= 0
}
```

Все времена — **секунды** виртуального времени (как в GSAP). Воспроизведение
начинается немедленно. Возврат — `TimelineControls`: getters `totalDuration` /
`time` (секунды) / `progress` ([0, 1]); `play()` / `pause()`;
`seek(t: number | string)` (`NaN` — no-op, `< 0` → 0, `+Infinity` →
`complete()`, строка — метка); `complete()` (снап к `to` + резолв); `cancel()`
(стоп в текущей позиции + резолв); `label(name, at?)`; thenable (`await
createTimeline(…)`).

Бросает `MotionParamError`: `LM102` (`from` неконечен), `LM103` (`to`
неконечен), `LM104` (`duration` неположительна/неконечна), `LM105` (числовой
`at` неконечен или `< 0`), `LM106` (`offset` неконечен или `< 0`), `LM107`
(`segments` пуст).

### Type-only экспорты

- `./animate`: `AnimatableElement`, `AnimateTarget`, `AnimatePropValue`,
  `AnimateProps`, `AnimateOptions`, `AnimateControls`.
- `./stagger`: `StaggerOptions`, `StaggerFrom`, `StaggerGridOptions`.
- `./timeline`: `TimelineOptions`, `TimelineControls`, `SegmentConfig`,
  `SegmentValue`, `MatchMediaResult`.

## Контракты

- **SSR-safe.** Импорт любого из трёх субпутей не трогает `window`/`document`.
  `./stagger` и `./timeline` — zero-DOM целиком (в `./timeline` `matchMedia` —
  структурная инъекция `{ matches }`); `./animate` резолвит селектор и читает
  capability только в момент вызова.
- **Reduced-motion — смена характера, не выключение.** `./animate`: мгновенная
  запись финальных значений без кадров (засчитывается естественным завершением);
  `./timeline`: однократный синхронный снап всех сегментов к `to` + резолв;
  `./stagger` при `reducedMotion: true`: задержки схлопываются в 0 — элементы
  анимируются одновременно.
- **Финитность.** `./animate` и `./timeline` бросают `MotionParamError` на
  не-конечных входах рано; NaN/∞ не эмитятся никогда (в `./timeline` выход
  пользовательского easing зашит guard'ом: NaN → 0, ±∞ → ±`Number.MAX_VALUE`);
  `./stagger` вместо бросков зажимает ошибочные значения к 0.
- **Детерминизм.** Время — только через инжектируемый `requestFrame` (плюс
  `now`/`setTimer` compositor-пути `./animate`); `stagger` — чистая функция:
  одинаковые входы → бит-идентичные массивы на любой платформе.

## Примеры

`gsap.to` / `gsap.fromTo` + stagger одной строкой (мс; дефолт — пружина):

```ts
import { animate } from '@labpics/motion/animate';
import { easeOut } from '@labpics/motion/easing';

const card = document.querySelector('.card') as HTMLElement;

// gsap.to(card, { x: 240, duration: 0.3, ease: 'power2.out' })
await animate(card, { x: 240 }, { duration: 300, ease: easeOut });

// Без tween-грамматики режим — пружина spring.default (у GSAP был бы твин 0.5 c).
await animate(card, { scale: 1.05 });

// gsap.fromTo('.list li', { y: 16, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.06 })
// — а заодно обход gsap.from: значения покоя (0, 1) заданы явным финалом пары.
await animate(
  '.list li',
  { y: [16, 0], opacity: [0, 1] },
  { duration: 300, ease: easeOut, stagger: 60 },
);
```

`gsap.timeline()` с position parameters → `createTimeline` (секунды — без
пересчёта; DOM пишет `onStep`):

```ts
import { createTimeline } from '@labpics/motion/timeline';

const panel = document.querySelector('.panel') as HTMLElement;
const badge = document.querySelector('.badge') as HTMLElement;

// tl.to(panel, { x: 240, duration: 0.5 })
//   .to(badge, { opacity: 1, duration: 0.3 }, '-=0.1')
//   .addLabel('shown', 0.7)
const tl = createTimeline({
  labels: { shown: 0.7 },
  segments: [
    {
      from: 0, to: 240, duration: 0.5,
      onStep: (x) => { panel.style.transform = `translateX(${x}px)`; },
    },
    {
      from: 0, to: 1, duration: 0.3, at: '-=0.1', // 0.1 c до конца предыдущего
      onStep: (o) => { badge.style.opacity = String(o); },
    },
  ],
});

tl.pause();        // стартует сразу — пауза до первого кадра
tl.seek('shown');  // перемотка к метке (секунды), эмитит значения
tl.play();
await tl;          // резолв при завершении (natural / complete / cancel)
```

Standalone `stagger()`: сетка от центра + обход `from: 'random'` собственным
shuffle (задержки — per-цель `delay` отдельных вызовов):

```ts
import { animate } from '@labpics/motion/animate';
import { stagger } from '@labpics/motion/stagger';
import { easeIn } from '@labpics/motion/easing';

const cells = [...document.querySelectorAll('.grid .cell')] as HTMLElement[];

// gsap: stagger: { each: 0.04, from: 'center', grid: [rows, 6], ease: 'power2.in' }
const delays = stagger(cells.length, {
  gap: 40, from: 'center', grid: { columns: 6 }, easing: easeIn,
});

// Обход from: 'random' — перемешать готовый массив задержек (Fisher–Yates).
for (let i = delays.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [delays[i], delays[j]] = [delays[j]!, delays[i]!];
}

await Promise.all(
  cells.map((cell, i) =>
    animate(cell, { opacity: [0, 1] }, { duration: 250, delay: delays[i] }).finished,
  ),
);
```
