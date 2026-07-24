# ./projection — проекционное дерево (вложенный FLIP)

> Роль: справка — публичный API экспорт-субпутя `./projection`: чистая математика проекционного дерева (`createProjector`, `projectAt`, `mixBox`, `cornerRadiusAt`), headless-драйвер `createProjection` (одна нормированная пружина с живым v0) и DOM-адаптер `createDomProjection` (capture → play).

## Назначение

Субпуть `./projection` — честный **вложенный** FLIP жанра Framer projection: дерево узлов едет «одним жестом», transform родителя **не искажает** детей и `border-radius`. Scale-коррекция считается замкнутой формой через visual box ближайшего проецирующего предка — цепочка любой глубины схлопывается, для внука нужен только ближайший проецирующий предок. Это закрывает ровно два гэпа плоского [`./flip`](./flip.md): вложенность и velocity continuity при прерывании (у `./flip` начальная скорость жёстко 0; здесь пружина стартует с живым v0).

Три слоя, DOM только в последнем:

- **`createProjector` + `projectAt`/`mixBox`/`cornerRadiusAt`** — чистая математика дерева боксов (zero-DOM, SSR-safe, тотальная к враждебным входам);
- **`createProjection`** — headless-драйвер: **одна** нормированная пружина `0 → 1` на весь переход (групповая когерентность — все узлы от одного `p`, tearing родитель/ребёнок исключён по построению), C⁰/C¹-перехват, скраб `seek`/`release`;
- **`createDomProjection`** — тонкий DOM-адаптер: `capture()` до мутации layout, `play()` после; замеры батчируются (clear → measure → start), дерево строится по composed-предкам автоматически.

Модель строго осевая: `rotate`/`skew` и `transform-origin` ≠ `'0 0'` — не-цели v1 (повёрнутый предок ломает замкнутую форму); `position: fixed/sticky` в дереве и компенсация скролла вложенных scroll-контейнеров (page-space считается от window-scroll) — тоже. Жестовых распознавателей нет — только швы `seek`/`release`; трекер скорости берите из [`@labpics/motion/gestures`](./gestures.md).

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Субпуть tree-shakeable — в корневой бандл не входит.

## Импорт

```ts
import {
  createDomProjection,
  createProjection,
  createProjector,
  projectAt,
  mixBox,
  cornerRadiusAt,
  type FlipRect,
  type ProjectionNodeInit,
  type ProjectionBoxes,
  type ProjectedTransform,
  type ProjectionFrame,
  type Projector,
  type ProjectionOptions,
  type ProjectionPlayNode,
  type ProjectionControls,
  type DomProjectionOptions,
  type DomProjectionElement,
  type DomProjectionControls,
  type BoxRadii,
  type CornerRadius,
} from '@labpics/motion/projection';
```

Все боксы — **пиксели** (page-space в DOM-адаптере: viewport-координаты + scroll), timestamps кадров — **миллисекунды**, скорости прогресса — **progress/s**.

## API

### createDomProjection

```ts
function createDomProjection(options?: DomProjectionOptions): DomProjectionControls;

interface DomProjectionControls {
  capture(elements: readonly DomProjectionElement[]): void;
  play(): void;
  cancel(): void;
  readonly playing: boolean;
}
```

DOM-контроллер: `capture(elements)` → мутация layout потребителем → `play()`. Единственный слой субпутя, знающий про DOM — duck-typed (`DomProjectionElement` — структурный минимум, node-тесты живут на фейках) и **в момент вызова**: импорт модуля не трогает `globalThis` (SSR-safe).

#### options

| Опция | Тип / дефолт | Поведение |
| --- | --- | --- |
| `spring` | `SpringParams`, дефолт `{ mass: 1, stiffness: 200, damping: 24 }` | Невалидная → `MotionParamError` (`LM088`–`LM091`) **в фабрике**, даже под reduced-motion |
| `clamp` | `boolean`, дефолт **`false`** | Честный overshoot пружины (осознанное отличие от легаси-дефолта `./flip`); размеры флорятся ≥ 0 всегда |
| `requestFrame` | `RequestFrameFn`, дефолт `globalThis.requestAnimationFrame` (резолв в момент вызова фабрики) | Среда без rAF и без шва → полёт завершается синхронно точным финалом |
| `matchMedia` | `(q: string) => { matches: boolean }`, **дефолта нет** | Reduced-motion учитывается **только через этот шов** — передайте `(q) => window.matchMedia(q)` |
| `radius` | `boolean`, дефолт `true` | Снимать и морфить радиусы (8 computed longhand-компонент на узел); `false` — дешевле на замере |
| `getScroll` | `() => { x: number; y: number }`, дефолт `globalThis.scrollX/scrollY` под try/catch → `{0,0}` | Page-space шов |
| `getComputedStyle` | функция, дефолт `globalThis.getComputedStyle` в момент вызова | Шов чтения computed-радиусов |

#### capture(elements)

FIRST-замер набора элементов: `getBoundingClientRect()` + scroll (page-space), computed-радиусы (`%` → px против width/height на замере; `calc()`/`var()`/иные юниты — тихая деградация, радиусы не анимируются), прежние **инлайны** `transform`/`transform-origin`/`border-radius` сохраняются для восстановления. Узлы **активного полёта** не меряются под нашим transform — берётся аналитический `V(p̂)` через `boxAt` (ноль DOM-чтений). Враждебный вход (не-элемент, бросающий `getBoundingClientRect`) молча пропускается — `capture` никогда не бросает.

#### play()

Без `capture` — `MotionParamError` **`LM077`**. Затем граница переизмерения одним синхронным JS-проходом (paint между шагами не случается):

1. **batch-CLEAR** — снять наши инлайны у узлов активного полёта (замер увидит чистый layout);
2. **batch-MEASURE** — все `getBoundingClientRect` + радиусы одним проходом чтений (один принудительный reflow — неизбежная цена FLIP-границы); исчезнувший между `capture` и `play` узел — тихая деградация;
3. дерево по **composed-подъёму**: `assignedSlot` → `parentElement` → `getRootNode().host` — границы открытых shadow root прозрачны, closed — невидимы; враждебный parent-цикл → узел честно считается корнем, из DOM-состояния **никогда не бросаем**; ближайший замеренный предок становится `parent` узла;
4. старт полёта; на каждом кадре пишутся `transform: translate(…px, …px) scale(…)` и `border-radius`, после успешного старта — `transform-origin: '0 0'` (жёсткий контракт формул). Узлам ещё активного полёта драйверу уходит `first: undefined` — visual pickup считается в драйвере на момент `play` (C⁰ и при отложенном `play`).

Снимок `capture` потребляется **однократно**: успешный `play()` (и `cancel()`) очищает его — повторный `play` без нового `capture` бросает `LM077` (телепорт по протухшему снимку хуже ошибки), detached-поддеревья не пинятся ссылками из снимка.

По завершении полёта (rest) сохранённые инлайны восстанавливаются — элементы снапаются в конечный layout.

#### cancel()

Снимает наши инлайны (снап в конечный layout), глушит полёт, инвалидирует снимок. Идемпотентен; onRest-аналога у адаптера нет.

Известный риск: чужой inline/CSS-`transform` на треканном элементе — `getBoundingClientRect` вернёт визуальный бокс, математика примет его за layout (matrix-декомпозиция — не-цель v1).

### createProjection

```ts
function createProjection(options?: ProjectionOptions): ProjectionControls;

interface ProjectionOptions {
  readonly spring?: SpringParams | undefined;        // дефолт { mass: 1, stiffness: 200, damping: 24 }
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  readonly onFrame?: ((frames: readonly ProjectionFrame[]) => void) | undefined;
  readonly onRest?: (() => void) | undefined;
  readonly clamp?: boolean | undefined;              // дефолт false
}
```

Headless-драйвер: **одна** нормированная пружина `0 → 1` на весь переход, синхронные колбэки, ноль DOM. Невалидная `spring` → `MotionParamError` (`LM088`–`LM091`) в фабрике (ранний детерминированный бросок, даже под reduced-motion). `onFrame` получает кадры полёта — **массив и объекты кадров переиспользуются между вызовами, ссылки не удерживать**; первый кадр эмитится синхронно при `play` (анти-мигание). `onRest` зовётся **ровно один раз** на завершившийся полёт (финал — ровно `p = 1`, точный identity); `cancel` его не зовёт. Исключение из `onFrame` не оставляет «играющий» зомби-run: полёт гасится, ошибка пробрасывается.

Время: из `ts` кадра (**мс**) либо фиксированный шаг `1/60` с, когда шов не дал timestamp. Сходимость: `|1 − value| < 1e-3` и `|velocity| < 1e-3` (по неклампленному значению) либо потолок 2000 кадров. Без `requestFrame` полёт завершается синхронно точным финалом.

#### ProjectionControls

```ts
interface ProjectionControls {
  play(nodes: readonly ProjectionPlayNode[]): void;
  cancel(): void;
  seek(p: number): void;
  release(velocity?: number): void;
  boxAt(id: string): FlipRect | undefined;
  readonly playing: boolean;   // active || held (скраб держит полёт)
  readonly progress: number;   // публично ВСЕГДА [0, 1], даже при clamp: false
  readonly velocity: number;   // производная эмитируемого прогресса, 1/s; покой и зажатая clamp-граница → 0
}

interface ProjectionPlayNode extends Omit<ProjectionNodeInit, 'first'> {
  readonly first?: FlipRect | undefined; // опционален только для id незавершённого полёта
}
```

- **`play(nodes)`** — старт или перехват. Mid-flight узел может опустить `first`: подхват — аналитический `first' = V(p̂)` (visual pickup, ноль DOM-чтений; radii/opacity ребейзятся тем же lerp'ом) — C⁰ всех каналов по построению. C¹ — по доминантному каналу всех продолжающихся узлов (боксы, radii, opacity — полноправные каналы); при неизменных целях `v0' = v̂/(1 − p̂)` точен для **каждого** канала каждого узла. `first` опущен у **нового** id (нет незавершённого полёта) → `MotionParamError` **`LM078`**. Валидация дерева (`createProjector`, коды `LM079`–`LM083`) — рано, до любых эффектов, даже под reduce. Reduced-motion резолвится **один раз на `play`**; смена в полёте не подхватывается.
- **`cancel()`** — замораживает текущее аналитическое состояние без финального эмита и `onRest`; повторный `play` может подхватить его с нулевой скоростью. Идемпотентен.
- **`seek(p)`** — скраб (жест ведёт): гасит пружину, синхронно эмитит кадры на `p` (сырой `p` при `clamp: false`; `NaN` → 0). Скраб **держит** полёт (`playing === true`) — жест обязан завершиться `release()`/`cancel()`. Валиден и после rest; на контроллере без полёта вовсе — no-op.
- **`release(velocity?)`** — продолжить пружиной из текущего `p` с начальной скоростью (**progress/s**; `NaN` → 0, дефолт 0). Внутри — ребейз `first' = V(p̂)` (та же механика, что перехват); нулевой остаточный диапазон всех каналов всех узлов → немедленный settle: один синхронный эмит `p = 1` + `onRest`, ноль кадров rAF. `v0 = velocity / (1 − p̂)` с потолком величины (при `p̂ → 1` знаменатель мал — без капа нефизичный рывок).
- **`boxAt(id)`** — аналитический visual box узла **сейчас**, без чтения DOM: rest → `last`; полёт/скраб/cancel → `mixBox(first, last, p̂)`; неизвестный id → `undefined`.

### createProjector

```ts
function createProjector(nodes: readonly ProjectionNodeInit[]): Projector;

interface ProjectionNodeInit {
  readonly id: string;                                // уникален; пустой → LM079, дубль → LM080
  readonly parent?: string | null | undefined;        // ближайший ПРОЕЦИРУЮЩИЙ предок; null/undefined = корень
  readonly first: FlipRect;                           // px, page-space
  readonly last: FlipRect;
  readonly anchor?: FlipRect | undefined;             // где узел ФАКТИЧЕСКИ стоит в layout; дефолт last
  readonly radii?: { readonly first: BoxRadii; readonly last: BoxRadii } | undefined;
  readonly opacity?: { readonly from: number; readonly to: number } | undefined;
}

interface Projector {
  at(p: number): readonly ProjectionFrame[]; // родитель раньше ребёнка; массив/объекты ПЕРЕИСПОЛЬЗУЮТСЯ
  readonly order: readonly string[];         // топологический порядок id (диагностика/тесты)
}
```

Чистая SSR-safe фабрика: валидация + топосорт (вход в любом порядке — родитель в выдаче строго раньше ребёнка) + precompute вырожденности один раз. Бросает `MotionParamError` рано, до первого кадра:

| Код | Условие |
| --- | --- |
| `LM079` | `id` не строка или пустой |
| `LM080` | `id` повторяется в наборе |
| `LM081` | `radii` — не две четвёрки углов (мальформный вход ловится рано, не поздним `TypeError` из горячего `at()`) |
| `LM082` | `parent` ссылается на неизвестный id |
| `LM083` | цикл parent-ссылок |

`anchor` — где узел **фактически** стоит в layout (дефолт `last`; для кроссфейд-ghost'а — `first`). Вырожденный anchor (сторона ≤ `1e-6` px либо нефинитен) → кадр узла с `degenerate: true`: transform не вычисляется, opacity снапнут к `to`, дети **переякориваются** к следующему невырожденному проецирующему предку (один раз, на precompute).

`at(p)`: `p` не клампится (overshoot-путь; `NaN` → 0), размеры visual box флорятся ≥ 0 — зеркалирования отрицательным scale нет; прогресс радиусов и opacity клампится к `[0, 1]`. Ноль аллокаций на вызов — не удерживайте ссылки на кадры между вызовами.

#### ProjectionFrame

```ts
interface ProjectionFrame {
  readonly id: string;
  readonly tx: number;                    // px — локальный transform узла
  readonly ty: number;                    // px
  readonly sx: number;                    // безразмерный масштаб
  readonly sy: number;
  readonly kx: number;                    // кумулятивный визуальный масштаб узла (V.size/anchor.size)
  readonly ky: number;                    //   — сырьё для собственных коррекций потребителя
  readonly radii?: BoxRadii | undefined;  // скорректированные радиусы (px); undefined без radii
  readonly opacity?: number | undefined;  // [0, 1]
  readonly degenerate: boolean;           // true → transform НЕ применять
}
```

Потребитель **обязан** выставить элементу `transform-origin: '0 0'` — формулы выведены для верхнего-левого origin.

### projectAt

```ts
interface ProjectionBoxes {
  readonly first: FlipRect;
  readonly last: FlipRect;
  readonly anchor?: FlipRect | undefined; // дефолт last
}

interface ProjectedTransform {
  readonly tx: number; // px
  readonly ty: number; // px
  readonly sx: number;
  readonly sy: number;
}

function projectAt(
  node: ProjectionBoxes,
  ancestor: ProjectionBoxes | null,
  p: number,
): ProjectedTransform;
```

Локальный transform одного узла на прогрессе `p` через visual box ближайшего **проецирующего** предка; оба узла берутся на **одном** `p`. `ancestor: null` = корень — тогда при `anchor = last` результат тождествен `flipAt(computeFlip(first, last), p)` из `./flip` на `p ∈ [0, 1]` (вне `[0, 1]` `flipAt` клампит, `projectAt` честно продолжает ту же кривую — overshoot-путь). Тотальная функция: `NaN` в `p` → 0, враждебные ректы проходят через стражи конечности, не бросает.

### mixBox

```ts
function mixBox(first: FlipRect, last: FlipRect, p: number): FlipRect;
```

Покомпонентный lerp боксов: `p` **не клампится** (overshoot-путь; `NaN` → 0), размеры флорятся ≥ 0. Этой же формой драйвер считает аналитический visual box `V(p̂)` при перехвате и в `boxAt`.

### cornerRadiusAt

```ts
interface CornerRadius {
  readonly x: number; // px, x-полуось
  readonly y: number; // px, y-полуось (эллиптический угол)
}

type BoxRadii = readonly [CornerRadius, CornerRadius, CornerRadius, CornerRadius]; // TL, TR, BR, BL

function cornerRadiusAt(
  first: CornerRadius,
  last: CornerRadius,
  kx: number,
  ky: number,
  p: number,
): CornerRadius;
```

Радиус угла на прогрессе `p` с коррекцией под масштаб: `lerp(first, last, clamp01(p))` (прогресс радиуса **клампится** — overshoot на радиус не транслируем), floor 0, затем scale-коррекция пер-оси (живой вызов `correctRadius` из `./flip`). Делитель — **кумулятивный** масштаб узла `kx`/`ky` из `ProjectionFrame` (не локальный `sx`/`sy`): по индукции `k` уже равен полному произведению масштабов предков.

### Type-only экспорты

`BoxRadii`, `CornerRadius`, `ProjectedTransform`, `ProjectionBoxes`, `ProjectionFrame`, `ProjectionNodeInit`, `Projector`, `ProjectionControls`, `ProjectionOptions`, `ProjectionPlayNode`, `DomProjectionControls`, `DomProjectionElement`, `DomProjectionOptions`, а также re-export `FlipRect` из `./flip` (стирается в рантайме).

## Контракты

- **P1. CSS-safe финитность.** Каждое число каждого кадра конечно: `NaN` → 0, `±Infinity` → `±Number.MAX_VALUE`, деление на вырожденный размер → нейтральный fallback, `-0` схлопнут в `+0` (включая opacity). Бросает только валидация параметров (`MotionParamError`, рано) — враждебный вход в полёте деградирует, не бросает.
- **P2. Zero-DOM / SSR-safe.** `createProjector`/`projectAt`/`mixBox`/`cornerRadiusAt` и `createProjection` не трогают DOM вовсе; `createDomProjection` резолвит платформу (`requestAnimationFrame`, `getComputedStyle`, scroll) только **в момент вызова** — путь импорта чист.
- **P3. Детерминизм.** Время — только из `ts` кадра (мс) либо фиксированного шага `1/60` с; стык кадров с `ts` и без не удваивает время. Ни wall-clock, ни `Math.random` — бит-в-бит воспроизводимость.
- **P4. Reduced-motion — переключение характера.** Под `prefers-reduced-motion: reduce` — снап в identity: один синхронный эмит финала (`p = 1`) + `onRest`, ноль кадров rAF. Резолв — один раз на `play`; смена предпочтения в полёте не подхватывается. `matchMedia` — инжектируемый шов (в том числе в DOM-адаптере дефолта **нет** — передайте `window.matchMedia`).
- **P5. Continuity и origin.** C⁰ при любом перехвате по построению (visual pickup — аналитический, из DOM ничего не читается); C¹ — точный при неизменных целях, по доминантному каналу при изменённых. `transform-origin` потребителя — строго `'0 0'` (DOM-адаптер выставляет сам).
- **Clamp-дефолт `false`** — честный overshoot пружины; безопасен: размеры visual box флорятся ≥ 0, opacity — clamp01, публичный `progress` — всегда `[0, 1]`. Осознанное отличие от легаси-дефолта `./flip` (`true`).

Каталог всех LM-кодов с исправлениями — [docs/errors.md](../errors.md).

## Примеры

Основной путь: DOM-адаптер `capture → мутация → play`.

```ts
import { createDomProjection } from '@labpics/motion/projection';

const grid = document.querySelector('#grid') as HTMLElement;
const items = Array.from(grid.children) as HTMLElement[];

const projection = createDomProjection({
  spring: { mass: 1, stiffness: 260, damping: 26 },
  matchMedia: (q) => window.matchMedia(q), // reduced-motion — только через этот шов
});

// FIRST: снимок page-space боксов, радиусов и прежних инлайнов — ДО мутации.
projection.capture(items);

// Мутация layout потребителем: класс, перестановка DOM, resize — что угодно.
grid.classList.toggle('expanded');

// LAST: batch clear → measure → дерево по composed-предкам → полёт.
// Первый кадр — синхронно (анти-мигание); повторный play требует нового capture (LM077).
projection.play();
```

Headless-драйвер: свой writer, скраб жестом и release со скоростью.

```ts
import { createProjection, type ProjectionFrame } from '@labpics/motion/projection';

const card = document.querySelector('.card') as HTMLElement;
card.style.transformOrigin = '0 0'; // жёсткий контракт формул (P5)

const controls = createProjection({
  requestFrame: (cb) => requestAnimationFrame(cb),
  onFrame: (frames: readonly ProjectionFrame[]) => {
    // Массив и объекты кадров переиспользуются — ссылки не удерживать.
    for (const f of frames) {
      if (f.id !== 'card' || f.degenerate) continue;
      card.style.transform = `translate(${f.tx}px, ${f.ty}px) scale(${f.sx}, ${f.sy})`;
      if (f.opacity !== undefined) card.style.opacity = String(f.opacity);
    }
  },
  onRest: () => {
    card.style.transform = ''; // ровно один раз на завершившийся полёт; cancel не зовёт
  },
});

controls.play([
  {
    id: 'card',
    first: { x: 0, y: 0, width: 120, height: 80 },   // px, page-space
    last: { x: 240, y: 160, width: 240, height: 160 },
    opacity: { from: 0, to: 1 },
  },
]);

// Жест ведёт полёт: seek гасит пружину и держит playing === true...
controls.seek(0.6);
// ...а release продолжает пружиной с начальной скоростью (progress/s), C¹-шов.
controls.release(1.2);
```

Чистая математика дерева — без DOM и без пружины (SSR, тесты, свой рендерер).

```ts
import { createProjector, projectAt } from '@labpics/motion/projection';

const projector = createProjector([
  {
    id: 'parent',
    first: { x: 0, y: 0, width: 100, height: 100 },
    last: { x: 0, y: 0, width: 200, height: 100 },
  },
  {
    id: 'child',
    parent: 'parent', // ближайший ПРОЕЦИРУЮЩИЙ предок — не обязательно прямой DOM-родитель
    first: { x: 10, y: 10, width: 40, height: 40 },
    last: { x: 20, y: 10, width: 40, height: 40 },
  },
]);

// Родитель гарантированно раньше ребёнка; scale родителя ребёнка не искажает.
for (const frame of projector.at(0.5)) {
  console.log(frame.id, frame.tx, frame.ty, frame.sx, frame.sy, frame.kx, frame.ky);
}

// Одиночная пара боксов без фабрики: корень (ancestor: null) тождествен
// flipAt(computeFlip(first, last), p) из ./flip на p в [0, 1].
const t = projectAt(
  { first: { x: 0, y: 0, width: 100, height: 100 }, last: { x: 50, y: 0, width: 200, height: 100 } },
  null,
  0.25,
);
console.log(t.tx, t.ty, t.sx, t.sy);
```
