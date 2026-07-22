# ./gestures — drag с инерцией и handoff

> Роль: справка — публичный API экспорт-субпутя `./gestures`: headless-распознаватели press/hover/pan, трекер скорости указателя и drag-контроллер `createDrag` с границами, rubber-band, инерцией через `./decay` и handoff скорости compositor → gesture.

## Назначение

Субпуть `./gestures` — слой интеракции движка: press/tap (с клавиатурным путём), hover, pan (порог + оси), drag (границы + rubber-band + инерция).

Распознаватели — **чистые машины состояний**, питающиеся структурными точками `{x, y, t}`. DOM-событий в модуле нет: потребитель (биндинг/приложение) сам транслирует `PointerEvent → GesturePoint`:

```ts
const point = { x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }; // t — СЕКУНДЫ
```

Это даёт бит-в-бит детерминизм в тестах и SSR-безопасность без гвардов. Единственный платформенный шов — инжектируемый `requestFrame` (нужен только инерционному глайду drag).

В core-bundle субпуть не включён — попадает в бандл только при явном импорте. Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  createVelocityTracker,
  createPress,
  createHover,
  createPan,
  createDrag,
  type GesturePoint,
  type DragOptions,
  type DragControls,
} from '@labpics/motion/gestures';
```

Класс ошибки и тип пружины — из корневого субпутя:

```ts
import { MotionParamError, type SpringParams } from '@labpics/motion';
```

## API

Единицы модуля: координаты — px; `GesturePoint.t` — **секунды** (например `e.timeStamp / 1000`); скорости — px/s; `timeConstant` инерции — секунды. Исключение — timestamp колбэка `requestFrame`: **миллисекунды** (конвенция rAF).

### GesturePoint, GestureAxis (общие типы)

```ts
interface GesturePoint {
  readonly x: number; // px
  readonly y: number; // px
  readonly t: number; // СЕКУНДЫ
}

type GestureAxis = 'x' | 'y';
```

### createVelocityTracker

```ts
function createVelocityTracker(windowSec?: number): VelocityTracker;

interface VelocityTracker {
  push(p: GesturePoint): void;
  velocity(): { vx: number; vy: number }; // px/s
  reset(): void;
}
```

Оценщик мгновенной скорости указателя по скользящему окну сэмплов. Оценка — наклон между первым и последним сэмплом внутри окна `windowSec` (секунды, по умолчанию `0.1`) — устойчиво к дрожанию отдельных событий и детерминированно.

| Параметр | Единицы | Дефолт | Валидация |
| --- | --- | --- | --- |
| `windowSec` | секунды | `0.1` | не число, не конечно или `≤ 0` → молча дефолт |

- `push(p)` — добавить сэмпл; компоненты финитятся на входе (NaN → 0, ±∞ → ±`Number.MAX_VALUE`).
- `velocity()` — `< 2` сэмплов в окне или `Δt ≤ 0` (одинаковые timestamps) → `{vx: 0, vy: 0}`, не NaN. Результат всегда конечен.
- `reset()` — сбросить все сэмплы.

Не бросает.

### createPress

```ts
function createPress(options?: PressOptions): PressRecognizer;

interface PressOptions {
  readonly slop?: number | undefined; // px, по умолчанию 3
  readonly onPressStart?: (() => void) | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly onPressCancel?: (() => void) | undefined;
}

interface PressRecognizer {
  pointerDown(p: GesturePoint): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  keyDown(key: string): void;
  keyUp(key: string): void;
  readonly pressing: boolean;
}
```

Машина состояний нажатия (tap): pointer-путь + клавиатурный путь.

| Опция | Единицы | Дефолт | Валидация |
| --- | --- | --- | --- |
| `slop` | px | `3` (паритет порога tap-cancel у Motion) | не число, не конечно или `< 0` → молча дефолт |

- Движение **строго дальше** `slop` от точки `pointerDown` отменяет нажатие (`onPressCancel`); равенство границе держит нажатие. Сравнение по квадратам дистанции, без sqrt.
- Клавиатурная доступность: `keyDown('Enter')` / `keyDown(' ')` ведут себя как down (автоповтор ОС не даёт второго `onPressStart`), `keyUp` тех же клавиш — как up (`onPress`); `keyDown('Escape')` отменяет.
- `pointerUp` в ненарушенном состоянии эмитит `onPress`; `pointerCancel` отменяет.
- `pressing` — `true`, пока нажатие активно (pointer- или key-путь).

Не бросает.

### createHover

```ts
function createHover(options?: HoverOptions): HoverRecognizer;

interface HoverOptions {
  readonly onHoverStart?: (() => void) | undefined;
  readonly onHoverEnd?: (() => void) | undefined;
}

interface HoverRecognizer {
  enter(pointerType?: string): void; // pointerType из PointerEvent
  leave(): void;
  readonly hovering: boolean;
}
```

Распознаватель наведения. `enter('touch')` игнорируется — эмулированный touch-hover не считается hover'ом. Повторный `enter` при активном hover и `leave` без hover — no-op. Не бросает.

### createPan

```ts
function createPan(options?: PanOptions): PanRecognizer;

interface PanEvent {
  readonly dx: number; // px, смещение от точки pointerDown
  readonly dy: number; // px
  readonly vx: number; // px/s
  readonly vy: number; // px/s
}

interface PanOptions {
  readonly threshold?: number | undefined;   // px, по умолчанию 3
  readonly axis?: GestureAxis | undefined;
  readonly onPanStart?: (() => void) | undefined;
  readonly onPan?: ((e: PanEvent) => void) | undefined;
  readonly onPanEnd?: ((e: PanEvent) => void) | undefined;
}

interface PanRecognizer {
  pointerDown(p: GesturePoint): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  readonly panning: boolean;
}
```

| Опция | Единицы | Дефолт | Валидация |
| --- | --- | --- | --- |
| `threshold` | px | `3` (паритет Motion) | не число, не конечно или `< 0` → молча дефолт |
| `axis` | — | `undefined` (2D) | — |

- Старт: дистанция от точки `pointerDown` достигает `threshold` (нестрогое `≥`) → `onPanStart`, затем `onPan` на каждый move. При `axis` порог и смещения меряются **только по этой оси**, вторая компонента (`dx`/`dy` и `vx`/`vy`) — ровно `0`.
- Скорость — внутренний `createVelocityTracker()` с дефолтным окном `0.1` s.
- `pointerUp` — `onPanEnd` со скоростью отпускания (если pan стартовал). `pointerCancel` — `onPanEnd` с нулевой скоростью в последней точке.
- `panning` — `true` только после пересечения порога.

Не бросает.

### createDrag

```ts
function createDrag(options?: DragOptions): DragControls;
```

Headless drag-контроллер: интеграция позиции, границы с rubber-band сопротивлением, инерция отпускания через аналитический `./decay` и CHARACTER-switch при reduced-motion.

#### DragOptions

```ts
interface DragBounds {
  readonly min?: number | undefined; // px
  readonly max?: number | undefined; // px
}

interface DragInertiaOptions {
  readonly power?: number | undefined;        // безразмерный
  readonly timeConstant?: number | undefined; // СЕКУНДЫ
  readonly restDelta?: number | undefined;    // px/s
}

interface DragOptions {
  readonly from?: { readonly x?: number | undefined; readonly y?: number | undefined } | undefined;
  readonly axis?: GestureAxis | undefined;
  readonly bounds?: { readonly x?: DragBounds | undefined; readonly y?: DragBounds | undefined } | undefined;
  readonly rubberBand?: number | undefined;
  readonly inertia?: DragInertiaOptions | false | undefined;
  readonly snapBackSpring?: SpringParams | undefined;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  readonly onStep?: ((x: number, y: number) => void) | undefined;
  readonly onRest?: ((x: number, y: number) => void) | undefined;
}
```

| Опция | Единицы | Дефолт | Поведение |
| --- | --- | --- | --- |
| `from` | px | `{x: 0, y: 0}` | начальная позиция; неконечные компоненты финитятся (NaN → 0) |
| `axis` | — | `undefined` (обе оси) | блокировка оси: вторая ось заморожена |
| `bounds` | px | `undefined` (без границ) | границы по осям; неконечный `min`/`max` = сторона без ограничения |
| `rubberBand` | безразмерный ∈ [0, 1] | `0.5` (класс elastic у Motion) | `displayed = bound + overshoot·rubberBand`; `0` = жёсткий clamp; не конечно → дефолт, вне [0, 1] → clamp |
| `inertia` | см. `DragInertiaOptions` | включена | knobs прокидываются в `createDecay` (`./decay`: дефолты `power` 0.8, `timeConstant` 0.35 s, `restDelta` 0.5; невалидные — молча дефолты); `false` = остановиться сразу при отпускании |
| `snapBackSpring` | `SpringParams` | `undefined` (жёсткий clamp) | пружина snap-back на границе глайда (см. ниже); невалидная → `MotionParamError` **синхронно из `createDrag`** |
| `matchMedia` | — | `undefined` (reduced = false) | инжектируемый шов reduced-motion; не функция или бросил → `false` |
| `requestFrame` | ts колбэка — **миллисекунды** | `undefined` | кадровый шов глайда; без него (и без шва) глайд невозможен — release оседает сразу в клампнутую точку покоя |
| `onStep` | px | `undefined` | **единственный канал вывода позиции**; значения всегда конечны |
| `onRest` | px | `undefined` | позиция окончательно осела (после глайда/снапа/отпускания) |

Rubber-band действует **только под пальцем**; инерционный глайд и снапы используют жёсткий clamp.

Механика глайда: decay-модель по каждой оси; timestamp шва — миллисекунды, без timestamp — фиксированный шаг `1/60` s; потолок — 2000 кадров (страховка от вечного цикла); возврат handle `0` из `requestFrame` → fallback `setTimeout(0)` (non-draining тестовый шов, конвенция репо).

`snapBackSpring` (iOS-манера): при касании границы инерционным глайдом остаточная скорость **не выбрасывается**, а наследуется пружиной к границе — стык decay|spring непрерывен по C¹ (короткий overshoot за границу и упругий возврат на неё). Пружина решается каноническим `solveSpring` ядра; сходимость — относительный порог ядра, non-finite-страж снапает на границу. Без опции — прежнее поведение бит-в-бит: жёсткий clamp, скорость касания гасится, ось оседает в кадре касания.

Reduced-motion (инвариант G4) — CHARACTER-switch: при `prefers-reduced-motion: reduce` (через инжектированный `matchMedia`) release снапает в клампнутую точку покоя физики **немедленно**, без глайд-кадров — движение исчезает, результат жеста сохраняется.

Бросает: `MotionParamError` с кодом `LM088` (масса), `LM089` (жёсткость), `LM090` (демпфирование), `LM091` (время оседания превышает бюджет) — синхронно из `createDrag`, если `snapBackSpring` не проходит `validateSpringParams` (fail-fast: невалидная пружина не доживает до первого касания границы). Остальные входы валидируются мягко, без ошибок. Полный каталог — [docs/errors.md](../errors.md).

#### DragControls (возврат createDrag)

```ts
interface DragPickup {
  readonly vx?: number | undefined; // px/s
  readonly vy?: number | undefined; // px/s
}

interface DragControls {
  pointerDown(p: GesturePoint, pickup?: DragPickup): void;
  pointerMove(p: GesturePoint): void;
  pointerUp(p: GesturePoint): void;
  pointerCancel(): void;
  stop(): void;
  readonly x: number;        // px, отображаемая позиция
  readonly y: number;        // px
  readonly dragging: boolean;
  readonly gliding: boolean; // true, пока после отпускания идёт инерционный глайд
}
```

- `pointerDown(p, pickup?)` — захват; активный глайд гасится, его кадры инвалидируются. Прайор скорости нового жеста: явный `pickup` **авторитетен** и целиком замещает внутренний; без аргумента наследуется скорость активного глайда. Вырожденные компоненты `pickup` (NaN/±∞/не число) → ровно `0`. Прайор засевается синтетическим сэмплом трекера на полокна назад (`0.05` s при дефолтном окне): немедленный release без движения продолжает движение почти с той же скоростью, а удержание пальца естественно вытесняет прайор из окна (v → 0).
- `pointerMove(p)` — интеграция позиции от точки захвата; за границами — rubber-band; каждый move эмитит `onStep`.
- `pointerUp(p)` — release: при `inertia: false` — немедленное оседание на клампнутой позиции (`onStep` + `onRest`); иначе — инерционный глайд со скоростью отпускания из трекера.
- `pointerCancel()` — единая семантика «системный перехват указателя»: осесть где стоишь (клампнуто) — и при активном drag, и при глайде (`onStep` + `onRest`).
- `stop()` — заглушить активный **глайд** без `onRest` (тихая отмена инерции). Во время активного drag (палец на элементе) — сознательный no-op: жест владеет позицией.
- `x`/`y` — текущая отображаемая позиция (после rubber-band), всегда конечна.

#### Handoff compositor → gesture

`DragPickup` — шов «элемент летит НЕ нашим глайдом» (WAAPI/compositor-ран, чужой аниматор): потребитель в `pointerdown` сообщает жесту живую скорость элемента. Рецепт для compositor-рана (`./compositor`, **без чтения DOM**):

```ts
const read = readCompositorSpring(spring, { from, to, t: elapsedSec });
controller.stop(); // владение переходит жесту
drag.pointerDown(point, { vx: read.velocity });
```

Прямого импорта gestures → compositor нет — субпути ядра независимы; связка живёт у потребителя.

### Type-only экспорты

`GesturePoint`, `GestureAxis`, `VelocityTracker`, `PressOptions`, `PressRecognizer`, `HoverOptions`, `HoverRecognizer`, `PanEvent`, `PanOptions`, `PanRecognizer`, `DragBounds`, `DragInertiaOptions`, `DragOptions`, `DragPickup`, `DragControls`.

## Контракты

Инварианты пакета (G1–G5 из исходника):

- **G1. CSS-safe (финитность).** Все эмитимые числа конечны — никогда NaN/Infinity: страж на каждом выходе (`onStep`, `velocity()`, события pan), включая overflow-края арифметики.
- **G2. Zero-DOM / SSR-safe.** Ни `window`, ни `document` на верхнем уровне модуля и на пути вычисления; единственный платформенный шов — инжектируемый `requestFrame` (drag). Распознаватели создаются и работают на сервере/в воркере.
- **G3. Детерминизм.** Время — только из входных точек (`GesturePoint.t`) и `requestFrame`-шва; нет `Date.now`/`Math.random`. Одинаковые точки и одинаковый шов → бит-в-бит одинаковый вывод.
- **G4. Reduced-motion (drag) — CHARACTER-switch, не hard-off.** Release снапает в точку покоя физики немедленно (без глайд-кадров), а не отключает движение. Детекция — через инжектируемый `matchMedia` при каждом release.
- **G5. Zero runtime deps.** Только внутренние примитивы (`./decay`, канонический солвер/валидатор пружин ядра, errors); внешних npm-зависимостей нет.
- **Единицы.** `GesturePoint.t` и `timeConstant` — секунды; скорости — px/s; timestamp колбэка `requestFrame` — миллисекунды.
- **Ошибки.** Единственный бросаемый тип — `MotionParamError` (только из `createDrag` при невалидном `snapBackSpring`: `LM088`–`LM091`); каталог — [docs/errors.md](../errors.md).

## Примеры

Drag по оси X: границы, rubber-band, инерция, reduced-motion:

```ts
import { createDrag, type GesturePoint } from '@labpics/motion/gestures';

const card = document.querySelector('.card') as HTMLElement;

const toPoint = (e: PointerEvent): GesturePoint => ({
  x: e.clientX,
  y: e.clientY,
  t: e.timeStamp / 1000, // СЕКУНДЫ — контракт GesturePoint
});

const drag = createDrag({
  axis: 'x',
  bounds: { x: { min: -160, max: 160 } },
  rubberBand: 0.5,                       // сопротивление за границей под пальцем
  inertia: { timeConstant: 0.35 },       // секунды; глайд после release
  matchMedia: window.matchMedia.bind(window), // G4: reduced → снап без глайд-кадров
  requestFrame: (cb) => requestAnimationFrame(cb), // ts колбэка — миллисекунды
  onStep: (x, y) => {
    card.style.transform = `translate(${x}px, ${y}px)`; // значения всегда конечны
  },
  onRest: (x) => console.log('осел на', x),
});

card.addEventListener('pointerdown', (e) => {
  card.setPointerCapture(e.pointerId);
  drag.pointerDown(toPoint(e));
});
card.addEventListener('pointermove', (e) => drag.pointerMove(toPoint(e)));
card.addEventListener('pointerup', (e) => drag.pointerUp(toPoint(e)));
card.addEventListener('pointercancel', () => drag.pointerCancel());
```

Handoff compositor → gesture: перехват летящего элемента с наследованием скорости:

```ts
import { MotionParamError, type SpringParams } from '@labpics/motion';
import { readCompositorSpring } from '@labpics/motion/compositor';
import { createDrag } from '@labpics/motion/gestures';

const sheet = document.querySelector('.sheet') as HTMLElement;
const spring: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const from = 0;
const to = 320;
const runStartedMs = performance.now(); // старт compositor-рана той же пружины

let drag: ReturnType<typeof createDrag>;
try {
  drag = createDrag({
    axis: 'y',
    bounds: { y: { min: 0, max: 320 } },
    snapBackSpring: spring, // C¹-стык decay|spring: упругий возврат на границу
    requestFrame: (cb) => requestAnimationFrame(cb),
    onStep: (_x, y) => {
      sheet.style.transform = `translateY(${y}px)`;
    },
  });
} catch (e) {
  if (e instanceof MotionParamError) {
    // e.code: 'LM088'..'LM091' — невалидный snapBackSpring, синхронно из createDrag
  }
  throw e;
}

sheet.addEventListener('pointerdown', (e) => {
  // Элемент летит WAAPI/compositor-раном — жест забирает его живую скорость
  // аналитическим снимком той же пружины, БЕЗ чтения DOM (getComputedStyle
  // форсил бы синхронный recalc).
  const elapsedSec = (e.timeStamp - runStartedMs) / 1000;
  const read = readCompositorSpring(spring, { from, to, t: elapsedSec });
  drag.pointerDown(
    { x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 },
    { vy: read.velocity }, // px/s; явный pickup авторитетен
  );
});
sheet.addEventListener('pointermove', (e) =>
  drag.pointerMove({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }),
);
sheet.addEventListener('pointerup', (e) =>
  drag.pointerUp({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }),
);
```

Headless press + pan: детерминизм без DOM (SSR/воркер/тест):

```ts
import { createPan, createPress } from '@labpics/motion/gestures';

// Клавиатурный путь нажатия: Enter/Space = down/up, Escape = cancel.
const press = createPress({
  slop: 3, // px; движение СТРОГО дальше — cancel
  onPress: () => console.log('tap'),
  onPressCancel: () => console.log('отменено'),
});
press.keyDown('Enter');
press.keyUp('Enter'); // → onPress

// Pan с блокировкой оси: dy/vy ровно 0, порог меряется только по x.
const pan = createPan({
  axis: 'x',
  threshold: 3, // px, нестрогое >= для старта
  onPan: (e) => console.log('dx', e.dx, 'vx', e.vx),
  onPanEnd: (e) => console.log('скорость отпускания', e.vx), // px/s
});
pan.pointerDown({ x: 0, y: 0, t: 0 });
pan.pointerMove({ x: 10, y: 4, t: 0.016 }); // t — секунды
pan.pointerUp({ x: 40, y: 4, t: 0.048 });
// Время только из точек: одинаковые точки → бит-в-бит одинаковый вывод.
```
