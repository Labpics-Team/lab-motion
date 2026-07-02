# @labpics/motion

Headless-движок анимаций без runtime-зависимостей. Часть дизайн-системы Labpics.

Ядро — чистая математика (пружины, кадры, тайминги): ноль DOM, детерминизм
через инжектируемое виртуальное время, SSR-безопасность, гарантия конечности
(NaN/Infinity никогда не попадают в CSS), `prefers-reduced-motion` меняет
ХАРАКТЕР анимации, а не выключает её грубо. Каждая фича — изолированный
subpath: в бандл попадает только то, что импортировано.

## Как собрать

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build      # → dist/*
pnpm test
pnpm size       # замер gz всех субпутей
```

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
| `…/waapi` | Compositor-путь: `compileWaapi`/`animateWaapi` (кейфреймы движка → нативный `Element.animate`, hw-accel), `easingToLinear` (любой easing → CSS `linear()`), `supportsWaapi` |
| `…/auto` | Zero-config FLIP: `autoAnimate(parent)` — add/remove/move детей анимируются сами (класс AutoAnimate); reduced-motion меняет характер (move→снап), не выключает |
| `…/svg-morph` | Морфинг путей: `interpolatePath(dFrom, dTo)` — точный режим при совпадающей структуре, ресэмплинг с выравниванием старта/обхода замкнутых при разной |
| `…/react` | React: `useSpring`, `useMotionValue` |
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

## Инварианты (гарантии потребителю)

- **Zero-deps**: `dependencies: {}` — фреймворки только как optional peer.
- **CSS-safe**: движок никогда не отдаёт `NaN`/`Infinity` — ключевые математические
  слои (easing, value, driver, keyframes, timeline, stagger, decay, MotionValue)
  прогоняются fuzz-тестами на 10 000 входов; spring-солвер добивается косвенно
  через все слои поверх него.
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
