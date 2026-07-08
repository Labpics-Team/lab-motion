# @labpics/motion

Headless-движок анимаций без runtime-зависимостей. Часть дизайн-системы Labpics.

Ядро — чистая математика (пружины, кадры, тайминги): ноль DOM, детерминизм
через инжектируемое виртуальное время, SSR-безопасность, гарантия конечности
(NaN/Infinity никогда не попадают в CSS), `prefers-reduced-motion` меняет
ХАРАКТЕР анимации, а не выключает её грубо. Каждая фича — изолированный
subpath: в бандл попадает только то, что импортировано.

## Установка

Пакет пока не опубликован в npm (публикация — отдельное решение). До этого —
установка из тарбола (git-install не поддержан: `dist/` собирается, в гите его нет):

```bash
cd lab-motion && pnpm build && pnpm pack   # → labpics-motion-<версия>.tgz
cd ваш-проект && pnpm add /путь/к/labpics-motion-<версия>.tgz
```

Требования: Node ≥18. Рантайм-зависимостей нет; фреймворк для биндингов —
peer (ставится у потребителя). Целостность артефакта проверяется
`pnpm pack:smoke` (тарбол → чистый проект → импорт всех субпутей).

## Как собрать

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build      # → dist/*
pnpm test
pnpm size       # замер gz всех субпутей
pnpm bench      # ns/операцию горячих путей против dist (нужен pnpm build)
```

Перф-путь аналитический (O(1) на кадр, closed-form солвер). Числа `pnpm bench` —
справочные (ns/op машинозависимы); запечатан детерминированный инвариант работы
(`test/perf-hot-path.test.ts`: число кадров до сходимости = вызовов солвера,
машинонезависим).

## Карта субпутей

| Импорт | Что даёт |
|---|---|
| `@labpics/motion` | Ядро: `spring` (аналитический солвер), `tween`, `drive` (декларативный запуск), `MotionValue` (реактивное значение со smooth-pickup), `MotionParamError` |
| `…/easing` | Каталог кривых: named-кривые, `cubicBezier`, `steps`, кастомные функции |
| `…/value` | CSS-значения: парсинг/интерполяция единиц (px/%/deg/rem/vh), цветов (hex/rgb/hsl), transform-компонент, `var()`, относительных значений |
| `…/driver` | Scrubbable-контроллер: `play/pause/reverse/seek/timeScale/progress` + thenable |
| `…/keyframes` | Ключевые кадры: массивы, offsets, per-keyframe easing, repeat/reverse/yoyo |
| `…/timeline` | Оркестрация: `createTimeline` — сегменты, `seek/progress/totalDuration`, thenable |
| `…/stagger` | Каскадные задержки: списки и 2D-сетки, from/направления/easing |
| `…/decay` | Инерция: аналитическое затухание (для drag-momentum и инерционного скролла) |
| `…/gestures` | Интеракция: `createPress` (tap + клавиатурный путь Enter/Space), `createHover`, `createPan`, `createDrag` (границы + rubber-band + инерция + reduced-motion) |
| `…/scroll` | Скролл: прогресс страницы/target-с-офсетами (семантика Motion), in-view машина, скорость, scrub-клей к timeline |
| `…/presence` | Enter/exit lifecycle: «доиграй exit-анимацию → потом убирай из DOM», прерывания, `swapPresence` (wait/sync) |
| `…/flip` | Layout-анимация FLIP: инверсия first→last, пружинный «доезд», коррекция scale-искажений (`correctRadius`, `counterScale`) |
| `…/svg` | SVG: `parsePath`/`pathLength`, draw-математика штриха (`drawPath`), движение вдоль пути (`createMotionPath`) |
| `…/a11y` | Доступность: `createMotionConfig` — политика reduced-motion (`system`/`always`/`never`), меняет характер анимации, не выключает |
| `…/spring` | Эргономика пружин: `fromBounce` (duration+bounce ∈ [−1,1], канон SwiftUI ⊇ Motion [0,1]), `fromVisualDuration`, `springPresets` (канон react-spring), `springAsEasing` |
| `…/waapi` | Compositor-путь (низкоуровневый): `compileWaapi`/`animateWaapi` (кейфреймы движка → нативный `Element.animate`, hw-accel), `easingToLinear` (любой easing → CSS `linear()`), `supportsWaapi` |
| `…/compositor` | Compositor-компилятор ПРУЖИН: `compileSpringLinear` (пружина → адаптивный CSS `linear()`, число стопов ВЫВОДИТСЯ из бюджета ошибки), `compileSpringPlan`, `readCompositorSpring` (O(1) closed-form чтение value+velocity), `CompositorSpring` (one-shot хендофф с сохранением скорости C¹ + байт-паритетный main-thread fallback; `retarget` — смена цели в полёте, `handoffToLive` — переход на живую rAF-пружину, `delay` — стартовая задержка), `handoffToLive` (снимок → live `MotionValue` с сохранением скорости), **composited stagger** (`compileStaggerPlan` — общая кривая + per-element задержки; `CompositorStaggerGroup` — каскад группы на компоьзиторе через нативный WAAPI-delay, ноль работы main-потока), `createSpringLinearCache` (LRU), `supportsCompositor`. См. «Границы применимости» ниже |
| `…/tokens` | Motion-токены (ФУНДАМЕНТ, не вся ДС): `duration` (шкала мс), `easing` (семантические cubic-bezier `{fn, css}`), `spring` (пружинные пресеты для compositor), `staggerGap` (шаг каскада), `distanceScale` (травел→длительность). Типобезопасны (`as const`), tree-shakeable по семействам, не кричащие дефолты (Apple/Fluent/Material). Роль→токен — у потребителя (labui), не тут |
| `…/auto` | Zero-config FLIP: `autoAnimate(parent)` — add/remove/move детей анимируются сами (класс AutoAnimate); reduced-motion меняет характер (move→снап), не выключает |
| `…/svg-morph` | Морфинг путей: `interpolatePath(dFrom, dTo)` — точный режим при совпадающей структуре, ресэмплинг с выравниванием старта/обхода замкнутых при разной |
| `…/frame` | Единый frame-шедулер: `createFrameLoop` / синглтон `frame` — один rAF на кадр, фазы read→update→render против layout-thrash, ленивый старт/стоп, SSR-safe; `asRequestFrame(loop)` сажает MotionValue/drive на общий кадр через `opts.requestFrame` (N значений = один rAF). **Биндинги используют его ПО УМОЛЧАНИЮ** — все значения приложения делят один rAF без ручной настройки (как shared-ticker у Framer Motion/GSAP); инжекция своего `requestFrame` переопределяет. |
| `…/presets` | Словарь generic-движений «от смысла» (иконки): 10 фабрик (pulse, blink, wiggle…), мультитрековые кейфреймы (scale/rotate/x/y/opacity/progress), `runPreset` с виртуальным временем, `presetToWaapi` |
| `…/utils` | Value-mapping примитивы (ядро Framer Motion / GSAP, headless): `mapRange`, `interpolate` (N-стоповый маппер: клампинг, per-segment easing, кастомный `mixer` для не-числовых значений), `clamp`, `wrap`, `snap` (сетка/набор), `mix`, `pipe`. Каррируемые config-first, финитность-гарантированы (никаких NaN/∞), tree-shakeable (один символ ≈ 0.3 KB gz) |
| `…/react` | React: `useSpring`, `useMotionValue` |
| `…/preact` | Preact: `useSpring`, `useMotionValue` (зеркало react-биндинга поверх `preact/hooks`) |
| `…/solid` | Solid: `createSpring`, `createMotionValue` (сигналы, авто-уборка через `onCleanup`) |
| `…/angular` | Angular (v16+): `injectSpring`, `injectMotionValue` (Signals + DestroyRef, injection context) |
| `…/qwik` | Qwik: `useSpring` — управление сигналом `target` (резюм-safe), MotionValue = noSerialize, пересоздаётся на клиенте |
| `…/wc` | Vanilla web-component `<lab-spring>` без зависимостей — путь для Astro/Stencil/HTML-first стеков |
| `…/svelte` | Svelte: `springStore` |
| `…/vue` | Vue: директива `v-motion` |
| `…/lit` | Lit / web-components: `MotionController` (ReactiveController), `LabMotionSpringElement` |

## Быстрый старт

### Пружина к значению (ядро)

```typescript
import { MotionValue } from '@labpics/motion';

const x = new MotionValue({ initial: 0, spring: { mass: 1, stiffness: 200, damping: 20 } });
x.onChange((v) => { el.style.transform = `translateX(${v}px)`; });
x.setTarget(240);   // плавно едем; повторный setTarget подхватит скорость без рывка
```

### Управляемая анимация (scrub)

```typescript
import { createDriver } from '@labpics/motion/driver';

const anim = createDriver({ from: 0, to: 1, spring: { mass: 1, stiffness: 200, damping: 24 },
  onStep: (v) => { el.style.opacity = String(v); } });
anim.pause();
anim.seek(0.5);
await anim; // thenable
```

### Скролл-прогресс → таймлайн

```typescript
import { createScrollObserver, scrubBinding } from '@labpics/motion/scroll';
import { createTimeline } from '@labpics/motion/timeline';

const tl = createTimeline({ segments: [{ from: 0, to: 1, duration: 2 }] });
const observer = createScrollObserver({ onProgress: scrubBinding(tl) });
window.addEventListener('scroll', (e) => observer.update({
  pos: scrollY, contentLength: document.body.scrollHeight,
  viewportLength: innerHeight, t: e.timeStamp / 1000,
}));
```

### Drag с инерцией

```typescript
import { createDrag } from '@labpics/motion/gestures';

const drag = createDrag({
  bounds: { x: { min: 0, max: 300 } },
  matchMedia: window.matchMedia.bind(window),
  requestFrame: requestAnimationFrame.bind(window),
  onStep: (x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; },
});
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  drag.pointerDown({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 });
});
el.addEventListener('pointermove', (e) => drag.pointerMove({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }));
el.addEventListener('pointerup', (e) => drag.pointerUp({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }));
```

### FLIP (layout-анимация)

```typescript
import { createFlip } from '@labpics/motion/flip';

const fl = createFlip({
  requestFrame: requestAnimationFrame.bind(window),
  onStep: (t) => { el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`; },
  onRest: () => { el.style.transform = ''; },
});
const first = el.getBoundingClientRect();
// ... DOM переставлен (порядок/размер/класс изменился) ...
fl.play(first, el.getBoundingClientRect()); // элемент «доезжает» пружиной
```

### Появление/уход (presence)

```typescript
import { drive } from '@labpics/motion';
import { createPresence } from '@labpics/motion/presence';

const spring = { mass: 1, stiffness: 200, damping: 24 };
const p = createPresence({
  onExitStart: (done) => {
    drive({ from: 1, to: 0, spring, onStep: (v) => { el.style.opacity = String(v); } }).then(done);
  },
  onGone: () => el.remove(), // убрать из DOM только после exit-анимации
});
p.exit();
```

### Value-mapping (utils)

```typescript
import { mapRange, interpolate, clamp, wrap, pipe } from '@labpics/motion/utils';

mapRange(0, 100, 0, 1, 50);              // 0.5 — ремап диапазона (канон GSAP mapRange)
const fade = interpolate([0, 100, 200], [0, 1, 0]); // N-стоповый маппер (канон Framer transform)
fade(50);                                // 0.5 — кусочно-линейно между стопами
const hue = wrap(0, 360);                // циклический wrap в полуинтервал [0, 360)
hue(370);                                // 10
const toProgress = pipe(clamp(0, 300), (x) => x / 300); // композиция слева-направо
```

### Compositor-компилятор пружин (автономный переход, ноль работы main-потока)

```typescript
import { CompositorSpring, compileSpringLinear } from '@labpics/motion/compositor';

// Чистый компилятор (SSR-safe): пружина → адаптивный CSS linear() (стопов — минимум
// под перцептивный бюджет; критическая ~32, bouncy ~69 против фикс ~40–100 у Motion/MDN).
const easing = compileSpringLinear({ mass: 1, stiffness: 170, damping: 26 });
el.style.transition = `transform 0.9s ${easing}`;

// Контроллер: коммитит план в Element.animate() (compositor-поток, переживает фризы);
// если WAAPI нет — байт-паритетный main-thread fallback (MotionValue) в apply().
const panel = new CompositorSpring({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'transform', from: 0, to: 240,
  target: el, format: (v) => `translateX(${v}px)`,
  apply: (val) => { el.style.transform = String(val); }, // только на fallback-пути
});
panel.start();
// ДИСКРЕТНОЕ прерывание (смена цели), НЕ покадрово: O(1) чтение value+velocity → новая
// кривая с непрерывной скоростью (C¹). Стоит ~один commit-кадр хендоффа.
panel.retarget(120);

// ХЕНДОФФ compositor→live: будущая траектория перестала быть автономной (палец
// перехватил значение — follow-фаза). Снимок (value, velocity) ЗАМКНУТОЙ формой
// (без getComputedStyle) → живая rAF-пружина продолжает БЕЗ разрыва позиции и
// скорости (C¹). Дальше значением управляет вызывающий (setTarget/stop/destroy).
const live = panel.handoffToLive();          // продолжить к текущей цели, ИЛИ
const live2 = panel.handoffToLive(300);      // сразу к новой цели с сохранённой скоростью
```

Латентность горячих путей (`pnpm bench:latency`, main-thread, Node v24, справочно —
машинозависимо, гейтом НЕ является; распределение ОДНОЙ операции, p50/p95/p99):

| путь | p50 | p95 | p99 |
|---|---|---|---|
| `readCompositorSpring` (аналитический снимок) | ~100 ns | ~200 ns | ~300 ns |
| `CompositorSpring.retarget` (read+cancel+рекомпиляция+re-emit) | ~20 µs | ~30 µs | ~54 µs |
| `handoffToLive` (снимок → live `MotionValue`) | ~200 ns | ~200 ns | ~200 ns |
| `CompositorSpring.handoffToLive` (полный) | ~300 ns | ~400 ns | ~700 ns |

Хендофф-p99 ≈ 0.02% кадра при 240 Hz — стоимость на main-потоке пренебрежимо мала;
доминанта ретаргета — перекомпиляция кривой (промах кэша при новой скорости).

**Границы замера.** Стенд меряет ТОЛЬКО main-thread cost (Node, против `dist`).
Compositor-резидентность (осталась ли анимация на compositor-потоке после
`Element.animate`/мутации) и input→photon **НЕ наблюдаемы из JS** — достоверно
только реальным Chrome + tracing (`cc.animation` в DevTools Performance), вне
CI-скоупа (ручная валидация). Браузерный слой (PerformanceObserver LoAF / Event
Timing) — по той же причине не в этом стенде.

**Мутации `playbackRate`/`currentTime` для ретаргета — вердикт (опровергнуто как
механизм ретаргета).** Гипотеза research (помечена «непроверено»): их мутация
compositor-safe и годится как дешёвая замена cancel+re-emit. Проверка по W3C Web
Animations L1 (§4.4.4 «set current time», §4.4.15 «set/seamlessly update playback
rate») и MDN: обе операции живут в **timing model** и НЕ трогают `KeyframeEffect`
(кривую/конечную точку) — `playbackRate` лишь единый скаляр скорости вдоль уже
запечённой кривой, `currentTime` — seek по ней. Ретаргет пружины требует НОВОЙ
точки равновесия И нового профиля скорости из текущих (pos, vel) — это **новый**
`KeyframeEffect`, а не тайминг-твик. Поэтому cancel + рекомпиляция `linear()` через
кэш + re-emit — НЕОБХОДИМЫ, а не упущенная оптимизация. (Под-утверждение «мутация
остаётся на compositor-потоке» правдоподобно по спеке/MDN — `updatePlaybackRate`
спроектирован под off-main-thread анимации — но из JS не верифицируемо; см.
«Границы замера».)

### Composited stagger (каскад группы на компоьзиторе)

Каскадный (staggered) запуск группы, где ЗАДЕРЖКИ каждого элемента — нативный
WAAPI-`delay` поверх ОДНОЙ запечённой `linear()`-кривой пружины, а НЕ покадровая
работа main-потока. Пружина компилируется один раз (общий кэш отдаёт всем
элементам одну кривую), сдвиг во времени задаёт браузер на compositor-потоке.

```typescript
import { CompositorStaggerGroup, compileStaggerPlan } from '@labpics/motion/compositor';

// Чистый планировщик (SSR-safe): общая кривая + per-element задержки (headless).
const plan = compileStaggerPlan({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'opacity', from: 0, to: 1,
  count: 5, gap: 40, staggerFrom: 'first',   // → delays [0, 40, 80, 120, 160] мс
});

// Контроллер группы: N целей делят кривую, каждый стартует со своей задержкой.
const list = new CompositorStaggerGroup({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'transform', from: 24, to: 0,
  targets: rows,                              // N Element'ов; count = rows.length
  gap: 40, staggerFrom: 'center',
  format: (v) => `translateY(${v}px)`,
  apply: (i, v) => { rows[i].style.transform = String(v); }, // только fallback-путь
});
list.start();                                 // каскад: N Element.animate с delay[i]
```

**Граница per-group vs per-element (согласовано с M2, честно):**

- **Каскад (`start`) — per-GROUP.** Стартовые задержки — свойство ФАЗЫ ЗАПУСКА;
  это и есть composited-выигрыш (steady-state — ноль работы main-потока).
- **Ретаргет — per-ELEMENT.** Примитив M2 (снимок замкнутой формой + cancel +
  re-emit, C¹) поэлементен. `retarget(i, to)` действует на один элемент;
  `retargetAll(to)` — fan-out одновременно, БЕЗ пере-каскада (ретаргет есть
  дискретное прерывание, не новый парад — пере-stagger копил бы латентность).
- **Хендофф — per-ELEMENT только.** `handoffToLive(i, to?)` отдаёт ОДИН элемент
  (тот, что стал интерактивным) в живую rAF-пружину. Группового хендоффа нет.

Reduced-motion (флаг `reducedMotion`) схлопывает все задержки в 0 — элементы
анимируются, но одновременно (CHARACTER-switch, не hard-off).

Планирование (`pnpm bench:latency`, справочно, машинозависимо): `compileStaggerPlan`
p50 ≈ 14 µs и ПЛОСКО по N=10/50/200 (пружина компилируется один раз, per-element
задержки дёшевы); `CompositorStaggerGroup.start` растёт линейно с N (по одному
`Element.animate` на элемент). Per-frame стоимость каскада — НОЛЬ (гоняет браузер).

## Motion-токены (фундамент движения)

Типобезопасный словарь примитивов движения: длительности, изинги, пружины,
дистанс-скейл, шаг каскада — плюс их именование, готовое к оркестрации сверху
(роль → токен) слоем дизайн-системы. Это ФУНДАМЕНТ, а не вся ДС: семантики ролей
(«кнопка-ховер») здесь нет — она у потребителя (labui). Дефолты не кричащие
(в духе Apple spring-first / Fluent 2 / Material 3): критично-задемпфированные
пружины и мягкие изинги, bounce — opt-in. Значения запинены тестами как контракт.

```typescript
import { duration, easing, spring, staggerGap, distanceScale } from '@labpics/motion/tokens';

duration.normal;        // 250 (мс): дефолтный UI-переход
easing.entrance.css;    // 'cubic-bezier(0, 0, 0.2, 1)' — для CSS/WAAPI/compositor
easing.entrance.fn;     // EasingFn — для ./keyframes / ./stagger
spring.default;         // { mass: 1, stiffness: 170, damping: 26 } — для ./compositor
staggerGap.normal;      // 40 (мс): шаг каскада для compileStaggerPlan({ gap })

// Дистанс-скейл: чем дальше путь, тем дольше движение (единообразная скорость).
distanceScale(200);     // 275 (мс) в дефолтной полосе 0→400px ↦ fast(150)→slow(400)
```

Каждое семейство — отдельный экспорт, tree-shakeable (импорт `duration` не тянет
`easing`/`cubicBezier`; `sideEffects: false`). Весь субпуть ~1.1 KB gz.

## Границы применимости (compositor-путь vs main-поток)

Фазовая модель (заземлена red-team-исследованием; путать фазы — класс дефекта):

- **Compositor (`…/compositor`, `…/waapi`)** — для **автономных переходов, settle
  и release-фазы** жеста. Fire-and-forget: скомпилировать `linear()` → `Element.animate`.
  Пружина живёт на compositor-потоке, main-поток не будится до завершения.
- **Main-поток (`drive` / `MotionValue` / `…/gestures`)** — для **интерактива и
  follow-фазы** (палец ведёт значение, будущая траектория неизвестна).
- **Прерывание compositor-анимации** — **редкое ONE-SHOT событие** (`CompositorSpring.retarget`):
  cancel + аналитическое чтение (value, velocity) + новая кривая. Стоит ~один commit-кадр
  хендоффа. **Непрерывный ретаргет каждый кадр (gesture-follow через cancel+re-emit) —
  задокументированный АНТИПАТТЕРН**: для follow берите main-поток.
- **`will-change`** — bounded-дисциплина у потребителя: включать точечно перед переходом
  и **снимать после завершения**, не «на всякий случай» (иначе лишние слои и GPU-память).

## Отвергнутые пути (контрфакты, НЕ реализованы)

Отвергнуты с доказательствами (документируем, чтобы не переизобретать):

- **WASM/SIMD для одиночных пружин** — наш прямой замер precompute-контрфакта дал
  **−24.6% регрессию** (19.4→24.2 ns/кадр): V8 инлайнит мономорфный closed-form солвер,
  граница JS↔WASM дороже сэкономленной арифметики. Солвер уже в физическом оптимуме.
  (SIMD ~1.7–4.5× — только большие БАТЧИ, не одиночная DOM-анимация.)
- **GPU compute (WebGPU)** — не может писать в DOM без readback-stall; выигрыш только для
  canvas/WebGL при 10k+ объектов, не для DOM-значений.
- **Движок в Web Worker + SharedArrayBuffer** — не снижает input→photon для DOM (ввод всё
  равно идёт через compositor/main-поток, +hop `postMessage`); SAB требует COOP/COEP,
  ломающих сторонние embed'ы.
- **Анимация CSS custom properties как «compositor-путь»** — `@property`/`var()` НЕ
  ускоряются на compositor и триггерят style-invalidation каждый тик (expressiveness, не перф).

Числа справочны и машинозависимы (`pnpm bench`); проверяемый seal — тесты
(граница ошибки реконструкции ≤ tolerance, байт-паритет fallback в узлах, C¹-непрерывность).

## Инварианты (гарантии потребителю)

- **Zero-deps**: `dependencies: {}` — фреймворки только как optional peer.
- **CSS-safe**: движок никогда не отдаёт `NaN`/`Infinity` — числовые слои
  (easing, value, driver, keyframes, timeline, stagger, decay, MotionValue, utils)
  прогоняются property-fuzz на 10 000 входов, а сам spring-солвер — отдельным
  seeded-fuzz по рабочему боксу валидного пространства (mass/stiffness/damping/t,
  включая нижние края), не только косвенно через слои поверх.
- **Детерминизм**: время только через инжектируемый `requestFrame` — бит-в-бит воспроизводимые прогоны.
- **SSR-safe**: импорт любого subpath не трогает `window`/`document`.
- **A11y**: `prefers-reduced-motion` переключает характер (снап/фейд), не отключает движение грубо.
- **Запинённый контракт**: публичная поверхность математических субпутей и `lit`
  зафиксирована api-surface-pin тестами (в обе стороны: пропавший И лишний
  экспорт — красный тест).

## Ошибки

```typescript
import { MotionParamError } from '@labpics/motion';

try {
  spring({ mass: -1, stiffness: 100, damping: 10 }, 0);
} catch (e) {
  if (e instanceof MotionParamError) console.error(e.message);
}
```

## Лицензия

MIT
