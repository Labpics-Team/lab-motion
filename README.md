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
| `…/compositor` | Compositor-компилятор ПРУЖИН: `compileSpringLinear` (пружина → адаптивный CSS `linear()`, число стопов ВЫВОДИТСЯ из бюджета ошибки), `compileSpringPlan`, `readCompositorSpring` (O(1) closed-form чтение value+velocity), `CompositorSpring` (one-shot хендофф с сохранением скорости C¹ + байт-паритетный main-thread fallback), `createSpringLinearCache` (LRU), `supportsCompositor`. См. «Границы применимости» ниже |
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
```

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
