# ./auto — автоматические переходы (zero-config FLIP)

> Роль: справка — публичный API экспорт-субпутя `./auto`: drop-in аниматор childList-мутаций `autoAnimate` и его чистое ядро (`planAuto`, `moveKeyframes`, `enterKeyframes`, `exitKeyframes`).

## Назначение

Субпуть `./auto` — zero-config анимация add/remove/move детей одного родителя (канон — auto-animate.formkit.com): один вызов `autoAnimate(parent, options)` → контроллер `enable`/`disable`/`disconnect`, дальше обычные DOM-мутации анимируются сами. Статичный родитель получает `position: relative`; дефолты — 0.25 с (канон 250 мс) и `ease-in-out`; `prefers-reduced-motion` уважается по умолчанию.

Архитектура — чистое ядро, отделённое от DOM-адаптера:

- **Ядро.** `planAuto` — детерминированный дифф двух снапшотов детей по ключам (с порогом `epsilon` против суб-пиксельной дрожи); `moveKeyframes`/`enterKeyframes`/`exitKeyframes` — строители WAAPI-кейфреймов поверх `computeFlip` из [./flip](./flip.md).
- **Адаптер.** `MutationObserver` — только триггер переплана; весь дифф считается по кэшу rect'ов против текущих детей. Эмит — нативный `element.animate`; easing движка компилируется в строку CSS `linear()` обвязкой `./waapi` ([compositor.md](./compositor.md)). Все швы инжектируемы (`MutationObserverCtor`/`matchMedia`/`getComputedPosition`) — модуль тестируется duck-typed фейками без DOM; среда без `MutationObserver` (SSR/legacy) получает **инертный контроллер**, не исключение.

Reduced-motion — смена **характера**, не выключение: move снапает (позиция меняется мгновенно, вестибулярное движение убрано), enter/exit остаются opacity-фейдом (не вестибулярны). Канонический AutoAnimate в этом режиме отключается целиком — здесь обратная связь сохраняется.

Удаление — по канону: узел реинсертится `position: absolute` на прежнем месте, играет exit-фейд и физически удаляется на `onfinish`; до завершения исключён из планирования.

Инварианты: zero-DOM на пути импорта, zero-deps, детерминизм чистого ядра, CSS-safe (transform-числа через стражи `computeFlip`), `MotionParamError` — рано, на границе вызова. Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  autoAnimate,
  planAuto,
  moveKeyframes,
  enterKeyframes,
  exitKeyframes,
  type AutoPlan,
  type AutoParent,
  type AutoAnimateOptions,
  type AutoAnimateControls,
  type FlipRect,
} from '@labpics/motion/auto';
```

## API

### autoAnimate

```ts
interface AutoAnimateOptions {
  readonly duration?: number;              // секунды движка, конечная, > 0; дефолт 0.25 (канон 250 мс)
  readonly easing?: WaapiEasingFn;         // (t: number) => number; эмитится как CSS linear()
  readonly epsilon?: number;               // px, конечный, >= 0; дефолт 0.5
  readonly respectReducedMotion?: boolean; // дефолт true
  readonly MutationObserverCtor?: new (cb: (records: unknown[]) => void) => MutationObserverLike;
  readonly matchMedia?: (query: string) => { matches: boolean };
  readonly getComputedPosition?: (el: AutoParent) => string;
}

interface AutoAnimateControls {
  enable(): void;     // вернуть анимации после disable(); пересобирает снапшот (без прыжков)
  disable(): void;    // заглушить: мутации применяются мгновенно (снап)
  disconnect(): void; // отписать observer навсегда
}

function autoAnimate(parent: AutoParent, options?: AutoAnimateOptions): AutoAnimateControls;
```

Zero-config аниматор childList-мутаций родителя. Наблюдает только `{ childList: true }`; на каждую пачку записей строит `planAuto(prevCache, currentSnapshot, epsilon)` и эмитит анимации через `element.animate` каждого ребёнка.

Параметры (`AutoAnimateOptions`):

- `duration` — длительность каждой анимации в **секундах движка** (конвенция входных опций, как в [./compositor](./compositor.md)); конечная, `> 0`, дефолт `0.25`. В тайминг `element.animate` уходит в **миллисекундах** (×1000, конвенция WAAPI) вместе с `fill: 'both'`. Некорректная — `MotionParamError` `LM002`.
- `easing` — easing-функция движка (`WaapiEasingFn = (t: number) => number`, тип из `@labpics/motion/waapi`, справка — [compositor.md](./compositor.md)); компилируется в строку CSS `linear()` (`easingToLinear`). Не задана — нативный `'ease-in-out'`.
- `epsilon` — порог движения в px против суб-пиксельной дрожи layout; конечный, `>= 0`, дефолт `0.5`. Некорректный — `MotionParamError` `LM001`.
- `respectReducedMotion` — уважать `prefers-reduced-motion: reduce` (смена характера: move снапает, enter/exit остаются фейдом). Дефолт `true`; `false` отключает детект.
- `MutationObserverCtor` — инжектируемый конструктор observer'а (тесты / нестандартные среды); дефолт — глобальный `MutationObserver`. Нет ни того, ни другого → инертный контроллер, без броска.
- `matchMedia` — инжектируемый детект `(prefers-reduced-motion: reduce)`; дефолт — глобальный `matchMedia`. Отсутствие или бросок трактуются как «нет предпочтения».
- `getComputedPosition` — инжектируемый замер computed `position` родителя; дефолт — `getComputedStyle(el).position` (пустая строка без `getComputedStyle`). Результат `'static'` → родителю пишется инлайновый `position: relative` (канон: absolute-exit нужен позиционированный предок).

Поведение:

- **Enter** — opacity-фейд `0 → 1`. **Move** — FLIP-кейфреймы `moveKeyframes(first, last)` (доезд со старой позиции чистым `transform`). **Exit** — узел реинсертится `position: absolute; left/top` на прежнем месте (координаты от padding-box родителя, с учётом `clientLeft`/`clientTop`), играет фейд `1 → 0` и физически удаляется на завершении анимации; инлайновые стили, занятые библиотекой, восстанавливаются. Узел, возвращённый потребителем в DOM во время exit'а («revival»), не удаляется.
- Повторный вызов на уже занятом `parent` возвращает контроллер действующего owner'а; **новые options не перенастраивают** действующую сессию.
- Ownership ограничен экземпляром модуля: для одного DOM-документа нужен один канонический экземпляр пакета, если разные callers могут трогать одни узлы.
- `parent` — duck-typed `AutoParent` (см. ниже); реальный `Element` соответствует в рантайме. В TS с `lib.dom` `CSSStyleDeclaration` не сужается до `Record<string, string>` — нужен явный каст (см. примеры).
- Ошибка валидации закрывает owner (контроллер становится инертным) и пробрасывается наружу.

Бросает: `MotionParamError` — `LM002` (некорректная `duration`), `LM001` (некорректный `epsilon`). Свод кодов — [docs/errors.md](../errors.md).

Контроллер (`AutoAnimateControls`):

- `enable()` — снять `disable()`; снапшот детей пересобирается заново, поэтому мутации, применённые в заглушённом состоянии, не «доигрываются» прыжком.
- `disable()` — заглушить анимации: мутации применяются мгновенно, observer продолжает поддерживать кэш.
- `disconnect()` — отписать observer навсегда: очередь добирается через `takeRecords`, активные exit-анимации терминируются, стили восстанавливаются, `parent` освобождается. Необратимо.

### planAuto

```ts
interface AutoPlan<K> {
  readonly enters: readonly K[];
  readonly exits: readonly (readonly [K, FlipRect])[];
  readonly moves: readonly (readonly [K, { readonly first: FlipRect; readonly last: FlipRect }])[];
}

function planAuto<K>(
  prev: readonly (readonly [K, FlipRect])[],
  next: readonly (readonly [K, FlipRect])[],
  epsilon?: number, // px; дефолт 0.5
): AutoPlan<K>;
```

Чистый дифф двух снапшотов детей (пары «ключ → rect», `FlipRect` — срез `getBoundingClientRect` из [./flip](./flip.md), все поля — px). Ключ `K` произволен (адаптер использует сами узлы).

- `enters` — ключи, появившиеся в `next`.
- `exits` — ключи, исчезнувшие из `next`, с последним известным rect'ом (для absolute-реинсерта).
- `moves` — ключи, присутствующие в обоих снапшотах, чей сдвиг **или** изменение размера превышает `epsilon`: `|Δx| > ε || |Δy| > ε || |Δwidth| > ε || |Δheight| > ε`. Суб-пиксельная дрожь layout не плодит анимаций.
- `NaN`-разницы не считаются движением (сравнение с `epsilon` у `NaN` ложно) — план строится без исключений при любом IEEE-754 входе.

Бросает: `MotionParamError` `LM001` — `epsilon` не конечен или `< 0`.

### moveKeyframes

```ts
function moveKeyframes(first: FlipRect, last: FlipRect): Record<string, string | number>[];
```

FLIP-кейфреймы движения — два кадра для `element.animate`:

1. Инверсия First→Last через `computeFlip(first, last)`: `{ transform: 'translate(<dx>px, <dy>px) scale(<sx>, <sy>)', transformOrigin: '0 0' }`. `transform-origin: '0 0'` — требование формул [./flip](./flip.md); числа проходят стражи `computeFlip` (всегда конечны: `NaN` → `0`, вырожденный знаменатель масштаба → `1`), `-0` схлопывается в `0` — строка `-0px` не эмитится.
2. `{ transform: 'none' }`.

Бросает: ничего.

### enterKeyframes

```ts
function enterKeyframes(): Record<string, string | number>[];
```

Кейфреймы появления: `[{ opacity: 0 }, { opacity: 1 }]`. Opacity-фейд не вестибулярен — переживает reduced-motion.

Бросает: ничего.

### exitKeyframes

```ts
function exitKeyframes(): Record<string, string | number>[];
```

Кейфреймы ухода — обратный фейд: `[{ opacity: 1 }, { opacity: 0 }]`.

Бросает: ничего.

### Type-only экспорты

- `AutoPlan<K>` — разложение childList-дельты: `{ enters, exits, moves }` (см. `planAuto`).
- `AutoParent` — duck-typed минимум родителя: `children` (ArrayLike + Iterable), опциональные `clientLeft`/`clientTop` (ширина бордера: absolute-дети позиционируются от padding-box), `getBoundingClientRect()`, `appendChild`, `removeChild`, `style`. Реальный `Element` соответствует в рантайме. От детей duck-typed минимум — `getBoundingClientRect()`, `style`, опциональные `animate` (узел без него завершает exit без анимации) и `parentNode` (oracle владения при exit'е).
- `AutoAnimateOptions` — опции `autoAnimate`.
- `AutoAnimateControls` — контроллер (`enable`, `disable`, `disconnect`).
- `FlipRect` — реэкспорт из [./flip](./flip.md): `{ x, y, width, height }` (px).

Тип `WaapiEasingFn` для опции `easing` экспортируется из `@labpics/motion/waapi`.

## Контракты

- **SSR-safe / zero-DOM.** Импорт не трогает DOM/`window`. Среда без `MutationObserver` (и без инжектированного `MutationObserverCtor`) получает инертный контроллер, не исключение; `matchMedia`/`getComputedStyle` опциональны, их отсутствие или бросок — «нет предпочтения» / «position неизвестен».
- **Reduced-motion — смена характера, не hard-off.** Под `(prefers-reduced-motion: reduce)` (детект при вызове `autoAnimate`, `respectReducedMotion: false` отключает): move снапает — позиция меняется мгновенно, вестибулярное движение убрано; enter/exit остаются opacity-фейдом — обратная связь сохраняется.
- **Детерминизм чистого ядра.** `planAuto`, `moveKeyframes`, `enterKeyframes`, `exitKeyframes` — чистые функции: идентичный вход → идентичный план и кейфреймы. Ни wall-clock, ни `Math.random`.
- **Финитность / CSS-safe.** Числа transform'а в `moveKeyframes` проходят стражи `computeFlip` — всегда конечны; `-0` схлопнут; `NaN`-разницы rect'ов не считаются движением — план строится без исключений.
- **`MotionParamError` рано.** `LM001`/`LM002` бросаются на границе вызова (`planAuto`/`autoAnimate`), не поздним исключением из колбэка observer'а; ошибка валидации `autoAnimate` закрывает сессию до проброса. Свод кодов — [docs/errors.md](../errors.md).
- **Single-writer ownership.** Повторный `autoAnimate` на занятом `parent` возвращает контроллер действующего owner'а (options игнорируются); exit-узел исключён из планирования до завершения; узел, отобранный потребителем (перенос в другой parent, revival), библиотекой не удаляется.

## Примеры

Drop-in анимация списка — обычные DOM-мутации, анимации автоматические:

```ts
import { autoAnimate, type AutoParent } from '@labpics/motion/auto';

const list = document.querySelector('#todos') as HTMLElement;
// TS c lib.dom: CSSStyleDeclaration не сужается до Record<string, string> — каст.
const controls = autoAnimate(list as unknown as AutoParent);

const item = document.createElement('li');
item.textContent = 'Новая задача';
list.appendChild(item);                          // enter: opacity 0 → 1
list.insertBefore(item, list.firstElementChild); // move остальных: FLIP-доезд
list.removeChild(item);                          // exit: фейд на прежнем месте, удаление на onfinish

controls.disable();    // мутации применяются мгновенно
controls.enable();     // вернуть анимации; снапшот пересобран — без прыжков
controls.disconnect(); // отписаться навсегда
```

Настройка: длительность, easing движка (эмитится как CSS `linear()`), порог дрожи:

```ts
import { autoAnimate, type AutoParent } from '@labpics/motion/auto';
import { easeOut } from '@labpics/motion/easing';

const grid = document.querySelector('.grid') as HTMLElement;
autoAnimate(grid as unknown as AutoParent, {
  duration: 0.18, // секунды движка; в element.animate уйдёт в миллисекундах
  easing: easeOut,
  epsilon: 1,     // сдвиги/ресайзы в пределах 1px не анимируются
});
```

Чистое ядро без DOM — дифф и кейфреймы для собственного эмиттера или теста:

```ts
import {
  planAuto,
  moveKeyframes,
  enterKeyframes,
  exitKeyframes,
  type FlipRect,
} from '@labpics/motion/auto';

const rect = (x: number, y: number): FlipRect => ({ x, y, width: 100, height: 40 });

const prev: [string, FlipRect][] = [['a', rect(0, 0)], ['b', rect(0, 48)]];
const next: [string, FlipRect][] = [['b', rect(0, 0)], ['c', rect(0, 48)]];

const plan = planAuto(prev, next); // epsilon 0.5px по умолчанию
// plan.enters → ['c']
// plan.exits  → [['a', { x: 0, y: 0, width: 100, height: 40 }]]
// plan.moves  → [['b', { first: { y: 48, … }, last: { y: 0, … } }]]

for (const [, { first, last }] of plan.moves) {
  const frames = moveKeyframes(first, last);
  // [{ transform: 'translate(0px, 48px) scale(1, 1)', transformOrigin: '0 0' },
  //  { transform: 'none' }]
  void frames;
}
void enterKeyframes(); // [{ opacity: 0 }, { opacity: 1 }]
void exitKeyframes();  // [{ opacity: 1 }, { opacity: 0 }]
```
