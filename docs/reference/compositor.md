# ./compositor, ./compositor/stagger и ./waapi — compositor-путь и WAAPI

> Роль: справка — публичный API экспорт-субпутей `./compositor` (пружина → compositor-резидентный план + контроллер с ретаргетом и хендоффом), `./compositor/stagger` (composited-каскад группы) и `./waapi` (компиляция модели движка в аргументы `Element.animate()`).

## Назначение

Три субпутя закрывают один маршрут исполнения — **off-main-thread через WAAPI**:

- **`./waapi`** — низкоуровневый эмит: чистая конвертация модели движка (values / times / per-segment easing / repeat) в нативные аргументы `Element.animate()`. Произвольная easing-функция эмитится строкой CSS `linear()` (Baseline с 12.2023). Hw-accel и off-main-thread отдаёт браузер.
- **`./compositor`** — компилятор пружины: аналитическая кривая сэмплируется адаптивно (число узлов выводится из бюджета ошибки, а не фиксировано), кэшируется в bounded LRU и уезжает в `Element.animate()`. Steady-state — ноль работы main-потока: браузер гоняет кривую на compositor-потоке, переживая фризы main-потока. Второе свойство пути — one-shot **хендофф/ретаргет с сохранением скорости**: `(value, velocity)` читаются из тех же serialized stops по `Animation.currentTime` за O(log K), без чтения DOM (`getComputedStyle` форсил бы синхронный recalc).
- **`./compositor/stagger`** — каскад группы: одна запечённая кривая на всех (идентичная пружина → cache hit), per-element сдвиг — нативный WAAPI-`delay`. Steady-state каскада — тоже ноль работы main-потока.

**Граница применимости (фазовая модель).** Этот путь — для автономных переходов и release-фазы (fire-and-forget). Прерывание — редкое one-shot событие ценой ~одного commit-кадра. Непрерывный ретаргет каждый кадр (gesture-follow: cancel + re-emit на кадр) — антипаттерн: follow-фаза жестов живёт на main-потоке (`drive` / `MotionValue`, субпуть `./value`).

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  compileSpringLinear,
  createSpringLinearCache,
  compileSpringPlan,
  readCompositorSpring,
  supportsCompositor,
  supportsLinearEasing,
  resolveCompositorTier,
  CompositorSpring,
  handoffToLive,
  DEFAULT_TOLERANCE,
  type CompositorPlan,
  type CompositorPlanOptions,
  type CompositorSpringOptions,
} from '@labpics/motion/compositor';
```

```ts
import {
  compileStaggerPlan,
  CompositorStaggerGroup,
  // реэкспорт из ./compositor — один consumer-entry владеет всей capability
  compileSpringPlan,
  CompositorSpring,
  type CompositorStaggerOptions,
  type CompositorStaggerPlan,
  type CompositorStaggerGroupOptions,
} from '@labpics/motion/compositor/stagger';
```

```ts
import {
  easingToLinear,
  compileWaapi,
  supportsWaapi,
  animateWaapi,
  type WaapiCompileOptions,
  type WaapiCompiled,
  type WaapiAnimatable,
} from '@labpics/motion/waapi';
```

Тип `SpringParams` (`{mass, stiffness, damping}`) и `MotionValue` — из корня `@labpics/motion`; конструкторы пружин — из `./spring`.

## API — ./compositor

Единицы в этом субпуте: **толерантность — единицы прогресса `[0..1]`**; **длительности плана и задержки — миллисекунды**; аргумент `t` у `readCompositorSpring` — **секунды**; скорость — единицы значения в секунду.

### DEFAULT_TOLERANCE

```ts
const DEFAULT_TOLERANCE: number; // 1/400
```

Дефолтный бюджет ошибки реконструкции кривой в единицах прогресса. Выведен из субпиксельного бюджета: `1/400` прогресса при типичной амплитуде UI-перемещения 100 px = 0.25 px — ниже порога обнаружения. Крупнее амплитуда → передайте `tolerance` меньше (`ε_progress = ε_px / амплитуда_px`) либо задайте абсолютный `maxValueError` (см. `compileSpringPlan`).

### compileSpringLinear

```ts
function compileSpringLinear(spring: SpringParams, options?: SpringLinearOptions): string;

interface SpringLinearOptions {
  readonly v0?: number;        // нормализованная начальная скорость; по умолчанию 0
  readonly tolerance?: number; // ед. прогресса, ∈ (0, 1); по умолчанию DEFAULT_TOLERANCE
}
```

Пружина → CSS `linear()`-строка с **адаптивным** числом узлов (минимум под бюджет ошибки), через общий bounded LRU-кэш модуля. Чистая, SSR-safe, детерминированная.

Бросает: `LM088`/`LM089`/`LM090`/`LM091` (физика и settle-бюджет пружины), `LM008` (`v0` не конечное), `LM014` (`tolerance` вне открытого `(0, 1)`), `LM016` (кривая превышает бюджет сетки — использовать живой путь или увеличить `tolerance`).

### createSpringLinearCache

```ts
function createSpringLinearCache(capacity?: number): SpringLinearCompiler;

interface SpringLinearCompiler {
  compile(spring: SpringParams, options?: SpringLinearOptions): string;
  clear(): void;
  readonly size: number;     // занятые слоты
  readonly capacity: number; // ёмкость в слотах
}
```

Изолированный компилятор со **своим** bounded LRU-кэшем (для тестов/независимых зон, вместо общего кэша `compileSpringLinear`). `capacity` — число слотов, по умолчанию `256`; нецелое или неположительное значение тихо заменяется дефолтом (это дефолт, не ошибка). Попадание в кэш не аллоцирует; ключ — точные пять чисел `mass/stiffness/damping/v0/tolerance` (без квантования). `compile` бросает те же коды, что `compileSpringLinear`.

### compileSpringPlan

```ts
function compileSpringPlan(options: CompositorPlanOptions): CompositorPlan;

interface CompositorPlanOptions {
  readonly spring: SpringParams;
  readonly property: string;       // camelCase WAAPI ('opacity', 'transform'); непустое
  readonly from: number;           // начальное значение в единицах свойства
  readonly to: number;             // конечное значение
  readonly v0?: number;            // нормализованная начальная скорость; по умолчанию 0
  readonly tolerance?: number;     // ед. прогресса; по умолчанию DEFAULT_TOLERANCE
  readonly maxValueError?: number; // абсолютный бюджет в ЕДИНИЦАХ свойства; > 0
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both'; // по умолчанию 'both'
  readonly composite?: 'replace' | 'add' | 'accumulate';      // по умолчанию 'replace'
  readonly format?: (v: number) => string | number;           // по умолчанию число как есть
}

interface CompositorPlan {
  readonly keyframes: Record<string, string | number>[]; // 2 крайних кадра с linear(); в WebKit — явные адаптивные кадры
  readonly easing: string;      // CSS linear()-строка либо обычный linear (WebKit-форма)
  readonly duration: number;    // МИЛЛИСЕКУНДЫ (движок считает в секундах)
  readonly iterations: number;  // всегда 1 (пружина не циклична)
  readonly fill: 'none' | 'forwards' | 'backwards' | 'both';
  readonly composite: 'replace' | 'add' | 'accumulate';
  readonly nodes: readonly SpringNode[]; // {progress, percent} — инспекция/байт-паритетные тесты
}
```

Пружина + `from`/`to`/`property` → исполнимый план `Element.animate()`. Длительность выводится из аналитического закона оседания пружины. `maxValueError` переводится в эффективную толерантность `min(tolerance, maxValueError/|to−from|)` (строже двух бюджетов); вырожденный span (`|to−from| ≈ 0`) деление не выполняет. SSR-safe: capability-проба формы кривой (WebKit vs `linear()`) не обращается к DOM и fail-closed вне браузера.

Бросает: `LM088`–`LM091` (пружина), `LM010` (пустое `property`), `LM011` (`property` из метаданных WAAPI-кейфрейма: `offset`/`easing`/`composite`), `LM009` (`from`/`to`/`v0` не конечные), `LM014` (`tolerance`), `LM170` (`maxValueError` не конечное положительное), `LM016` (бюджет сетки).

### readCompositorSpring

```ts
function readCompositorSpring(
  spring: SpringParams,
  options: ReadSpringOptions,
  out?: { value: number; velocity: number },
): { value: number; velocity: number };

interface ReadSpringOptions {
  readonly from?: number; // по умолчанию 0
  readonly to?: number;   // по умолчанию 1
  readonly v0?: number;   // нормализованная начальная скорость; по умолчанию 0
  readonly t: number;     // СЕКУНДЫ от старта прогона; ≥ 0
}
```

O(1) замкнутая форма: `(value, velocity)` пружины в произвольный момент `t` — механизм ретаргета с сохранением скорости. НЕ читает DOM. `value` — в абсолютных единицах `[from..to]`, `velocity` — единицы/с. Финитность гарантирована. `out` — опциональный scratch-объект (без аллокации на вызов).

Бросает: `LM088`–`LM091`, `LM009` (`from`/`to`/`v0`), `LM012` (`t` не конечное).

### supportsCompositor

```ts
function supportsCompositor(target?: unknown): boolean;
```

Пригодна ли цель/среда для compositor-пути: WAAPI **и** исполнимая форма кривой (WebKit — явные кадры без многостопового `linear()`; остальные движки — CSS `linear()`). С `target` — duck-typing его `.animate`; без — проверка `Element.prototype.animate`. Среда читается только внутри вызова (SSR-safe), решения мемоизированы. `MotionParamError` не бросает.

### supportsLinearEasing

```ts
function supportsLinearEasing(): boolean;
```

Поддерживает ли среда CSS `linear()`-easing (через `CSS.supports`, мемоизируется на реалм). SSR/нет CSS-API → `true` (итоговое решение остаётся за `supportsWaapi`). Не бросает.

### resolveCompositorTier

```ts
function resolveCompositorTier(inputs: {
  readonly target?: unknown;                                    // duck-typed цель WAAPI
  readonly matchMedia?: (query: string) => { matches: boolean } | undefined;
  readonly requestFrame?: unknown;                              // инжектированный планировщик кадров
}): CompositorTier;

type CompositorTier = 'compositor' | 'waapi-no-linear' | 'raf' | 'reduced' | 'ssr';
```

Диагностический resolver тира деградации (тот же, что зовёт конструктор `CompositorSpring`). Тип объекта входов не экспортируется — передавайте литерал. Precedence: `prefers-reduced-motion: reduce` проверяется **первым** (политика доступности перекрывает любой движок) → WAAPI → `linear()`; без WAAPI различаются `raf`/`ssr` по наличию DOM либо инжектированного `requestFrame`. Поведенчески движков два (compositor / живой rAF) + снап (`reduced`); ярлыки `waapi-no-linear`/`raf`/`ssr` различают только причину живого пути. `MotionParamError` не бросает.

### CompositorSpring

```ts
class CompositorSpring {
  constructor(opts: CompositorSpringOptions);
  get tier(): CompositorTier;               // стабилен на весь жизненный цикл
  get mode(): 'compositor' | 'fallback';    // обратная совместимость
  get value(): number;                      // последнее известное значение (конечно)
  start(): void;
  retarget(newTarget: number): void;
  handoffToLive(newTarget?: number): MotionValue;
  stop(): void;
  destroy(): void;
}

interface CompositorSpringOptions {
  readonly spring: SpringParams;
  readonly property: string;                  // непустое
  readonly from: number;
  readonly to: number;
  readonly target?: WaapiAnimatable | undefined; // нет/без .animate → fallback
  readonly apply?: ((value: string | number) => void) | undefined; // писатель fallback-пути
  readonly tolerance?: number | undefined;    // по умолчанию DEFAULT_TOLERANCE
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both' | undefined; // 'both'
  readonly composite?: 'replace' | 'add' | 'accumulate' | undefined;      // 'replace'
  readonly format?: ((v: number) => string | number) | undefined;
  readonly now?: (() => number) | undefined;  // часы (мс); по умолчанию performance.now/Date.now
  readonly requestFrame?: RequestFrameFn | undefined; // для fallback-драйвера
  readonly delay?: number | undefined;        // МИЛЛИСЕКУНДЫ, ≥ 0; по умолчанию 0
  readonly setTimer?: SetTimerFn | undefined; // таймер fallback-задержки; по умолчанию setTimeout
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

type SetTimerFn = (cb: () => void, ms: number) => () => void; // возвращает идемпотентный cancel
```

Контроллер пружины к значению для автономных переходов и release-фазы, выбирающий путь **один раз в конструкторе** (единственное обращение к среде; `.tier` — телеметрия):

- **compositor** — план в `Element.animate()`; steady-state без работы main-потока. Значение пишет браузер, `apply` не вызывается.
- **живой rAF** (`waapi-no-linear` / `raf` / `ssr`) — main-thread драйвер `MotionValue`; значения приходят в `apply` (формат — как в keyframes).
- **снап** (`reduced`, `prefers-reduced-motion: reduce` через инжектированный `matchMedia`) — мгновенная эмиссия финального значения без анимации; единая снап-политика пакета. Детекция один раз в конструкторе; смена системного предпочтения в полёте не подхватывается.

Семантика методов:

- `start()` — запуск `from → to`. `delay` (мс) применяется **только** к первичному старту: на compositor-пути — нативный WAAPI-`delay` (браузер планирует старт off-main-thread), на fallback — отложенный `setTarget` через `setTimer`. В тире `reduced` — снап сразу, `delay` игнорируется.
- `retarget(newTarget)` — one-shot перенацеливание с сохранением effect-space правого slope: O(log K)-снимок `(value, velocity)` из serialized stops + cancel + пере-эмиссия. Для **дискретных** событий; не для покадрового gesture-follow. `delay` не переигрывается.
- `handoffToLive(newTarget?)` — снимает `(value, velocity)` по native `currentTime`, отменяет compositor-`Animation` и продолжает движение живой rAF-пружиной. Возвращает `MotionValue` — дальше значением управляет вызывающий (`setTarget`/`stop`/`destroy` у него); `stop()`/`destroy()` контроллера всё же остановят/освободят его (страховка от утечки). `newTarget` не задан → продолжение к текущему `to` (хвост воспроизводится точно). После `destroy()` возвращает инертный (уже уничтоженный) `MotionValue`.
- `stop()` — останавливает прогон без разрушения; позиция прерывания compositor-эффекта не фиксируется, повторный `start()` идёт от последнего известного значения. Пауза с сохранением позы — контракт `handoffToLive()`.
- `destroy()` — терминально освобождает ресурсы; последующие `start`/`retarget`/`stop` — no-op.

**Гарантия непрерывности** (effect-space, numeric/affine-канал, активный дефолт `fill: 'both'`): новый прогон точно продолжает piecewise-позицию и правый slope. Это не обещание rendered-pixel C¹ при clamping, non-affine `format`, `composite` с меняющимся underlying или fill вне активного интервала.

Конструктор бросает: `LM088`–`LM091` (пружина), `LM010` (`property`), `LM009` (`from`/`to` не конечные), `LM014` (`tolerance`), `LM013` (`delay` не конечное или `< 0`). `retarget`/`handoffToLive` бросают `LM009`/`LM015` соответственно на неконечную цель; compositor-компиляция может транзитом дать `LM016`.

### handoffToLive

```ts
function handoffToLive(opts: HandoffToLiveOptions): MotionValue;

interface HandoffToLiveOptions {
  readonly spring: SpringParams;
  readonly value: number;    // позиция в момент хендоффа
  readonly velocity: number; // ед./с в момент хендоффа
  readonly target?: number;  // по умолчанию = value (выбег по импульсу и возврат)
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly onChange?: ((v: number) => void) | undefined;
  readonly clamp?: boolean | undefined; // по умолчанию false — честная пружина, overshoot эмитится
}
```

Свободная функция моста compositor→live уровня состояния: `(value, velocity)` приходят снаружи (обычно из execution-снимка), DOM не трогается. Строит `MotionValue`, рождённый в этой точке (`initialVelocity`), — первый `setTarget` подхватывает скорость штатным smooth-pickup, позиция и скорость без разрыва (C¹). Продолжить тот же переход → передайте исходный `to` как `target`.

Бросает: `LM088`–`LM091` (пружина), `LM015` (`value`/`velocity`/`target` не конечные).

### Type-only экспорты ./compositor

`SpringNode`, `HandoffToLiveOptions`, `CompositorTier`, `SpringLinearOptions`, `SpringLinearCompiler`, `CompositorPlan`, `CompositorPlanOptions`, `ReadSpringOptions`, `SetTimerFn`, `CompositorSpringOptions`.

## API — ./compositor/stagger

Субпуть реэкспортирует из `./compositor` runtime-экспорты **`compileSpringPlan`** и **`CompositorSpring`** (те же объекты; контракты — выше) плюс типы `CompositorPlan`, `CompositorPlanOptions`, `CompositorSpringOptions`, `SetTimerFn` — чтобы один consumer-entry владел всей capability без второй копии ядра в приложении.

Общие опции распределения каскада (проксируют `./stagger`; поле `from` переименовано в `staggerFrom`, чтобы не конфликтовать со spring-`from`): `gap` — базовый шаг задержки между соседями, **мс**, по умолчанию `50`; `staggerFrom: 'first' | 'last' | 'center' | 'edges' | number` — точка отсчёта, по умолчанию `'first'`; `staggerEasing` — easing на нормализованную позицию элемента, по умолчанию linear; `grid: { columns }` — 2D-дистанция; `reducedMotion` — все задержки → 0 (каскад схлопывается, элементы всё равно анимируются).

### compileStaggerPlan

```ts
function compileStaggerPlan(options: CompositorStaggerOptions): CompositorStaggerPlan;

interface CompositorStaggerOptions /* extends общие опции плана + распределения */ {
  readonly count: number;  // неотрицательное целое, ≤ 100 000
  readonly v0?: number;    // форма кривой чистого плана; по умолчанию 0
  readonly spring: SpringParams;
  readonly property: string;
  readonly from: number;   // общее для всех элементов
  readonly to: number;
  readonly tolerance?: number;
  readonly fill?: 'none' | 'forwards' | 'backwards' | 'both';
  readonly composite?: 'replace' | 'add' | 'accumulate';
  readonly format?: (v: number) => string | number;
  readonly gap?: number;
  readonly staggerFrom?: 'first' | 'last' | 'center' | 'edges' | number;
  readonly staggerEasing?: (t: number) => number;
  readonly grid?: { columns: number };
  readonly reducedMotion?: boolean;
}

interface CompositorStaggerPlan /* extends CompositorPlan */ {
  // ...все поля CompositorPlan (общая кривая), плюс:
  readonly delays: readonly number[]; // per-element WAAPI-delay, МИЛЛИСЕКУНДЫ; длина = count
  readonly count: number;
}
```

**Чистый** планировщик composited stagger: общий план пружины (одна компиляция на группу, общий кэш `./compositor`) + массив per-element задержек (ядро `./stagger`). SSR-safe, детерминирован, без DOM — SSOT расписания группы.

Бросает: `LM017` (`count` не целое, `< 0` или `> 100 000`) + всё, что бросает `compileSpringPlan`.

### CompositorStaggerGroup

```ts
class CompositorStaggerGroup {
  constructor(opts: CompositorStaggerGroupOptions);
  get mode(): 'compositor' | 'fallback'; // по первому элементу; пустая группа → 'fallback'
  get count(): number;
  get delays(): readonly number[];       // мс
  get plan(): CompositorStaggerPlan;     // инспекция/тесты
  valueAt(index: number): number;        // NaN при выходе индекса за диапазон
  start(): void;
  retarget(index: number, newTarget: number): void;
  retargetAll(newTarget: number): void;
  handoffToLive(index: number, newTarget?: number): MotionValue;
  stop(): void;
  destroy(): void;
}

interface CompositorStaggerGroupOptions /* extends общие опции плана + распределения */ {
  readonly targets: ReadonlyArray<WaapiAnimatable | undefined>; // count = targets.length
  readonly apply?: ((index: number, value: string | number) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly setTimer?: SetTimerFn | undefined;
}
```

Контроллер группы: по одному `CompositorSpring` на элемент (со своей stagger-задержкой). Элемент с `undefined` целью (или без `.animate`) уходит на fallback-путь, сохраняя задержку через `setTimer`; его значения приходят в `apply(index, value)`.

Границы модели (что per-group, что per-element):

- **Каскад (`start`) — per-group**: все элементы получают одну кривую и свой WAAPI-`delay`.
- **Ретаргет — per-element**: `retarget(index, v)` — one-shot на одном элементе; `retargetAll(v)` — fan-out в N независимых ретаргетов **одновременно, без пере-каскада** (ретаргет — дискретное прерывание, не новый парад; нужен каскадный ретаргет → новый `start()`).
- **Хендофф — только per-element**: `handoffToLive(index, newTarget?)` отдаёт один элемент живой пружине. Группового хендоффа нет: «группа целиком стала интерактивной» — не сценарий хендоффа.

Контроллер стартует элементы из покоя (скорость появляется лишь через retarget smooth-pickup); опция `v0` действует только в чистом `compileStaggerPlan`.

Бросает: конструктор — `LM018` (`targets` не массив), `LM017` (`targets.length > 100 000`) + коды `compileSpringPlan`; `retarget(index, …)` — `LM019`, `handoffToLive(index, …)` — `LM020` (индекс вне группы).

### Type-only экспорты ./compositor/stagger

`CompositorPlan`, `CompositorPlanOptions`, `CompositorSpringOptions`, `SetTimerFn`, `CompositorStaggerOptions`, `CompositorStaggerPlan`, `CompositorStaggerGroupOptions`.

## API — ./waapi

Единицы: `duration`/`repeatDelay` во **входных** опциях — секунды движка; `timing.duration` на **выходе** — миллисекунды (конвенция WAAPI).

### easingToLinear

```ts
function easingToLinear(fn: (t: number) => number, points?: number): string;
```

Произвольная easing-функция движка → строка CSS `linear()`. Равноудалённые стопы (проценты по спеке не требуются), округление до 4 знаков — детерминированно и компактно. Выход зашит `normalizeEasing` (`NaN → 0`, `±Infinity → ±MAX_VALUE`) — CSS-safe. `points` — число точек сэмплирования, целое `≥ 2`, по умолчанию `33`.

Бросает: `LM119` (`points` не целое или `< 2`).

### compileWaapi

```ts
function compileWaapi(options: WaapiCompileOptions): WaapiCompiled;

interface WaapiCompileOptions {
  readonly property: string;               // camelCase WAAPI; непустое
  readonly values: readonly number[];      // длина ≥ 2, конечные
  readonly duration?: number;              // СЕКУНДЫ движка, > 0; по умолчанию 1
  readonly times?: readonly number[];      // доли [0,1] на значение; нет → равномерно
  readonly easing?: ((t: number) => number) | readonly ((t: number) => number)[];
  readonly repeat?: number;                // ДОПОЛНИТЕЛЬНЫЕ повторы: целое 0…2147483647 или Infinity
  readonly repeatType?: 'loop' | 'reverse' | 'mirror'; // по умолчанию 'loop'
  readonly repeatDelay?: number;           // СЕКУНДЫ, ≥ 0
  readonly format?: (v: number) => string | number;
  readonly easingPoints?: number;          // целое ≥ 2; по умолчанию 33
}

interface WaapiCompiled {
  readonly keyframes: Record<string, string | number>[];
  readonly timing: {
    readonly duration: number;   // МИЛЛИСЕКУНДЫ
    readonly iterations: number; // repeat + 1 (полное число) либо Infinity
    readonly direction: 'normal' | 'alternate';
    readonly fill: 'none' | 'forwards' | 'backwards' | 'both'; // всегда 'both'
  };
}
```

Чистая компиляция модели движка в аргументы `Element.animate()`. Маппинг:

- `times[i]` → `offset` (оба `[0,1]` по возрастанию; `times[0] = 0`, `times[last] = 1`);
- per-segment easing движка → per-keyframe easing WAAPI (действие «от кадра до следующего», перенос 1:1); один общий easing или массив длиной `values.length − 1`; каждая функция эмитится через `easingToLinear`;
- `repeat` → `iterations = repeat + 1`; `repeatType 'loop'` → `direction 'normal'`, `'reverse'` → `'alternate'`; **`mirror` с `repeat > 0` fail-closed** (`LM160`): WAAPI `alternate` разворачивает time/easing и не эквивалентен перестановке generator-values;
- `repeatDelay`: у WAAPI нет per-iteration delay. Бесконечный `loop` запекает паузу hold-сегментом в повторяемый цикл; **конечный `repeat` с `repeatDelay > 0` fail-closed** (`LM161`) — portable terminal/reset-семантики нет; такой track направляйте в канонический keyframes-runner (`./keyframes`);
- `fill` всегда `'both'`: WAAPI-дефолт `'none'` снэпает элемент обратно после finish — сюрприз, не поведение.

Бросает: `LM120` (пустое `property`), `LM121` (`property` = `offset`/`easing`/`composite`), `LM122` (`values.length < 2`), `LM123` (неконечное значение), `LM124`–`LM126` (`times`: длина/концы/неконечная или убывающая отметка), `LM127` (`duration`), `LM128` (`repeat`), `LM129` (`repeatDelay`), `LM130` (`repeatType`), `LM131` (`repeatDelay` с не-`loop` повтором), `LM160` (mirror-повтор), `LM161` (расписание непредставимо / finite `repeatDelay`), `LM162` (timing/offset схлопнулись после масштаба в binary64), `LM132`–`LM134` (контейнер/длина/элемент `easing`), транзитом `LM119` (`easingPoints`).

### supportsWaapi

```ts
function supportsWaapi(target?: unknown): boolean;
```

Feature-detect WAAPI. С `target` — duck-typing его `.animate`; без — проверка `Element.prototype.animate`, выполняемая **только внутри вызова** (SSR-safe). `MotionParamError` не бросает.

### animateWaapi

```ts
function animateWaapi(
  el: WaapiAnimatable,
  options: WaapiCompileOptions & { fill?: 'none' | 'forwards' | 'backwards' | 'both' },
): unknown;

interface WaapiAnimatable {
  animate(keyframes: Record<string, string | number>[], timing: object): unknown;
}
```

Тонкий адаптер: компилирует (`compileWaapi`) и коммитит в `el.animate()`. Возвращает нативный `Animation` (`play`/`pause`/`reverse`/`finished` — у браузера); тип `unknown`, так как контракт цели duck-typed (тестируется без DOM). Позволяет переопределить `fill`.

Бросает: `LM135` (цель без WAAPI — **рано, до компиляции**) + все коды `compileWaapi`.

### Type-only экспорты ./waapi

`WaapiEasingFn`, `WaapiCompileOptions`, `WaapiCompiled`, `WaapiAnimatable`.

## Контракты

- **SSR-safe / zero-DOM на импорте.** Ни один из трёх субпутей не обращается к DOM-глобалам на импорте. `supportsWaapi`/`supportsCompositor`/`supportsLinearEasing`/`resolveCompositorTier` читают среду только внутри вызова; конструктор `CompositorSpring` делает детекцию тира один раз и не трогает часы/DOM; native time читается только при прерывании.
- **Детерминизм.** Компиляторы — чистые функции: идентичный вход → идентичный артефакт. `easingToLinear` — фиксированная сетка, округление до 4 знаков; compositor-сегментация — адаптивная (RDP по бюджету ошибки), без wall-clock; кэш — точный числовой ключ без квантования (квантование меняло бы физику сильнее `tolerance`).
- **Финитность.** `NaN`/`±Infinity` никогда не попадают в CSS: входы валидируются рано (`MotionParamError`), выходы easing зашиты `normalizeEasing`, `readCompositorSpring` и `value` контроллера всегда конечны.
- **Reduced-motion.** Две согласованные политики: одиночный `CompositorSpring` при `prefers-reduced-motion: reduce` (инжектированный `matchMedia`) выбирает тир `reduced` — мгновенный снап к цели, стартовая `delay` игнорируется (единая снап-политика пакета). Каскад (`reducedMotion: true` в stagger-опциях) — CHARACTER-switch из `./stagger`: все задержки → 0, элементы всё равно анимируются.
- **Фазовая модель.** Ретаргет и хендофф — редкие one-shot события (~один commit-кадр); непрерывный per-frame ретаргет — антипаттерн, follow-фаза жестов живёт на main-потоке (`./value`).
- **Непрерывность C¹.** Ретаргет/хендофф читают `(value, velocity)` из фактически исполняемых serialized stops (не из `getComputedStyle`); live-пружина рождается в этой точке — позиция и правый slope без разрыва (effect-space; см. оговорки у `CompositorSpring`).
- **Ошибки.** Все броски — `MotionParamError` с полем `code` (`LM008`–`LM020`, `LM088`–`LM091`, `LM119`–`LM135`, `LM160`–`LM162`, `LM170`); полный каталог с лечением — [docs/errors.md](../errors.md).

## Примеры

Compositor-переход с дискретным ретаргетом и хендоффом в live:

```ts
import { CompositorSpring } from '@labpics/motion/compositor';
import { springPresets } from '@labpics/motion/spring';

const card = document.querySelector('.card') as HTMLElement;

const spring = new CompositorSpring({
  spring: springPresets.default,
  property: 'transform',
  from: 0,
  to: 240,
  target: card, // есть WAAPI + linear() → значение ведёт браузер на compositor-потоке
  // Писатель нужен только fallback-пути (waapi-no-linear / raf / ssr):
  apply: (v) => { card.style.transform = String(v); },
  format: (x) => `translateX(${x}px)`,
  matchMedia: typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined,
});

spring.start();

// Дискретное событие: перенацелить, сохранив скорость (one-shot, не per-frame).
setTimeout(() => spring.retarget(120), 300);

// Палец перехватил элемент → хендофф в живую rAF-пружину (владение у вызывающего).
card.addEventListener('pointerdown', () => {
  const live = spring.handoffToLive();
  live.setTarget(0);
});
```

Composited-каскад списка (одна кривая, нативные WAAPI-задержки):

```ts
import { CompositorStaggerGroup } from '@labpics/motion/compositor/stagger';
import { fromBounce } from '@labpics/motion/spring';

const items = Array.from(document.querySelectorAll('.list-item')) as HTMLElement[];

const group = new CompositorStaggerGroup({
  spring: fromBounce({ duration: 0.5, bounce: 0.2 }),
  property: 'opacity',
  from: 0,
  to: 1,
  targets: items,
  apply: (i, value) => { items[i]!.style.opacity = String(value); }, // fallback-путь
  gap: 60,                // мс между соседями
  staggerFrom: 'center',  // центр стартует первым
});

group.start();               // каскад — per-group
group.retargetAll(0.5);      // fan-out per-element, каскад НЕ переигрывается
```

Чистый WAAPI-эмит произвольного трека:

```ts
import { animateWaapi, compileWaapi, supportsWaapi } from '@labpics/motion/waapi';
import { springAsEasing, springPresets } from '@labpics/motion/spring';

const box = document.querySelector('.box') as HTMLElement;
const options = {
  property: 'opacity',
  values: [0, 1, 0.85, 1],
  times: [0, 0.4, 0.7, 1],
  duration: 0.6, // секунды движка; timing.duration выйдет в миллисекундах
  easing: springAsEasing(springPresets.gentle), // один easing на все сегменты
};

if (supportsWaapi(box)) {
  animateWaapi(box, options); // возвращает нативный Animation
} else {
  const compiled = compileWaapi(options); // чистый артефакт — исполните своим путём
  console.log(compiled.timing.duration, compiled.keyframes.length);
}
```
