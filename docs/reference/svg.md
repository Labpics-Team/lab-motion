# ./svg и ./svg-morph — SVG-анимации и морфинг

> Роль: справка — публичный API экспорт-субпутей `./svg` (парсер d-атрибута, длина пути, draw-стили штриха `drawPath`, движение вдоль пути `createMotionPath`) и `./svg-morph` (морфинг форм `interpolatePath`).

## Назначение

Субпуть `./svg` — чистая математика SVG-путей: строгий парсер d-атрибута, нормализация в абсолютные кубики (L/H/V/Q/T/A/Z → C по каноничным формулам, дуги — через endpoint→center параметризацию W3C F.6.5–F.6.6), детерминированная arc-length таблица (фиксированные 32 сэмпла на кубический сегмент). Поверх неё — три задачи: полная длина (`pathLength`), «отрисовка» штриха через `stroke-dasharray`/`stroke-dashoffset` (`drawPath`) и точка+угол касательной на доле длины для движения элемента вдоль пути (`createMotionPath`, равномерная скорость по длине, не по параметру кривой).

Субпуть `./svg-morph` — морфинг форм: `interpolatePath(dFrom, dTo)` возвращает чистую функцию `p → d-строка` промежуточной формы. Два режима:

- **Точный** — структуры команд совпадают (типы и арности, без дуг `A`/`a` — их флаги неинтерполируемы): покомпонентная линейная интерполяция значений, кривые остаются кривыми, ноль потери качества.
- **Ресэмплинг** — структуры разные: обе формы сэмплируются равномерно по длине (`samples` точек выходной полилинии). Для пары замкнутых путей стартовые точки **выравниваются** — перебор циклического сдвига и направления обхода с минимизацией Σd² (пути из разных редакторов часто имеют противоположный winding) — иначе морф «проворачивается» или схлопывается через центр.

Составные пути (несколько `M`/`m` — дырки, буква «O») морфятся **пер-подконтурно**: подконтуры сопоставляются по порядку определения (детерминизм; авторы иконок управляют соответствием порядком в d); при разном числе лишние подконтуры появляются/исчезают через точку-центроид последнего реального партнёра противоположной стороны.

Инварианты обоих модулей (закреплены в JSDoc и коде):

- **V1. CSS-safe.** Любой выход конечен (`NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE`); `drawPath(_, 1).offset` строго `0` — без float-хвоста.
- **V2. Zero-DOM / SSR-safe.** Чистые функции, ноль платформенных швов; DOM и `window` не трогаются ни на импорте, ни в рантайме.
- **V3. Детерминизм.** Фиксированное число сэмплов, ни wall-clock, ни `Math.random` — бит-в-бит одинаковый результат на любой машине.
- **V4. Fail-fast парсер.** Мусор на входе → `MotionParamError` со стабильным LM-кодом, а не тихий мусор в стилях.
- **V5. Zero runtime deps.**

Оба субпутя tree-shakeable — в корневой бандл не входят. Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

```ts
import {
  parsePath,
  pathLength,
  drawPath,
  createMotionPath,
  type SVGCommand,
  type MotionPathPoint,
  type MotionPath,
  type DrawPathResult,
} from '@labpics/motion/svg';

import {
  interpolatePath,
  type InterpolatePathOptions,
} from '@labpics/motion/svg-morph';
```

## API

### parsePath

```ts
interface SVGCommand {
  readonly type: string;             // буква команды как в исходной строке (регистр сохранён)
  readonly values: readonly number[];
}

function parsePath(d: string): SVGCommand[];
```

Распарсить d-атрибут в список команд. Строгая SVG path-грамматика с поддержкой компактного синтаксиса: `M10-20`, `-5.5.5`, arc-флаги впритык (`011`), экспоненты, повтор аргументов (повтор аргументов у `M` по спецификации трактуется как `L`/`l`). Arc-флаги (аргументы 3 и 4 команды `A`) — ровно одна цифра `0`/`1`.

Бросает `MotionParamError` (V4):

- `LM095` — ожидалось число;
- `LM096` — неконечное число;
- `LM097` — некорректный arc-флаг (не `0`/`1`);
- `LM098` — путь пуст;
- `LM099` — неизвестная команда;
- `LM100` — первая команда не `M`/`m`;
- `LM101` — в пути нет команд.

Свод кодов — [docs/errors.md](../errors.md).

### pathLength

```ts
function pathLength(d: string): number;
```

Полная длина пути (px), детерминированная (V3: фиксированная сетка сэмплирования — 32 сэмпла на кубический сегмент). Разрывы между субпутями (новый `M`) длину не добавляют.

Бросает: коды `parsePath` (`LM095`–`LM101`).

### drawPath

```ts
interface DrawPathResult {
  readonly strokeDasharray: string;
  readonly strokeDashoffset: number;
}

function drawPath(pathOrLength: string | number, progress: number): DrawPathResult;
```

Стили «отрисовки» штриха: `strokeDasharray` — длина пути, `strokeDashoffset` — невидимый остаток. `progress ∈ [0, 1]` — доля прорисованного (`0` — штрих скрыт, `1` — прорисован полностью); клампится, `NaN` → `0`. При `progress ≥ 1` offset **строго** `0` (V1, без float-хвоста).

- `pathOrLength` строкой — путь парсится и меряется на месте; числом — заранее вычисленная длина (px), парсинга нет. Для покадровой анимации считайте длину один раз через `pathLength` и передавайте число.
- Отрицательная/невалидная длина клампится к `0`.

Бросает: коды `parsePath` — только для строковой перегрузки; с числом не бросает ничего.

### createMotionPath

```ts
interface MotionPathPoint {
  readonly x: number;     // px
  readonly y: number;     // px
  readonly angle: number; // угол касательной, градусы
}

interface MotionPath {
  at(t: number): MotionPathPoint;
  readonly length: number; // полная длина пути, px
}

function createMotionPath(d: string): MotionPath;
```

Сэмплированный путь для движения вдоль него. Парсинг и построение arc-length таблицы происходят один раз при создании; `at` — дешёвый бинарный поиск по таблице.

- `at(t)` — точка и угол касательной на доле **длины** `t ∈ [0, 1]` (равномерная скорость по длине, не по параметру кривой). `t` клампится, `NaN` → `0`.
- Вырожденный путь (нулевая длина) → `at` возвращает стартовую точку с `angle: 0`.
- Все выходы конечны (V1).

Бросает: коды `parsePath` (`LM095`–`LM101`) — только в момент создания; `at` не бросает ничего.

### interpolatePath

```ts
interface InterpolatePathOptions {
  readonly samples?: number; // точек в режиме ресэмплинга; целое >= 2; дефолт 64
}

function interpolatePath(
  dFrom: string,
  dTo: string,
  options?: InterpolatePathOptions,
): (p: number) => string;
```

Морф `dFrom → dTo`. Возвращает чистую функцию `p ∈ [0, 1] → d-строка` промежуточной формы (`p` клампится, `NaN` → `0`). Эндпоинты честные: `p <= 0` возвращает **оригинальную** строку `dFrom`, `p >= 1` — оригинальную `dTo` (ни ресэмплинг, ни форматирование не трогают крайние формы). Парсинг и выравнивание — один раз при создании; вызов функции дешёвый.

Выбор режима:

- Совпавшая структура (типы и арности команд поэлементно, без `A`/`a`) у **открытых** путей → точный покомпонентный lerp.
- Совпавшая структура у пары **замкнутых** путей → точный режим только при тождественном соответствии вершин (выравнивание нашло сдвиг `0` без реверса); иначе ресэмплинг с найденным выравниванием — lerp вершин к чужим углам схлопывал бы фигуру через центр.
- Разные структуры → ресэмплинг: `samples` равномерных по длине точек выходной полилинии (`M`/`L`/`Z`, координаты с округлением до 4 знаков, `-0` схлопнут).
- Составной путь с любой стороны (несколько `M`/`m`) → пер-подконтурный морф: пары по порядку определения, каждая пара — своим режимом; непарные подконтуры растут из / стягиваются в центроид последнего реального партнёра противоположной стороны (enter/exit).

Скоуп-пределы (осознанные, из JSDoc):

- Открытые пути с совпадающей структурой морфятся как есть, без пере-выравнивания — направление соответствия задаёт потребитель порядком точек.
- Относительные команды (`l`/`c`/…) в точном режиме lerp'аются посегментно как есть (дельты линейны — геометрия корректна); смешанная нотация (`L` vs `l`) считается разной структурой и уходит в ресэмплинг.
- Дуги `A`/`a` в точный режим не допускаются (флаги неинтерполируемы) — всегда ресэмплинг.

Бросает `MotionParamError`:

- `LM094` — невалидный `samples` (не целое или < 2);
- коды `parsePath` (`LM095`–`LM101`) — для мусора в `dFrom`/`dTo`.

Все ошибки — рано, при создании; возвращённая функция не бросает ничего.

### Type-only экспорты

`./svg`:

- `SVGCommand` — команда пути `{ type, values }` как в исходной строке;
- `MotionPathPoint` — `{ x, y, angle }` (px, px, градусы);
- `MotionPath` — сэмплированный путь (`at`, `length`);
- `DrawPathResult` — `{ strokeDasharray, strokeDashoffset }`.

`./svg-morph`:

- `InterpolatePathOptions` — опции `interpolatePath` (`samples`).

## Контракты

- **SSR-safe / zero-DOM (V2).** Оба субпутя — чистые функции над строками и числами: ни DOM, ни `window`, ни таймеров. Работают в Node/воркере/на сервере без ограничений. Шва reduced-motion здесь нет — модули не двигают ничего сами; предпочтение `prefers-reduced-motion` учитывает драйвер, который вызывает `at`/`drawPath`/морф-функцию по кадрам.
- **Финитность (V1).** Любой выход конечен при любом IEEE-754 входе: `NaN` → `0`, `±Infinity` → `±Number.MAX_VALUE`. `drawPath(_, p)` при `p ≥ 1` даёт offset строго `0`; в d-строках морфа `-0` схлопнут.
- **Детерминизм (V3).** Фиксированная сетка (32 сэмпла на кубик в `./svg`; `samples` точек выходной полилинии в `./svg-morph`), ни рандома, ни времени: одинаковый вход → бит-в-бит одинаковый выход на любой машине. Выравнивание замкнутых контуров и сопоставление подконтуров детерминированы (перебор с фиксированным порядком, пары — по порядку определения в d).
- **Fail-fast (V4).** Невалидный вход бросает `MotionParamError` со стабильным кодом (`LM094`–`LM101`) в момент создания/парсинга — не поздним исключением из кадра и не тихим мусором в стилях. Возвращённые функции (`MotionPath.at`, морф-функция) не бросают.
- **Честные эндпоинты морфа.** `p <= 0` / `p >= 1` возвращают оригинальные входные строки — форматирование и ресэмплинг крайние формы не трогают.

## Примеры

Draw-on штриха: длина считается один раз, покадрово — перегрузка числом без повторного парсинга:

```ts
import { drawPath, pathLength } from '@labpics/motion/svg';
import { easeOut } from '@labpics/motion/easing';

const path = document.querySelector('#logo path') as SVGPathElement;
const d = path.getAttribute('d') as string;
const len = pathLength(d); // px; детерминированная (V3)

const DURATION_MS = 1200;
const start = performance.now();

const frame = (now: number): void => {
  const p = Math.min(1, (now - start) / DURATION_MS);
  const s = drawPath(len, easeOut(p)); // p = 1 → offset строго 0 (V1)
  path.style.strokeDasharray = s.strokeDasharray;
  path.style.strokeDashoffset = String(s.strokeDashoffset);
  if (p < 1) requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

Движение элемента вдоль пути с поворотом по касательной — равномерная скорость по длине:

```ts
import { createMotionPath } from '@labpics/motion/svg';

const el = document.querySelector('.rocket') as HTMLElement;
const mp = createMotionPath('M 20 200 C 120 40 280 40 380 200');

const DURATION_MS = 2000;
const start = performance.now();

const frame = (now: number): void => {
  const t = Math.min(1, (now - start) / DURATION_MS);
  const { x, y, angle } = mp.at(t); // t — доля ДЛИНЫ; angle в градусах
  el.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
  if (t < 1) requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

Морфинг замкнутых форм — стартовые точки и направление обхода выравниваются автоматически:

```ts
import { interpolatePath } from '@labpics/motion/svg-morph';

const path = document.querySelector('#icon path') as SVGPathElement;

const square = 'M 10 10 L 90 10 L 90 90 L 10 90 Z';
const diamond = 'M 50 5 L 95 50 L 50 95 L 5 50 Z';
const morph = interpolatePath(square, diamond, { samples: 128 });

const DURATION_MS = 400;
const start = performance.now();

const frame = (now: number): void => {
  const p = Math.min(1, (now - start) / DURATION_MS);
  path.setAttribute('d', morph(p)); // p<=0 → square, p>=1 → diamond (оригиналы)
  if (p < 1) requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```
