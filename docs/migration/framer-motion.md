# Миграция с Framer Motion / Motion за 15 минут

> Роль: справка — карта переноса вызовов Framer Motion / Motion на субпути `./animate`, `./nano`, `./spring`, `./presence`, `./in-view`: таблицы соответствий, единицы времени (миллисекунды против секунд), точные сигнатуры и честный список отсутствующего.

## Назначение

Страница переносит **конкретные вызовы** Framer Motion / Motion (в т.ч. `motion/mini`)
на пять субпутей `@labpics/motion`. Это карта переноса, а не утверждение о
совпадении возможностей, поведения или lifecycle (полный целевой охват — в
[roadmap #106](https://github.com/Labpics-Team/lab-motion/issues/106)):

| Что у Motion | Куда переносится |
|---|---|
| `animate(el, props, options)` (hybrid) | [`./animate`](../reference/animate.md) — фасад-one-liner |
| `animate` из `motion/mini` (WAAPI) | [`./nano`](../reference/nano.md) — platform-trusted WAAPI-вход |
| `type: 'spring'`, `duration`/`bounce`/`visualDuration`, spring-easing | [`./spring`](../reference/spring.md) — конструкторы `SpringParams` |
| `<AnimatePresence>` (exit-анимации) | [`./presence`](../reference/presence.md) — headless enter/exit машина |
| `inView()` / `whileInView` / `useInView` | [`./in-view`](../reference/scroll-in-view.md) — `IntersectionObserver`-адаптер |

Характеристики размера — не в этой странице: снимок чисел даёт вывод
`pnpm size` / `bench/compare/size-compare.mjs`, методология — в
[docs/benchmark.md](../benchmark.md).

## Главный закон миграции: МИЛЛИСЕКУНДЫ, не секунды

Motion считает время в **секундах**; DOM-фасады `@labpics/motion` — в
**МИЛЛИСЕКУНДАХ**. Это источник 90% ошибок переноса — умножайте на 1000:

| Величина | Motion | `@labpics/motion` |
|---|---|---|
| `duration` в `animate` | `0.3` (сек) | `300` (**мс**) — `./animate`, `./nano` |
| `delay` | `0.1` (сек) | `100` (**мс**) |
| каскад | `delay: stagger(0.05)` (сек) | `stagger: 50` (**мс**, шаг между целями) |
| перемотка | `a.time = 0.5` (сек, getter/setter) | `a.seek(500)` (**мс**, write-only) |
| перцептивные пружины (`./spring`) | `duration`/`visualDuration` в сек | **секунды** — канон SwiftUI/Motion сохранён намеренно: вход Motion переносится без пересчёта |

Единственное «секундное» исключение — конструкторы `./spring`
(`fromBounce`, `fromVisualDuration`, `fromPeak`, `fromOscillation`): их
координаты перцептивные (канон SwiftUI `Spring(duration:bounce:)` и Motion
`visualDuration`), поэтому значение из Motion-кода копируется как есть.

## Импорт

```ts
import { animate } from '@labpics/motion/animate';
import { animate as nanoAnimate } from '@labpics/motion/nano';
import {
  fromBounce,
  fromVisualDuration,
  fromPeak,
  fromOscillation,
  springPresets,
  springAsEasing,
} from '@labpics/motion/spring';
import { createPresence, swapPresence } from '@labpics/motion/presence';
import { inView, MotionParamError } from '@labpics/motion/in-view';
```

Тип `SpringParams` (и чистый солвер `spring()`, `MotionParamError` с типом
кода) экспортируется корневым субпутём `@labpics/motion`.

## Таблица соответствий: `animate` → `./animate`

| Motion | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `animate(el, { x: 100 })` | `animate(el, { x: 100 })` | совпадает `x`/`y`-срез transform-шортхендов; у Motion набор осей шире |
| `animate('.item', { … })` | `animate('.item', { … })` | селектор резолвится через `document.querySelectorAll` в момент вызова |
| `animate(el, { opacity: [0, 1] })` | `animate(el, { opacity: [0, 1] })` | пара `[from, to]` — тот же смысл; явный `from` отключает подхват |
| `animate(el, { x: [0, 120, -40, 0] }, { times })` | то же | N-keyframe кортежи + `times` + per-segment `ease: [...]` |
| `animate(el, { x: 100 }, { duration: 0.3 })` | `…, { duration: 300 }` | **мс, не секунды** |
| `animate(el, { x: 100 }, { delay: 0.1 })` | `…, { delay: 100 }` | мс |
| `animate('.item', …, { delay: stagger(0.05) })` | `…, { stagger: 50 }` | число = шаг-мс; конфиг `./stagger` (`gap`, `from`, `easing`, `grid`, `reducedMotion`) тоже принимается |
| `{ type: 'spring', stiffness: 200, damping: 20 }` | `{ spring: { mass: 1, stiffness: 200, damping: 20 } }` | все три поля `SpringParams` обязательны |
| `{ type: 'spring', duration: 0.5, bounce: 0.25 }` | `{ spring: fromBounce({ duration: 0.5, bounce: 0.25 }) }` | секунды остаются секундами |
| `{ type: 'spring', visualDuration: 0.4, bounce: 0.3 }` | `{ spring: fromVisualDuration({ visualDuration: 0.4, bounce: 0.3 }) }` | секунды |
| `{ ease: 'easeOut' }` | `{ ease: fn }` | `ease` — JS-функция `(t) => number`; готовые кривые — субпуть `./easing`; CSS-строки — грамматика `./nano` |
| `await animate(…)` / `.then(…)` | то же | контролы thenable; `finished` доступен отдельным Promise |
| `const a = animate(…); a.pause(); a.play()` | то же | после естественного завершения Motion перезапускается, Lab Motion — нет |
| `a.time = 0.5` | `a.seek(500)` | write-only, мс; пауза сохраняется |
| `a.stop()` | `a.stop()` | оба сохраняют текущую позу; в Lab Motion `stop` — алиас `cancel` |
| `a.cancel()` | прямого эквивалента нет | Motion возвращает initial pose; Lab Motion сохраняет текущую |
| `animate(el, { '--x': 100 })` | `animate(el, { '--x': ['0px', '100px'] })` | CSS-переменная с явным юнитом |
| `onComplete` в options | `onComplete` | вызывается один раз, когда все цели осели естественно |

## Таблица соответствий: `motion/mini` → `./nano`

`./nano` — доверенная современная платформа: native `Element.animate`,
`Animation.commitStyles`, CSS `linear()`; без rAF-fallback, C¹-подхвата и
hostile/polyfill-защиты (это контракт полного `./animate`).

| `motion/mini` | `@labpics/motion/nano` | Заметка |
|---|---|---|
| `animate(el, { transform: 'translateX(240px)' })` | `nanoAnimate(el, { translate: '240px' })` | nano ведёт целые CSS longhand-каналы `translate`/`scale`/`rotate`; шортхенды `x`/`y` — грамматика `./animate` (типы `x`/`y`/`translateX`/`translateY` запрещены) |
| `animate(el, { opacity: [0, 1] })` | `nanoAnimate(el, { opacity: [0, 1] })` | пара `[from, to]` однородна по типу (числа ИЛИ строки) |
| `{ duration: 0.3, ease: 'ease-out' }` | `{ duration: 300, ease: 'ease-out' }` | **мс**; `ease` — нативная CSS-строка |
| `{ type: spring(...) }` | `{ spring: { mass: 1, stiffness: 170, damping: 26 } }` | пружина компилируется в CSS `linear()`; `spring` и `duration`/`ease` взаимоисключающие на уровне типов |
| контролы Motion | `Animation[]` | каждый элемент — нативный `Animation`: `const controls = animate(...)`, общий финал — `Promise.all(controls.map((a) => a.finished))` |

## `useAnimate` / `motion.div` → фасад и адаптеры

Компонентного слоя (`motion.div`, JSX-пропсы `animate`/`initial`/`exit`/
`variants`) в пакете нет — движок headless. Перенос:

| Motion (React) | `@labpics/motion` |
|---|---|
| `const [scope, animate] = useAnimate()` | `animate` из `./animate` напрямую: `animate(ref.current as HTMLElement, …)`; scoped-селекторов нет — строка-селектор резолвится глобально через `document.querySelectorAll` |
| `<motion.div animate={{ x: 100 }} />` | императивный `animate(el, { x: 100 })` в effect; либо хуки `./react` (`useSpring`, `useMotionValue`, `useMotionStyle`) — см. [adapters](../reference/adapters.md) |
| `<motion.div exit={{ opacity: 0 }} />` + `<AnimatePresence>` | `createPresence` + `swapPresence` (`./presence`): выходную анимацию запускаете сами в `onExitStart`, элемент убираете в `onGone` |
| `whileInView` / `useInView` / `inView()` | `inView(target, onEnter, { root, margin, amount })` из `./in-view` — та же форма, что standalone `inView` Motion |
| `useReducedMotion()` | `useReducedMotion` из `./react` (вне охвата страницы) |
| `whileHover` / `whileTap` / `drag` | субпуть `./gestures` (вне охвата страницы) |
| `layout` / `layoutId` | субпути `./flip`, `./projection`, `./smart` (вне охвата страницы) |
| `useScroll` / `useTransform` | субпути `./scroll`, `./utils` (вне охвата страницы) |

## Чего НЕТ (честно)

Не переносится ничем из пяти субпутей:

- **Компоненты и JSX-пропсы**: `motion.*`, `variants`,
  `staggerChildren`/`delayChildren`-оркестрация — движок headless.
- **Per-property transitions**: `transition: { x: {…}, opacity: {…} }` — один
  режим (`spring` ИЛИ `duration`/`ease`) на вызов `animate`.
- **`repeat` / `repeatType` (`reverse`/`mirror`) / `repeatDelay`** — в
  `./animate` отсутствуют.
- **Value/object targets**: `animate(0, 100, …)`, анимация полей объектов —
  фасад анимирует только CSS-стили DOM/SVG-элементов; headless-значения — это
  `MotionValue` корневого субпутя.
- **HTML/SVG-атрибуты и path-specific каналы** (`pathLength` и т.п.) —
  draw-математика живёт в `./svg`, но не в `animate`.
- **Sequences / timeline внутри `animate`** — оркестрация есть в отдельном
  `./timeline`, общего owner/lifecycle с фасадом нет.
- **Контролы**: нет getters `time`/`speed`/`duration`, нет `reverse`,
  `complete`, `restart`; `cancel()` Motion (возврат к initial pose)
  эквивалента не имеет — наш `cancel`/`stop` сохраняет текущую позу; `play()`
  после естественного завершения не перезапускает.
- **`<AnimatePresence>` целиком**: `popLayout`, `propagate`, авто-подхват
  ушедших детей из React-дерева — `./presence` headless: о завершении фазы
  сообщаете вы (`done`), из DOM убираете вы (`onGone`).
- **Live-подписка на смену `prefers-reduced-motion` в полёте** — предпочтение
  читается один раз на вызов/фазу (живая подписка — `createMotionConfig` из
  `./a11y`, влияет на будущие запуски).

## API

### `./animate`

Единственный runtime-экспорт — `animate`. Type-only экспорты:
`AnimatableElement`, `AnimateTarget`, `AnimatePropValue`, `AnimateProps`,
`AnimateOptions`, `AnimateControls`.

```ts
import type {
  AnimateTarget,
  AnimateProps,
  AnimateOptions,
  AnimateControls,
} from '@labpics/motion/animate';

declare function animate(
  target: AnimateTarget,          // Element | список (Array/NodeList) | CSS-селектор
  props: AnimateProps,            // Record<string, number | string | readonly (number | string)[]>
  options?: AnimateOptions,       // по умолчанию {}
): AnimateControls;
```

`props` — каналы движения: transform-шортхенды (`x`/`y`/`scale`/`rotate`/…),
`opacity`, любые CSS-свойства и `--переменные`. Значение канала — цель,
пара `[from, to]` (явный `from` отключает подхват скорости) или N-keyframe
кортеж длины ≥ 3. Свойство `transform` целиком запрещено (`LM140`).

`options` (все времена — **миллисекунды**):

| Поле | Тип | Дефолт | Семантика |
|---|---|---|---|
| `spring` | `SpringParams` | режим по умолчанию: `{ mass: 1, stiffness: 170, damping: 26 }` (SSOT токена `spring.default`) | режим пружины; взаимоисключим с `duration`/`ease`/`times` (`LM136`) |
| `duration` | `number`, **мс**, конечное `> 0` | `200` (токен `duration.base`), если задан только `ease`/`times` | режим tween |
| `ease` | `(t: number) => number` или массив длины `N−1` | standard `cubic-bezier(0.2, 0, 0, 1)` | JS-функция; массив — per-segment изинги N-keyframe вызова |
| `times` | `readonly number[]` | равномерные offsets | offsets N-keyframe вызова: конечные, неубывающие, `times[0]=0`, `times[N−1]=1`; дубликаты легальны (right-biased скачок) |
| `delay` | `number`, **мс**, `≥ 0` | `0` | задержка старта всем целям |
| `stagger` | `number` (**мс**-гап) или `StaggerOptions` | нет | каскад для многих целей |
| `onComplete` | `() => void` | нет | один раз, когда ВСЕ цели осели естественно (не `cancel`) |
| `requestFrame` / `matchMedia` / `now` / `setTimer` | швы | rAF / `globalThis.matchMedia` / `performance.now` / `setTimeout` | инжекция среды (детерминизм тестов, SSR) |

Возврат — агрегированные контролы (thenable: `await animate(…)` ≡
`await animate(…).finished`):

```ts
interface AnimateControls extends PromiseLike<void> {
  readonly finished: Promise<void>; // резолв при завершении всех целей (естественном ИЛИ cancel/stop)
  play(): void;                     // возобновить после pause()
  pause(): void;                    // заморозить (кадры не эмитятся)
  seek(tMs: number): void;          // мс; write-only; пауза сохраняется; нефинитное игнорируется
  cancel(): void;                   // остановить в текущей позе; finished резолвится
  stop(): void;                     // алиас cancel()
}
```

Бросаемые `MotionParamError` (все — рано, ДО записей в стиль; полный каталог —
[docs/errors.md](../errors.md)): `LM156` (options не объект), `LM151` (props
не объект-запись), `LM136` (конфликт режимов, включая трек + явная пружина),
`LM137` (duration), `LM138` (ease не функция), `LM169` (длина ease-массива ≠
числу сегментов), `LM168` (times/топология), `LM139` (delay/stagger),
`LM088`–`LM091` (валидация `SpringParams`, включая бюджет времени оседания),
`LM149` (селектор без `document`), `LM146`/`LM147` (контейнер/элемент целей),
`LM140` (whole `transform`), `LM141` (битая пара/кортеж), `LM142` (нефинитное
число), `LM143`/`LM144` (тип/синтаксис CSS-значения), `LM150` (непредставимый
импульс), `LM157` (реентрантная смена владельца).

### `./nano`

Единственный runtime-экспорт — `animate`. Type-only экспорты: `NanoSpring`,
`NanoOptions`, `NanoPair`, `NanoProps`, `NanoTarget`, `NanoControls`.

```ts
import type {
  NanoTarget,
  NanoProps,
  NanoOptions,
  NanoControls,
} from '@labpics/motion/nano';

declare function animate(
  target: NanoTarget,    // Element | string | Iterable<Element> | ArrayLike<Element>
  props: NanoProps,      // longhand-каналы; rotate — только скаляр (deg-суффикс)
  options?: NanoOptions, // по умолчанию {}
): NanoControls;         // Animation[] & { finished: Promise<Animation[]> }
```

`options` (времена — **миллисекунды**): `delay` (мс), `stagger` (мс-шаг между
целями), `reducedMotion` (явный boolean; иначе `prefers-reduced-motion`
читается в момент вызова), и взаимоисключимо на уровне типов — `spring`
(`NanoSpring`, по умолчанию `mass/stiffness/damping = 1/170/26`) ИЛИ
`duration` (мс, обязателен в tween-ветке) + `ease` (нативная CSS-строка, по
умолчанию `'ease'`).

Каждая цель получает нативный `element.animate(frame, { fill: 'both' })`; по
`finish` вызываются `commitStyles()` + `cancel()` (финал остаётся в inline
style). Под reduced-motion — `duration: 0`, `delay: 0`, `easing: 'linear'`:
мгновенный финал, характер, а не выключение.

Ошибки: `MotionParamError` здесь НЕТ — по platform-trusted контракту
defensive-границы нет. Невалидная или непредставимая конечной кривой пружина
бросает `RangeError` (`'spring parameters must be finite and positive'`,
`'spring is not representable'`); остальное — нативные исключения платформы.

### `./spring`

Runtime-экспорты: `fromBounce`, `fromVisualDuration`, `fromPeak`,
`fromOscillation`, `springPresets`, `springAsEasing`. Type-only экспорты:
`FromBounceOptions`, `FromVisualDurationOptions`, `FromPeakOptions`,
`FromOscillationOptions`. Все конструкторы — точные преобразования (#218,
#230): без скрытой коэрсии под бюджет исполнителя; выход проверяется
физической границей (`validateSpringPhysics` → транзитом `LM088`–`LM090`).
Невалидная `mass` в опциях тихо заменяется на `1` (дефолт, не ошибка).

```ts
import type { SpringParams } from '@labpics/motion';

declare function fromBounce(options: {
  readonly duration: number;          // СЕКУНДЫ, > 0 (перцептивная длительность)
  readonly bounce: number;            // ∈ [−1, 1]; 0 — критическое демпфирование
  readonly mass?: number | undefined; // по умолчанию 1
}): SpringParams;
```

Канон SwiftUI `Spring(duration:bounce:)`: `ζ = 1 − bounce`, `ω₀ = 2π/duration`.
Motion принимает подмножество `bounce ∈ [0, 1]` — любой Motion-вход валиден.
`bounce = 1` честно означает `damping = 0`. Бросает `LM093` (duration),
`LM092` (bounce).

```ts
import type { SpringParams } from '@labpics/motion';

declare function fromVisualDuration(options: {
  readonly visualDuration: number;    // СЕКУНДЫ, > 0: время ПЕРВОГО касания цели
  readonly bounce: number;            // ∈ [−1, 1]
  readonly mass?: number | undefined; // по умолчанию 1
}): SpringParams;
```

Класс Motion `visualDuration`: для `ζ < 1` — точное решение первого
пересечения `x(t) = 1`; для `ζ ≥ 1` пересечения нет — `visualDuration`
трактуется как выход на ~99% цели по медленнейшей моде. Бросает `LM093`,
`LM092`.

```ts
import type { SpringParams } from '@labpics/motion';

declare function fromPeak(options: {
  readonly overshoot: number;         // доля первого перелёта ∈ (0, 1]
  readonly peakTime: number;          // СЕКУНДЫ, > 0: время первого пика
  readonly mass?: number | undefined; // по умолчанию 1
}): SpringParams;
```

Обратное преобразование из наблюдаемого первого перелёта (underdamped из
покоя). `overshoot = 0` не имеет underdamped-прообраза и отклоняется `LM171`
(без epsilon-подмены) — «без перелёта» описывается `fromBounce({ bounce: 0 })`.
Бросает `LM171` (overshoot), `LM093` (peakTime). Аналога у Motion нет.

```ts
import type { SpringParams } from '@labpics/motion';

declare function fromOscillation(options: {
  readonly period: number;            // СЕКУНДЫ, > 0: период затухающих колебаний
  readonly halfLife: number;          // СЕКУНДЫ, > 0: амплитуда огибающей падает вдвое
  readonly mass?: number | undefined; // по умолчанию 1
}): SpringParams;
```

Из наблюдаемого периода и half-life огибающей; всегда underdamped. Бросает
`LM093`. Аналога у Motion нет.

```ts
import type { SpringParams } from '@labpics/motion';

declare const springPresets: Readonly<Record<
  'default' | 'gentle' | 'wobbly' | 'stiff' | 'slow' | 'molasses',
  SpringParams
>>;
```

Замороженные канонические пресеты react-spring (tension/friction при
`mass = 1`); `springPresets.default` = `{ mass: 1, stiffness: 170, damping: 26 }`.

```ts
import type { SpringParams } from '@labpics/motion';

declare function springAsEasing(params: SpringParams): (t: number) => number;
```

Пружина как easing-функция `t ∈ [0, 1] → value` для tween/keyframe-слотов
(форма OVERSHOOTING при `ζ < 1`). Шкала нормализована: `t = 1` — выведенный
конечный горизонт оседания, хвост запечатан C¹ Hermite-коррекцией; эндпоинты
точны, вход клампится, `NaN → 0`. В отличие от spring-easing Motion
длительность НЕ выводится — `duration` tween выбираете сами. Бросает
`LM088`–`LM090` (физика), `LM167` (`ζ = 0`: незатухающая пружина не имеет
конечного easing-горизонта).

### `./presence`

Runtime-экспорты: `createPresence`, `swapPresence`. Type-only экспорты:
`PresenceState`, `PresenceSnapshot`, `PresencePhaseStart`, `PresenceOptions`,
`PresenceControls`, `SwapPresenceOptions`.

```ts
import type { PresenceSnapshot } from '@labpics/motion/presence';

declare function createPresence<S = PresenceSnapshot>(
  options?: PresenceOptions<S>,
): PresenceControls;

type PresenceState = 'gone' | 'entering' | 'present' | 'exiting';

interface PresenceOptions<S = PresenceSnapshot> {
  readonly initiallyPresent?: boolean;           // по умолчанию false → 'gone'
  readonly onEnterStart?: PresencePhaseStart<S>; // старт входной анимации
  readonly onExitStart?: PresencePhaseStart<S>;  // старт выходной анимации
  readonly onPresent?: () => void;               // терминально вошли
  readonly onGone?: () => void;                  // терминально ушли — безопасно убирать из DOM
  readonly matchMedia?: (query: string) => { matches: boolean }; // шов prefers-reduced-motion
}

type PresencePhaseStart<S> = (
  done: () => void,                 // сообщить о завершении фазы; после прерывания инертен
  interrupted: S | undefined,       // снимок прерванного встречного рана (наследование импульса)
  capture: (read: () => S) => void, // зарегистрировать живой снимок ТЕКУЩЕГО рана
) => void;

interface PresenceControls {
  enter(): void;                    // идемпотентен в entering/present
  exit(): void;                     // идемпотентен в exiting/gone
  onStateChange(cb: (state: PresenceState) => void): () => void; // синхронно; авторитетен controls.state
  readonly state: PresenceState;
}
```

Замена `<AnimatePresence>`: анимации запускаете вы в `onEnterStart`/
`onExitStart` и зовёте `done` по завершении; `onGone` — момент убрать элемент
из DOM. `done` привязан к своей фазе поколением: после прерывания завершение
старой анимации машину не двигает. `interrupted`/`capture` — наследование
импульса при прерывании (`PresenceSnapshot`: `value` в единицах значения,
`velocity` — units/s); reduce-ветка снимок не читает. Аниматор фазы не задан →
переход мгновенен. Ошибок не бросает.

```ts
import type { PresenceControls } from '@labpics/motion/presence';

declare function swapPresence(
  prev: PresenceControls,
  next: PresenceControls,
  options: { readonly mode: 'wait' | 'sync' },
): void;
```

Координатор замены old→new (класс режимов `<AnimatePresence mode>`):
`'wait'` — вход нового только по терминальному `'gone'` старого (прерывание
exit'а отменяет своп); `'sync'` — exit и enter стартуют одновременно.
Контракт `'wait'`: если `done` exit-анимации старого никогда не вызовут,
новый не войдёт — машина без таймеров и не «дотаймаутит» за вас.

### `./in-view`

Runtime-экспорты: `inView` и класс `MotionParamError` (экспортирован рядом
для корректного `instanceof` у физически отдельного entry). Type-only
экспорты: `MotionParamErrorCode`, `InViewAmount`, `InViewTarget`,
`InViewLeaveHandler`, `InViewEnterHandler`, `InViewOptions`, `InViewStop`.

```ts
import type {
  InViewTarget,
  InViewEnterHandler,
  InViewStop,
} from '@labpics/motion/in-view';

declare function inView(
  target: InViewTarget,        // Element | CSS-селектор | конечный array-like (NodeList)
  onEnter: InViewEnterHandler, // (target, entry) => void | leave-handler
  options?: InViewOptions,     // по умолчанию {}
): InViewStop;                 // () => void, идемпотентен

interface InViewOptions {
  readonly root?: Element | Document | null; // корень IO; null/undefined = viewport
  readonly margin?: string;                  // нативный rootMargin, напр. '0px 0px -20%'
  readonly amount?: 'some' | 'all' | number; // 'some' (default) | 'all' | доля [0, 1]
}
```

Форма standalone `inView` Motion сохранена: вернули из `onEnter`
leave-handler — получаете парный enter/leave lifecycle; не вернули — цель
one-shot (после входа наблюдение с неё снимается; когда one-shot целей не
осталось, observer отключается сам). На natural leave handler получает
`IntersectionObserverEntry`; терминальный `stop()` вызывает все активные
leave-cleanup ровно один раз с `undefined`. Один нативный
`IntersectionObserver` на вызов; target/options снимаются ровно один раз.

Бросает `MotionParamError`: `LM156` (`onEnter` не функция / битые options /
нативная SyntaxError грамматики явного `margin`), `LM146` (некорректный
контейнер целей), `LM147` (элемент списка не Element), `LM149` (селектор без
`document` / нет `IntersectionObserver` / host нарушил контракт). Свойство
`error.code: MotionParamErrorCode` стабильно; неизвестное сообщение → `'LM000'`.

## Контракты

- **SSR-safe импорт** — импорт любого из пяти субпутей не трогает
  `window`/`document`: `./animate` и `./in-view` резолвят селекторы и читают
  host только в момент вызова; `./presence` и `./spring` — zero-DOM
  (у presence единственный платформенный шов — инжектируемый `matchMedia`);
  `./nano` требует DOM в вызове, но не при импорте.
- **Reduced-motion = смена характера, не выключение** — `./animate`: снап к
  финальному значению без кадров (единая политика пакета; завершение считается
  естественным — `onComplete` вызывается); `./nano`: `duration: 0`,
  `delay: 0` + `commitStyles`; `./presence`: анимационной фазы нет —
  мгновенно терминальное состояние, колбэки фаз не зовутся, снимок импульса
  не читается. Предпочтение читается один раз на вызов/фазу.
- **Финитность** — `NaN`/`Infinity` не попадают в стиль: `./animate` бросает
  `MotionParamError` до первой записи; конструкторы `./spring` валидируют и
  вход, и физический выход; `springAsEasing` клампит вход и возвращает
  конечное значение; `./nano` отклоняет невалидную пружину `RangeError`.
- **Детерминизм** — время только через инжектируемые швы (`requestFrame` /
  `now` / `setTimer` в `./animate`); `./presence` вообще без таймеров и часов
  (темп задаёт потребитель); `./spring` — чистые функции.

## Примеры

### 1. One-liner c перцептивной пружиной (до/после)

```ts
// Было (Framer Motion):
//   import { animate } from 'framer-motion';
//   const a = animate('.card', { x: 240, opacity: 1 },
//     { type: 'spring', duration: 0.5, bounce: 0.25 });
//   a.time = 0.12;

// Стало:
import { animate } from '@labpics/motion/animate';
import { fromBounce } from '@labpics/motion/spring';

const controls = animate('.card', { x: 240, opacity: 1 }, {
  spring: fromBounce({ duration: 0.5, bounce: 0.25 }), // секунды: канон Motion/SwiftUI
});
controls.seek(120); // МИЛЛИСЕКУНДЫ (у Motion было 0.12 сек)
await controls;     // thenable ≡ await controls.finished
```

### 2. `<AnimatePresence>` → `createPresence`

```ts
// Было: <AnimatePresence><motion.div exit={{ opacity: 0, y: 16 }} /></AnimatePresence>
import { animate } from '@labpics/motion/animate';
import { createPresence } from '@labpics/motion/presence';

const toast = document.querySelector('.toast') as HTMLElement;

const presence = createPresence({
  onEnterStart: (done) => {
    void animate(toast, { opacity: [0, 1], y: [16, 0] }, { duration: 200 }).finished.then(done);
  },
  onExitStart: (done) => {
    void animate(toast, { opacity: 0, y: 16 }, { duration: 160 }).finished.then(done);
  },
  onGone: () => toast.remove(), // безопасный момент убрать из DOM
  matchMedia: (query) => matchMedia(query), // reduced: фазы мгновенны, без анимации
});

presence.enter();
// позже: presence.exit() — exit-анимация доиграет, ТОЛЬКО потом onGone
```

### 3. `whileInView` → `inView` (one-shot reveal)

```ts
// Было: <motion.div whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }} />
import { animate } from '@labpics/motion/animate';
import { inView } from '@labpics/motion/in-view';

const stop = inView('.reveal', (target) => {
  void animate(target as HTMLElement, { opacity: [0, 1], y: [24, 0] }, { duration: 240 });
  // ничего не возвращаем → цель one-shot: после входа наблюдение снимается само
}, { amount: 0.5 });

// stop() — идемпотентная полная остановка (активные leave-cleanup получат undefined)
```

Смежные страницы: [GSAP](./gsap.md), [Anime.js](./animejs.md); точные справки
субпутей — [animate](../reference/animate.md), [nano](../reference/nano.md),
[spring](../reference/spring.md), [presence](../reference/presence.md),
[scroll-in-view](../reference/scroll-in-view.md).
