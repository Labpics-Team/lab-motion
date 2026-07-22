# ./nano — минимальный WAAPI-вход

> Роль: справка — публичный API экспорт-субпутя `./nano`: функция `animate(target, props, options)` — platform-trusted компиляция целевого значения (или пары `[from, to]`) в native WAAPI; пружина — в CSS `linear()`.

## Назначение

Субпуть `./nano` — минимальный DOM-фасад для **доверенной современной платформы**: целевое значение (или явная пара `[from, to]`) компилируется в нативный `Element.animate()`, пружина — в замкнутой форме в CSS `linear()`-строку. Контракт platform-trusted требует нативные `Element.animate()`, `Animation.commitStyles()` и CSS `linear()`; скрытого rAF-fallback, C¹-подхвата при прерывании и защиты от hostile/polyfill-host здесь нет — это намеренно контракт полного [`./animate`](./animate.md) (см. «Отличие от ./animate»).

Спружинный артефакт — SSOT `src/nano/spring-linear.ts`: та же каноническая пара «длительность + `linear()`-строка» потребляется build-time compiler-lowering (#208, nano + `./compiler/vite`), поэтому runtime- и compiled-кривая совпадают бит-в-бит по построению. Сам `springLinear` субпутём не экспортируется — это внутренний шов.

Субпуть живёт под жёстким размер-гейтом; характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  animate,
  type NanoSpring,
  type NanoOptions,
  type NanoPair,
  type NanoProps,
  type NanoTarget,
  type NanoControls,
} from '@labpics/motion/nano';
```

Смежные публичные пути: конструктор `fromBounce({ duration, bounce })` для перцептивной параметризации пружины — `@labpics/motion/spring` (#218); полный DOM-фасад — `@labpics/motion/animate`.

## API

Единственный runtime-экспорт субпутя — `animate`.

### animate

```ts
function animate(
  target: NanoTarget,
  props: NanoProps,
  options?: NanoOptions, // по умолчанию {}
): NanoControls;

type NanoTarget = Element | string | Iterable<Element> | ArrayLike<Element>;
type NanoControls = Animation[] & { finished: Promise<Animation[]> };
```

Анимирует одну или несколько DOM-целей на native WAAPI: один вызов `element.animate(frame, …)` на цель, `fill: 'both'`.

**Резолв цели** (в момент вызова):

- строка → `document.querySelectorAll(target)`;
- объект с методом `animate` (`'animate' in target`) → одиночная цель;
- иначе — `Iterable`/`ArrayLike` итерируется как коллекция; порядок задаёт индекс для `stagger`.

#### props: каналы и пары [from, to]

```ts
type NanoPair = [from: number, to: number] | [from: string, to: string];

type NanoProps = Record<string, string | number | NanoPair | undefined> & {
  readonly translate?: string | [from: string, to: string] | undefined;
  readonly scale?: number | [from: number, to: number] | undefined;
  readonly rotate?: number | undefined; // только скаляр
  readonly x?: never;          // poison: грамматика полного ./animate
  readonly y?: never;          // poison: грамматика полного ./animate
  readonly translateX?: never; // poison: оси полного ./animate
  readonly translateY?: never; // poison: оси полного ./animate
};
```

| Ключ | Тип | Поведение |
| --- | --- | --- |
| `translate` | `string \| [string, string]` | Весь CSS `translate` **longhand** одним каналом: `'240px'`, `'240px 12px'` |
| `scale` | `number \| [number, number]` | Нативный CSS `scale` |
| `rotate` | `number` | Только скаляр: значение получает принудительный суффикс `deg` (`${rotate}deg`) |
| любое другое CSS-свойство | `string \| number \| NanoPair` | Нативно в WAAPI (имена — IDL/camelCase: `backgroundColor`); цвета, фильтры и единицы интерполирует браузер |

**Пара `[from, to]`** — явный старт вместо to-only инференса WAAPI. Пара однородна по типу (оба числа ИЛИ обе строки — требование WAAPI `PropertyIndexedKeyframes`), поэтому пробрасывается нативно без единого runtime-байта. Одиночное значение — целевое: `from` браузер берёт из computed style. Благодаря `fill: 'both'` `from` применяется сразу, включая период `delay`.

**Poison-ключи (запрещены типами):**

| Ключ | Почему запрещён | Замена в nano |
| --- | --- | --- |
| `x`, `y` | Transform-шортхенды `x`/`y` — грамматика полного `./animate`; nano не читает layout, чтобы угадывать вторую ось | `translate: '240px 12px'` |
| `translateX`, `translateY` | Независимые оси translate — контракт полного `./animate` (`x`/`y`) | целый `translate` longhand |
| `rotate: [from, to]` | Принудительный `deg`-суффикс не переживает массив | скаляр здесь; пара — `./animate` |

Запрет — **типовой** (compile-time, `never`), runtime-фильтра нет — политика нуля runtime-байт: из нетипизированного JS такой ключ уйдёт в WAAPI как одноимённое CSS-свойство.

#### options

```ts
type NanoOptions = {
  readonly delay?: number;          // мс, по умолчанию 0
  readonly stagger?: number;        // мс между целями, по умолчанию 0
  readonly reducedMotion?: boolean; // иначе prefers-reduced-motion в момент вызова
} & (
  | { spring?: NanoSpring; duration?: never; ease?: never }   // spring-режим (дефолт)
  | { spring?: never; duration: number; ease?: string }       // tween-режим
);

interface NanoSpring {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}
```

Все времена — **миллисекунды** (Framer/Motion считают в секундах — ×1000). Задержка конкретной цели: `delay + stagger * index`.

Режим — дискриминированное объединение, `spring` и `duration`/`ease` взаимоисключающи на уровне типов:

- **spring-режим** (без `duration`; действует и при полностью опущенных options): пружина из покоя, дефолт `mass/stiffness/damping = 1/170/26` (тот же `springPresets.default`). Длительность и плотность `linear()`-строки выводятся из полюсов системы и settle-допуска пакета `ε = 1e-3`, без wall-clock cap; число узлов — из оценки ошибки линейного сегмента (`≤ max|x″|·h²/8`), не из Hz. Думаете в `duration`/`bounce` — `spring: fromBounce({ duration, bounce })` из `@labpics/motion/spring`: точное преобразование (#218), результат структурно совместим с `NanoSpring`.
- **tween-режим**: `duration` в мс, `ease` — нативная CSS easing-строка, по умолчанию `'ease'`.

#### Грамматика ease-строк

`ease` — нативная CSS `<easing-function>`-строка; nano её не парсит и не валидирует — она уходит в `Element.animate({ easing })` как есть:

```text
<easing-function> = linear | ease | ease-in | ease-out | ease-in-out
                  | cubic-bezier(<x1>, <y1>, <x2>, <y2>)
                  | steps(<n> [, <jump-position>])
                  | linear(<point> [, <point>]#)
```

Неразборную строку отклоняет сама платформа (граница platform-trusted). JS-функции изинга (`(t) => number`, кривые `@labpics/motion/easing`) — контракт полного `./animate`.

#### Возврат: NanoControls

Массив нативных `Animation` в порядке целей — `pause()`, `play()`, `reverse()`, `cancel()`, `playbackRate` доступны напрямую, без обёртки. Плюс поле:

- `finished: Promise<Animation[]>` — `Promise.all` по всем целям. На `finish` каждой анимации финал фиксируется `commitStyles()` и анимация снимается `cancel()`; на платформе без `commitStyles` финал удерживает `fill: 'both'`. Резолвится массивом всех `Animation`; отклоняется, если `finished` любой из анимаций отклонился (например, пользовательский `cancel()`).

#### Бросаемые ошибки

nano не тянет каталог `MotionParamError`/LM-кодов — бросает нативный `RangeError`, в spring-режиме и **до создания первой анимации**:

| Сообщение | Условие |
| --- | --- |
| `spring parameters must be finite and positive` | `mass`/`stiffness`/`damping` неконечны или `≤ 0` |
| `spring is not representable` | выведенная длительность неконечна, либо число узлов `linear()`-сетки превышает общий с compositor-компилятором потолок (`BASE_GRID_MAX`): выше синхронной CSS-строки живой солвер полного `./animate` дешевле и не блокирует event loop |

Tween-режим пакетом не валидируется: `duration`/`ease` уходят платформе как есть.

### Type-only экспорты

`NanoSpring`, `NanoOptions`, `NanoPair`, `NanoProps`, `NanoTarget`, `NanoControls`.

## Отличие от ./animate

| | `./nano` | `./animate` |
| --- | --- | --- |
| Платформа | trusted: нативные `Element.animate`, `commitStyles`, CSS `linear()` обязательны; fallback нет | defensive host boundary: авто-tier reduced/compositor/main, rAF-микроцикл, WebKit-ветка явных ключевых кадров |
| Прерывание | без C¹-подхвата: повторный вызов — новая WAAPI-анимация | канон MotionValue smooth-pickup, C¹ на обоих путях |
| Keyframes | целевое значение или пара `[from, to]` | N-keyframe кортежи (#205) |
| Transform | целые longhand-каналы `translate`/`scale`/`rotate`; `rotate` — скаляр | шортхенды `x`/`y`, независимые оси, пары для поворота |
| Easing | нативная CSS-строка | JS-функции изинга, кривые `./easing` |
| Сверхдлинные пружины | `RangeError` выше потолка сетки | живой main-солвер |
| Контролы | сами `Animation[]` | thenable-контролы |
| Ошибки | нативный `RangeError` | `MotionParamError` с LM-кодами ([docs/errors.md](../errors.md)) |

## Контракты

- **SSR-safe импорт.** Модуль не трогает DOM на import; `document` читается только при вызове со строкой-селектором, `matchMedia` — под `typeof`-гардом. Сам **вызов** требует DOM (`Element.animate`) — nano исполняется только в браузере.
- **Reduced-motion.** `options.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches` — читается в момент вызова. При reduce: `duration: 0`, `delay: 0`, `easing: 'linear'` — мгновенный финал через нулевую WAAPI-анимацию (`fill: 'both'` + `commitStyles()`), `finished` резолвится штатно.
- **Финитность.** Spring-параметры проверяются на конечность и положительность, длительность и `linear()`-сетка — на представимость; `RangeError` бросается до создания анимаций.
- **Детерминизм.** Spring-артефакт — замкнутая аналитическая форма без wall-clock: идентичный вход → идентичная пара «длительность + `linear()`-строка»; бит-в-бит совпадает с выходом build-time компилятора (#208).
- **Единицы.** `delay`, `stagger`, `duration` и длительность пружины — миллисекунды; `rotate` — градусы (`deg`-суффикс).

## Примеры

Базовый вызов: пружина по умолчанию, longhand-каналы, каскад.

```ts
import { animate } from '@labpics/motion/nano';

// options.spring можно опустить: дефолт mass/stiffness/damping = 1/170/26.
const controls = animate('.card', {
  translate: ['0px 24px', '0px 0px'], // целый CSS translate longhand — не x/y
  rotate: 6,                          // только скаляр: получает суффикс deg
  opacity: [0, 1],                    // пара [from, to], однородная по типу
}, { stagger: 40 });                  // мс между целями

// Каждый элемент — нативный Animation: pause()/reverse()/playbackRate напрямую.
await controls.finished;              // финал зафиксирован commitStyles()
```

Tween с нативной CSS easing-строкой.

```ts
import { animate } from '@labpics/motion/nano';

const panel = document.querySelector('#panel') as HTMLElement;

await animate(panel, {
  opacity: [0, 1],
  backgroundColor: ['#0ea5e9', '#22c55e'], // цвета интерполирует браузер
}, {
  duration: 400,                           // мс (Framer/Motion: секунды — ×1000)
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',  // нативная CSS <easing-function>
  delay: 100,                              // мс; from применяется сразу (fill: 'both')
}).finished;
```

Перцептивная параметризация пружины через `./spring`.

```ts
import { animate } from '@labpics/motion/nano';
import { fromBounce } from '@labpics/motion/spring';

// SwiftUI-координаты (секунды!) → точные {mass, stiffness, damping} (#218);
// результат структурно совместим с NanoSpring.
const spring = fromBounce({ duration: 0.5, bounce: 0.2 });

const controls = animate(document.querySelectorAll('.item'), { scale: [0.92, 1] }, {
  spring,
  stagger: 40, // мс, в порядке NodeList
});
await controls.finished;
```
