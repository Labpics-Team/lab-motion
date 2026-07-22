# ./stagger — каскады задержек

> Роль: справка — публичный API экспорт-субпутя `./stagger`: чистая функция `stagger(count, options)` → массив конечных неотрицательных задержек старта (мс) для каскадного запуска группы элементов.

## Назначение

Субпуть `./stagger` — L1-домен headless-распределения задержек. `stagger()` — чистая функция: по числу элементов и опциям возвращает массив стартовых задержек в **миллисекундах**; элементы дальше от очага (`from`) получают бо́льшую задержку — группа стартует каскадом. Ни DOM, ни `window`, ни часов на пути импорта: применение задержек (WAAPI `delay`, `transition-delay`, собственный цикл) — целиком забота вызывающего. Easing не встроен — инжектируется вызывающим (обычно из `@labpics/motion/easing`).

Инварианты модуля (закреплены в JSDoc и коде):

- **ST1. Финитность.** Каждая возвращённая задержка — конечное неотрицательное число. `NaN`/`Infinity` в любом входе (`count`, `gap`, возврат `easing`) → задержка клампится до `0`.
- **ST2. Zero-DOM.** Никаких `querySelector`/`document`/`window` на пути импорта — SSR-safe.
- **ST3. Reduced-motion — переключение ХАРАКТЕРА.** При `reducedMotion: true` все задержки схлопываются в `0`. Элементы по-прежнему анимируются — просто стартуют одновременно. Это смена характера (мгновенный одновременный старт), а НЕ hard-off.
- **ST4. Детерминизм.** Идентичные входы → идентичные выходы, бит-точно на всех платформах.
- **ST5. Краевые случаи.** `count = 0` → `[]`; `count = 1` → `[0]`; отрицательный/неконечный `count` → `[]`.
- **ST6. Доступность.** `count` ограничен сверху пределом `100 000` (внутренняя константа `MAX_STAGGER_COUNT`). Враждебный или случайный экстремальный `count` (`Number.MAX_SAFE_INTEGER`, `1e9`, …) КЛАМПИТСЯ, не зануляется — вызывающий получает пригодный ограниченный массив вместо OOM/зависания от безграничной аллокации.

Характеристики размера/производительности — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md). Субпуть tree-shakeable — в корневой бандл не входит.

## Импорт

```ts
import {
  stagger,
  type StaggerOptions,
  type StaggerFrom,
  type StaggerGridOptions,
} from '@labpics/motion/stagger';
```

## API

### stagger

```ts
type StaggerFrom = 'first' | 'last' | 'center' | 'edges' | number;

interface StaggerGridOptions {
  columns: number;
}

interface StaggerOptions {
  gap?: number;                        // мс; дефолт 50
  from?: StaggerFrom;                  // дефолт 'first'
  easing?: (t: number) => number;      // дефолт — тождественная (linear)
  grid?: StaggerGridOptions;           // дефолт — 1D (линейный индекс)
  reducedMotion?: boolean;             // дефолт false
}

function stagger(count: number, options?: StaggerOptions): number[];
```

Вычисляет стартовые задержки (мс) для группы из `count` элементов. Задержка каждого элемента — функция его расстояния до очага `from`: нормализованная позиция `distance / maxDistance ∈ [0, 1]` проходит через `easing` и масштабируется обратно, `delay = easing(distance / maxDistance) × maxDistance × gap`. Для тождественного easing это ровно `distance × gap`; максимальная задержка (дальний элемент, linear) — `maxDistance × gap`.

Параметры:

- `count` — число элементов. Положительное конечное → `Math.floor`; ноль, отрицательное, неконечное → `[]` (ST5). Значение выше `100 000` клампится до предела (ST6).
- `options.gap` — базовый шаг задержки между соседними элементами, **миллисекунды**. Дефолт `50`. Неконечное или отрицательное значение заменяется дефолтом; `gap: 0` валиден — все задержки `0`.
- `options.from` — очаг распределения, кто стартует первым (задержка `0`). Дефолт `'first'`.
  - `'first'` — элемент 0 первый; задержки растут к концу.
  - `'last'` — последний первый; задержки растут к началу.
  - `'center'` — центральный(е) первый(е); задержки растут наружу. Для чётного `count` очаг — дробная позиция `(count − 1) / 2` между двумя центральными.
  - `'edges'` — оба края стартуют одновременно первыми; задержки растут внутрь.
  - `number` — конкретный 0-based индекс первый; задержки растут наружу. Округляется (`Math.round`) и клампится в `[0, count − 1]`.
- `options.easing` — функция `(t: number) => number` над нормализованной позицией: `0` — ближайший к очагу (минимальная задержка), `1` — дальний (максимальная). Дефолт — тождественная. Не-функция игнорируется. Неконечный или дающий отрицательную задержку возврат → задержка `0` (ST1). Готовые кривые — `@labpics/motion/easing` (`easeOut`, `circOut`, …).
- `options.grid` — 2D-раскладка: элементы трактуются как сетка с `columns` колонок на строку (`rows = ceil(count / columns)`), расстояние до очага — евклидово в пространстве строк/колонок; `'edges'` — минимальное расстояние до границы сетки. `columns` — конечное число `≥ 1`, берётся `Math.floor`; иначе опция игнорируется (расчёт остаётся 1D).
- `options.reducedMotion` — переключатель характера (ST3): строго `true` → все задержки `0`. Дефолт `false`. Сам `stagger()` DOM-free (ST2) — снимите `window.matchMedia('(prefers-reduced-motion: reduce)')` на своей стороне и передайте результат.

Возврат: массив длины `min(floor(count), 100 000)` конечных неотрицательных задержек (мс). Вырожденная геометрия (максимальное расстояние до очага равно нулю, например `from: 'edges'` при `count = 2` или сетка из одной строки при `from: 'edges'`) → все задержки `0`.

Бросает: ничего. Контракт forgiving — любой враждебный вход клампится, LM-кодов у субпутя нет. Коды `LM017`–`LM020` из [docs/errors.md](../errors.md) принадлежат другому субпутю — `./compositor/stagger` (WAAPI-группы) — и к headless `stagger()` не относятся.

### Type-only экспорты

- `StaggerOptions` — опции `stagger()` (`gap`, `from`, `easing`, `grid`, `reducedMotion`).
- `StaggerFrom` — `'first' | 'last' | 'center' | 'edges' | number`, очаг распределения.
- `StaggerGridOptions` — `{ columns: number }`, дескриптор 2D-сетки.

## Контракты

- **SSR-safe / zero-DOM (ST2).** Ни DOM, ни `window`, ни часов, ни глобального состояния на пути импорта — безопасен на сервере и в воркерах. Детект `prefers-reduced-motion` — на стороне вызывающего.
- **Финитность (ST1).** Каждая задержка конечна и `≥ 0` при любом IEEE-754 входе; неконечный `gap` → дефолт, неконечный возврат `easing` и отрицательная производная задержка → `0`.
- **Reduced-motion (ST3).** `reducedMotion: true` — смена характера, не hard-off: массив нулей той же длины, анимация выполняется, но одновременно.
- **Детерминизм (ST4).** Чистая функция без `Math.random`, wall-clock и зависимостей: идентичный вход → бит-идентичный выход.
- **Доступность (ST6).** Аллокация ограничена пределом `100 000` элементов — экстремальный `count` клампится, не роняя процесс.
- **Без исключений.** Публичный путь не содержит `throw` — валидация forgiving (кламп/дефолт/пустой массив).

## Примеры

Линейный каскад списка через `transition-delay` (`stagger(5, { gap: 60 })` → `[0, 60, 120, 180, 240]`):

```ts
import { stagger } from '@labpics/motion/stagger';

const items = Array.from(document.querySelectorAll('.list-item')) as HTMLElement[];
const delays = stagger(items.length, { gap: 60 });

items.forEach((el, i) => {
  el.style.transitionDelay = `${delays[i]}ms`;
  el.classList.add('is-visible');
});
```

Каскад от центра с `easeOut`-распределением, WAAPI-запуск и уважение reduced-motion:

```ts
import { stagger } from '@labpics/motion/stagger';
import { easeOut } from '@labpics/motion/easing';

const cards = Array.from(document.querySelectorAll('.card')) as HTMLElement[];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const delays = stagger(cards.length, {
  from: 'center',
  gap: 80,
  easing: easeOut,       // сжимает задержки к очагу, растягивает к краям
  reducedMotion,         // true → все нули: карточки стартуют одновременно
});

cards.forEach((el, i) => {
  el.animate(
    [
      { opacity: 0, transform: 'translateY(12px)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 300, delay: delays[i], easing: 'ease-out', fill: 'both' },
  );
});
```

2D-волна по сетке: расстояние — евклидово в пространстве строк/колонок от ячейки-очага:

```ts
import { stagger } from '@labpics/motion/stagger';

const cells = Array.from(document.querySelectorAll('.grid-cell')) as HTMLElement[];

// 4 колонки; очаг — ячейка с индексом 0 (левый верхний угол) → волна по диагонали.
const delays = stagger(cells.length, { grid: { columns: 4 }, from: 0, gap: 40 });

cells.forEach((el, i) => {
  el.style.animationDelay = `${delays[i]}ms`;
});
```
