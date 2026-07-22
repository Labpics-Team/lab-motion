# ./animate — одно-строчный DOM-фасад

> Роль: справка — публичный API экспорт-субпутя `./animate`: функция `animate(target, props, options)` — one-liner DOM-анимации с авто-tier (reduced / compositor / main), N-keyframe кортежами (#205), thenable-контролами и C¹-каноном прерывания.

## Назначение

Субпуть `./animate` — one-liner для частого DOM-сценария: `animate(el, { x: 100 })` вместо ручной сборки `MotionValue`/`drive`/`CompositorSpring`. Фасад не добавляет физики: вся математика — существующие ядро и субпути, здесь только DOM-склейка (резолв целей, каналы, реестр прерываний, маршрутизация путей):

- `./compositor` — аналитика кадра и C¹-ретаргета, WAAPI-план, авто-tier;
- `./value` — parse/interpolate (цвета, юниты), `buildTransform` (шортхенды);
- `./stagger` — каскад задержек (число = gap, конфиг — как есть);
- внутренний SSOT дефолтов — тот же, что у токенов `spring.default` / `duration.base` / `easing.standard`.

Маршрутизация — авто-tier, решение в момент вызова, отдельно для каждой цели:

| Условие (на цель) | Путь | Поведение |
| --- | --- | --- |
| `prefers-reduced-motion: reduce` (шов `matchMedia`) | reduced | единая снап-политика пакета: мгновенная запись финальных значений, ноль кадров; засчитывается естественным завершением |
| spring-режим + группа `transform`/`opacity` + у цели есть `.animate()` (WAAPI) + CSS `linear()` (либо WebKit — явные ключевые кадры) + общий представимый v0 движущихся каналов + план скомпилирован | compositor | вся кривая компилируется в `Element.animate` (`linear()`-easing), ноль работы main-потока на кадр |
| иначе (tween-режим, произвольные CSS-свойства, нет WAAPI/`linear()`, непредставимый общий импульс) | main | rAF-микроцикл на той же замкнутой аналитической форме |

Матрица тиров «тир → поведение → что теряем» — в README; диагностический резолвер `resolveCompositorTier` — субпуть `./compositor`. Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  animate,
  type AnimatableElement,
  type AnimateTarget,
  type AnimatePropValue,
  type AnimateProps,
  type AnimateOptions,
  type AnimateControls,
} from '@labpics/motion/animate';
```

Смежные публичные пути: `MotionParamError` и `type SpringParams` — корень `@labpics/motion`; конструктор `fromBounce({ duration, bounce })` — `@labpics/motion/spring`; готовые кривые изинга — `@labpics/motion/easing`; `type StaggerOptions` — `@labpics/motion/stagger`.

## API

Все времена этого субпутя — **миллисекунды**: `duration`, `delay`, gap каскада `stagger`, аргумент `seek(tMs)` (Framer/Motion считают в секундах — ×1000).

### animate

```ts
function animate(
  target: AnimateTarget,
  props: AnimateProps,
  options?: AnimateOptions,
): AnimateControls;
```

Анимирует элемент(ы) к целям `props` одной строкой. Вся валидация — рано, ДО каких-либо записей в стиль: бросок `MotionParamError` гарантирует ноль побочных эффектов и не оставляет abandoned Promise. Вызов исполняется в две фазы (plan/read → commit): все цели читаются и привязываются до первой мутации, браузер не видит чередования read→write→read.

#### target

```ts
type AnimateTarget =
  | AnimatableElement
  | string
  | ArrayLike<AnimatableElement>
  | readonly AnimatableElement[];
```

- **Элемент** — duck-контракт `AnimatableElement`: объект со `style.setProperty` / `style.getPropertyValue` (любой `Element` подходит). Цель, не проходящая контракт, — `LM147`.
- **Строка** — CSS-селектор; резолвится через `document.querySelectorAll` **в момент вызова** (SSR-safe импорт). Селектор без доступного `document.querySelectorAll` — `LM149`. Пустой результат селектора — no-op: возвращаются контролы с уже разрешённым `finished` (и `onComplete` вызывается).
- **Список** (Array/NodeList/array-like) — снимается однократным снимком; контейнер без корректного `length` либо длиннее предела `100_000` целей — `LM146`.

#### props

```ts
type AnimatePropValue = number | string | readonly (number | string)[];
type AnimateProps = Record<string, AnimatePropValue>;
```

Каналы движения (ключи `props`):

- **Transform-шортхенды** — `x`, `y` (px), `scale`, `scaleX`, `scaleY` (безразмерные), `rotate`, `skewX`, `skewY` (deg). Сливаются в одну `transform`-строку в порядке translate → scale → rotate → skew (канон Motion/GSAP). `scale` разворачивается в независимые `scaleX`/`scaleY` (кроме явно заданных тем же вызовом); равные значения сериализуются компактным `scale(N)`. Ключ `transform` целиком запрещён — `LM140`.
- **`opacity`** — числовой канал (from без явного значения читается из стиля; нераспознанное — дефолт браузера `1`).
- **Любое CSS-свойство** — camelCase-ключ становится kebab-case CSS-именем (`backgroundColor` → `background-color`); значения парсит `./value` (цвета, юниты, `var()`, относительные `+=`/`-=`). Не строка и не число — `LM143`; нераспознанный синтаксис — `LM144`.

Формы значения канала:

| Форма | Семантика |
| --- | --- |
| `x: 100` | цель; from резолвится каскадом живой прогон → реестр → inline/computed стиль → identity/дефолт |
| `x: [0, 100]` | пара `[from, to]`: явный from **отключает подхват** (старт из покоя, v0 = 0) |
| `x: [0, 120, -40, 0]` | N-keyframe кортеж длины ≥ 3 (#205): все стопы явные (первый — явный from), offsets равномерные либо `options.times`, изинг per-segment (`options.ease`) |

Массив короче 2 — `LM141`; не-конечное число в числовом канале — `LM142`. `props`, не являющийся объектом-записью (null/массив/примитив), — `LM151`.

#### options

```ts
interface AnimateOptions {
  readonly spring?: SpringParams | undefined;
  readonly duration?: number | undefined;
  readonly ease?: ((t: number) => number) | readonly ((t: number) => number)[] | undefined;
  readonly times?: readonly number[] | undefined;
  readonly delay?: number | undefined;
  readonly stagger?: number | StaggerOptions | undefined;
  readonly onComplete?: (() => void) | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: SetTimerFn | undefined;
}
```

Не-объект вместо options — `LM156`. Режимы `spring` и tween (`duration` / `ease` / `times`) **взаимоисключающие** — одновременно `LM136`.

| Опция | Единицы / форма | Дефолт | Семантика |
| --- | --- | --- | --- |
| `spring` | `SpringParams` `{ mass, stiffness, damping }` | `{ mass: 1, stiffness: 170, damping: 26 }` (токен `spring.default`) — дефолт всего вызова без tween-грамматики | Режим пружины. Вход снимается снимком и проходит `validateSpringParams` (транзитом `LM088`–`LM091`). Думаете в duration/bounce — `spring: fromBounce({ duration, bounce })` из `./spring` (точное преобразование, #218) |
| `duration` | мс, конечная, `> 0` | `200` (токен `duration.base`), если tween выбран через `ease`/`times` | Длительность tween. Некорректная — `LM137` |
| `ease` | функция `t∈[0,1] → прогресс` либо массив функций | `easing.standard` — `cubic-bezier(0.2, 0, 0, 1)` | Изинг tween (готовые кривые — `./easing`; CSS-строки вида `'ease-out'` — грамматика `./nano`). Не-функция (или элемент массива) — `LM138`. Массив (#205) — per-segment изинги N-keyframe вызова, длина ровно `N − 1` (пустой массив либо неверная длина — `LM169`). Scalar ease на треке применяется К КАЖДОМУ сегменту |
| `times` | массив длины `N`: конечные, неубывающие, `times[0] = 0`, `times[N−1] = 1` | равномерные offsets `0, 1/(N−1), …, 1` | Offsets N-keyframe вызова (#205). Дубликаты легальны — скачок нулевой ширины, на самом offset выигрывает поздний сегмент (right-bias). Нарушение грамматики — `LM168` |
| `delay` | мс, конечная, `≥ 0` | `0` | Задержка старта — всем целям |
| `stagger` | число (gap, мс) либо `StaggerOptions` из `./stagger` (`gap` — дефолт 50 мс, `from` — дефолт `'first'`, `easing`, `grid.columns`, `reducedMotion`) | — | Каскад для многих целей. Отрицательный/не-конечный числовой gap — `LM139` (некорректный `gap` внутри конфига по контракту `./stagger` тихо заменяется его дефолтом); итоговая задержка цели = `delay + offset` и обязана остаться конечной `≥ 0`, иначе `LM139` |
| `onComplete` | `() => void` | — | Вызывается один раз, когда ВСЕ цели осели **естественно** (не через `cancel`/`stop` и не при вытеснении повторным `animate`). Бросок из callback не владеет lifecycle — репортится через `globalThis.reportError` |
| `requestFrame` | `(cb: (ts?: number) => void) => number` | rAF / setTimeout-шим | Шов кадра main-пути (детерминизм тестов) |
| `matchMedia` | `(query) => { matches }` | `globalThis.matchMedia` (если среда умеет) | Шов reduced-motion; один снимок политики на вызов |
| `now` | `() => number` (мс) | `performance.now` / `Date.now` | Часы compositor-пути |
| `setTimer` | `(cb, ms) => cancel` | `setTimeout`/`clearTimeout` | Таймер compositor-finished |

**Выбор режима и топология (#205).** `times` — грамматика keyframe-движка и участвует в выборе режима: `spring + times` конфликтует тем же `LM136`, что `spring + duration`. N-keyframe кортеж в `props` без явного режима получает tween с дефолтными `duration` (200 мс) и `ease` (standard); кортеж при явном `spring` — `LM136`. При заданных `times` и/или ease-массиве все каналы вызова обязаны нести одну authored-топологию `N` (число стопов кортежа; пара `[from, to]` = 2; одиночная цель = 1); несовпадение — `LM168` (топология из `times`) либо `LM169` (из длины ease-массива). Скрытых эвристик нет.

**Возврат:** `AnimateControls` (см. ниже).

**Бросает** — `MotionParamError` с полем `code`, рано и до записей в стиль (полный каталог с лечением — [docs/errors.md](../errors.md)):

| Код | Условие |
| --- | --- |
| `LM136` | одновременно `spring` и tween-грамматика (`duration`/`ease`/`times`); N-keyframe кортеж при явном `spring` |
| `LM137` | `duration` не конечная или `≤ 0` |
| `LM138` | `ease` (или элемент ease-массива) не функция |
| `LM139` | `delay`, gap `stagger` или итоговая задержка цели не конечны или `< 0` |
| `LM140` | ключ props `transform` целиком |
| `LM141` | массив-значение канала короче 2 |
| `LM142` | не-конечное числовое значение канала |
| `LM143` | CSS-значение не строка и не число |
| `LM144` | CSS-значение не разобрано кодеком `./value` |
| `LM146` | контейнер целей без корректного `length` либо длиннее 100 000 |
| `LM147` | элемент цели не проходит duck-контракт `style` |
| `LM149` | селектор при недоступном `document.querySelectorAll` |
| `LM150` | импульс подхвата не представим у числовой границы (вырожденный диапазон при огромном `from`) |
| `LM151` | `props` не объект-запись |
| `LM156` | `options` не объект |
| `LM157` | реентрантная смена владельца группы (повторный `animate` из host-транзакции той же группы) |
| `LM168` | некорректные `times` либо канал с топологией ≠ длине `times` |
| `LM169` | пустой ease-массив, длина ≠ `N − 1`, либо канал с топологией ≠ выведенной из ease-массива |
| `LM088`–`LM091` | транзитом из `validateSpringParams`: некорректные `mass`/`stiffness`/`damping` либо время оседания вне бюджета frame-loop |

#### AnimateControls (возврат)

```ts
interface AnimateControls extends PromiseLike<void> {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
  stop(): void;
}
```

Контролы прогона; для группы целей — агрегированные (fan-out на все юниты вызова).

- **Thenable** — `await animate(...)` эквивалентен `await controls.finished` (канон Motion/driver).
- `finished` резолвится при завершении всех целей — естественном ИЛИ через `cancel`/`stop`/вытеснение повторным `animate`; естественность сигналит только `onComplete`. Promise никогда не реджектится: ошибки валидации — синхронный бросок из самого `animate`.
- `play()` — возобновить после `pause()`.
- `pause()` — заморозить в текущей позиции (кадры не эмитятся).
- `seek(tMs)` — перемотать к времени `tMs` (мс); пауза сохраняется, не-конечный вход игнорируется.
- `cancel()` — остановить в текущей позиции; `finished` резолвится (не считается естественным завершением).
- `stop()` — алиас `cancel()` (канон driver).

#### Канон прерывания (C¹)

Повторный `animate` на том же элементе и группе (`transform` / `opacity` / CSS-свойство) **прерывает живой прогон с подхватом** — канон MotionValue smooth-pickup, C¹ на обоих движках (rAF и WAAPI):

- числовые каналы: новый прогон стартует из живой пары (value, velocity) в момент прерывания;
- CSS-каналы: скорость прогресса ṗ проецируется между прогресс-пространствами по доминантному компоненту нового спана (C¹-контракт #93); несовместимые виды значений (`var()`, unit×color) остаются C⁰;
- явный from (пара / первый стоп кортежа) отключает подхват — старт из покоя;
- после естественного оседания реестр отдаёт значение покоя (v = 0);
- остаточные transform-каналы замораживаются на текущем значении: новый прогон `x` не сбрасывает прежний `rotate` — transform-строка остаётся полной проекцией состояния;
- вытесненный юнит завершается (его `finished` резолвится), `onComplete` вытесненного вызова не срабатывает;
- реестр состояния — модульный `WeakMap` по элементам: повторный `animate` из любого места видит один и тот же прогон; уход элемента из DOM не удерживает состояние.

### Type-only экспорты

`AnimatableElement`, `AnimateTarget`, `AnimatePropValue`, `AnimateProps`, `AnimateOptions`, `AnimateControls`. Типы `SpringParams` и `StaggerOptions` в сигнатурах импортируйте из `@labpics/motion` и `@labpics/motion/stagger` соответственно.

## Контракты

- **SSR-safe импорт.** Модуль не трогает DOM при импорте; селектор, `matchMedia`, чтения стиля и capability-проверки происходят только в момент вызова `animate`.
- **Reduced-motion.** `prefers-reduced-motion: reduce` (через шов `matchMedia`) перекрывает любой доступный движок: мгновенная запись финальных значений без единого кадра; засчитывается естественным завершением (`onComplete` вызывается, `finished` резолвится). Политика снимается одним снимком на вызов.
- **Финитность.** Не-конечный вход → ранний `MotionParamError`; NaN/∞ в стиль не эмитятся никогда (выходы стерилизуют `buildTransform`/interpolate ядра `./value`).
- **Детерминизм.** Время только через инжектируемые `requestFrame`/`now`/`setTimer`; глобальных часов в логике нет — идентичные входы и тики дают идентичные кадры.
- **Fail-fast без побочных эффектов.** Вся валидация — до первой записи в стиль; входные массивы (кортежи, `times`, ease-массив, списки целей) снимаются однократным снимком — hostile getters не меняют набор между валидацией и исполнением; бросок не оставляет abandoned Promise и запущенных «наполовину» целей.
- **Единицы.** Все времена — миллисекунды; `x`/`y` — px, `rotate`/`skewX`/`skewY` — deg, `scale*` и `opacity` — безразмерные.
- **Ошибки.** Все броски — `MotionParamError` с полем `code`; каталог с лечением — [docs/errors.md](../errors.md).

## Примеры

One-liner с дефолтной пружиной (thenable):

```ts
import { animate } from '@labpics/motion/animate';

const card = document.querySelector('.card') as HTMLElement;

// Дефолт режима — пружина spring.default (mass 1, stiffness 170, damping 26).
// transform/opacity на WAAPI-способной среде уходят на compositor-путь.
await animate(card, { x: 240, opacity: 0.5 });
```

N-keyframe кортежи + `times` + per-segment ease (#205) и контролы:

```ts
import { animate } from '@labpics/motion/animate';
import { backOut, easeOut } from '@labpics/motion/easing';

const badge = document.querySelector('.badge') as HTMLElement;

// 3 стопа = 2 сегмента: times длиной 3 (0 → 1), ease длиной 2.
// Оба канала обязаны нести одну authored-топологию (здесь N = 3).
const controls = animate(
  badge,
  { y: [0, -24, 0], scale: [1, 1.15, 1] },
  {
    duration: 480,            // миллисекунды
    times: [0, 0.35, 1],
    ease: [easeOut, backOut], // по одному изингу на сегмент
    onComplete: () => console.log('осел естественно'),
  },
);

controls.pause();
controls.seek(240); // мс; пауза сохраняется
controls.play();
await controls;     // эквивалент await controls.finished
```

Селектор + каскад и прерывание с C¹-подхватом:

```ts
import { animate } from '@labpics/motion/animate';

// Селектор резолвится в момент вызова; 60 мс каскада между целями.
const enter = animate(
  '.list li',
  { opacity: [0, 1], y: [16, 0] }, // явные пары [from, to] — подхват отключён
  { duration: 300, stagger: 60 },
);

// Повторный animate тех же элементов/каналов прерывает живой прогон с
// подхватом value и velocity (C¹); enter.finished при этом резолвится,
// а onComplete первого вызова не срабатывает.
const exit = animate('.list li', { opacity: 0, y: -8 }, { duration: 200 });
await exit.finished;
```
