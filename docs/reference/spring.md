# ./spring — точная пружина: параметры, конструкторы, easing

> Роль: справка — публичный API экспорт-субпутя `./spring`: эргономичные конструкторы `SpringParams` (`fromBounce`, `fromVisualDuration`, `fromPeak`, `fromOscillation`), канонические пресеты и пружина как C¹-конечная easing-функция.

## Назначение

Субпуть `./spring` — слой эргономики поверх физического ядра `{mass, stiffness, damping}` (чистый солвер `spring()` из корневого субпутя). Он решает две задачи:

1. **Интуитивные параметризации** — построить `SpringParams` из перцептивных координат: `duration + bounce` (канон SwiftUI `Spring(duration:bounce:)`) и `visualDuration + bounce` (класс Motion), из наблюдаемых координат: `overshoot + peakTime` и `period + halfLife` (observable-конструкторы, #230), плюс замороженные пресеты канона react-spring.
2. **Пружина как easing** — спроецировать пружину на нормализованное время `t ∈ [0, 1] → value` для потребителей формы `(t: number) => number` (easing-слоты keyframes/tween).

Модуль — чистая математика: zero-DOM, zero-deps, детерминизм, ранний `MotionParamError`. Ключевой закон слоя — **точность конструкторов (#218)**: `fromBounce`/`fromVisualDuration` возвращают точное математическое преобразование запрошенных координат, без скрытой коэрсии под бюджет какого-либо исполнителя. Представимость у конкретного исполнителя — граница самого исполнителя (см. «validateSpringPhysics vs validateSpringParams»).

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  fromBounce,
  fromVisualDuration,
  fromPeak,
  fromOscillation,
  springPresets,
  springAsEasing,
  type FromBounceOptions,
  type FromVisualDurationOptions,
  type FromPeakOptions,
  type FromOscillationOptions,
} from '@labpics/motion/spring';
```

Тип `SpringParams` (и `SpringResult`, солвер `spring()`, валидаторы) экспортируются корневым субпутём:

```ts
import {
  spring,
  validateSpringPhysics,
  validateSpringParams,
  MotionParamError,
  type SpringParams,
  type SpringResult,
} from '@labpics/motion';
```

## API

Все времена в этом модуле — **секунды** (не миллисекунды): `duration`, `visualDuration`, `peakTime`, `period`, `halfLife`, аргумент `t` солвера `spring()`. `SpringResult.velocity` — нормализованные единицы позиции в секунду.

### fromBounce

```ts
function fromBounce(options: FromBounceOptions): SpringParams;

interface FromBounceOptions {
  readonly duration: number;          // секунды, > 0
  readonly bounce: number;            // ∈ [−1, 1]
  readonly mass?: number | undefined; // по умолчанию 1
}
```

Пружина из перцептивной длительности и упругости — канон SwiftUI `Spring(duration:bounce:)`. Точное преобразование (#218):

```text
ζ  = 1 − bounce
ω₀ = 2π / duration
stiffness = mass · ω₀²
damping   = 2 · mass · ζ · ω₀
```

- `bounce ∈ [−1, 1]` — точный диапазон SwiftUI: `0` — критическое демпфирование, `> 0` — упругая (underdamped), `< 0` — пере-демпфированная «плоская». Motion принимает подмножество `[0, 1]`, поэтому любой Motion-вход валиден и здесь.
- `bounce = 1` честно означает `ζ = 0` ⇒ `damping = 0` (незатухающая) — без подмены.
- `mass`: любое не-число, неконечное или `≤ 0` значение тихо заменяется на `1` (это дефолт, не ошибка).
- Выход проверяется физической границей (`validateSpringPhysics`): экстремальные `duration`, у которых точное преобразование непредставимо конечным положительным double (underflow/overflow `stiffness` или `damping`), — честная ошибка входа, не тихая подмена.

Бросает: `LM093` (`duration` не конечное или `≤ 0`), `LM092` (`bounce` не конечное или вне `[−1, 1]`); транзитом из проверки результата — `LM088`/`LM089`/`LM090`.

### fromVisualDuration

```ts
function fromVisualDuration(options: FromVisualDurationOptions): SpringParams;

interface FromVisualDurationOptions {
  readonly visualDuration: number;    // секунды, > 0
  readonly bounce: number;            // ∈ [−1, 1]
  readonly mass?: number | undefined; // по умолчанию 1
}
```

Пружина, у которой время **первого визуального касания цели** равно `visualDuration` (класс Motion). Точное преобразование (#218), `ζ = 1 − bounce`:

- `ζ < 1` — решается точно из первого пересечения `x(t) = 1`:

  ```
  ω₀ = (π − atan(√(1−ζ²)/ζ)) / (√(1−ζ²) · Tv)
  ```

  `ζ = 0` включён: `atan(∞) = π/2` ⇒ `ω₀ = π/(2·Tv)` — точное касание незатухающей `x = 1 − cos(ω₀t)`.
- `ζ ≥ 1` — пересечения нет; `Tv` трактуется как выход на ~99% цели по медленнейшей моде: `ω₀ = ln(100) · (ζ + √(ζ²−1)) / Tv` (стабильная форма медленного корня без катастрофического вычитания, #226).

Именованный контракт API: `Tv` — время, `bounce` — характер; ни одна из запрошенных координат не подменяется под бюджет исполнителя. Инвариант «первое касание совпадает с аналитическим решением для возвращённых параметров» держится всегда. `mass` — как у `fromBounce` (дефолт `1`).

Бросает: `LM093` (`visualDuration`), `LM092` (`bounce`); транзитом — `LM088`/`LM089`/`LM090`.

### fromPeak

```ts
function fromPeak(options: FromPeakOptions): SpringParams;

interface FromPeakOptions {
  readonly overshoot: number;         // ∈ (0, 1]
  readonly peakTime: number;          // секунды, > 0
  readonly mass?: number | undefined; // по умолчанию 1
}
```

Пружина из **наблюдаемого** первого перелёта и времени пика (observable-конструктор, #230). Точное обратное преобразование underdamped-системы из покоя, не пресет:

```text
L  = −ln(overshoot)
ζ  = L / √(π² + L²)
ω₀ = √(π² + L²) / peakTime
stiffness = mass · (π² + L²) / peakTime²
damping   = 2 · mass · L / peakTime
```

— один `log`, ноль итераций.

- `overshoot ∈ (0, 1]` — доля первого перелёта относительно амплитуды. `overshoot = 1` честно означает `ζ = 0` ⇒ `damping = 0` (незатухающая, пик ровно `2 − from`).
- `overshoot = 0` **не** имеет underdamped-прообраза (критический предел) и отклоняется `LM171` без epsilon-подмены — «без перелёта» описывается `fromBounce({bounce: 0})` или `fromVisualDuration`.
- `mass` — как у `fromBounce` (невалидная масса тихо заменяется на `1`).
- Выход проверяется физической границей (`validateSpringPhysics`), как у остальных конструкторов.

Бросает: `LM171` (`overshoot` не конечное или вне `(0, 1]`), `LM093` (`peakTime` не конечное или `≤ 0`); транзитом из проверки результата — `LM088`/`LM089`/`LM090`.

### fromOscillation

```ts
function fromOscillation(options: FromOscillationOptions): SpringParams;

interface FromOscillationOptions {
  readonly period: number;            // секунды, > 0
  readonly halfLife: number;          // секунды, > 0
  readonly mass?: number | undefined; // по умолчанию 1
}
```

Пружина из **наблюдаемого** периода затухающих колебаний и half-life огибающей (амплитуда падает вдвое) — observable-конструктор (#230). Комплексные полюса `p = −α ± iβ`:

```text
α = ln 2 / halfLife
β = 2π / period
stiffness = mass · (α² + β²)
damping   = 2 · mass · α
```

- Результат **всегда** underdamped (`β > 0` ⇒ `ζ < 1`), точно.
- «`period = ∞`» не является скрытой критической ветвью — конечность входа обязательна.
- `mass` — как у `fromBounce` (дефолт `1`).
- Выход проверяется физической границей (`validateSpringPhysics`).

Бросает: `LM093` (`period` или `halfLife` не конечное или `≤ 0`); транзитом из проверки результата — `LM088`/`LM089`/`LM090`.

### springPresets

```ts
const springPresets: Readonly<Record<
  'default' | 'gentle' | 'wobbly' | 'stiff' | 'slow' | 'molasses',
  SpringParams
>>;
```

Канонические пресеты react-spring (tension/friction при `mass = 1`). Объект и каждый пресет заморожены (`Object.freeze`) — пин контракта:

| Пресет | mass | stiffness | damping |
| --- | --- | --- | --- |
| `default` | 1 | 170 | 26 |
| `gentle` | 1 | 120 | 14 |
| `wobbly` | 1 | 180 | 12 |
| `stiff` | 1 | 210 | 20 |
| `slow` | 1 | 280 | 60 |
| `molasses` | 1 | 280 | 120 |

Не бросает.

### springAsEasing

```ts
function springAsEasing(params: SpringParams): (t: number) => number;
```

Пружина как easing-функция нормализованного времени `t ∈ [0, 1] → value` (форма OVERSHOOTING при `ζ < 1`). Шкала: `t = 1` — конечный горизонт, выведенный из параметров: наименьший безразмерный горизонт `U = ω₀·T`, при котором замкнутая огибающая решения укладывается в settle-допуск пакета (#219). Горизонт зависит только от `ζ`, поэтому scale-equivalent тройки `(m, k, c)` дают одну и ту же кривую.

**C¹-конечность (#219).** Хвост запечатан C¹ Hermite-коррекцией `g = f + (1−f₁)(3t²−2t³) − s₁(t³−t²)`, поэтому:

```text
g(0) = 0,  g′(0) = 0,  g(1) = 1,  g′(1) = 0
```

— без endpoint-прыжка старой шкалы, и `|g − f| ≤ |1−f₁| + (4/27)|s₁| ≤ допуска`. Эндпоинты точны (дисциплина NE2).

Поведение возвращённой функции:

- вход клампится: `t ≤ 0 → 0`, `t ≥ 1 → 1`; `NaN → 0` (дисциплина NE1/NE2);
- выход всегда конечен (неконечный промежуточный результат → `1`);
- валидация и горизонт считаются один раз в конструкторе; сэмпл — один вызов внутреннего солвера, без повторной валидации и аллокаций;
- поиск горизонта — детерминированная брекет-бисекция по монотонно затухающей огибающей, без wall-clock.

Бросает (в конструкторе, не в сэмпле): `LM088`/`LM089`/`LM090` (физика), `LM167` — `ζ = 0` (`damping = 0`; отрицательный `damping` отвергнут раньше физикой с `LM090`): незатухающая пружина не имеет конечного easing-горизонта; конечная проекция на `[0, 1]` существует только у затухающей системы — это граница именно этого исполнителя (#218). Лечение: `damping > 0` либо живой исполнитель (`drive`/`MotionValue`).

### validateSpringPhysics vs validateSpringParams

Оба валидатора экспортируются **корневым субпутём** `@labpics/motion` (не `./spring`), но именно их разграничение определяет контракт конструкторов этого субпутя (#218):

| | `validateSpringPhysics(p)` | `validateSpringParams(p)` |
| --- | --- | --- |
| Граница | Физический домен: конечные `mass > 0`, `stiffness > 0`, `damping ≥ 0` — и ничего больше | Физика **плюс** бюджет автономного frame-loop-исполнителя |
| Легальны | Сколь угодно медленные и незатухающие (`ζ = 0`) системы | Только пружины, чья аналитическая верхняя граница времени оседания помещается в бюджет кадра-капа (`MAX_FRAMES · FIXED_DT_S`, ≈33.3 с) |
| Бросает | `LM088` (mass), `LM089` (stiffness), `LM090` (damping) | То же + `LM091` (время оседания превышает бюджет) |
| Кто применяет | Чистый `spring()`; конструкторы `fromBounce`/`fromVisualDuration`/`fromPeak`/`fromOscillation` (проверка представимости результата); `springAsEasing` | Автономные frame-loop-исполнители (`drive`, `MotionValue`, фасад) — на своей стороне, до Promise и до первого кадра |

Следствие: `fromBounce({duration, bounce: 1})` — валидный выход этого субпутя (`damping = 0`), пригодный для чистого сэмплирования и compositor-плана, но `validateSpringParams` у живого исполнителя честно отвергнет его с `LM091`, а `springAsEasing` — с `LM167`.

### Type-only экспорты

`FromBounceOptions`, `FromVisualDurationOptions`, `FromPeakOptions`, `FromOscillationOptions`. Тип `SpringParams` в сигнатурах импортируйте из корня `@labpics/motion`.

## Контракты

- **SSR-safe / zero-DOM.** Модуль не трогает DOM, `window`, часы и глобальное состояние — безопасен на сервере и в воркерах.
- **Детерминизм.** Идентичный вход → идентичный выход; поиск easing-горизонта — детерминированная бисекция, wall-clock не используется.
- **Финитность.** Функция из `springAsEasing` всегда возвращает конечное число (`NaN` на входе → `0`, неконечный результат → `1`); конструкторы либо возвращают конечные положительные `SpringParams`, либо бросают `MotionParamError` рано.
- **Точность (#218).** `fromBounce`/`fromVisualDuration` — точные математические преобразования без коэрсии под чей-либо бюджет; границы представимости проверяются честной ошибкой, не подменой параметров.
- **Единицы.** Все длительности — секунды; `bounce` и `t` easing-функции безразмерны.
- **Reduced-motion.** Этот слой — чистая математика и `prefers-reduced-motion` не читает; уважение reduced-motion — контракт исполнителей (`drive` и выше).
- **Ошибки.** Все броски — `MotionParamError` с полем `code` (`LM088`–`LM093`, `LM167`, `LM171`); полный каталог с лечением — [docs/errors.md](../errors.md).

## Примеры

Конструктор + чистое сэмплирование:

```ts
import { spring, type SpringParams } from '@labpics/motion';
import { fromBounce } from '@labpics/motion/spring';

// SwiftUI-координаты: полсекунды перцептивной длительности, лёгкая упругость.
const params: SpringParams = fromBounce({ duration: 0.5, bounce: 0.3 });

// t — секунды; value нормализован (0 → 1), velocity — единицы позиции в секунду.
const { value, velocity } = spring(params, 0.25);
console.log(value, velocity);
```

Пружина как easing в собственном rAF-цикле:

```ts
import { springAsEasing, springPresets } from '@labpics/motion/spring';

const ease = springAsEasing(springPresets.wobbly); // C¹: ease(0)=0, ease(1)=1
const el = document.querySelector('.card') as HTMLElement;
const durationMs = 600; // шкала прогресса — забота вызывающего
const start = performance.now();

function frame(now: number): void {
  const t = Math.min((now - start) / durationMs, 1);
  el.style.transform = `translateX(${ease(t) * 240}px)`;
  if (t < 1) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

Граница исполнителя: точный конструктор vs бюджет frame-loop:

```ts
import { MotionParamError, validateSpringParams } from '@labpics/motion';
import { fromVisualDuration } from '@labpics/motion/spring';

// bounce = 1 ⇒ ζ = 0 ⇒ damping = 0 — точный и валидный выход конструктора.
const params = fromVisualDuration({ visualDuration: 0.4, bounce: 1 });

try {
  validateSpringParams(params); // граница автономного frame-loop-исполнителя
} catch (e) {
  if (e instanceof MotionParamError && e.code === 'LM091') {
    // Незатухающая пружина не осядет в бюджет кадра-капа:
    // для drive/MotionValue возьмите bounce < 1.
  }
}
```
