# ./decay — инерционное затухание

> Роль: справка — публичный API экспорт-субпутя `./decay`: headless-генератор экспоненциального инерционного затухания `createDecay` (momentum после release жеста) с closed-form сэмплированием по виртуальному времени.

## Назначение

Субпуть `./decay` — чистый математический примитив «инерция после отпускания»: замкнутая форма экспоненциального затухания от начальной позиции и скорости (например, из отпущенного drag-жеста) к асимптотической точке покоя — класс `inertia`/`decay` Framer Motion и нативного scroll-momentum (UIScrollView / OverScroller).

Модуль **не ведёт frame loop**: `createDecay` возвращает модель, которую вызывающая сторона (drag-momentum, собственный rAF-цикл, тест) опрашивает по своему виртуальному времени `t` — инжектируемому шву, в **секундах с момента release**. Никаких `Date.now`/`Math.random`/DOM на пути вычисления.

Физическая модель (closed-form):

```text
amplitude   = power · velocity · timeConstant
value(t)    = from + amplitude · (1 − e^(−t/timeConstant))
velocity(t) = (amplitude / timeConstant) · e^(−t/timeConstant)
rest        = from + amplitude                    (value(t) при t → ∞)
```

`velocity(t)` — точная аналитическая производная `value(t)`; они никогда не аппроксимируются независимо, поэтому дифференциальный оракул «velocity против численной производной value» держится по построению.

В core-bundle субпуть не включён — попадает в бандл только при явном импорте (ESM subpath-tree-shaking). Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import { createDecay, type DecayOptions, type DecayModel } from '@labpics/motion/decay';
```

Класс ошибки экспортируется корневым субпутём:

```ts
import { MotionParamError } from '@labpics/motion';
```

## API

Все времена этого модуля — **секунды** (не миллисекунды): `timeConstant` и аргумент `t` методов модели. Скорости — units позиции в секунду (units/s).

### createDecay

```ts
function createDecay(options: DecayOptions): DecayModel;

interface DecayOptions {
  readonly from: number;                 // обязательна, конечная
  readonly velocity: number;             // units/s, обязательна, конечная
  readonly power?: number | undefined;        // безразмерный, по умолчанию 0.8
  readonly timeConstant?: number | undefined; // секунды, > 0, по умолчанию 0.35
  readonly restDelta?: number | undefined;    // units/s, ≥ 0, по умолчанию 0.5
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
}
```

| Опция | Единицы | Дефолт | Валидация |
| --- | --- | --- | --- |
| `from` | units позиции | — (обязательна) | не конечна → `MotionParamError('LM021')` |
| `velocity` | units/s | — (обязательна) | не конечна → `MotionParamError('LM022')` |
| `power` | безразмерный множитель скорости | `0.8` | не конечна → молча дефолт |
| `timeConstant` | секунды | `0.35` | не конечна или `≤ 0` → молча дефолт |
| `restDelta` | units/s (абсолютный порог) | `0.5` | не конечна или `< 0` → молча дефолт |
| `matchMedia` | — | `undefined` | не функция или бросил → трактуется как `reduced = false` |

Граница валидации двухуровневая: обязательные `from`/`velocity` проверяются жёстко (ранний `MotionParamError`), опциональные knobs деградируют мягко — невалидное значение молча заменяется дефолтом, без ошибки.

- `power` определяет итоговую пройденную дистанцию (`amplitude = power · velocity · timeConstant`); любое конечное значение легально, включая `0` и отрицательные.
- `matchMedia` — инжектируемый шов reduced-motion. В браузере передайте `window.matchMedia.bind(window)`; `undefined` (SSR / нет предпочтений) означает `reduced = false`. Предпочтение снимается **один раз при создании модели** — смена системной настройки в полёте не подхватывается.

Бросает: `LM021` (`from` не конечна), `LM022` (`velocity` не конечна). Полный каталог с лечением — [docs/errors.md](../errors.md).

### DecayModel (возврат createDecay)

```ts
interface DecayModel {
  readonly rest: number;
  readonly reduced: boolean;
  valueAt(t: number): number;
  velocityAt(t: number): number;
  isSettledAt(t: number): boolean;
}
```

- `rest` — асимптотическая точка покоя (`from + amplitude`, значение при `t → ∞`). Всегда конечна: при overflow (`velocity`/`from` около `±Number.MAX_VALUE`) амплитуда и `rest` зажимаются к ближайшей конечной границе double с сохранением знака направления движения.
- `reduced` — `true`, если сработал reduced-motion CHARACTER-switch (см. Контракты).
- `valueAt(t)` — позиция при виртуальном времени `t` (секунды с момента release). Клампинг входа: `t < 0 → 0` (движение ещё не началось), `NaN → 0`, `t = ∞ → rest`. Результат всегда конечен (неконечный промежуточный результат → `rest`).
- `velocityAt(t)` — скорость (units/s), точная аналитическая производная `valueAt`. Тот же клампинг входа (`t = ∞ → 0`); результат всегда конечен (fallback `0`).
- `isSettledAt(t)` — `true`, когда `|velocityAt(t)| ≤ restDelta` — движение практически завершено. При `amplitude === 0` (нулевая скорость или `power = 0`) — `true` для любого `t`.

При `reduced = true` модель снэпнута на точку покоя: `valueAt` всегда возвращает `rest`, `velocityAt` — `0`, `isSettledAt` — `true`, независимо от `t`.

Методы не бросают: вся валидация — в конструкторе; сэмпл — чистая арифметика без аллокаций и повторной валидации.

### Type-only экспорты

`DecayOptions`, `DecayModel`.

## Контракты

- **SSR-safe.** Нет обращений к глобалам ни на верхнем уровне модуля, ни на пути вычисления: `matchMedia` инжектируется, `undefined` — легальный SSR-вход. Модель создаётся и сэмплируется на сервере и в воркере.
- **Headless.** Модуль не запускает frame loop и не пишет в DOM; виртуальное время `t` ведёт вызывающая сторона.
- **Детерминизм.** Нет `Date.now`/`Math.random`; одинаковый вход и одинаковый шов времени → бит-в-бит одинаковый вывод.
- **Финитность (CSS-safe).** `rest`, `valueAt`, `velocityAt` всегда конечны — никогда `NaN`/`Infinity`, включая overflow-края (`velocity`/`from` около `±Number.MAX_VALUE`): амплитуда зажимается к `±Number.MAX_VALUE` с сохранением знака.
- **Reduced-motion — CHARACTER-switch, не hard-off.** При `prefers-reduced-motion: reduce` (через инжектированный `matchMedia`) модель немедленно снэпается на вычисленную точку покоя `rest`: результат жеста сохраняется, исчезает только движение. Детекция — один снимок в `createDecay`.
- **Единицы.** `t` и `timeConstant` — секунды; `velocity`, `restDelta` и `velocityAt` — units/s; `power` безразмерен.
- **Ошибки.** Единственный бросаемый тип — `MotionParamError` с полем `code` (`LM021`, `LM022`); каталог — [docs/errors.md](../errors.md).
- **Zero-deps.** Внешних runtime-зависимостей нет.

## Примеры

Drag-momentum: release-скорость → собственный rAF-цикл:

```ts
import { createDecay } from '@labpics/motion/decay';

const el = document.querySelector('.panel') as HTMLElement;

// Скорость из отпущенного жеста (units/s — здесь px/s).
const model = createDecay({
  from: 120,
  velocity: -1800,
  matchMedia: window.matchMedia.bind(window), // reduced → мгновенный снап на model.rest
});

const start = performance.now();
function frame(now: number): void {
  const t = (now - start) / 1000; // виртуальное время — секунды с момента release
  el.style.transform = `translateX(${model.valueAt(t)}px)`;
  if (!model.isSettledAt(t)) {
    requestAnimationFrame(frame);
  } else {
    el.style.transform = `translateX(${model.rest}px)`; // финальный доснап на точку покоя
  }
}
requestAnimationFrame(frame);
```

Детерминированное headless-сэмплирование (SSR/воркер/тест) и граница ошибок:

```ts
import { MotionParamError } from '@labpics/motion';
import { createDecay, type DecayModel } from '@labpics/motion/decay';

let model: DecayModel;
try {
  model = createDecay({
    from: 0,
    velocity: 2400,     // units/s
    power: 0.6,
    timeConstant: 0.5,  // секунды
    restDelta: 1,       // units/s
    // matchMedia не передан: SSR — reduced = false
  });
} catch (e) {
  if (e instanceof MotionParamError) {
    // e.code: 'LM021' — from не конечна; 'LM022' — velocity не конечна
  }
  throw e;
}

// Нет DOM и часов — одинаковый t всегда даёт бит-в-бит одинаковый вывод.
for (const t of [0, 0.1, 0.25, 0.5, 1]) {
  console.log(t, model.valueAt(t), model.velocityAt(t), model.isSettledAt(t));
}
console.log('rest:', model.rest); // from + power·velocity·timeConstant = 720
```
