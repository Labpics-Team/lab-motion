# Рецепты @labpics/motion

> Роль: практика — runnable-рецепты интеграции: связка с DOM-событиями и
> композиция субпутей. Концепты и контракты каждого пути — в
> [справочнике API](api.md) и топик-доках ([compositor.md](compositor.md),
> [projection.md](projection.md), [smart.md](smart.md),
> [behaviors.md](behaviors.md)).

## Слежение за указателем

Один `MotionValue` обслуживает поток целей; новую анимацию на каждое событие
создавать не нужно. Пространственному движению нужен `clamp: false`, чтобы не
обрезать инерцию при смене направления. Политика reduced-motion сохраняет результат
через `snapTo`, а завершение компонента снимает и значение, и обработчики.

```typescript
import { MotionValue } from '@labpics/motion';
import { asRequestFrame } from '@labpics/motion/frame';

const card = document.querySelector('.card') as HTMLElement;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const x = new MotionValue({
  initial: 0,
  spring: { mass: 1, stiffness: 200, damping: 20 },
  clamp: false,
  requestFrame: asRequestFrame(),
});
x.onChange(value => { card.style.translate = `${value}px 0`; });
let target = 0;
const follow = () => reduced.matches ? x.snapTo(target) : x.setTarget(target);
const move = (event: PointerEvent) => { target = event.clientX; follow(); };
window.addEventListener('pointermove', move);
reduced.addEventListener('change', follow);

function dispose() {
  window.removeEventListener('pointermove', move);
  reduced.removeEventListener('change', follow);
  x.destroy();
}
```

Здесь `clientX` и `translate` намеренно иллюстрируют одну числовую ось. В продукте
приведите координаты указателя к исходной позиции карточки один раз на границе
измерения; не вызывайте `getBoundingClientRect()` на каждом событии без необходимости.
`destroy()` останавливает эффект, но не отменяет внешние CSS-изменения приложения.
## Карточка загрузки: одна модель, разные движения

Приложение владеет `status`, `progress` и `pressed`, а не фазами твинов. Три
визуальные роли привязываются один раз. Прогресс не перезапускает нажатие или
индикатор завершения; меняется только его собственная роль.

```typescript
import { animate } from '@labpics/motion/animate';
import { createMotionBinding } from '@labpics/motion/bindings';

export interface UploadMotionModel {
  readonly pressed: boolean;
  readonly status: 'idle' | 'uploading' | 'complete';
  readonly progress: number;
}

export function bindUploadMotion(
  parts: { surface: HTMLElement; progress: HTMLElement; complete: HTMLElement },
) {
  const spring = { mass: 1, stiffness: 240, damping: 28 };
  return createMotionBinding(
    (model: UploadMotionModel) => ({
      surface: { scale: model.pressed ? 0.97 : 1 },
      progress: { scaleX: Math.max(0, Math.min(1, model.progress)) },
      complete: { opacity: model.status === 'complete' ? 1 : 0 },
    }),
    {
      surface: goal => animate(parts.surface, goal, { spring }),
      progress: goal => animate(parts.progress, goal, { spring }),
      complete: goal => animate(parts.complete, goal, { spring }),
    },
  );
}
```

У прогресс-полосы задайте CSS `transform-origin: left center`. Передайте фактическую
модель через `view.update(model)` после монтирования и вызывайте `view.destroy()`
при размонтировании. Доступный текст, атрибуты `aria-busy` и `aria-valuenow`, обработку
клавиатуры и изменение бизнес-данных оставьте компоненту. Системное уменьшенное
движение обрабатывает обычный `animate`, без второй политики в привязке.

В Solid уже существующий сигнал и его batch остаются владельцами данных:

```typescript
import { createEffect, onCleanup } from 'solid-js';

// view создан после монтирования; model — аксессор существующего сигнала.
createEffect(() => view.update(model()));
onCleanup(view.destroy);
```

Меняйте чистый рецепт, а не модель приложения: например, стиль нажатия можно
сделать спокойнее, не переименовывая `pressed` во всём продукте. Общая привязка
не требует контекста, provider или дополнительного store. Цели описывают состояние,
а повторяемые события (shake/replay) остаются отдельными явными действиями.
[Полные правила владения и ошибок](bindings.md).

## Навигация: выбор и клавиатурный фокус независимы

> Роль: практика — два индикатора одной навигации без смешивания выбранной страницы
> и временного фокуса. Оба элемента имеют CSS `width: 1px; transform-origin: left center`
> и абсолютное положение `left: 0` в общем контейнере; они не перехватывают события.

Приложение владеет ключом выбранной страницы и фокусом. DOM-адаптер передаёт
измеренные позиции пунктов относительно контейнера: новые измерения после resize
или изменения текста — обычный update, не пересоздание привязки. Рецепт связывает
эти данные с движением, не хранит вторую копию порядка или активной страницы.

```typescript
import { animate } from '@labpics/motion/animate';
import { createMotionBinding } from '@labpics/motion/bindings';

interface NavigationMotionModel {
  selected: string;
  focused: string | null;
  items: readonly { key: string; x: number; width: number }[];
}

export function bindNavigationMotion(targets: {
  selection: HTMLElement;
  focus: HTMLElement;
}) {
  const spring = { mass: 1, stiffness: 280, damping: 30 };
  return createMotionBinding(
    (model: NavigationMotionModel) => {
      const selected = model.items.find(item => item.key === model.selected);
      const focused = model.focused === null ? selected
        : model.items.find(item => item.key === model.focused);
      if (!selected || !focused) throw new RangeError('Пункт отсутствует в измеренной навигации');
      return {
        selection: { x: selected.x, scaleX: selected.width },
        focus: { x: focused.x, scaleX: focused.width, opacity: model.focused === null ? 0 : 1 },
      };
    },
    {
      selection: goal => animate(targets.selection, goal, { spring }),
      focus: goal => animate(targets.focus, goal, { spring }),
    },
  );
}
```

На focus/blur меняйте только `focused`, на принятую навигацию — `selected`.
Перемещение клавиатурного фокуса не перезапускает движение выбора. Переход на другую
страницу не требует знать названия анимаций; ширина индикатора меняется через scale,
не через покадровый layout. Для RTL передавайте фактические физические позиции:
порядок текста или массива не подменяет геометрию браузера.

Измеряйте неанимируемые пункты, не сами индикаторы. Ключи пунктов уникальны,
ширины положительны. Семантика ссылок/кнопок, `aria-current`, видимый focus outline,
обработка ввода и уведомление о resize остаются у компонента. Декоративный индикатор
не заменяет доступный фокус. При размонтировании вызовите `view.destroy()`.

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
## Каскад состояний взаимодействия без гонок

Наведение, нажатие и перетаскивание задают слои; масштабом управляет один
`MotionValue`. Адаптер принимает уже распознанные состояния приложения.
При предпочтении уменьшенного движения цель применяется сразу.

```ts
import { MotionValue } from '@labpics/motion';
import { createStateCascade } from '@labpics/motion/behaviors';

export function bindInteractionScale(element: HTMLElement) {
  const state = createStateCascade<{ scale: number }>();
  state.createLayer({ scale: 1 }); // Постоянный base: scale не исчезает.
  const hover = state.createLayer();
  const press = state.createLayer(); // Выше hover только для своих свойств.
  const drag = state.createLayer();
  const value = new MotionValue({
    initial: 1,
    spring: { mass: 1, stiffness: 200, damping: 26 },
  });
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const original = element.style.getPropertyValue('scale');
  const priority = element.style.getPropertyPriority('scale');
  const render = (scale: number) => element.style.setProperty('scale', String(scale));
  const offValue = value.onChange(render);
  render(1);
  const apply = (target: number) => {
    if (media.matches) value.snapTo(target);
    else value.setTarget(target);
  };
  const offState = state.subscribe(({ changed }) => {
    if (Object.hasOwn(changed, 'scale')) apply(changed.scale!);
  });
  const onPreference = () => apply(state.get('scale')!);
  media.addEventListener('change', onPreference);
  let disposed = false;
  return {
    setHovered(active: boolean) { if (active) hover.set({ scale: 1.03 }); else hover.clear(); },
    setPressed(active: boolean) { if (active) press.set({ scale: 0.97 }); else press.clear(); },
    setInteraction(input: { hovered: boolean; pressed: boolean; dragging: boolean }) {
      state.batch(() => {
        if (input.hovered) hover.set({ scale: 1.03 }); else hover.clear();
        if (input.pressed) press.set({ scale: 0.97 }); else press.clear();
        if (input.dragging) drag.set({ scale: 1.02 }); else drag.clear();
      });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      media.removeEventListener('change', onPreference);
      offState();
      offValue();
      state.destroy();
      value.destroy();
      if (original) element.style.setProperty('scale', original, priority);
      else element.style.removeProperty('scale');
    },
  };
}
```

`setHovered(false)` не отменяет активное нажатие. `setInteraction` группирует
смену состояний: переход от нажатия к перетаскиванию сразу задаёт масштаб `1.02`,
без промежуточной цели `1`. Историю указателя для оценки скорости хранит
распознаватель, не каскад. Адаптер единолично владеет встроенным стилем `scale`
до `destroy()`, который возвращает исходное значение и приоритет. Распознавание
ввода и вызов очистки остаются у приложения.
[Полный контракт](behaviors.md#каскад-визуальных-намерений).
## Перестановка списка или сетки

Роль: how-to. `./behaviors/reorder` предлагает новый порядок по снимку геометрии.
Приложение принимает предложение, переставляет свои данные/DOM и публикует новый
снимок. `./projection` анимирует только подтверждённое изменение. Ни runtime
`./animate`, ни новый scheduler для этого не нужны.

Ниже один компонентный адаптер для горизонтального/вертикального списка и сетки,
включая RTL. Перенос происходит между ячейками: это не свободный drag-follow,
не автопрокрутка и не перенос между списками. Оболочка `<li>` никогда не получает
transform; проецируется только внутренняя `.reorder-card`, поэтому координаты
слотов остаются layout-координатами даже во время незавершённого полёта.

```html
<p id="sort-help">Пробел — выбрать; стрелки — переместить; Enter или Escape — закончить.
  Также доступны кнопки «Раньше» и «Позже».</p>
<ul id="tasks" aria-label="Порядок задач" aria-describedby="sort-help">
  <li data-key="design"><div class="reorder-card">
    <button type="button" data-grip aria-pressed="false" style="touch-action:none">Дизайн</button>
    <button type="button" data-move="previous" aria-label="Дизайн: раньше">Раньше</button>
    <button type="button" data-move="next" aria-label="Дизайн: позже">Позже</button>
  </div></li>
  <li data-key="build"><div class="reorder-card">
    <button type="button" data-grip aria-pressed="false" style="touch-action:none">Разработка</button>
    <button type="button" data-move="previous" aria-label="Разработка: раньше">Раньше</button>
    <button type="button" data-move="next" aria-label="Разработка: позже">Позже</button>
  </div></li>
</ul>
<p id="sort-status" role="status" aria-live="polite" aria-atomic="true"></p>
```

Прямые дочерние `<li>` имеют уникальные `data-key`, `.reorder-card` и `button[data-grip]`.
Для grid достаточно CSS-сетки на `<ul>`; `dir="rtl"` меняет logical horizontal
keyboard order. `touch-action:none` нужен только на ручке, остальная карточка
не препятствует прокрутке. Кнопки раньше/позже дают альтернативу drag одним
нажатием; это не замена проверки accessibility всего приложения.

<!-- reorder-component-recipe:start -->
```typescript
import { createReorder, type ReorderSession, type ReorderStep } from '@labpics/motion/behaviors/reorder';
import { createPan } from '@labpics/motion/gestures';
import { createDomProjection } from '@labpics/motion/projection';

export function mountReorder(root: HTMLElement, status: HTMLElement): () => void {
  const win = root.ownerDocument.defaultView!;
  const slots = new Map(Array.from(root.children, node => [(node as HTMLElement).dataset.key!, node as HTMLElement]));
  const cards = Array.from(slots.values(), node => node.querySelector<HTMLElement>('.reorder-card')!);
  // Единственный app-owned порядок. В reactive приложении здесь будет signal/store.
  let keys = Array.from(slots.keys());
  let disposed = false, dirty = false;
  let session: ReorderSession | undefined;
  let pointer: number | undefined;
  let startX = 0, startY = 0;
  const media = win.matchMedia('(prefers-reduced-motion: reduce)');
  const projection = createDomProjection({ radius: false, matchMedia: () => media });
  const measure = () => keys.map(key => ({ key, rect: slots.get(key)!.getBoundingClientRect() }));
  const announce = (key: string) => {
    const label = slots.get(key)!.querySelector('[data-grip]')!.textContent;
    status.textContent = `${label}: ${keys.indexOf(key) + 1} из ${keys.length}`;
  };
  const state = createReorder({
    items: measure(), direction: win.getComputedStyle(root).direction === 'rtl' ? 'rtl' : 'ltr',
    onReorder(next, proposal) {
      if (!state.isCurrent(proposal)) return;
      const focused = root.ownerDocument.activeElement as HTMLElement | null;
      projection.capture(cards);
      keys = [...next];
      root.append(...keys.map(key => slots.get(key)!));
      state.update(measure()); dirty = false;
      projection.play();
      focused?.focus({ preventScroll: true });
      announce(proposal.key);
    },
  });
  const markDirty = () => { dirty = true; };
  const refresh = () => { if (dirty) { state.update(measure()); dirty = false; } };
  function finish(): void {
    const captured = pointer; pointer = undefined;
    session?.end(); session = undefined;
    for (const node of slots.values()) node.querySelector('[data-grip]')!.setAttribute('aria-pressed', 'false');
    if (captured !== undefined && root.hasPointerCapture(captured)) root.releasePointerCapture(captured);
  }
  const pan = createPan({
    threshold: 4,
    onPan(event) { refresh(); session?.move({ x: startX + event.dx, y: startY + event.dy }); },
    onPanEnd: finish,
  });
  const point = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp / 1000 });
  const slotFor = (e: Event) => {
    const node = (e.target as Element).closest<HTMLElement>('[data-key]');
    return node?.parentElement === root ? node : undefined;
  };
  const listeners = new AbortController();
  const listen = <E extends Event>(type: string, handler: (e: E) => void) => {
    root.addEventListener(type, ((e: E) => {
      if (disposed) return;
      try { handler(e); } catch (error) { cleanup(); throw error; }
    }) as EventListener, { signal: listeners.signal });
  };
  listen<PointerEvent>('pointerdown', e => {
    const node = slotFor(e);
    if (!node || !(e.target as Element).closest('[data-grip]') || e.button !== 0 || pointer !== undefined) return;
    finish(); state.update(measure()); dirty = false;
    session = state.start(node.dataset.key!);
    if (!session) return;
    const r = node.getBoundingClientRect(); startX = r.x + r.width / 2; startY = r.y + r.height / 2;
    pointer = e.pointerId; root.setPointerCapture(pointer); pan.pointerDown(point(e));
    node.querySelector<HTMLElement>('[data-grip]')!.focus({ preventScroll: true });
    node.querySelector('[data-grip]')!.setAttribute('aria-pressed', 'true');
  });
  listen<PointerEvent>('pointermove', e => { if (e.pointerId === pointer) pan.pointerMove(point(e)); });
  listen<PointerEvent>('pointerup', e => { if (e.pointerId === pointer) { pan.pointerUp(point(e)); finish(); } });
  const cancelPointer = (e: PointerEvent) => { if (e.pointerId === pointer) { pan.pointerCancel(); finish(); } };
  listen('pointercancel', cancelPointer); listen('lostpointercapture', cancelPointer);
  const directions: Record<string, ReorderStep> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' };
  listen<KeyboardEvent>('keydown', e => {
    const node = slotFor(e);
    if (!node || !(e.target as Element).matches('[data-grip]') || pointer !== undefined) return;
    if (session?.active && state.activeKey !== node.dataset.key) finish();
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault(); if (e.repeat) return;
      if (session?.active) finish();
      else {
        state.update(measure()); dirty = false; session = state.start(node.dataset.key!);
        node.querySelector('[data-grip]')!.setAttribute('aria-pressed', String(!!session));
        announce(node.dataset.key!);
      }
    } else if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (session?.active && directions[e.key]) { e.preventDefault(); refresh(); session.step(directions[e.key]!); }
  });
  listen<MouseEvent>('click', e => {
    const node = slotFor(e), action = (e.target as Element).closest<HTMLElement>('[data-move]')?.dataset.move;
    if (!node || (action !== 'previous' && action !== 'next')) return;
    pan.pointerCancel(); finish(); state.update(measure()); dirty = false;
    session = state.start(node.dataset.key!); session?.step(action); finish();
  });
  // Не выполняют layout-read: следующий ввод потребляет один свежий snapshot.
  const resize = new ResizeObserver(markDirty); resize.observe(root);
  for (const node of slots.values()) resize.observe(node);
  win.addEventListener('scroll', markDirty, { capture: true, signal: listeners.signal });
  const reduced = () => { if (media.matches) projection.cancel(); };
  media.addEventListener('change', reduced);
  function cleanup(): void {
    if (disposed) return;
    disposed = true; listeners.abort(); resize.disconnect(); media.removeEventListener('change', reduced);
    pan.pointerCancel(); finish(); state.destroy(); projection.cancel();
  }
  return cleanup;
}
```
<!-- reorder-component-recipe:end -->

Вызывайте возвращённый cleanup из lifecycle владельца: `onCleanup` в Solid,
cleanup `useEffect` в React или перед удалением vanilla-компонента. SSR не
исполняет `mountReorder`: этот адаптер требует реального DOM. Каждый mount
получает новый resolver; cleanup не откатывает уже принятый порядок данных.
Новый состав коллекции в этом компактном рецепте требует remount; более общий
consumer передаёт `state.update` по собственной stable-key модели.

При async-проверке предложения до изменения store снова проверяйте
`state.isCurrent(proposal)`. Любой новый snapshot, другой intent, конец session
или destroy отзывает старое предложение. Нельзя принять stale permutation
после внешнего изменения коллекции. Listener/ResizeObserver и focus/ARIA
принадлежат компоненту, не headless resolver.

## Диагностика compiler lowering

Сначала соберите точный `dist`, затем запустите тот же acceptance-путь с trace:

```sh
pnpm build && node scripts/compiler-acceptance.mjs --trace
```

Команда печатает `tooling-trace` только после успешной проверки lowering. Поля,
версия схемы и правило fail-closed определены в [контракте компилятора](compiler.md#диагностический-trace-контракт).
Если acceptance падает, trace не считается доказательством и не должен разбираться
как частичный успешный результат.
