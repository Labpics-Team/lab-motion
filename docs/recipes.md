# Рецепты @labpics/motion

> Роль: практика — runnable-рецепты интеграции: связка с DOM-событиями и
> композиция субпутей. Концепты и контракты каждого пути — в
> [справочнике API](api.md) и топик-доках ([compositor.md](compositor.md),
> [projection.md](projection.md), [smart.md](smart.md),
> [behaviors.md](behaviors.md)).

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

## Диалог с прерываемым закрытием

Диалог содержит `[data-panel]` и сам хранит доступность, фокус и модальность через
нативный `<dialog>`. Адаптер вызывается после монтирования. Кнопка открытия вызывает
`binding.setPresent(true)`, кнопка закрытия — `binding.setPresent(false)`;
при размонтировании нужен `binding.destroy()`. Повторное открытие во время ухода
не сбрасывает позу и не позволяет старому завершению закрыть диалог.

```typescript
import { animate } from '@labpics/motion/animate';
import { createPresenceTransition } from '@labpics/motion/presence';

export function bindAnimatedDialog(dialog: HTMLDialogElement) {
  const panel = dialog.querySelector<HTMLElement>('[data-panel]');
  if (!panel) throw new TypeError('В диалоге отсутствует [data-panel]');
  const spring = { mass: 1, stiffness: 240, damping: 28 };
  const presence = createPresenceTransition({
    initiallyPresent: dialog.open,
    enter: () => {
      if (!dialog.open) {
        panel.style.opacity = '0';
        panel.style.transform = 'translateY(12px)';
        dialog.showModal();
      }
      return animate(panel, { opacity: 1, y: 0 }, { spring });
    },
    exit: () => animate(panel, { opacity: 0, y: 12 }, { spring }),
    onGone: () => dialog.close(),
  });
  const onCancel = (event: Event) => {
    event.preventDefault();
    presence.setPresent(false);
  };
  dialog.addEventListener('cancel', onCancel);
  return {
    setPresent: presence.setPresent,
    get state() { return presence.state; },
    get finished() { return presence.finished; },
    destroy() {
      dialog.removeEventListener('cancel', onCancel);
      try { presence.destroy(); } finally { dialog.close(); }
    },
  };
}
```

При обычном exit не вызывайте `dialog.close()` и не удаляйте узел раньше `onGone`:
иначе браузер не сможет показать выходную анимацию. `destroy()` выше — отдельная
граница размонтирования: он отзывает фазу, `onGone` при этом не вызывается, а диалог
закрывается в `finally`. Escape проходит обычную фазу ухода. Уменьшенное движение
обрабатывает `animate`; фокус возвращает сам `dialog.close()`. Для нескольких
независимых анимаций фазы верните массив controls: удаление дождётся всей группы.
[Точный контракт и исходы ошибок](presence.md).

## Появление/уход (presence)

```typescript
import { drive } from '@labpics/motion';
import { createPresence } from '@labpics/motion/presence';

const el = document.querySelector('.toast') as HTMLElement;
const spring = { mass: 1, stiffness: 200, damping: 24 };
const p = createPresence({
  initiallyPresent: true,
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

## Анимации, принадлежащие компоненту

`createAnimateScope` из `./animate` связывает локальные селекторы с одной уборкой.
Каждый mount создаёт свою область. Строки выбирают потомков root, включая новые
узлы при следующем вызове; для самого root передайте элемент явно. Переданный
напрямую внешний элемент тоже допустим — область не является песочницей DOM.

В примере компонент содержит кнопку `[data-replay]` и элемент `.motion-target`.
Сохраните общий код в `card-motion.ts`. Нативная кнопка даёт мышь, touch и клавиатуру
без отдельной реализации распознавания ввода. `prefers-reduced-motion` проверяется
существующим `animate` при каждом запуске.

<!-- recipe:animate-scope-vanilla -->
```typescript
import { createAnimateScope } from '@labpics/motion/animate';

export function mountCardMotion(root: HTMLElement): () => void {
  const button = root.querySelector<HTMLButtonElement>('[data-replay]');
  if (!button) throw new Error('Компоненту нужна кнопка [data-replay]');
  const scope = createAnimateScope(root);
  const replay = () => {
    scope.animate('.motion-target', { x: [0, 24], opacity: [0, 1] });
  };
  const dispose = () => {
    button.removeEventListener('click', replay);
    scope.destroy();
  };
  try {
    button.addEventListener('click', replay);
    replay();
    return dispose;
  } catch (error) {
    try { dispose(); } catch { /* исходная ошибка setup остаётся причиной */ }
    throw error;
  }
}
```

Для обычного DOM вызовите `const dispose = mountCardMotion(root)` после создания
разметки, а перед удалением компонента — `dispose()`. Область учитывает анимации,
но не произвольные listeners: их снимает владелец компонента, как в примере выше.

### React: cleanup эффекта, а не render на каждый кадр

`react-card.ts` использует тот же общий `card-motion.ts`. Область создаётся внутри
эффекта: повторный setup в StrictMode получает новый lifecycle, а не уничтоженный
объект из прошлого setup. Изменение DOM выполняет движок, React state на кадре нет.

<!-- recipe:animate-scope-react -->
```typescript
import { createElement, useEffect, useRef } from 'react';
import { mountCardMotion } from './card-motion.js';

export function ScopedCard() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => mountCardMotion(root.current!), []);
  return createElement('section', { ref: root },
    createElement('button', { 'data-replay': '', type: 'button' }, 'Повторить'),
    createElement('div', { className: 'motion-target' }, 'Карточка'),
  );
}
```

### Solid: область живёт столько же, сколько owner

`solid-card.ts` также импортирует `card-motion.ts`. Этот вариант без JSX возвращает
обычный DOM-узел; компонент монтируется стандартным `render` из `solid-js/web`.
Создание области откладывается до `onMount`, cleanup регистрируется у owner.

<!-- recipe:animate-scope-solid -->
```typescript
import { onCleanup, onMount } from 'solid-js';
import { mountCardMotion } from './card-motion.js';

export function SolidScopedCard(): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = '<button data-replay type="button">Повторить</button>' +
    '<div class="motion-target">Карточка</div>';
  onMount(() => {
    const dispose = mountCardMotion(root);
    onCleanup(dispose);
  });
  return root;
}
```

Для SSR используйте разметку компонента/JSX своего framework; эта конкретная
Solid-фабрика создаёт DOM и вызывается только на клиенте. Импорт `./animate`
сам по себе не читает DOM. React-пример допускает server render: эффект там
не запускается.

### Границы уборки

`destroy()` сразу запрещает новые вызовы через эту область и пытается отменить
все её незавершённые анимации, включая paused и delayed. Поздний handler получает
завершённый no-op controls без чтения его входов. Естественно завершённые handles
удаляются из учёта после `finished`; область не копит историю переходов.

Если destroy вызван внутри синхронной host-транзакции, один финальный проход в
микрозадаче повторяет отмену после снятия reservation. Кадровый цикл не добавляется.
Для ожидания конкретного завершения используйте исходный `controls.finished`.
Одна синхронная ошибка cleanup выбрасывается без замены, несколько — `AggregateError`;
ошибки финального прохода сообщаются через доступный `globalThis.reportError`.
У постоянно неисправного host отмена остаётся best-effort, а не обещанием отката.

Cleanup **сохраняет текущую позу**, не восстанавливает стили до анимации. Это не
`revert`. Он также не отменяет новый переход, который другой scope или прямой
`animate` уже сделал владельцем тех же свойств. После destroy создайте новую
область для нового mount; не переиспользуйте старую.
