# ./value — парсинг и интерполяция CSS-значений, transform

> Роль: справка — публичный API экспорт-субпутя `./value`: разбор CSS-значений (числа, юниты, `+=`/`-=`, `var()`, цвета) в типизированный AST, их интерполяция по прогрессу `t` и сборка/интерполяция CSS `transform`-строк из независимых каналов.

## Назначение

Субпуть `./value` — headless value-модель пакета: чистые функции без DOM, `window` и глобального состояния. Три контура:

1. **Юниты** — `parseUnit`/`interpolateUnit`: числа с опциональным CSS-юнитом, относительные `+=`/`-=`, `var(--x[, fallback])`.
2. **Цвета** — `parseColor`/`interpolateColor`/`mixColor` + конверсии `hslToRgb`/`rgbToHsl`: hex, legacy-`rgb()`/`rgba()`, legacy-`hsl()`/`hsla()`; RGB-смешение по умолчанию в приближённо-линейном свете.
3. **Transform** — `buildTransform`/`interpolateTransform`: единая `transform`-строка из независимых каналов (`x`, `y`, `scale*`, `rotate`, `skew*`) в порядке translate → scale → rotate → skew.

Поверх них — единый фасад `parse`/`interpolate`, диспетчеризующий по виду AST.

Ключевой закон модуля — **FINITENESS GUARD**: ни одна интерполяция и ни одна сборка строки никогда не выпускает `NaN`/`Infinity` наружу — ни при переполнении диапазона, ни при hostile-`t`, ни при hand-constructed AST с неконечными полями.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  // единый фасад
  parse,
  interpolate,
  // юниты
  parseUnit,
  interpolateUnit,
  // цвета
  parseColor,
  interpolateColor,
  mixColor,
  hslToRgb,
  rgbToHsl,
  // transform
  buildTransform,
  interpolateTransform,
  // type-only
  type ValueAST,
  type ParsedUnit,
  type ParsedRelative,
  type ParsedVar,
  type ParsedColor,
  type ColorMixSpace,
  type ColorMixOptions,
  type TransformState,
} from '@labpics/motion/value';
```

## API

Аргумент `t` везде — безразмерный нормированный прогресс `[0, 1]`. Hostile-`t` безопасен во всех интерполяторах и обрабатывается одинаково: конечный `t` клампится в `[0, 1]`; `NaN → 0` (позиция старта); `+Infinity → 1`; `−Infinity → 0`. Юниты времени `ms`/`s` в этом модуле — лишь распознаваемые суффиксы CSS-строк, пересчёт между ними не выполняется.

### parse

```ts
function parse(value: string | number): ValueAST;

type ValueAST = ParsedUnit | ParsedRelative | ParsedVar | ParsedColor;
```

Единая точка разбора. Диспетчеризация:

- `number` → `ParsedUnit` с `unit: ''` (значение прогоняется через страж конечности: `NaN → 0`, `±Infinity → ±Number.MAX_VALUE`);
- строка после `trim()`, начинающаяся с `#` или матчащая `^rgba?`/`^hsla?` (case-insensitive) → цветовой контур (`parseColor`);
- иначе — юнитный контур (`parseUnit`): `var()`, `+=`/`-=`, число с юнитом.

Бросает `RangeError` (без LM-кода):

- `@labpics/motion value: не удалось распарсить цвет "<вход>"` — цветовая ветка не распознала формат;
- транзитом из `parseUnit` — обе его ошибки (см. ниже).

### parseUnit

```ts
function parseUnit(value: string | number): ParsedUnit | ParsedRelative | ParsedVar;

interface ParsedUnit     { readonly kind: 'unit';     readonly value: number; readonly unit: string; }
interface ParsedRelative { readonly kind: 'relative'; readonly op: '+' | '-'; readonly amount: number; readonly unit: string; }
interface ParsedVar      { readonly kind: 'var';      readonly name: string;  readonly fallback: string | undefined; }
```

Разбор юнитного контура. Поддерживаемые формы:

- **Числа**: целые, дробные, научная нотация, со знаком — `42`, `3.14`, `-1.5e2`;
- **С юнитом**: `px`, `%`, `deg`, `rem`, `vh`, `vw`, `em`, `rad`, `turn`, `ms`, `s`, `fr` или пустой (unitless); юнит нормализуется в нижний регистр;
- **Относительные**: `"+=10"`, `"-=5"`, `"+=10px"`, `"-=5%"` — семантика «прибавить/вычесть `amount` из текущего значения»;
- **CSS custom property**: `"var(--my-var)"`, `"var(--my-var, 10px)"` — fallback триммится и сохраняется строкой.

Числовые поля (`value`, `amount`) зажимаются стражем конечности. `var()`-регекс — линейный (без catastrophic backtracking); defense-in-depth — потолок длины входа 4096 символов до запуска любой регулярки (см. `test/value-var-redos.test.ts`).

Бросает `RangeError` (без LM-кода):

- `@labpics/motion value: CSS-значение слишком длинное (<N> символов, максимум 4096)`;
- `@labpics/motion value: не удалось распарсить CSS-значение "<вход>"`.

### interpolateUnit

```ts
function interpolateUnit(
  from: ParsedUnit | ParsedRelative | ParsedVar,
  to: ParsedUnit | ParsedRelative | ParsedVar,
  t: number,
): string | number;
```

Линейная интерполяция юнитного контура:

- `unit × unit` — lerp числовой части; юнит берётся из `to`, при пустом — из `from`; при итоговом пустом юните возвращается `number`, иначе строка `"<число><юнит>"`;
- `relative` — разрешается как `±amount` от базы `0`, затем lerp;
- `var()` (с любой стороны) — дискретный свап: сериализованный `from` при `t < 0.5`, `to` при `t ≥ 0.5`.

FINITENESS GUARD: `range = to − from` может переполниться в `±Infinity` при `|from| + |to| > Number.MAX_VALUE` — результат зажимается до `±Number.MAX_VALUE`; hostile-`t` — по общей схеме. Не бросает.

### parseColor

```ts
function parseColor(value: string): ParsedColor | null;

interface ParsedColor {
  readonly kind: 'color';
  readonly r: number; // 0–255
  readonly g: number; // 0–255
  readonly b: number; // 0–255
  readonly a: number; // 0–1
  readonly format: 'hex' | 'rgb' | 'hsl';
  readonly hsl?: { readonly h: number; readonly s: number; readonly l: number };
}
```

Разбор строки CSS-цвета. Возвращает `null`, если формат не распознан — **не бросает**. Поддержка:

- **hex**: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`;
- **rgb**: `rgb(r, g, b)`, `rgba(r, g, b, a)` — legacy comma-синтаксис; `r,g,b` зажимаются в `[0, 255]`, `a` — в `[0, 1]`;
- **hsl**: `hsl(h, s%, l%)`, `hsla(h, s%, l%, a)` — legacy comma-синтаксис; hue — `<number>` со знаком и без юнита (нормализуется в `[0, 360)`), `s`/`l` — проценты (суффикс `%` опционален); `format: 'hsl'` дополнительно сохраняет исходные `h`,`s`,`l` в поле `hsl` для HSL-интерполяции.

Modern space-синтаксис (`rgb(0 0 0 / 50%)`, angle-юниты `deg`/`turn` в hue) сознательно не поддерживается. `format` определяет формат вывода интерполяции: `'hex'`/`'rgb'` → `rgb()`/`rgba()`, `'hsl'` → `hsl()`/`hsla()`.

### interpolateColor

```ts
function interpolateColor(
  from: ParsedColor,
  to: ParsedColor,
  t: number,
  options?: ColorMixOptions,
): string;

type ColorMixSpace = 'linear' | 'srgb';
interface ColorMixOptions { readonly space?: ColorMixSpace | undefined; }
```

Интерполяция двух `ParsedColor`, возврат — CSS-строка:

- оба `format: 'hsl'` → интерполяция в пространстве HSL с hue-wraparound (кратчайший путь по кругу); вывод `hsl(...)`, при `a < 1` — `hsla(...)`;
- иначе — RGB-путь; вывод `rgb(...)`, при `a < 1` — `rgba(...)` (alpha округляется до 4 знаков).

RGB-смешение (`options.space`):

- `'linear'` (дефолт) — приближённо-линейный свет: `ch(t) = √(a²·(1−t) + b²·t)` по каналам (γ=2-аппроксимация sRGB EOTF, класс `mixLinearColor` popmotion/framer-motion) — lerp кодированных каналов темнит середину, физически свет складывается в линейном пространстве;
- `'srgb'` — легаси линейный lerp кодированных каналов (CSS Color 4 §13.1) для потребителей, пиннивших старый вывод.

Alpha **всегда** линейный lerp (альфа — покрытие, не свет). FINITENESS GUARD: каналы зажимаются в `[0, 255]`, alpha — в `[0, 1]`; hostile-AST с неконечными каналами не пробивается в строку. Не бросает.

### mixColor

```ts
function mixColor(fromStr: string, toStr: string, t: number, options?: ColorMixOptions): string;
```

Удобная обёртка: `parseColor` обеих строк + `interpolateColor`. Если хотя бы одна строка не распарсилась — безопасный фоллбек без броска: возвращается `fromStr` при `t < 0.5`, иначе `toStr`. Не бросает.

### hslToRgb

```ts
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number };
```

HSL → RGB по каноническому алгоритму W3C CSS Color 3 §4.2.4. Вход: `h ∈ [0, 360]` (нормализуется по кругу), `s`, `l ∈ [0, 1]`. Выход: `r`, `g`, `b ∈ [0, 255]`. Не бросает.

### rgbToHsl

```ts
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number };
```

RGB → HSL по тому же канону. Вход: `r`, `g`, `b ∈ [0, 255]`. Выход: `h ∈ [0, 360)`, `s`, `l ∈ [0, 1]`; для ахроматических цветов (`max === min`) — `h = 0`, `s = 0`. Не бросает.

### buildTransform

```ts
function buildTransform(state: TransformState): string;

interface TransformState {
  readonly x?: number;      // translateX, px; по умолчанию 0
  readonly y?: number;      // translateY, px; по умолчанию 0
  readonly scale?: number;  // равномерный масштаб; по умолчанию 1; перекрывает scaleX/scaleY
  readonly scaleX?: number; // по умолчанию 1
  readonly scaleY?: number; // по умолчанию 1
  readonly rotate?: number; // градусы; по умолчанию 0
  readonly skewX?: number;  // градусы; по умолчанию 0
  readonly skewY?: number;  // градусы; по умолчанию 0
}
```

Собирает CSS `transform`-строку из независимых каналов. Порядок функций фиксирован: **translate → scale → rotate → skew** (совпадает с Framer Motion / Motion One / GSAP). Правила эмиссии:

- отсутствующие поля = identity (`0` для translate/rotate/skew, `1` для масштабов); identity-каналы в строку не попадают;
- полностью identity-состояние → `"none"` (браузер не тратит ресурсы на layout/composite);
- translate: `translateX(...)` / `translateY(...)` при одной ненулевой оси, `translate(x, y)` при обеих;
- масштаб: заданный `scale` перекрывает `scaleX`/`scaleY`; равные оси схлопываются в один `scale(...)`;
- skew: `skew(x, y)` при обеих ненулевых осях, иначе `skewX(...)` / `skewY(...)`.

FINITENESS GUARD: каждое значение зажимается стражем конечности до включения в строку. Не бросает.

### interpolateTransform

```ts
function interpolateTransform(from: TransformState, to: TransformState, t: number): string;
```

Интерполирует два `TransformState` поканально (независимый lerp каждого поля с защитой переполнения `range`) и возвращает результат `buildTransform`. Если `scale` задан только с одной стороны — нормализуется в пару `scaleX`/`scaleY` до lerp'а, чтобы каналы совпали. Hostile-`t` — по общей схеме. Не бросает.

### interpolate

```ts
function interpolate(from: ValueAST, to: ValueAST, t: number): string | number;
```

Единый интерполятор поверх фасада `parse`:

- `color × color` → `interpolateColor` (дефолтное RGB-пространство `'linear'`; опции здесь не пробрасываются);
- оба не-цвета (`unit`/`relative`/`var`) → `interpolateUnit`;
- разные виды (цвет против юнита) → дискретный свап: сериализованный `from` при `t < 0.5`, `to` при `t ≥ 0.5`; цвет при свапе сериализуется как `rgb(...)`.

FINITENESS GUARD: все числовые поля AST при сериализации свапа прогоняются через страж конечности — hand-constructed AST с `NaN`/`Infinity` не даёт `'NaN'`/`'Infinity'` в выводе. Не бросает.

### Type-only экспорты

`ValueAST`, `ParsedUnit`, `ParsedRelative`, `ParsedVar`, `ParsedColor`, `ColorMixSpace`, `ColorMixOptions`, `TransformState` — стираются при компиляции, рантайм-следа не имеют.

## Контракты

- **SSR-safe / zero-DOM.** `window`/`document` не используются ни при импорте, ни при вызове — модуль безопасен на сервере и в воркерах.
- **Zero runtime deps.** Внешних npm-зависимостей нет.
- **Финитность (FINITENESS GUARD).** Интерполяторы и сборщики строк никогда не возвращают `NaN`/`Infinity` — ни числом, ни подстрокой: переполнение диапазона зажимается до `±Number.MAX_VALUE`, hostile-`t` нормализуется (`NaN → 0`, `+∞ → 1`, `−∞ → 0`), цветовые каналы клампятся в свои диапазоны.
- **Детерминизм.** Чистые функции без wall-clock и глобального состояния: идентичный вход → идентичный выход.
- **ReDoS-защита.** `var()`-регекс линейный; потолок длины входа юнитного контура — 4096 символов (превышение — ранний `RangeError`).
- **Ошибки.** Бросают только `parse` и `parseUnit` — обычный `RangeError` с префиксом `@labpics/motion value:`, без LM-кодов (`MotionParamError` этим субпутём не используется). `parseColor` и `mixColor` — no-throw (возврат `null` / строковый фоллбек).
- **Reduced-motion.** Слой — чистая математика, `prefers-reduced-motion` не читает; уважение reduced-motion — контракт исполнителей.

## Примеры

Разбор и интерполяция произвольного CSS-значения:

```typescript
import { parse, interpolate } from '@labpics/motion/value';

const from = parse('0px');
const to = parse('240px');

console.log(interpolate(from, to, 0.25)); // "60px"

// Цвета: дефолтное смешение — приближённо-линейный свет.
const a = parse('#f00');
const b = parse('rgb(0, 0, 255)');
console.log(interpolate(a, b, 0.5)); // rgb(...) — без грязной тёмной середины

// Unitless-значения возвращаются числом.
console.log(interpolate(parse(0), parse(1), 0.5)); // 0.5
```

Transform-каналы в собственном rAF-цикле:

```typescript
import { interpolateTransform, type TransformState } from '@labpics/motion/value';

const el = document.querySelector('.card') as HTMLElement;
const from: TransformState = { x: 0, scale: 1 };
const to: TransformState = { x: 240, scale: 1.2, rotate: 45 };
const durationMs = 400; // шкала прогресса — забота вызывающего
const start = performance.now();

function frame(now: number): void {
  const t = Math.min((now - start) / durationMs, 1);
  // Порядок гарантирован: translate → scale → rotate → skew; identity → "none".
  el.style.transform = interpolateTransform(from, to, t);
  if (t < 1) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

Цветовые пространства и no-throw-обёртка:

```typescript
import { mixColor, parseColor, interpolateColor } from '@labpics/motion/value';

// Легаси-lerp кодированных каналов — для пиннивших старый вывод.
console.log(mixColor('#f00', '#00f', 0.5, { space: 'srgb' })); // "rgb(128, 0, 128)"

// mixColor не бросает: нераспознанный вход → дискретный свап исходных строк.
console.log(mixColor('oklch(0.7 0.1 200)', '#00f', 0.25)); // "oklch(0.7 0.1 200)"

// HSL × HSL — интерполяция в HSL с hue-wraparound, вывод hsl()/hsla().
const c1 = parseColor('hsl(350, 100%, 50%)');
const c2 = parseColor('hsl(10, 100%, 50%)');
if (c1 && c2) console.log(interpolateColor(c1, c2, 0.5)); // "hsl(0, 100%, 50%)"
```
