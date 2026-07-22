# ./behaviors — headless-машины мобильных взаимодействий

> Роль: справка — публичный API экспорт-субпутя `./behaviors`: четыре headless state machine типовых мобильных взаимодействий — bottom sheet (`createBottomSheet`), drag-to-dismiss (`createDragDismiss`), карусель/пейджер (`createCarousel`), pull-to-refresh (`createPullToRefresh`) — с единым контрактом `BehaviorState` (value/velocity/phase), C¹-перехватом и reduced-motion character-switch.

## Назначение

Субпуть `./behaviors` закрывает разрыв между примитивами и готовым поведением. `./gestures` даёт распознаватели (press/pan/drag) и трекер скорости, `./decay` — аналитическое инерционное затухание, ядро — пружинный солвер. Но «bottom sheet со snap-точками», «drag-to-dismiss с порогом», «пейджер с доводкой к странице», «pull-to-refresh с pending» — это **прикладные машины состояний** поверх этих примитивов: фаза + переходы + выбор цели. Ровно их и экспортирует `./behaviors` — не зная ни про фреймворк, ни про компонентную библиотеку. DOM-привязка — тонкий адаптер на стороне потребителя (`PointerEvent → BehaviorPoint`, состояние → стиль).

Ничего не дублировано — переиспользование импортом:

- `./gestures` `createVelocityTracker` — оценка скорости указателя по окну сэмплов (~0.1 s);
- `./decay` `createDecay(...).rest` — проекция момента: куда прилетел бы элемент под инерцией → выбор целевого snap/страницы по положению **и** скорости;
- пружинный солвер ядра — доводка `value → target` с наследованием скорости (C¹-гладкий стык на границе follow|release);
- `./tokens` `spring` — дефолтные пружины доводки (`spring.default`, для карусели `spring.snappy`).

Каждое поведение владеет **одной** машиной состояний: pointer-события и программные переходы не создают параллельных циклов — в любой момент активен максимум один frame-runner (единый clock).

В core-bundle субпуть не включён — попадает в бандл только при явном импорте (ESM subpath-tree-shaking). Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  createBottomSheet,
  createDragDismiss,
  createCarousel,
  createPullToRefresh,
  type BehaviorPoint,
  type BehaviorState,
  type SheetController,
} from '@labpics/motion/behaviors';
```

Класс ошибки, тип пружины и тип кадрового шва — из корневого субпутя:

```ts
import { MotionParamError, type SpringParams, type RequestFrameFn } from '@labpics/motion';
```

## API

Единицы модуля: координаты и `value` — px; `BehaviorPoint.t` — **секунды** (например `e.timeStamp / 1000`); скорости (`velocity`, `velocityThreshold`) — px/s. Исключение — timestamp колбэка `requestFrame`: **миллисекунды** (конвенция rAF).

### Общие типы

```ts
type BehaviorPhase = 'idle' | 'follow' | 'release' | 'settle';

interface BehaviorState<T = number> {
  readonly value: T;    // единицы поведения (px); всегда конечно
  readonly velocity: T; // px/s; всегда конечно; во время follow равно 0
  readonly phase: BehaviorPhase;
}

interface BehaviorPoint {
  readonly x: number; // px
  readonly y: number; // px
  readonly t: number; // СЕКУНДЫ (например e.timeStamp / 1000)
}

type BehaviorAxis = 'x' | 'y';
```

Фазы: `idle` — покой; `follow` — указатель ведёт значение (после `pointerDown`); `release` — идёт пружинная доводка к цели (после `pointerUp`/`pointerCancel` или программного перехода); `settle` — доводка завершена. `settle` терминальна до следующего входа; исключение — pull-to-refresh, чей полный цикл возврата заканчивается в `idle` со сброшенными флагами. `cancel()` переводит в `idle` из любой фазы.

Во время `follow` в состоянии эмитится `velocity: 0` — скорость копится трекером сэмплов и материализуется на release.

### Общий контракт контроллера

Каждая фабрика возвращает контроллер со следующей общей поверхностью (плюс поведение-специфичные методы):

```ts
interface CommonController<S> {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  subscribe(fn: (s: S) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: S;
}
```

- `state` — текущий снимок состояния (immutable-объект, заменяется целиком на каждом изменении).
- `subscribe(fn)` — подписка на каждое изменение; текущее состояние при подписке **не** реплеится; возвращает отписку. Исключение одного подписчика не срывает остальных. После `destroy()` возвращает no-op-отписку.
- `cancel()` — гасит активную доводку/жест и оседает в `idle` на **текущем** значении (`velocity: 0`). Идемпотентна: повторный вызов на покоящейся машине — no-op без эмитов.
- `destroy()` — идемпотентно переводит контроллер в инертность: снимает подписчиков, гасит цикл; любой последующий вход (pointer-события, программные переходы) — no-op.
- `pointerDown` во время доводки **перехватывает** её: активный цикл гасится, а его текущая скорость наследуется прайором трекера — немедленный повторный release продолжает движение без излома (C¹-pickup).
- `pointerCancel` всегда даёт детерминированный исход без унаследованной скорости (ближайший snap / ближайшая страница / возврат домой).

Общие опции всех четырёх фабрик:

| Опция | Тип | Дефолт | Семантика |
| --- | --- | --- | --- |
| `spring` | `SpringParams` | токен `spring.default` из `./tokens` (`{ mass: 1, stiffness: 170, damping: 26 }`); у карусели — `spring.snappy` (`{ mass: 1, stiffness: 260, damping: 28 }`) | пружина доводки; валидируется в фабрике `validateSpringParams` → `LM088`/`LM089`/`LM090`/`LM091` |
| `requestFrame` | `RequestFrameFn` = `(cb: (ts?: number) => void) => number` | `undefined` | единственный платформенный шов кадров; `ts` колбэка — миллисекунды; **без него доводка выполняется мгновенным снапом в цель** (SSR/тест-путь) |
| `matchMedia` | `(query: string) => { readonly matches: boolean }` (структурно совместим с `window.matchMedia`) | `undefined` | шов reduced-motion; предпочтение снимается **один раз в фабрике**; не функция или бросил → `reduced = false` |
| `onChange` | `(s: State) => void` | `undefined` | сахар: подписка `subscribe` в момент создания (на создание не вызывается) |

Все фабрики бросают только из фабрики (fail-fast); методы контроллеров не бросают.

### createBottomSheet

```ts
function createBottomSheet(options: SheetOptions): SheetController;

interface SheetState extends BehaviorState<number> {
  readonly snapIndex: number; // индекс целевого/финального snap в отсортированном массиве
}

interface SheetController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  snapTo(index: number): void;
  subscribe(fn: (s: SheetState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: SheetState;
}
```

| Опция | Единицы | Дефолт | Семантика / валидация |
| --- | --- | --- | --- |
| `snapPoints` | px | — (обязательна) | snap-точки; сортируются по возрастанию; пустой массив → `MotionParamError('LM003')` |
| `initial` | px | минимальная snap-точка | стартовое `value` |
| `axis` | — | `'y'` | ось чтения ввода (вертикальный лист) |
| `rubberBand` | доля ∈ [0,1] | `0.5` | сопротивление за крайними snap (0 = жёсткий clamp); не число/не конечно → молча дефолт, иначе кламп в [0,1] |

Механика: во время `follow` значение под пальцем за крайними snap-точками резистится rubber-band'ом (`граница + overshoot·rubberBand`, знак overshoot сохраняется). На `pointerUp` цель выбирается **проекцией момента** через `./decay` с дефолтными параметрами (`landing = value + 0.28·velocity`) → ближайшая к landing snap-точка; скорость влияет монотонно (быстрый флик → дальний snap). Доводка наследует скорость отпускания. `pointerCancel` — ближайший к текущему значению snap, нулевая скорость.

`snapTo(index)` — программный переход тем же clock: индекс truncate + кламп в `[0, snapPoints.length − 1]`; активная доводка гасится, её скорость наследуется. `snapIndex` в состоянии обновляется при выборе цели (release) и на финише (settle).

Бросает: `LM003` (пустой `snapPoints`), `LM088`–`LM091` (невалидная пружина). Каталог — [docs/errors.md](../errors.md).

### createDragDismiss

```ts
function createDragDismiss(options: DismissOptions): DismissController;

interface DismissState extends BehaviorState<number> {
  readonly dismissed: boolean; // true после оседания в dismissTarget
}

interface DismissController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  subscribe(fn: (s: DismissState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: DismissState;
}
```

| Опция | Единицы | Дефолт | Семантика / валидация |
| --- | --- | --- | --- |
| `axis` | — | `'y'` | ось чтения ввода |
| `direction` | `1 \| -1` | `1` | знак направления вдоль оси, которое закрывает; любое значение кроме `-1` трактуется как `1` |
| `distanceThreshold` | px | — (обязательна) | порог смещения в направлении dismiss; после стража конечности (`NaN → 0`, `±∞ → ±MAX_VALUE`) значение `≤ 0` → `MotionParamError('LM004')` |
| `velocityThreshold` | px/s | `600` | порог скорости — быстрый флик закрывает раньше дистанции; берётся модуль; не число/не конечно → молча дефолт |
| `dismissTarget` | px | `direction · distanceThreshold · 8` | куда уезжает элемент при закрытии |
| `onDismiss` | — | `undefined` | вызывается **один раз**, когда элемент осел в `dismissTarget` |

Правило порога на `pointerUp` (проекции на направление `direction`, границы **включительно**):

```text
direction·value ≥ distanceThreshold  ИЛИ  direction·velocity ≥ velocityThreshold  →  dismiss
иначе                                                                              →  возврат в 0
```

Возврат домой наследует скорость отпускания (недоведённый жест пружинит назад «с ходу»). `pointerCancel` — всегда возврат домой без скорости, без dismiss. После `dismissed: true` контроллер инертен для нового ввода (`pointerDown` — no-op); смещение остаётся в `dismissTarget`.

Бросает: `LM004`, `LM088`–`LM091`.

### createCarousel

```ts
function createCarousel(options: CarouselOptions): CarouselController;

interface CarouselState extends BehaviorState<number> {
  readonly index: number; // текущая страница; выводится из value каждый кадр
}

interface CarouselController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  goTo(index: number): void;
  next(): void;
  prev(): void;
  subscribe(fn: (s: CarouselState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: CarouselState;
}
```

| Опция | Единицы | Дефолт | Семантика / валидация |
| --- | --- | --- | --- |
| `pageCount` | шт | — (обязательна) | truncate до целого после стража конечности; `< 1` → `MotionParamError('LM005')` |
| `pageSize` | px | — (обязательна) | после стража конечности значение `≤ 0` → `MotionParamError('LM006')` |
| `index` | — | `0` | стартовая страница; round + кламп в `[0, pageCount − 1]` |
| `axis` | — | `'x'` | ось прокрутки |
| `rtl` | — | `false` | right-to-left: зеркалит направление выбора страницы |
| `velocityThreshold` | px/s | `400` | порог флик-перелистывания; берётся модуль; не число/не конечно → молча дефолт |

Модель позиции: `value` — px в position-пространстве, страница `i` покоится на `i · pageSize`. Смещение указателя транслируется со знаком направления: горизонталь LTR — палец влево → `value` растёт (следующая страница); RTL — зеркально; вертикаль — палец вверх → следующая. `index` — **не отдельный счётчик**: и во время follow, и на каждом кадре доводки он выводится из `value` (`round(value / pageSize)` с клампом) — позиция и индекс согласованы всегда (единый clock).

Выбор страницы на `pointerUp`: decay-проекция момента → ближайшая к landing страница; флик (`|velocity| ≥ velocityThreshold`) перелистывает минимум на одну страницу в сторону знака скорости; итог клампится в `±1` от страницы начала свайпа — один свайп листает максимум на страницу. `pointerCancel` — доводка к ближайшей странице без скорости.

`goTo(index)` — round + кламп в `[0, pageCount − 1]`, тем же clock, с наследованием скорости активной доводки; `next()` / `prev()` — `goTo(state.index ± 1)`.

Бросает: `LM005`, `LM006`, `LM088`–`LM091`.

### createPullToRefresh

```ts
function createPullToRefresh(options: PullOptions): PullController;

interface PullState extends BehaviorState<number> {
  readonly pulling: boolean; // палец тянет прямо сейчас
  readonly armed: boolean;   // протяжка перешла порог (release запустит refresh)
  readonly pending: boolean; // async-действие в полёте (удержание на pendingPosition)
}

interface PullController {
  pointerDown(p: BehaviorPoint): void;
  pointerMove(p: BehaviorPoint): void;
  pointerUp(p: BehaviorPoint): void;
  pointerCancel(): void;
  subscribe(fn: (s: PullState) => void): () => void;
  cancel(): void;
  destroy(): void;
  readonly state: PullState;
}
```

| Опция | Единицы | Дефолт | Семантика / валидация |
| --- | --- | --- | --- |
| `threshold` | px | — (обязательна) | порог активации (по протяжке, т.е. уже после резистентности); после стража конечности значение `≤ 0` → `MotionParamError('LM007')` |
| `axis` | — | `'y'` | ось чтения ввода |
| `direction` | `1 \| -1` | `1` | знак направления протяжки вдоль оси (1 = вниз/плюс); кроме `-1` → `1` |
| `resistance` | доля ∈ [0,1] | `0.5` | резистентность overscroll (0.5 = вдвое «тяжелее» пальца); не число/не конечно → молча дефолт, иначе кламп в [0,1] |
| `pendingPosition` | px | `threshold` | высота удержания при pending |
| `onRefresh` | — | `undefined` | `() => void \| Promise<void>`; возврат пружиной — после резолва **и** после reject (позиция не залипает) |

Механика: `value` — протяжка `≥ 0`: `direction·смещение · resistance`; движение против направления — `0` (это не pull). `armed` пересчитывается на каждом `pointerMove` (`value ≥ threshold`). На `pointerUp`:

- `armed` → доводка к `pendingPosition` (скорость отпускания, тоже с резистентностью) → `phase: 'settle'`, `pending: true` → вызов `onRefresh`; после его резолва/реджекта — возврат пружиной в 0 и финальное `phase: 'idle'` со сброшенными флагами;
- не `armed` → возврат домой с унаследованной скоростью.

`pending` не заводит второго владельца позиции: удержание и возврат — тот же единственный runner. Пока `pending: true`, `pointerDown` — no-op. `pointerCancel` — возврат домой без активации refresh. `destroy()` во время `pending` делает контроллер инертным — отложенный возврат после резолва не запускается.

Бросает: `LM007`, `LM088`–`LM091`.

### Type-only экспорты

`BehaviorPhase`, `BehaviorState`, `BehaviorPoint`, `BehaviorAxis`, `SheetState`, `SheetOptions`, `SheetController`, `DismissState`, `DismissOptions`, `DismissController`, `CarouselState`, `CarouselOptions`, `CarouselController`, `PullState`, `PullOptions`, `PullController`.

## Контракты

- **SSR-safe.** Ни `window`, ни `document` на пути импорта и создания; платформенные швы (`requestFrame`, `matchMedia`) инжектируются, `undefined` — легальный SSR-вход (доводка тогда — мгновенный снап, reduced = false).
- **Headless.** Модуль не пишет в DOM и не слушает события; потребитель транслирует `PointerEvent → BehaviorPoint` и применяет состояние сам.
- **Один clock.** У поведения максимум один активный frame-цикл: pointer-перехват, программные переходы и pending-удержание гасят предыдущий цикл generation-токеном (stale-кадры отбрасываются), а не наслаиваются.
- **Финитность.** `value` и `velocity` конечны на каждом эмите: `NaN → 0`, `±∞ → ±Number.MAX_VALUE`, `−0` схлопнут в `+0` — включая враждебный ввод в `BehaviorPoint` и overflow разностей.
- **Финитность цикла.** Доводка сходится по относительному порогу 0.5% от диапазона (позиция и скорость одновременно) и жёстко ограничена потолком 2000 кадров; при отсутствии timestamp у кадрового шва используется фиксированный шаг 1/60 s.
- **C¹-непрерывность.** Release наследует скорость трекера (нормировка на диапазон), перехват `pointerDown` — скорость активной доводки через прайор трекера: производная непрерывна на стыках follow|release и release|follow.
- **Reduced-motion — character-switch, не hard-off.** При `prefers-reduced-motion: reduce` (через инжектированный `matchMedia`) любая доводка — мгновенный снап в цель без промежуточных кадров; состояние, выбор цели и результат жеста сохраняются. Снимок предпочтения — один раз в фабрике.
- **Идемпотентность жизненного цикла.** `cancel()` и `destroy()` идемпотентны; после `destroy()` вход инертен (no-op), включая обрыв активного жеста — «уцелевший» pointerMove не воскрешает движение.
- **Детерминизм.** Нет `Date.now`/`Math.random`; при инжектированных швах одинаковая последовательность точек даёт одинаковую последовательность состояний; `pointerCancel` всегда детерминирован (без унаследованной скорости).
- **Ошибки.** Единственный бросаемый тип — `MotionParamError` с полем `code`; только из фабрик: `LM003` (sheet), `LM004` (dismiss), `LM005`/`LM006` (carousel), `LM007` (pull) + `LM088`–`LM091` (валидация пружины). Каталог с лечением — [docs/errors.md](../errors.md).
- **Zero-deps.** Внешних runtime-зависимостей нет.

## Примеры

Bottom sheet: DOM-адаптер поверх headless-контроллера, программный `snapTo`:

```ts
import { createBottomSheet } from '@labpics/motion/behaviors';

const sheet = document.querySelector('.sheet') as HTMLElement;
const grip = document.querySelector('.sheet-grip') as HTMLElement;

const ctrl = createBottomSheet({
  snapPoints: [0, 320, 640], // px по оси y: 0 — развёрнут, 320 — полулист, 640 — свёрнут
  initial: 320,
  requestFrame: (cb) => requestAnimationFrame(cb), // ts колбэка — миллисекунды
  matchMedia: window.matchMedia.bind(window),      // reduced → мгновенный снап в цель
  onChange: (s) => {
    sheet.style.transform = `translateY(${s.value}px)`;
  },
});

const pt = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 });
grip.addEventListener('pointerdown', (e) => {
  grip.setPointerCapture(e.pointerId);
  ctrl.pointerDown(pt(e)); // перехват активной доводки с наследованием её скорости (C¹)
});
grip.addEventListener('pointermove', (e) => ctrl.pointerMove(pt(e)));
grip.addEventListener('pointerup', (e) => ctrl.pointerUp(pt(e)));
grip.addEventListener('pointercancel', () => ctrl.pointerCancel());

// Программное разворачивание — тем же clock, что и жест.
(document.querySelector('.expand') as HTMLElement).addEventListener('click', () => ctrl.snapTo(0));
```

Drag-to-dismiss headless: без `requestFrame` доводка снэпается синхронно — детерминизм для SSR/тестов; граница ошибок:

```ts
import { MotionParamError } from '@labpics/motion';
import { createDragDismiss } from '@labpics/motion/behaviors';

let closed = false;
try {
  const card = createDragDismiss({
    axis: 'y',
    direction: 1,           // закрывает протяжка вниз
    distanceThreshold: 120, // px
    velocityThreshold: 600, // px/s
    onDismiss: () => {
      closed = true;
    },
  });

  card.pointerDown({ x: 0, y: 0, t: 0 });     // t — СЕКУНДЫ
  card.pointerMove({ x: 0, y: 90, t: 0.05 }); // 90 px < 120 px, но…
  card.pointerUp({ x: 0, y: 90, t: 0.05 });   // …скорость 1800 px/s ≥ 600 → dismiss
  console.log(card.state.phase, card.state.dismissed, closed); // 'settle' true true
} catch (e) {
  if (e instanceof MotionParamError) {
    console.error(e.code); // 'LM004' — невалидный distanceThreshold
  }
  throw e;
}
```

Pull-to-refresh: резистентный overscroll, async-действие, возврат после резолва:

```ts
import { createPullToRefresh } from '@labpics/motion/behaviors';

const feed = document.querySelector('.feed') as HTMLElement;
const spinner = document.querySelector('.spinner') as HTMLElement;

const ctrl = createPullToRefresh({
  threshold: 72,   // px протяжки (после резистентности) для активации
  resistance: 0.5, // палец «тяжелее» вдвое
  requestFrame: (cb) => requestAnimationFrame(cb),
  matchMedia: window.matchMedia.bind(window),
  onRefresh: async () => {
    await fetch('/api/feed'); // возврат пружиной запустится после резолва (и после reject)
  },
  onChange: (s) => {
    feed.style.transform = `translateY(${s.value}px)`;
    spinner.style.opacity = s.pending || s.armed ? '1' : String(Math.min(1, s.value / 72));
  },
});

const pt = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 });
feed.addEventListener('pointerdown', (e) => ctrl.pointerDown(pt(e))); // при pending — no-op
feed.addEventListener('pointermove', (e) => ctrl.pointerMove(pt(e)));
feed.addEventListener('pointerup', (e) => ctrl.pointerUp(pt(e)));
feed.addEventListener('pointercancel', () => ctrl.pointerCancel());
```
