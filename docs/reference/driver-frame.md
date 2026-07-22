# ./driver и ./frame — управляемый драйвер и общий кадровый цикл

> Роль: справка — полный API субпутей `@labpics/motion/driver` (скраб-драйвер `createDriver` с thenable-хендлом `AnimationControls`) и `@labpics/motion/frame` (общий кадровый цикл `frame`/`createFrameLoop` с фазами read→update→render и адаптером `asRequestFrame`).

## Назначение

Два субпутя одного контура исполнения:

- **`./driver`** — управляемый (scrubbable/playback-controllable) хендл
  анимации поверх аналитического пружинного решателя. В отличие от
  одноразового `drive` из корня: явное виртуальное время с `seek`,
  `timeScale` (скорость/реверс/заморозка), `play`/`pause`, awaitable-хендл.
  Reduced-motion — CHARACTER-switch (снап к цели), не hard-off.
- **`./frame`** — единый frame-шедулер: один rAF на кадр и батч всех
  подписчиков вместо N колбэков от N живых значений (гэп D11 «shared rAF
  frameloop»). Фазы read → update → render (канон Motion frame /
  gsap.ticker): измерения DOM, затем вычисления, затем записи — исключает
  layout-thrash по построению. Адаптер `asRequestFrame` сажает
  `MotionValue`/`drive`/`createDriver` на один общий кадр через их
  существующий seam `requestFrame`.

Оба субпутя изолированы: в core-bundle не входят, попадают в бандл только при
явном импорте (ESM subpath-tree-shaking, инвариант North 6). Веса артефактов —
только из воспроизводимых прогонов: см. [docs/benchmark.md](../benchmark.md) и
`pnpm size`.

## Импорт

ESM и CJS (ветки `"./driver"` и `"./frame"` в `exports` package.json):

```typescript
import {
  createDriver,
  type AnimationControls,
  type DriverOptions,
} from '@labpics/motion/driver';

import {
  frame,
  createFrameLoop,
  asRequestFrame,
  type FrameLoop,
  type FrameCallbackOptions,
} from '@labpics/motion/frame';
```

## API

### `createDriver(opts)`

```ts
function createDriver(opts: DriverOptions): AnimationControls;

interface DriverOptions {
  readonly from: number;                    // начальное значение; конечное, иначе LM026
  readonly to: number;                      // цель; конечное, иначе LM027
  readonly spring: SpringParams;            // физика; валидируется validateSpringParams
  readonly onStep: (value: number) => void; // колбэк каждого шага; при reduce — однократно с to
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  readonly initialTimeScale?: number | undefined; // дефолт 1.0; NaN → 1.0
  readonly clamp?: boolean | undefined;           // дефолт true
}
```

Создаёт управляемый драйвер и **немедленно начинает воспроизведение**
(auto-play). Для старта на паузе — `pause()` сразу после создания, до первого
кадрового колбэка. Возвращаемый хендл thenable: `await createDriver(opts)`
разрешается при завершении.

Параметры:

- `matchMedia` — инжектируемый шов reduced-motion; в браузере передавайте
  `window.matchMedia.bind(window)`. `undefined` = SSR / нет предпочтений
  (reduce=false). Контракт позиции структурный (`(query) => { matches }`) —
  совместим с `window.matchMedia`, `lib.dom` у потребителя не требуется.
- `requestFrame` — инжектируемый заменитель `requestAnimationFrame`
  (детерминированные тесты, общий цикл через `asRequestFrame`). Возврат
  handle=0 по конвенции означает non-draining step-clock — драйвер
  переключается на `setTimeout`-fallback. Без опции: поздний lookup
  глобального rAF, в Node — `setTimeout`-шим с фиксированным шагом 1/60 с.
- `initialTimeScale` — начальный коэффициент скорости: 1.0 = нормальная,
  −1.0 = реверс, 0 = заморожено. Дефолт 1.0; `NaN` на входе даёт 1.0.
- `clamp` — дефолт `true`: эмитируемые значения зажаты в `[from, to]`
  (легаси CSS-safe). `false` — честная пружина: underdamped
  overshoot/bounce эмитится (аналитическая траектория без среза); финальный
  settle — ровно `to`, non-finite-защита остаётся в силе.

Мгновенные завершения (без единого кадра): `from === to`; переполнение
диапазона (`|from| + |to| > Number.MAX_VALUE`); reduced-motion. Во всех трёх
случаях — один `onStep(to)` и разрешённый Promise.

Пределы цикла: одно forward-воспроизведение ограничено капом 2000 кадров
(`MAX_FRAMES`, общий контур с `drive`/`MotionValue`); суммарный скраб любой
формы (реверсы, `timeScale=0`/NaN, качание) — глобальным пологом ×5 к нему,
после которого принудительный settle в текущей позиции.

Время: приращение виртуального времени = реальный `dt × timeScale`. `dt`
берётся из timestamp хоста (миллисекунды, делятся на 1000); первый кадр,
кадр после паузы/`seek`, отсутствующий `ts` или `dt ≤ 0` → фиксированный шаг
1/60 с.

Бросает синхронно `MotionParamError` (каталог — [docs/errors.md](../errors.md)):
`LM026` (`from` не конечно), `LM027` (`to` не конечно), `LM088`/`LM089`/`LM090`
(физика пружины), `LM091` (время оседания превышает бюджет frame-loop).

#### `AnimationControls`

```ts
interface AnimationControls {
  readonly time: number;      // виртуальное время, секунды (корректируется seek-ами)
  timeScale: number;          // writable; NaN при записи игнорируется; ±Infinity допустимы
  readonly progress: number;  // нормированная позиция пружины, зажата в [0, 1]
  readonly velocity: number;  // аналитическая скорость, units/s; всегда конечна

  play(): void;               // возобновить (no-op, если играет или settled)
  pause(): void;              // приостановить (no-op, если уже на паузе)
  reverse(): void;            // инвертировать знак timeScale
  seek(t: number): void;      // перемотка к виртуальному времени t (секунды)
  complete(): void;           // снап к to + resolve
  cancel(): void;             // остановка в текущей позиции + resolve
  stop(): void;               // alias для cancel()

  then<T1 = void, T2 = never>(
    onfulfilled?: ((value: void) => T1 | PromiseLike<T1>) | null | undefined,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null | undefined,
  ): Promise<T1 | T2>;
}
```

- `timeScale` — 1.0 = нормальная скорость, −1.0 = реверс, 0 = заморожено.
  `±Infinity` намеренно допустимы: мгновенная сходимость к `to` / реверс к
  `from`. Запись `NaN` игнорируется (текущее значение не меняется).
- `progress` — 0 = at `from`, 1 = at `to`; после settle на `to`/`from` —
  ровно 1/0, после `cancel` в промежуточной точке вычисляется из времени.
- `velocity` — скорость траектории солвера (hidden state) в единицах
  значения в секунду, НЕ производная клампованного выхода: режим `clamp` на
  неё не влияет (канон `MotionValue.velocity`). Назначение — live-чтение для
  хендоффа: приёмник наследует пару (эмитнутое value, velocity) как
  начальные условия. В покое ровно 0: до старта, после
  сходимости/`complete`/`cancel`, вырожденный `from === to`.
- `seek(t)` — `t` в секундах; `t < 0` и `−Infinity` зажимаются в 0, `NaN`
  игнорируется, `+Infinity` эквивалентно `complete()`. Эмитирует позицию
  пружины при новом времени через `onStep`. После завершения — no-op.
- `complete()`/`cancel()`/`stop()` идемпотентны; каждый эмитирует финальный
  `onStep` (соответственно `to` / текущая позиция) и разрешает Promise.
- `then` — разрешается `void` при любом завершении: естественная
  сходимость, `complete()`, `cancel()`/`stop()`, срабатывание кадрового капа.

### `createFrameLoop(options?)`

```ts
function createFrameLoop(options?: { requestFrame?: RequestFrameFn }): FrameLoop;

interface FrameLoop {
  read(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void;   // фаза 1: измерения DOM
  update(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void; // фаза 2: вычисления
  render(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void; // фаза 3: записи в DOM
  cancelAll(): void; // TEARDOWN владельца цикла: снять ВСЕ подписки всех фаз и остановить цикл
}

interface FrameCallbackOptions {
  readonly once?: boolean;                        // однократно + самоотписка; дефолт — ПОВТОР каждый кадр
  readonly onTeardown?: (() => void) | undefined; // вызывается только cancelAll(), не обычным off()
}
```

Создаёт независимый кадровый цикл с фазами read → update → render. Каждый
метод фазы возвращает идемпотентную функцию отписки. Колбэк получает `ts` —
timestamp хоста (миллисекунды, `DOMHighResTimeStamp` у нативного rAF), может
быть `undefined` у инжектированных часов.

Семантика кадра (закреплена в JSDoc модуля):

- батч кадра фиксируется на входе в тик: подписка во время тика исполняется
  со **следующего** кадра (кадр не видит собственных порождений);
- отписка действует немедленно — подписчик, снятый в текущем тике, в этом
  кадре уже не вызывается;
- исключение подписчика не срывает ни соседей, ни цикл (try/catch на кадр
  каждого колбэка);
- ленивый старт/стоп: пустой цикл не планирует кадров вовсе.

Внимание пришедшим из Motion: там инверсный дефолт `once` (однократно,
повтор через keepAlive) — здесь дефолт повторяется каждый кадр, потому что
главный потребитель — тикающие значения ядра.

`cancelAll()` — teardown владельца цикла, не отписка одного потребителя: на
разделяемом синглтоне `frame` гасит подписки **всех** субпутей. Для точечной
отписки держите off-хендл своей подписки. `onTeardown` — handshake для
агрегатов: терминализировать владельцев вместо удержания мёртвых handle-ов.

Планирование: инжектированный `requestFrame` (тип `RequestFrameFn` из корня
`@labpics/motion`) или глобальный rAF; без rAF — `setTimeout`-шим с шагом
1000/60 мс. Возврат handle=0 (non-draining тест-клок) переключает на
`setTimeout`-fallback; синхронный host переводится в отслеживаемый
async-trampoline — фазы не вклиниваются в subscribe/cancelAll/teardown.
LM-кодов модуль не бросает; синхронная ошибка инжектированного планировщика
пробрасывается вызывающему подписки, сама подписка при этом откатывается.

### `frame`

```ts
const frame: FrameLoop;
```

Дефолтный общий цикл пакета (модульный синглтон `createFrameLoop()`).
Создание ничего не планирует (ленивый старт) — импорт SSR-safe; rAF
затрагивается только первой подпиской.

### `asRequestFrame(loop?)`

```ts
function asRequestFrame(loop?: FrameLoop): RequestFrameFn; // дефолт loop = frame
```

Адаптер к шву инъекции ядра: превращает цикл в `RequestFrameFn` для
`opts.requestFrame` у `MotionValue`/`drive`/`createDriver` — N живых значений
= один rAF на кадр, не N. Зависимость инвертирована: ядро про `./frame` не
знает.

- Заявка = once-подписка фазы update; ядро перезаявляется из собственного
  тика, и батч-семантика цикла (заявка из тика → следующий кадр)
  воспроизводит семантику нативного rAF один-в-один.
- Возвращаемый handle всегда ненулевой: 0 по контракту ядра означает
  non-draining тест-клок и включил бы параллельный `setTimeout`-путь.
- Дисциплина фаз: тики значений (и, значит, `onChange`-эмиты) исполняются в
  фазе **update** — потребитель, пишущий DOM синхронно из `onChange`, пишет
  в update, не в render. Нужна строгая запись read→update→render —
  буферизуйте значение в `onChange` и пишите из своей render-подписки этого
  же цикла.

### Type-only экспорты

`./driver`: `DriverOptions`, `AnimationControls`. `./frame`: `FrameLoop`,
`FrameCallbackOptions`. Типы `SpringParams` и `RequestFrameFn` в сигнатурах
импортируйте из корня `@labpics/motion`. Стираются при компиляции,
runtime-цены не имеют.

## Контракты

- **SSR-safe.** Оба модуля не трогают window/document при импорте.
  `createDriver` с `matchMedia: undefined` работает без throw (reduce=false);
  синглтон `frame` создаётся без планирования — rAF затрагивается только
  первой подпиской.
- **Reduced-motion (`./driver`).** CHARACTER-switch, не hard-off:
  предпочтение читается однажды на входе через инжектированный `matchMedia`;
  при reduce цикл не входится никогда — один `onStep(to)`, синхронно
  разрешённый Promise. `./frame` — механика планирования, media-query не
  читает.
- **Финитность (CSS-safe).** `createDriver` никогда не эмитит NaN/±Infinity:
  входы валидируются fail-fast до Promise и кадров; неконечное промежуточное
  значение даёт снап в конечный `to`; `velocity` всегда конечна (в т.ч.
  схлопывание −0).
- **Детерминизм.** Часы инжектируются (`requestFrame`); глобальное время не
  читается — одинаковый seam → одинаковый вывод. Батч кадра `./frame`
  фиксируется на входе в тик: кадр не видит подписок, добавленных внутри
  него самого.
- **Изоляция сбоев (`./frame`).** Исключение одного подписчика (и одного
  `onTeardown`) не срывает соседей и цикл; ошибка host-планировщика не
  оставляет цикл в вечном не-idle состоянии.
- **Единицы.** `time`, `seek(t)`, время пружины — секунды; `velocity` —
  единицы значения в секунду; `timeScale` безразмерен; timestamp `ts`
  кадровых колбэков — миллисекунды.
- **Ошибки.** Все броски `./driver` — `MotionParamError` с машинным `code`
  (`LM026`, `LM027`, `LM088`–`LM091`); каталог с лечением —
  [docs/errors.md](../errors.md). `./frame` собственных кодов не имеет.

## Примеры

### Скраб-драйвер: скорость, перемотка, await

```typescript
import { createDriver } from '@labpics/motion/driver';

const panel = document.querySelector('.panel') as HTMLElement;

const controls = createDriver({
  from: 0,
  to: 320,
  spring: { mass: 1, stiffness: 200, damping: 24 },
  matchMedia: window.matchMedia.bind(window), // при reduce: один onStep(320), sync resolve
  onStep: (x) => { panel.style.transform = `translateX(${x}px)`; },
});

controls.timeScale = 0.5; // замедлить вдвое
controls.seek(0.25);      // перемотка: виртуальное время в секундах, эмитит позицию
controls.reverse();       // timeScale = -0.5: едем назад; при достижении 0 — settle(from)

await controls;           // thenable: разрешается при любом завершении
console.log(controls.progress, controls.velocity); // после settle: velocity ровно 0
```

### Общий цикл: read → update → render без layout-thrash

```typescript
import { frame } from '@labpics/motion/frame';

const card = document.querySelector('.card') as HTMLElement;
let width = 0;

// Фаза 1: измерения. Фаза 3: записи. Взаимный порядок гарантирован циклом.
const offRead = frame.read(() => {
  width = card.getBoundingClientRect().width;
});
const offRender = frame.render(() => {
  card.style.setProperty('--card-width', `${width}px`);
});

// Разовый замер на следующем кадре: once + самоотписка.
frame.read((ts) => console.log('ts (мс):', ts), { once: true });

// Точечный teardown — off-хендлы; frame.cancelAll() снял бы подписки ВСЕХ
// потребителей разделяемого синглтона.
offRead();
offRender();
```

### asRequestFrame: MotionValue и драйвер на одном кадре

```typescript
import { MotionValue } from '@labpics/motion';
import { asRequestFrame } from '@labpics/motion/frame';
import { createDriver } from '@labpics/motion/driver';

const el = document.querySelector('.fade') as HTMLElement;
const requestFrame = asRequestFrame(); // дефолт — общий синглтон frame

// Оба потребителя тикают в фазе update ОДНОГО rAF — не два цикла.
const opacity = new MotionValue({
  initial: 0,
  spring: { mass: 1, stiffness: 170, damping: 26 },
  requestFrame,
});
opacity.onChange((v) => { el.style.opacity = String(v); }); // эмит в фазе update
opacity.setTarget(1);

const slide = createDriver({
  from: -40,
  to: 0,
  spring: { mass: 1, stiffness: 170, damping: 26 },
  requestFrame,
  onStep: (y) => { el.style.transform = `translateY(${y}px)`; },
});

await slide;
opacity.destroy();
```
