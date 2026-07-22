# ./smart — умные переходы

> Роль: справка — публичный API экспорт-субпутя `./smart`: Figma-подобный smart-animate (`captureSmart`, `smartTransition`, `resolveSmartTier`, `SMART_KEY_ATTR`) — два снимка дерева по строковому identity-ключу, диф matched/entered/exited/skipped и оркестрация перехода поверх одного projection-движка.

## Назначение

`./projection` даёт честный вложенный FLIP набора элементов, но требует от потребителя вручную собрать этот набор и знать «что во что превратилось». `./smart` закрывает ровно этот разрыв: **два снимка дерева** по строковому identity-ключу (атрибут `data-motion-key`), диф → matched / entered / exited / skipped, и оркестрация поверх **одного** projection-движка:

- **matched** → FLIP через `createProjection`; id узла = строка-ключ, поэтому continuity переживает **пересоздание DOM-узла**: перехват повторным capture/animate берёт аналитический visual box `V(p̂)` и пересеивает скорость (C¹ — у драйвера projection; здесь только бухгалтерия «в какой элемент писать кадр»).
- **entered** → fade-in (`opacity` 0→1, **без** transform).
- **exited** → ghost-протокол: узел реинсертится в root `position: absolute` на прежних page-координатах (padding-box), фейд 1→0, `removeChild` **до** резолва `finished` (терминальное действие раньше уведомлений).
- Единый clock/пружина на весь переход — дерево едет одним жестом.

Осознанно вне скоупа: нативный View Transitions API (`SmartTier` без `'view-transitions'`), авто-детект мутаций (`MutationObserver`), live-подписка на смену reduced-motion в полёте, closed shadow roots, вложенные scroll-контейнеры (только window-scroll page-space — наследуется от `./projection`).

Инварианты модуля (закреплены в JSDoc и коде):

- **P1. CSS-safe.** Каждое число кадра конечно, `-0` схлопнут; координаты ghost'а проходят страж конечности (`NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE`).
- **P2. SSR-safe.** DOM трогается только в момент вызова; на пути импорта ни DOM, ни `window`. Не-элемент в качестве root → инертный capture/handle.
- **P3. Детерминизм.** Время — только из инжектируемого `requestFrame` (`ts` кадра в **миллисекундах**); ни wall-clock, ни `Math.random`.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Субпуть tree-shakeable — в корневой бандл не входит.

## Импорт

```ts
import {
  captureSmart,
  smartTransition,
  resolveSmartTier,
  SMART_KEY_ATTR,
  type SmartTier,
  type SmartPlan,
  type SmartHandle,
  type SmartCapture,
  type SmartElement,
  type SmartRoot,
  type SmartOptions,
} from '@labpics/motion/smart';
```

## API

### SMART_KEY_ATTR

```ts
const SMART_KEY_ATTR = 'data-motion-key';
```

DX-константа: имя атрибута identity-ключа по умолчанию. Ключ — непустая строка; matched-континуальность привязана к строке-ключу, не к DOM-узлу.

### resolveSmartTier

```ts
type SmartTier = 'projection' | 'reduced' | 'ssr';

function resolveSmartTier(inputs?: Record<string, unknown>): SmartTier;
```

Резолвит tier перехода по среде. **Чистая функция** — путь можно выбрать заранее, без побочных эффектов. Прецеденс:

1. `'reduced'` — `inputs.matchMedia` (функция вида `window.matchMedia`) сообщает `prefers-reduced-motion: reduce`;
2. `'projection'` — `inputs.requestFrame` является функцией **или** `inputs.documentLike` не `undefined`/`null` (признак document-подобной среды);
3. иначе `'ssr'`.

Не функция / бросающий `matchMedia` трактуется как «нет предпочтения». Бросает: ничего.

### captureSmart

```ts
interface SmartCapture {
  animate(): SmartHandle;
  readonly size: number;
}

function captureSmart(root: unknown, options?: SmartOptions): SmartCapture;
```

FIRST-снимок дерева `root` по ключу: структура (document order, nearest keyed-предок) + page-геометрия и `border-radius` каждого keyed-узла. Возвращает `SmartCapture`, чей `animate()` строит второй снимок, дифает и проигрывает переход. `size` — число keyed-узлов в снимке.

Порядок работы:

- Валидация опций — **fail-fast, до проверки среды и даже под reduced-motion**: `keyAttr` (LM085), `epsilon` (LM086), `spring` через `validateSpringParams` (LM088–LM091).
- Не-элемент `root` (нет `getBoundingClientRect`) / SSR → инертный capture: `size = 0`, `animate()` возвращает инертный handle с `tier: 'ssr'`, пустым планом и уже разрешённым `finished`.
- Обход: light DOM + **открытые** shadow roots (при `shadow` ≠ `false`); keyless-обёртки прозрачны; ghost-элементы адаптера пропускаются целиком. Дубликат ключа → ранний `MotionParamError` **LM084**.
- Узлы активного полёта **не меряются** из DOM под transform — берётся аналитический `boxAt` движка (ноль DOM-чтений, граница capture честная mid-flight).

#### SmartOptions

```ts
interface SmartOptions {
  keyAttr?: string;              // дефолт SMART_KEY_ATTR ('data-motion-key')
  epsilon?: number;              // px; дефолт 0.01
  spring?: SpringParams;         // дефолт { mass: 1, stiffness: 200, damping: 24 }
  shadow?: boolean;              // дефолт true
  radius?: boolean;              // дефолт true
  respectReducedMotion?: boolean; // дефолт true
  requestFrame?: (cb: (ts?: number) => void) => number; // ts в мс
  matchMedia?: (query: string) => { matches: boolean };
  getScroll?: () => { x: number; y: number };
  getComputedStyle?: (el: unknown) => { getPropertyValue(n: string): string };
  clamp?: boolean;               // дефолт false (наследуется от ./projection)
  documentLike?: unknown;        // только для resolveSmartTier
}
```

- `keyAttr` — имя атрибута identity-ключа. Не строка или пустая строка → `LM085`.
- `epsilon` — порог «узел двигался» в **px**, по каждому каналу бокса (`x`/`y`/`width`/`height`) и по углам радиуса. Дефолт `0.01`. Нефинитный или отрицательный → `LM086`.
- `spring` — единая пружина перехода, `SpringParams` (`{ mass, stiffness, damping }`, тип из корня `@labpics/motion`; конструкторы параметризаций — [./spring](./spring.md)). Дефолт наследуется от `./projection`: `{ mass: 1, stiffness: 200, damping: 24 }`. Невалидная → `MotionParamError` **в фабрике** (`LM088`–`LM091`), даже под reduced-motion.
- `shadow` — обходить открытые shadow roots (composed-обход). Дефолт `true`. Closed — вне скоупа (пусто).
- `radius` — читать и анимировать `border-radius` (computed longhand'ы; требует `getComputedStyle`). Дефолт `true`.
- `respectReducedMotion` — уважать `prefers-reduced-motion`. Дефолт `true`; `false` — полный projection-путь и под reduce.
- `requestFrame` — инжектируемый кадровый шов (`(cb) => requestAnimationFrame(cb)` в браузере); `ts` колбэка — **миллисекунды** (P3). Без шва полёт завершается синхронно и детерминированно (SSR/тесты).
- `matchMedia` — инжектируемый детект `prefers-reduced-motion: reduce`. Резолвится **в `./smart`** (character-switch, см. Контракты) — драйверу projection не передаётся.
- `getScroll` — скролл page-пространства (боксы = `getBoundingClientRect` + scroll). Дефолт `() => ({ x: 0, y: 0 })`; не-число/нефинит санитайзится в `0`.
- `getComputedStyle` — computed-стили: чтение радиусов и детект `position: static` у root (якорение ghost'а). Без него радиусы не анимируются, static-root не переводится в `relative`.
- `clamp` — прокидывается в projection-движок. Дефолт `false` — честный overshoot пружины; публичный `progress` клампится в `[0, 1]` всегда.
- `documentLike` — используется **только** `resolveSmartTier`; сами `captureSmart`/`smartTransition` его игнорируют.

Реестр контроллеров — по `root` (WeakMap): повторный `captureSmart` на том же root **mid-flight** переиспользует живой движок (перехват): `spring`/`clamp`/`requestFrame` принадлежат живому прогону и не переключаются (иначе рвётся continuity), а per-capture опции `getScroll`/`getComputedStyle`/`radius` реконсилируются значениями текущего вызова. В покое контроллер пересобирается — **все** опции текущего вызова в силе.

#### animate(): диф и классификация

`animate()` строит второй снимок (batch: clear наших инлайнов → один замер → старт) и классифицирует ключи в `SmartPlan`:

```ts
interface SmartPlan {
  readonly matched: readonly string[];
  readonly entered: readonly string[];
  readonly exited: readonly string[];
  readonly skipped: readonly string[];
}
```

- **matched** — ключ в обоих снимках (в т.ч. на **другом** DOM-узле — пересоздание); едет FLIP-ом, если сдвинулся сам больше `epsilon` **или** движется его ближайший matched-предок (вложенная проекция; `transform-origin: '0 0'` на полёт ставит и восстанавливает сам `./smart`). Реинкарнация (ключ вернулся при живом ghost) — тоже matched: ghost физически снимается до старта, узел стартует от его состояния с `opacity` 0→1.
- **entered** — ключа не было при capture, либо его first-бокс был вырожденным (0×0, `display: none`): FLIP-«откуда» нет → fade-in на новом месте.
- **exited** — ключ был, теперь его нет, и старый узел отсоединён (`isConnected` ≠ `true`) → ghost-протокол. Continue-exit: живой ghost при по-прежнему отсутствующем ключе продолжает аналитический фейд без прыжка.
- **skipped** — вырожденный новый бокс (нефинитный или сторона ≤ `1e-6`), либо узел уехал в чужой контейнер (`isConnected === true` вне root — не «красть» чужое): ноль записей в такие узлы.

Пустой диф → мгновенно разрешённый инертный handle (ноль кадров, ноль записей), `tier` и `plan` честные. Дубликат ключа во **втором** снимке → `LM084` из `animate()`.

Записи в полёте: matched — `transform` (+ `border-radius` при радиусах), enter/exit — только `opacity`; matched-реинкарнация — ещё и `opacity`. На терминале инлайны восстанавливаются (снятое — снимается, бывшее — возвращается), ghost'ы удаляются, `position` root'а (если переводился в `relative`) возвращается.

#### SmartHandle

```ts
interface SmartHandle {
  readonly finished: Promise<void>;
  cancel(): void;
  readonly playing: boolean;
  readonly progress: number; // [0, 1]; 1 — терминал
  readonly tier: SmartTier;
  readonly plan: SmartPlan;
}
```

- `finished` — резолвится на natural rest, `cancel()` **и** при перехвате новым прогоном (superseded). Никогда не reject'ится. Уборка DOM (в т.ч. `removeChild` ghost'ов) — **до** резолва.
- `cancel()` — идемпотентен: cancel движка + терминальная уборка; на инертном/завершённом — no-op.
- `playing` — `true` только у активного прогона; `progress` после терминала — `1`.
- `tier` — эффективный tier прогона: `'reduced'` (reduce и `respectReducedMotion` ≠ `false`) либо `'projection'`; у инертного SSR-handle — `'ssr'`.

Бросает `captureSmart`: `MotionParamError` — `LM084` (дубликат ключа), `LM085` (keyAttr), `LM086` (epsilon), `LM088`–`LM091` (пружина, из `validateSpringParams`). Свод кодов — [docs/errors.md](../errors.md). Всё остальное forgiving: враждебный `getBoundingClientRect`/`getAttribute`/style не бросает наружу (вырожденный бокс → skipped, тихие деградации).

### smartTransition

```ts
function smartTransition(
  root: unknown,
  mutate: () => void | Promise<void>,
  options?: SmartOptions,
): SmartHandle;
```

Полный цикл одним вызовом: `captureSmart(root, options)` → `mutate()` → `animate()`.

- `mutate` не функция → `MotionParamError` **LM087** (до capture).
- Синхронный `mutate` → переход стартует сразу; возврат — handle реального прогона.
- Promise-`mutate` → синхронно возвращается фасад-handle, переход подвязывается **после** разрешения промиса. До подвязки: `playing = false`, `progress = 0`, `plan` пуст, `tier` — эффективный tier среды (или `'ssr'` для не-элемента). Ошибка `mutate` не подвешивает `finished` (резолв без анимации); `cancel()` до разрешения — анимация не стартует, `finished` резолвится.

Бросает: `LM087` плюс всё, что бросает `captureSmart` (валидация — fail-fast, до вызова `mutate`).

### Type-only экспорты

- `SmartTier` — `'projection' | 'reduced' | 'ssr'`.
- `SmartPlan` — итог дифа: `matched` / `entered` / `exited` / `skipped` (массивы ключей).
- `SmartHandle` — handle перехода (`finished`, `cancel`, `playing`, `progress`, `tier`, `plan`).
- `SmartCapture` — результат `captureSmart` (`animate()`, `size`).
- `SmartElement` — duck-typed минимум DOM-элемента (`getAttribute`, `getBoundingClientRect`, `style`, опц. `isConnected`) — node-тесты на фейках без jsdom.
- `SmartRoot` — `SmartElement` + `appendChild`/`removeChild` (+ опц. `clientLeft`/`clientTop`) — root перехода и якорь ghost'ов.
- `SmartOptions` — опции обоих фасадов (см. выше).

Тип `SpringParams` экспортируется из корня `@labpics/motion` и субпутя [./spring](./spring.md).

## Контракты

- **SSR-safe (P2).** Ни DOM, ни `window` на пути импорта; все платформенные швы (`requestFrame`, `matchMedia`, `getScroll`, `getComputedStyle`) инжектируются. Не-элемент root → инертный capture/handle (`tier: 'ssr'`, `finished` уже разрешён). `resolveSmartTier` — чистая функция.
- **Reduced-motion — переключение характера, не hard-off.** Резолвится в `./smart` (драйверу `matchMedia` не передаётся): matched **снапаются** (ноль transform-записей, но в `plan.matched` остаются — жизненный цикл потребителя не ломается), а enter/exit-фейды остаются **живыми** (`opacity` анимируется). Валидация параметров бросает и под reduce (в фабрике, до любых эффектов).
- **Финитность (P1).** Каждое число кадра конечно, `-0` схлопнут (держит projection); координаты/размеры ghost'а проходят страж `NaN → 0`, `±Infinity → ±Number.MAX_VALUE` — `NaNpx` в CSS не эмитится ни при каком IEEE-754 входе. Вырожденная геометрия классифицируется в skipped, не бросается.
- **Детерминизм (P3).** Время — только из инжектируемого `requestFrame` (`ts` в мс); идентичная последовательность `ts` → идентичная последовательность кадров. Без шва — синхронное детерминированное завершение.
- **Continuity по строке-ключу.** Identity — ключ, не DOM-узел: пересоздание узла с тем же ключом не рвёт полёт; перехват mid-flight берёт аналитический `V(p̂)` (ноль DOM-чтений под нашим transform) и пересеивает скорость (C¹ у драйвера projection).
- **Терминальный порядок.** Уборка DOM — `removeChild` ghost'ов, восстановление инлайн-стилей узлов и `position` root'а — происходит **до** резолва `finished`; `finished` никогда не reject'ится (включая ошибку async-`mutate`).
- **Fail-fast на входе, forgiving в рантайме.** Дубликат ключа (`LM084`), невалидные `keyAttr`/`epsilon`/`spring`/`mutate` — ранний `MotionParamError`; враждебное DOM-состояние в полёте — тихие деградации без бросков.

## Примеры

Полный цикл одним вызовом — синхронная мутация DOM, FLIP + фейды по плану:

```ts
import { smartTransition } from '@labpics/motion/smart';

const root = document.querySelector('#list') as HTMLElement;

const handle = smartTransition(
  root,
  () => {
    // Любая синхронная мутация keyed-дерева: перестановка/удаление/вставка.
    const first = root.firstElementChild;
    if (first !== null) root.appendChild(first); // узел уехал в конец списка
  },
  {
    requestFrame: (cb) => requestAnimationFrame(cb),
    matchMedia: window.matchMedia.bind(window), // reduced: matched снап, фейды живые
    getScroll: () => ({ x: window.scrollX, y: window.scrollY }),
    getComputedStyle: (el) => getComputedStyle(el as Element),
  },
);

void handle.finished.then(() => {
  console.log(handle.tier, 'ехали:', handle.plan.matched);
});
```

Двухфазный `captureSmart` — снимок, произвольная мутация между снимками, ghost-протокол ушедшего узла:

```ts
import { captureSmart, SMART_KEY_ATTR } from '@labpics/motion/smart';

const root = document.querySelector('#board') as HTMLElement;

const cap = captureSmart(root, {
  spring: { mass: 1, stiffness: 300, damping: 26 },
  epsilon: 0.5, // px: сдвиги мельче полупикселя — не «движение»
  requestFrame: (cb) => requestAnimationFrame(cb),
  matchMedia: window.matchMedia.bind(window),
  getScroll: () => ({ x: window.scrollX, y: window.scrollY }),
  getComputedStyle: (el) => getComputedStyle(el as Element),
});
console.log(`keyed-узлов в снимке: ${cap.size}`);

// Мутация между снимками; continuity привязана к строке-ключу, не к узлу —
// пересоздание элемента с тем же data-motion-key останется matched.
root.querySelector(`[${SMART_KEY_ATTR}="card-b"]`)?.remove();

const handle = cap.animate();
void handle.finished.then(() => {
  console.log('ушли ghost-фейдом:', handle.plan.exited); // ['card-b']
});
```

Выбор пути заранее (`resolveSmartTier`) и async-`mutate` — переход подвязывается после `await`:

```ts
import { resolveSmartTier, smartTransition, type SmartTier } from '@labpics/motion/smart';

const tier: SmartTier = resolveSmartTier({
  matchMedia: typeof window !== 'undefined' ? window.matchMedia.bind(window) : undefined,
  documentLike: typeof document !== 'undefined' ? document : undefined,
});

if (tier !== 'ssr') {
  const root = document.querySelector('#feed') as HTMLElement;
  const handle = smartTransition(
    root,
    async () => {
      const res = await fetch('/api/feed');
      root.innerHTML = await res.text(); // переход стартует ПОСЛЕ await
    },
    {
      requestFrame: (cb) => requestAnimationFrame(cb),
      matchMedia: window.matchMedia.bind(window),
      getScroll: () => ({ x: window.scrollX, y: window.scrollY }),
      getComputedStyle: (el) => getComputedStyle(el as Element),
    },
  );
  void handle.finished.then(() => {
    console.log('план перехода:', handle.plan);
  });
}
```
