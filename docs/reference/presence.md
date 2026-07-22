# ./presence — mount/unmount переходы (enter/exit lifecycle)

> Роль: справка — публичный API экспорт-субпутя `./presence`: headless-машина enter/exit lifecycle `createPresence` («элемент хочет размонтироваться → доиграть exit-анимацию → только потом убрать из DOM») с честными прерываниями и наследованием импульса, плюс координатор замены `swapPresence` (режимы `'wait'`/`'sync'`).

## Назначение

Субпуть `./presence` закрывает класс задач `AnimatePresence` (Motion) / `useTransition` (react-spring): элемент нельзя убирать из DOM, пока не доиграла выходная анимация, а прерывания (`enter()` во время выхода, `exit()` во время входа) обязаны быть честными в обе стороны.

Архитектура — **headless-машина состояний**: сама она ничего не анимирует. Анимации запускает потребитель в `onEnterStart`/`onExitStart` и сообщает о завершении вызовом полученного `done`. `done` привязан к своей фазе поколением (generation): после прерывания завершение старой анимации машину не двигает (тот же класс stale-инвалидации, что в `MotionValue`).

Прерывание — не телепорт, а **reversed continuation**: колбэк фазы через `capture(read)` регистрирует функцию живого снимка своего рана; в момент прерывания машина синхронно снимает его и передаёт новой фазе аргументом `interrupted` — новая анимация продолжает с текущей позиции и скорости (C¹). Снимок непрозрачен для машины (по умолчанию — пара `PresenceSnapshot`, но можно нести вектор каналов и т.п.). Для WAAPI/compositor-рана, у которого нет живого чтения, снимок берётся замкнутой формой — `readCompositorSpring` из [`./compositor`](./compositor.md), без `getComputedStyle`.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  createPresence,
  swapPresence,
  // type-only
  type PresenceState,
  type PresenceSnapshot,
  type PresencePhaseStart,
  type PresenceOptions,
  type PresenceControls,
  type SwapPresenceOptions,
} from '@labpics/motion/presence';
```

## API

### createPresence

```ts
function createPresence<S = PresenceSnapshot>(
  options?: PresenceOptions<S>,
): PresenceControls;

interface PresenceOptions<S = PresenceSnapshot> {
  readonly initiallyPresent?: boolean | undefined;
  readonly onEnterStart?: PresencePhaseStart<S> | undefined;
  readonly onExitStart?: PresencePhaseStart<S> | undefined;
  readonly onPresent?: (() => void) | undefined;
  readonly onGone?: (() => void) | undefined;
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
}

type PresencePhaseStart<S> = (
  done: () => void,
  interrupted: S | undefined,
  capture: (read: () => S) => void,
) => void;

type PresenceState = 'gone' | 'entering' | 'present' | 'exiting';

interface PresenceSnapshot {
  readonly value: number;    // единицы значения потребителя
  readonly velocity: number; // единицы значения в секунду
}
```

Создаёт машину enter/exit lifecycle. Граф состояний:

```
gone ──enter()──▶ entering ──done──▶ present ──exit()──▶ exiting ──done──▶ gone
                     ▲  └────────────exit()────────────────▶│
                     └────────────────enter()───────────────┘   (прерывания, со снимком)
```

Параметры (`options`, все поля опциональны):

- `initiallyPresent` — стартовать в `'present'` (элемент уже в DOM). По умолчанию `false` → стартовое состояние `'gone'`.
- `onEnterStart` — начало входной анимации. Вызывается синхронно внутри `enter()`, **после** перехода в `'entering'`. Потребитель обязан вызвать `done` по завершении анимации — машина перейдёт в `'present'`. Если колбэк не задан, вход мгновенен (машина зовёт `done` сама).
- `onExitStart` — симметрично: начало выходной анимации; `done` → `'gone'`. Не задан — выход мгновенен.
- `onPresent` / `onGone` — терминальные колбэки. Являются **частью перехода** и вызываются **до** слушателей `onStateChange`: потребитель успевает снять элемент из DOM прежде, чем координаторы (`swapPresence`) начнут вводить новый. `onGone` — безопасный момент убрать элемент; оба зовутся и на мгновенном reduced-motion-пути, и при незаданном колбэке фазы.
- `matchMedia` — инжектируемый seam для `prefers-reduced-motion` (структурный тип, совместимый с `window.matchMedia`; отдельно субпутём не экспортируется). `undefined` (SSR/Node), не-функция или бросивший `matchMedia` трактуются как «нет предпочтения» — без throw.

Аргументы колбэка фазы (`PresencePhaseStart<S>`):

- `done` — сообщить о завершении фазы. Привязан к своему поколению и ожидаемому состоянию: повторный вызов, вызов после прерывания или из чужого состояния — no-op (stale-инвалидация).
- `interrupted` — снимок прерванного встречного рана; `undefined`, если прерывать было нечего или снимок не регистрировался. Читается синхронно, ровно один раз, в момент прерывания, и **только** из живой фазы (`'entering'`/`'exiting'`): снимок доигранной фазы не наследуется, непрочитанный гасится на первом же следующем переходе (стейл-снимок недостижим).
- `capture(read)` — зарегистрировать функцию живого снимка **текущего** рана; машина позовёт её синхронно в момент прерывания. Регистратор прерванной фазы инертен (тот же gen-гард, что у `done`). Если `read` бросил при снятии снимка, исключение пробрасывается из `enter()`/`exit()`, но регистрация всё равно гасится — состояние машины консистентно, ретрай не бросает повторно.

Возвращает `PresenceControls`:

```ts
interface PresenceControls {
  enter(): void;
  exit(): void;
  onStateChange(cb: (state: PresenceState) => void): () => void;
  readonly state: PresenceState;
}
```

- `enter()` — запросить вход. Идемпотентен в `'entering'`/`'present'` (no-op). Из `'exiting'` — прерывание: снимок exit-рана снимается **до** перехода и передаётся `onEnterStart` как `interrupted`; `done` прерванного exit'а инертится.
- `exit()` — запросить выход; симметрично (`no-op` в `'exiting'`/`'gone'`, прерывание из `'entering'` со снимком).
- `onStateChange(cb)` — подписка на смену состояния; возвращает отписку. Вызов синхронный; список слушателей снапшотится на каждую доставку (отписка изнутри колбэка безопасна). При синхронной ре-энтрантности (терминальный колбэк или слушатель сам зовёт `enter()`/`exit()`) аргумент может отставать — авторитетен `controls.state`.
- `state` — текущее состояние (геттер).

**Reduced-motion (P2) — переключение характера, не выключение**: при активном `prefers-reduced-motion: reduce` анимационной фазы нет вовсе — `enter()` мгновенно даёт `'present'` (+`onPresent`), `exit()` мгновенно `'gone'` (+`onGone`); элемент не «зависает» и не мигает. `onEnterStart`/`onExitStart` не вызываются, снимок прерванного рана не читается и не переносится (импульс не наследуется), `done` прерванной фазы инертится.

**Ошибки**: сама машина не бросает и LM-кодов не имеет; наружу транзитом проходят только исключения потребительских колбэков (фазовых, терминальных, слушателей, `read` из `capture` — см. выше).

### swapPresence

```ts
function swapPresence(
  prev: PresenceControls,
  next: PresenceControls,
  options: SwapPresenceOptions,
): void;

interface SwapPresenceOptions {
  readonly mode: 'wait' | 'sync';
}
```

Координатор замены old→new (класс режимов `AnimatePresence`). `options.mode` обязателен, дефолта нет:

- `'sync'` — `prev.exit()` и `next.enter()` стартуют одновременно.
- `'wait'` — сначала `prev.exit()`; вход нового стартует **только** по терминальному `'gone'` старого (синхронная подписка `onStateChange`, без таймеров и опроса — P3). Любой другой уход из `'exiting'` — например, `prev.enter()` передумал — **отменяет своп**: подписка снимается, новый не входит. Если `prev` уже был `'gone'` (его `exit()` — no-op без событий), новый входит сразу, кроме случаев, когда он уже `'present'`/`'entering'`.

Контракт `'wait'`: если потребитель никогда не вызовет `done` у exit-анимации старого, новый не войдёт, а подписка останется жить — доигрывание exit'а ответственность потребителя (машина без таймеров по P3 и не имеет права «дотаймаутить» за него). Сама функция не бросает.

### Type-only экспорты

`PresenceState`, `PresenceSnapshot`, `PresencePhaseStart`, `PresenceOptions`, `PresenceControls`, `SwapPresenceOptions` — стираются при компиляции, рантайм-следа не имеют.

## Контракты

- **SSR-safe / zero-DOM (P1).** Единственный платформенный шов — инжектируемый `matchMedia`; `window`/`document` не читаются ни при импорте, ни при вызове. `matchMedia: undefined` — рабочий SSR/Node-режим («нет предпочтения»).
- **Reduced-motion (P2).** CHARACTER-switch: анимационные фазы полностью пропускаются, терминальные состояния и колбэки достигаются мгновенно и синхронно; снимок импульса в reduce-ветке не читается и не переносится.
- **Детерминизм (P3).** Внутри нет таймеров, часов и опроса — темп задаёт потребитель вызовами `done`. Все переходы синхронны внутри `enter()`/`exit()`/`done`.
- **Zero runtime deps (P4).** Внешних npm-зависимостей нет.
- **Stale-инвалидация.** `done` и регистратор `capture` прерванных фаз инертны (генерации фиксируются до перехода — устойчиво и к синхронной ре-энтрантности слушателей); снимок читается только из живой прерываемой фазы, непрочитанный гасится на первом же следующем переходе.
- **Единицы.** Дефолтный снимок `PresenceSnapshot`: `value` — в единицах значения потребителя, `velocity` — единицы значения **в секунду**. Собственных временных величин у машины нет.
- **Ошибки.** LM-коды не бросаются; см. раздел API про транзит исключений потребительских колбэков.

## Примеры

### Тост: exit-анимация до удаления из DOM

```ts
import { drive } from '@labpics/motion';
import { createPresence } from '@labpics/motion/presence';

const toast = document.querySelector('.toast') as HTMLElement;
const mm = window.matchMedia.bind(window);
const spring = { mass: 1, stiffness: 300, damping: 26 };

const fade = (from: number, to: number, done: () => void): void => {
  void drive({
    from,
    to,
    spring,
    onStep: (v) => {
      toast.style.opacity = String(v);
    },
    matchMedia: mm,
  }).then(done); // done прерванной фазы инертен — поздний resolve безопасен
};

const presence = createPresence({
  matchMedia: mm, // P2: при reduce фаз нет — мгновенно present/gone
  onEnterStart: (done) => fade(0, 1, done),
  onExitStart: (done) => fade(1, 0, done),
  onGone: () => toast.remove(), // терминально ушли — безопасно убирать из DOM
});

presence.enter();
setTimeout(() => presence.exit(), 3000);
```

### Наследование импульса при прерывании (reversed continuation)

```ts
import { MotionValue } from '@labpics/motion';
import { createPresence, type PresenceSnapshot } from '@labpics/motion/presence';

const panel = document.querySelector('.panel') as HTMLElement;
const spring = { mass: 1, stiffness: 260, damping: 22 };
let mv: MotionValue | undefined;

function phase(
  target: number,
  fallbackFrom: number,
  done: () => void,
  from: PresenceSnapshot | undefined,
  capture: (read: () => PresenceSnapshot) => void,
): void {
  mv?.destroy(); // прерванный ран больше не пишет в стиль
  const value = new MotionValue({
    initial: from?.value ?? fallbackFrom, // продолжение с места прерывания…
    initialVelocity: from?.velocity ?? 0, // …и с его скоростью (C¹, без телепорта)
    spring,
    clamp: false, // честный довыбег унаследованного импульса
  });
  mv = value;
  // Живой снимок ЭТОЙ фазы: машина прочтёт его синхронно в момент прерывания.
  capture(() => ({ value: value.value, velocity: value.velocity }));
  const settled = (): boolean => value.value === target && value.velocity === 0;
  const unsub = value.onChange((v) => {
    panel.style.transform = `translateY(${v}px)`;
    if (settled()) {
      unsub();
      done();
    }
  });
  value.setTarget(target);
  if (settled()) {
    // Уже покоились ровно на target — setTarget был no-op без эмита.
    unsub();
    done();
  }
}

const presence = createPresence<PresenceSnapshot>({
  matchMedia: window.matchMedia.bind(window),
  onEnterStart: (done, from, capture) => phase(0, 24, done, from, capture),
  onExitStart: (done, from, capture) => phase(24, 0, done, from, capture),
  onGone: () => panel.remove(),
});

presence.enter();
// Передумали на полпути: exit() синхронно снимет снимок enter-рана и передаст
// его onExitStart — выход продолжится с текущей позиции и скорости.
presence.exit();
```

### swapPresence: замена страниц в режиме 'wait'

```ts
import { drive } from '@labpics/motion';
import { createPresence, swapPresence, type PresenceControls } from '@labpics/motion/presence';

const mm = typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined;
const spring = { mass: 1, stiffness: 220, damping: 24 };

function fadePresence(el: HTMLElement, initiallyPresent: boolean): PresenceControls {
  const fade = (from: number, to: number, done: () => void): void => {
    void drive({
      from,
      to,
      spring,
      onStep: (v) => {
        el.style.opacity = String(v);
      },
      matchMedia: mm,
    }).then(done);
  };
  return createPresence({
    initiallyPresent,
    matchMedia: mm,
    onEnterStart: (done) => {
      el.style.display = '';
      fade(0, 1, done);
    },
    onExitStart: (done) => fade(1, 0, done),
    onGone: () => {
      el.style.display = 'none';
    },
  });
}

const pageA = fadePresence(document.querySelector('#page-a') as HTMLElement, true);
const pageB = fadePresence(document.querySelector('#page-b') as HTMLElement, false);

// 'wait': вход B стартует только по терминальному 'gone' A; если A передумал
// (pageA.enter() во время выхода) — своп отменяется, B не входит.
swapPresence(pageA, pageB, { mode: 'wait' });
```
