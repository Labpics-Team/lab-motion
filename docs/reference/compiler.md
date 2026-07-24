# ./compiler — build-time lowering: Vite-плагин и рантайм артефактов

> Роль: справка — публичный API экспорт-субпутей `./compiler/vite` (плагин `motionCompiler()`, понижающий статические nano-вызовы на этапе сборки) и `./compiler/runtime` (executor `animateCompiled` и формат артефакта `{f,d,e,y,g,r}`).

## Назначение

Build-time lowering (#208, эпик #220): статически доказуемый вызов `animate(target, props, options?)` из `./nano` компилируется **на этапе сборки** в готовый артефакт — кадр, длительность и каноническую CSS `linear()`-строку, — так что spring-солвер не попадает в бандл вовсе. В коде вызов заменяется на `animateCompiled(target, артефакт)` из `./compiler/runtime`; всё, что статически недоказуемо, — **консервативный отказ**: вызов остаётся обычным runtime-вызовом `./nano`, source семантически не меняется.

Слой устроен из трёх частей:

1. **`./compiler/vite`** — build-tool entry (не runtime-tier): Vite/Rollup-плагин `motionCompiler()`. Transform-hook парсит модуль штатным `this.parse` (acorn Rollup), передаёт ESTree parse-независимому ядру (§13.5) и применяет байтовые правки с точной sourcemap версии 3.
2. **`./compiler/runtime`** — private executor compiled-артефактов. Сюда попадают ТОЛЬКО вызовы, которые compiler доказанно понизил; исполнительный WAAPI-хвост намеренно дублирует `nano/index` байт-в-байт по семантике, паритет запечатан differential-сьютом (`pnpm acceptance:compiler`).
3. **MotionProgram V1** (внутренний контракт, не публичный экспорт) — каноническое представление-оракул: каждый артефакт обязан пройти V1-парсер и спроецироваться обратно бит-в-бит, иначе — ошибка сборки, не silent fallback.

Математика — общий SSOT с `./nano` (`springLinear`): build-сторона и runtime считают ровно один и тот же кадр, длительность и `linear()`-строку по построению. Характеристики размера — не в этой странице: снимок чисел даёт вывод `pnpm size`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
// build-time, в vite.config.ts:
import { motionCompiler, type MotionCompilerPlugin } from '@labpics/motion/compiler/vite';

// runtime артефактов — hoisted-импорт инъецирует сам компилятор;
// вручную нужен только типам и инструментам:
import {
  animateCompiled,
  type CompiledNanoCall,
  type NanoControls,
  type NanoTarget,
} from '@labpics/motion/compiler/runtime';
```

## API

Все времена в этом слое — **миллисекунды**: `d`, `y`, `g` артефакта и итоговый `delay` каждого элемента.

### motionCompiler

```ts
function motionCompiler(options?: MotionCompilerOptions): MotionCompilerPlugin;

interface MotionCompilerOptions {
  readonly strict?: boolean | undefined;
  readonly onBudget?: ((report: MotionBudgetReport) => void) | undefined;
}

interface MotionBudgetReport {
  readonly lowered: number;       // понижено вызовов за билд
  readonly runtimeCalls: number;  // осталось рантаймовых (включая @motion-runtime)
  readonly artifactChars: number; // суммарная длина инъецированных литералов
}

interface MotionCompilerPlugin {
  readonly name: string;    // 'lab-motion:nano-lowering'
  readonly enforce: 'pre';
  transform(code: string, id: string): { code: string; map: /* precise v3 */ object } | undefined;
  buildEnd(): void;
}
```

Контракт плагина намеренно структурный — типы `vite` в `d.ts` пакета не затягиваются. `enforce: 'pre'` — трансформ идёт до остальных плагинов.

- **`strict: true`** (#237) — любой непониженный nano-вызов останавливает сборку ошибкой с файлом, позицией `line:col` и причиной отказа (гарантия «`./nano` физически не в бандле»; худший тихий регресс — nano и executor-шов одновременно из-за одного непониженного вызова — становится невозможен). Сознательно-динамический вызов помечается блочным комментарием `@motion-runtime` вплотную перед ним: он остаётся рантаймовым без ошибки (и считается в `runtimeCalls` квитанции). Смешанный модуль в strict падает целиком — до частичного понижения.
- **`onBudget`** (#237) — квитанция build-фактов по завершении билда (`buildEnd`): сколько вызовов понижено, сколько осталось рантаймовыми, суммарная длина артефакт-литералов. Из колбэка удобно писать `motion-budget.json` в CI.

Поведение `transform`:

- **Быстрый отсев до парсинга**: виртуальные id (содержат `\0`) и модули без подстроки `@labpics/motion/nano` возвращают `undefined` немедленно.
- Ошибка парсинга — `undefined`: не наш синтаксис, пусть падает штатный пайплайн.
- Если понижать нечего (или сработал консервативный отказ целиком) — `undefined`, модуль не тронут.
- Иначе: применяются байтовые правки, в конец модуля дописывается hoisted-импорт
  `import { animateCompiled as __labMotionNanoCompiled } from "@labpics/motion/compiler/runtime";`
  и возвращается точная sourcemap версии 3: сохранённые байты исходника мапятся сегмент-в-сегмент (включая многострочные вызовы, чьи правки схлопывают строки), замена целиком отображается в начало своей правки, hoisted-импорт остаётся неотображённым (это не пользовательский код); `sources` несёт id модуля, `sourcesContent` — исходник.

#### Что понижается статически (#221)

Срез #221 — spring-режим. Понижается вызов, у которого **всё** доказано на AST плюс побайтной проверкой тривиа-зон:

- Модуль импортирует ровно `import { animate } from '@labpics/motion/nano'` — direct named import **без алиаса** (`animate as a` не понижается).
- Нигде в модуле имя `animate` не занимает binding-позицию (параметр, деструктуризация, объявление — затенение где угодно означает отказ **целиком**, scope-анализа нет) и нигде не встречается идентификатор `__labMotionNanoCompiled` (коллизия локального имени — тоже отказ целиком).
- Callee — голый идентификатор `animate`, не optional-вызов (`animate?.(…)`); 2 или 3 аргумента, без spread.
- `props` — plain object literal: только init-свойства, non-computed, non-shorthand, ключи-идентификаторы без дубликатов, минимум один ключ; значения — **конечные числовые либо строковые литералы**; `scale`/`rotate` — только числа (типовой контракт `NanoProps`).
- `options` отсутствуют (→ дефолтная пружина `mass/stiffness/damping = 1/170/26`) ЛИБО plain object literal из `{ spring?, delay?, stagger?, reducedMotion? }`: `spring` — plain-литерал-подмножество `{mass, stiffness, damping}` из конечных числовых литералов; `delay`/`stagger` — конечные числовые литералы (мс); `reducedMotion` — булев литерал.
- Тривиа-зоны вызова верифицируются **побайтно**: между частями вызова — только `(` и `,` с пробельными символами вокруг; перед закрывающей `)` допускается висячая запятая (`animate(el, { opacity: 1 },)` понижается). Скобки вокруг callee/target (`(animate)(el, …)`), комментарии внутри вызова и прочая экзотика — отказ.

#### Что остаётся runtime

Любое сомнение — консервативный отказ конкретного вызова (он продолжает работать через `./nano`):

- **Tween-режим `{ duration, ease }`** — не понижается в срезе #221: нативная CSS easing-строка не выражается кусочно-линейными кривыми MotionProgram V1 без потери; расширение versioned-контракта строкой изинга — отдельное решение.
- Любое нелитеральное значение: переменные, template-литералы, вычисления, spread, computed/shorthand-свойства, дубликаты ключей.
- Отрицательные литералы (`-12` — это `UnaryExpression`, не `Literal`) и keyframe-пары `[from, to]` (`NanoPair`).
- Неконечный числовой литерал значения (например `1e999` → `Infinity`): статическая проверка требует `Number.isFinite` — вызов остаётся runtime.
- Неизвестные ключи options; пустой кадр `{}`.

#### Ошибки сборки

LM-кодов (`MotionParamError`) в этом слое нет. **Доказанно-статический, но невалидный** вход — ошибка сборки с причиной, не silent fallback (#221): бросается `Error` с сообщением `lab-motion compiler: статический nano-вызов невалиден — <причина>`. Причины:

- непредставимая пружина (`springLinear`, `RangeError`) — граница ИМЕННО lowering-а, не физики: ядро принимает `damping: 0` (#218), но незатухающая/нефинитно оседающая кривая не представима конечной `linear()`-строкой. Причины `RangeError`: параметры вне домена nano-грамматики (`spring parameters must be finite and positive`) либо кривая не сворачивается в конечный артефакт — неконечная длительность оседания или число узлов выше общего compiler-ceiling компоузитора (`spring is not representable`);
- расхождение V1-проекции с nano SSOT (включая `MotionProgramParseError` с кодами `LMP_*` из внутренней верификации).

### animateCompiled

```ts
function animateCompiled(target: NanoTarget, artifact: CompiledNanoCall): NanoControls;

type NanoTarget = Element | string | Iterable<Element> | ArrayLike<Element>;
type NanoControls = Animation[] & { finished: Promise<Animation[]> };
```

Private executor: предназначен для вызовов, инъецированных компилятором; публичен только потому, что hoisted-импорт обязан разрешаться из пользовательского бандла. Семантика — байт-в-байт nano:

- `target`-строка → `document.querySelectorAll(target)`; одиночный `Element` и коллекции — как есть.
- Один frame-объект на **весь** вызов (литерал артефакта), не на элемент — паритет с nano.
- Каждый элемент: `element.animate(f, { duration, easing, delay, fill: 'both' })`, где `delay = (y ?? 0) + (g ?? 0) · index` мс.
- Reduced-motion: явный `r` (1/0) побеждает; при отсутствии — `matchMedia('(prefers-reduced-motion: reduce)')` **в момент вызова**, как у nano. В reduced-режиме: `duration: 0`, `easing: 'linear'`, `delay: 0` — цели мгновенно в финальном кадре.
- `finished` резолвится, когда все анимации завершились: на `finish` каждой выполняется `commitStyles()` + `cancel()` (в `try/catch`: на платформе без `commitStyles` финал сохраняет `fill: 'both'`); реджектится, если реджектнулась любая `animation.finished`.

Не бросает LM-кодов; требует нативные `Element.animate()`/CSS `linear()` (контракт platform-trusted, как у `./nano`).

### CompiledNanoCall — формат артефакта

```ts
interface CompiledNanoCall {
  readonly f: Readonly<Record<string, number | string>>;
  readonly d: number;
  readonly e: string;
  readonly y?: number | undefined;
  readonly g?: number | undefined;
  readonly r?: 0 | 1 | undefined;
}
```

| Поле | Значение | Единицы / формат |
| --- | --- | --- |
| `f` | Готовый кадр (`PropertyIndexedKeyframes`-эквивалент). Воспроизводит семантику nano байт-в-байт, включая порядок ключей: `scale`, `rotate` → `` `${N}deg` ``, затем авторский порядок остальных | числа и строки-longhand |
| `d` | Длительность | миллисекунды |
| `e` | Каноническая CSS `linear()`-строка из `springLinear` | строка `linear(…)` |
| `y` | `delay` | миллисекунды; отсутствие = 0 |
| `g` | `stagger` — шаг каскада между целями | миллисекунды на индекс; отсутствие = 0 |
| `r` | Статически доказанный `reducedMotion` | `1`/`0`; отсутствие — ambient `matchMedia` в момент вызова |

Литерал артефакта, инъецируемый в код, — детерминированный и однострочный (закон sourcemap-композиции: замена не может содержать перевод строки — нарушение равно ошибке сборки). `delay`/`stagger`/`reducedMotion` не входят в программу одного элемента (delay зависит от индекса цели) и живут полями артефакта.

### MotionProgram V1 как каноническое представление

Пайплайн доверия артефакта: nano SSOT (`springLinear` + кадр по семантике `nano/index.ts`) → кандидат MotionProgram V1 → канонический V1-парсер (**единственный оракул доверия**) → проекция обратно с обязательным bit-exact сверением кадра, длительности и `linear()`-строки. Любое расхождение после доказанного match — ошибка сборки.

Кандидат строится ТОЛЬКО из артефакта: числовой `opacity` — standard-канал V1 (кодек scalar); прочие каналы — escaped host-extension `[255, stringIndex]` со scalar для чисел и webCssOpaque для строк — те же native-longhand семантики, что у nano/WAAPI (интерполирует host). MotionProgram V1 — независимый от хоста контракт данных (кортеж `[version: 1, requiredFeatures, strings, curves, bindings, tracks]`); публичным экспортом пакета он не является — здесь он верификационный контракт компилятора.

### Type-only экспорты

`./compiler/vite`: `MotionCompilerPlugin`. `./compiler/runtime`: `CompiledNanoCall`, а также реэкспорт `NanoControls`, `NanoTarget` из `./nano`.

## Контракты

- **Сохранение семантики.** Непониженный вызов — это в точности исходный runtime-вызов `./nano`; трансформ либо доказанно эквивалентен (общий SSOT + V1-оракул), либо не происходит.
- **Ошибка сборки, не silent fallback.** Доказанно-статический невалидный вход и любое расхождение V1-проекции роняют сборку с причиной.
- **Детерминизм.** Идентичный вход → идентичный вывод: артефакт-литерал детерминированный, wall-clock не используется; build и runtime считают одну математику (`springLinear` — общий шов, любое изменение меняет обе стороны сразу).
- **Паритет с nano запечатан** differential-сьютом compiler-nano-lowering (журнал keyframes/options, delay/stagger/explicit-reduced политика, `finished`/`commitStyles`/`cancel`): любая правка исполнительного хвоста здесь или в `nano/index` обязана пройти `pnpm acceptance:compiler`.
- **Единицы.** Все времена — миллисекунды.
- **Reduced-motion.** Явный `r` из статически доказанного `reducedMotion`; иначе `prefers-reduced-motion` читается в момент вызова. Reduced-путь — мгновенный финальный кадр.
- **SSR.** `motionCompiler()` — build-time, DOM не трогает. `animateCompiled` — DOM-executor (нативный `Element.animate`), на сервере не предназначен; `matchMedia` защищён `typeof`-проверкой, но исполнение требует WAAPI-хоста.
- **Ошибки.** LM-кодов в слое нет: компилятор бросает `Error`/`RangeError` на этапе сборки (см. «Ошибки сборки»); `animateCompiled` не бросает, `finished` может реджектнуться отменённой анимацией.

## Примеры

Подключение плагина:

```ts
// vite.config.ts
import { motionCompiler } from '@labpics/motion/compiler/vite';

export default {
  plugins: [motionCompiler()], // enforce: 'pre' — до остальных трансформов
};
```

Статически понижаемый вызов — пишется и типизируется как обычный `./nano`:

```ts
// src/toast.ts
import { animate } from '@labpics/motion/nano';

export function showToast(): Promise<Animation[]> {
  const el = document.querySelector('.toast') as HTMLElement;
  // Все значения — литералы, options — spring-режим из литералов: понижается.
  const controls = animate(el, { translate: '0px -12px', opacity: 1, scale: 1.05 }, {
    spring: { stiffness: 220, damping: 28 },
    delay: 40,
    stagger: 60,
  });
  return controls.finished;
}

// После трансформа (d/e компилятор вычислит из того же springLinear SSOT):
//   __labMotionNanoCompiled(el, {f:{scale:1.05,translate:"0px -12px",opacity:1},
//     d:<мс>,e:"linear(…)",y:40,g:60})
// плюс hoisted-импорт в конце модуля:
//   import { animateCompiled as __labMotionNanoCompiled }
//     from "@labpics/motion/compiler/runtime";
```

Граница понижения — что остаётся runtime:

```ts
import { animate } from '@labpics/motion/nano';

const cards = document.querySelectorAll('.card');

// Runtime: значение не литерал (template-литерал с переменной).
const dy = -12;
animate(cards, { translate: `0px ${dy}px` }, { stagger: 40 });

// Runtime: tween-режим { duration, ease } не понижается в срезе #221 —
// CSS easing-строка не выражается кривыми MotionProgram V1 без потери.
animate(cards, { opacity: 1 }, { duration: 300, ease: 'ease-out' });

// Понизится: литералы, options отсутствуют — дефолтная пружина 1/170/26.
animate(cards, { opacity: 1 });
```

## Стирание полного фасада: прагма `@lm-oneshot` (#240)

Понижается не только `./nano`: вызов **полного** `./animate` можно пометить
блочным комментарием `/* @lm-oneshot */`, и тогда компилятор заменит его
артефактом с исполнителем, а сам фасад уедет из бандла штатным tree-shake.

```ts
import { animate } from '@labpics/motion/animate';

export function reveal(el: HTMLElement): void {
  /* @lm-oneshot */ animate(el, { x: 240, opacity: 1 });
}
```

Прагма обязательна и означает согласие на **одноразовую семантику**: понижённый
вызов не публикует владельца поверхности, поэтому

- не подхватывает скорость живого прогона (нет C¹-перехвата),
- не сохраняет residual-transform от прошлых анимаций,
- не отдаёт контролы (`play`/`pause`/`seek`/`cancel`): результат обязан
  отбрасываться — вызов пишется отдельным выражением-стейтментом,
- считает стартом identity transform-каналов (`x: 0`, `scale: 1`, …) и `1` для
  `opacity` без явной пары; нужен другой старт — пишите пару `[from, to]`,
- поздний рантаймовый `animate()` на том же элементе не увидит понижённый
  прогон в реестре.

Всё прочее совпадает с фасадом бит-в-бит: те же кадры, та же кривая (артефакт
`compositor/curve`, не отдельная nano-математика), тот же тайминг, та же
политика `prefers-reduced-motion`, те же явные стопы на WebKit, который не
исполняет CSS `linear()`. Это запечатано C4-дифференциалом: журнал
`element.animate` понижённого пути сравнивается с фасадным поле в поле
(`test/compiler-facade-lowering.test.ts`).

Понижаемая грамматика: transform-шортхенды (`x`, `y`, `scale`, `scaleX`,
`scaleY`, `rotate`, `skewX`, `skewY`) и `opacity`; значения — конечные числовые
литералы (включая унарный минус) либо пары `[from, to]`; опции — `spring`,
`delay`, `stagger` литералами.

### Сколько вызовов можно стереть прямо сейчас

Стирание включается на вызов, поэтому легко не заметить, что бандл уже готов
похудеть. Квитанция сборки отвечает на это цифрой: передайте `onBudget`, и
компилятор посчитает **непомеченные вызовы, которые понизились бы чисто**.

```ts
motionCompiler({
  onBudget: ({ lowered, erasableFacadeCalls }) => {
    console.log(`понижено: ${lowered}, можно стереть ещё: ${erasableFacadeCalls}`);
  },
});
```

Счёт кандидатов выполняется только когда `onBudget` передан — без него
компилятор не разбирает модули, где нет прагмы, и сборка ничего не платит за
диагностику.

**Помеченный вызов, который понизить не вышло, — ошибка сборки, а не тихий
откат к рантаймовому фасаду**: прагма выражает запрос на стирание, и молчаливый
возврат 12+ КБ противоречил бы ему. В сообщении — файл, позиция и причина
(tween-режим, CSS-канал, использованный результат, …). Не готовы к
одноразовой семантике — просто не ставьте прагму: непомеченные вызовы остаются
полным фасадом без единого предупреждения.
