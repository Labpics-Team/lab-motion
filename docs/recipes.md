# Рецепты @labpics/motion

> Роль: справка — runnable-рецепты интеграции. Перенесены из README без потери
> содержания; концепты и контракты каждого пути — в соответствующих разделах
> README, здесь — только связка с DOM-событиями и композиция субпутей.

## Drag с инерцией

```typescript
import { createDrag } from '@labpics/motion/gestures';

const el = document.querySelector('.card') as HTMLElement;
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

Захват элемента, летящего compositor-анимацией: контроллер снимает фактические
serialized position/right-slope по `Animation.currentTime` без style/layout-read.
Жест наследует этот импульс, а не аналитическую аппроксимацию:

```typescript
// ЗАМЕНА pointerdown-обработчика выше (не второй listener): controller —
// CompositorSpring этого элемента, ведущий его текущую compositor-анимацию.
el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  const live = controller.handoffToLive(); // отменяет Animation после snapshot
  const vx = live.velocity;
  live.destroy();                         // дальше владельцем становится gesture
  drag.pointerDown({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }, { vx });
});
```

## FLIP (layout-анимация)

```typescript
import { createFlip } from '@labpics/motion/flip';

const el = document.querySelector('.card') as HTMLElement;
const fl = createFlip({
  requestFrame: requestAnimationFrame.bind(window),
  onStep: (t) => { el.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.sx}, ${t.sy})`; },
  onRest: () => { el.style.transform = ''; },
});
const first = el.getBoundingClientRect();
// ... DOM переставлен (порядок/размер/класс изменился) ...
fl.play(first, el.getBoundingClientRect()); // элемент «доезжает» пружиной
```

## Появление/уход (presence)

```typescript
import { drive } from '@labpics/motion';
import { createPresence } from '@labpics/motion/presence';

const el = document.querySelector('.toast') as HTMLElement;
const spring = { mass: 1, stiffness: 200, damping: 24 };
const p = createPresence({
  onExitStart: (done) => {
    drive({ from: 1, to: 0, spring, onStep: (v) => { el.style.opacity = String(v); } }).then(done);
  },
  onGone: () => el.remove(), // убрать из DOM только после exit-анимации
});
p.exit();
```

Прерывание с наследованием импульса (C¹, #93): `capture` регистрирует живой
снимок текущего рана, `interrupted` отдаёт его новой фазе — enter во время
exit продолжает движение из текущих (value, velocity), а не телепортом:

```typescript
import { MotionValue } from '@labpics/motion';

const el = document.querySelector('.toast') as HTMLElement;
const undoButton = document.querySelector('.undo') as HTMLElement;
const p = createPresence({
  onExitStart: (done, from, capture) => {
    const mv = new MotionValue({
      initial: from?.value ?? 1, initialVelocity: from?.velocity ?? 0,
      spring, clamp: false, // честный довыбег на стыке
    });
    mv.onChange((v) => {
      el.style.opacity = String(v);
      // Оседание: финальный эмит — ровно цель (settle-снап), скорость в покое 0.
      // Без done() фаза не завершится и onGone не сработает.
      if (v === 0 && mv.velocity === 0) done();
    });
    mv.setTarget(0);
    capture(() => ({ value: mv.value, velocity: mv.velocity }));
  },
  onEnterStart: (done, from, capture) => {
    const mv = new MotionValue({
      initial: from?.value ?? 0, initialVelocity: from?.velocity ?? 0,
      spring, clamp: false,
    });
    mv.onChange((v) => {
      el.style.opacity = String(v);
      if (v === 1 && mv.velocity === 0) done();
    });
    mv.setTarget(1);
    capture(() => ({ value: mv.value, velocity: mv.velocity }));
  },
});
p.exit();
// Передумали ДО onGone: reversed continuation из точки и скорости exit-рана.
undoButton.addEventListener('click', () => p.enter(), { once: true });
```

## Видимость DOM-цели

```typescript
import { inView } from '@labpics/motion/in-view';

const stop = inView('.card', (element) => {
  element.dataset.visible = 'true';
  // Возвращённая функция включает повторяемый enter/leave. Без неё target
  // автоматически снимается после первого входа (one-shot).
  return () => delete (element as HTMLElement).dataset.visible;
}, { amount: 0.5, margin: '0px 0px -10%' });

// На unmount: disconnect observer + cleanup всех активных входов.
stop();
```

`inView` использует только нативный `IntersectionObserver`; scrub/pin и запуск
анимации не входят в этот capability. Для числового прогресса используйте
headless `./scroll` и явно передавайте измеренные метрики.

Для `instanceof` импортируйте constructor из того же физического entry, что и
`inView`; корневой entry намеренно не связывает независимые bundle-графы:

```typescript
import { inView, MotionParamError } from '@labpics/motion/in-view';

try {
  inView('.card', () => undefined);
} catch (error) {
  if (error instanceof MotionParamError) console.error(error.code);
  else throw error;
}
```

## Скролл-прогресс → таймлайн

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

## Value-mapping (utils)

```typescript
import { mapRange, interpolate, clamp, wrap, pipe } from '@labpics/motion/utils';

mapRange(0, 100, 0, 1, 50);              // 0.5 — ремап диапазона (канон GSAP mapRange)
const fade = interpolate([0, 100, 200], [0, 1, 0]); // N-стоповый маппер (канон Framer transform)
fade(50);                                // 0.5 — кусочно-линейно между стопами
const hue = wrap(0, 360);                // циклический wrap в полуинтервал [0, 360)
hue(370);                                // 10
const toProgress = pipe(clamp(0, 300), (x) => x / 300); // композиция слева-направо
```

## Bottom sheet (behaviors, DOM-адаптер)

Runnable DOM-адаптер: transform из headless-состояния `createBottomSheet`.

```ts
import { createBottomSheet } from '@labpics/motion/behaviors';

const el = document.querySelector('.sheet') as HTMLElement;
const sheet = createBottomSheet({
  snapPoints: [0, 320, 640],       // px оффсеты закрыт/полу/раскрыт
  matchMedia: window.matchMedia.bind(window), // reduced-motion = снап
  onChange: (s) => {               // единственный канал вывода
    el.style.transform = `translateY(${s.value}px)`;
  },
});

el.addEventListener('pointerdown', (e) => {
  el.setPointerCapture(e.pointerId);
  sheet.pointerDown({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 });
});
el.addEventListener('pointermove', (e) =>
  sheet.pointerMove({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }));
el.addEventListener('pointerup', (e) =>
  sheet.pointerUp({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 }));
el.addEventListener('pointercancel', () => sheet.pointerCancel());

// программно раскрыть до верхнего snap (единый clock, C¹ из текущей скорости):
document.querySelector('.expand')?.addEventListener('click', () => sheet.snapTo(2));
```
