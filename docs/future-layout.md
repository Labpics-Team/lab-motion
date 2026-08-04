# Future Layout — сопряжённые поверхности

> Роль: контракт `animate(..., { layout: 'project' })` — что обещано, как
> проверяется и где проходят точные границы. Внутренний модуль
> `src/future-layout` не является новым публичным runtime-уровнем и не
> экспортируется субпутем: вход остаётся единственным — фасад `animate()`.

## Модель

Один commit конечного DOM; пиксели догоняют сопряжёнными snapshot-поверхностями:

```typescript
import { animate } from '@labpics/motion/animate';

const controls = animate(
  viewport,
  { width: [240, 360] },
  {
    layout: 'project',
    spring: { mass: 1, stiffness: 170, damping: 26 },
    onFrame: (frame) => { /* borrowed view — см. ниже */ },
  },
);
await controls.committed; // единственный commit конечного DOM состоялся
await controls.ready;     // capability-эксперимент прошёл, effects стартуют
await controls.finished;  // терминальное состояние (released/canceled/failed)
```

Ширина границы исполняется как `W(t) = W0 + (W1 − W0)·P(t)`, где `P` —
serialized пружина (та же строка `linear()`, что исполнит браузер).
Сопряжённый counter-scale `Q` строится ТОЛЬКО из serialized `P`; crossfade —
монотонная траектория `A` вместо oscillatory opacity. Произведение
`G·F·R` тождественно 1 на каждом кадре: контент не растягивается.

## Lifecycle и контролы

Порядок: capture old → commit конечного состояния → commit barrier →
capture new → capability-эксперимент → active phase → release snapshots.

- `committed` — commit состоялся (наблюдатель видит уже running/capturing-new);
- `ready` — native tier доказан и effects стартовали;
- `finished` — резолвится на ЛЮБОМ терминальном пути (`released`, `canceled`,
  `failed`) — висящих awaiter'ов не остаётся;
- `cancel()` — commit НЕ откатывается: cancel немедленно раскрывает уже
  committed DOM;
- `state` — `capturing-old | committing | capturing-new | running | released |
  canceled | failed`;
- `tier` — `future-layout-native | future-layout-snap |
  future-layout-projection` (V1 выдаёт native либо snap);
- `play/pause/seek` — вне контракта one-shot перехода (no-op), `stop()` = cancel.

## Fallback-матрица

Режим всегда явный: без `layout: 'project'` прямой width-tween не меняется.
Tier выбирается capability-экспериментом, не предположением:

| Условие | Исход |
|---|---|
| VT доступен, pseudo-модель доказана и артефакт доказуем | `future-layout-native`: постоянное число 5 generated CSS-анимаций псевдодерева (group scaleX, old/new reciprocal scaleX, old/new monotonic blend opacity) |
| reduced motion (user preference) | `future-layout-snap`: мгновенное раскрытие committed DOM |
| `document.startViewTransition` отсутствует | `future-layout-snap` — commit применяется напрямую |
| Pseudo-модель недоказуема (group-бокс ≠ committed ширина) | `future-layout-snap` |
| Позитивность/бюджет недоказуемы (overshoot к нулю, недостижимый бюджет) | `future-layout-snap` — Infinity/NaN в CSS не попадают |
| Любое сомнение маршрутизатора (не width-пара, неединственный канал, селектор/список, нечисловые концы) | обычный runtime path — скрытых подмен семантики нет |

## Точность

- Бюджет движущейся границы и сопряжения: `SURFACE_PRECISION_BUDGET_PX`
  (CSS px) — см. `src/future-layout/artifact.ts`, это SSOT числа.
- Certified bound: на сегменте serialized `P` ширина линейна, ошибка
  интерполяции `Q` ограничена `(h²/8)·max|R''|`, `R''(u) = 2β²/W(u)³`;
  subdivision продолжается, пока производственная ошибка сопряжения ≤ бюджета.
- Недоказуемо в потолке stops — fail-closed (`undefined` → snap), крупных
  аллокаций до доказательства нет.
- Receipt (`buildSurfaceReceipt` / `validateSurfaceReceipt`) фиксирует вклады
  машинно (числа из артефакта, не ручные); validator fail-closed: неизвестные
  ключи и повреждённые значения отвергаются.

## Observer semantics

`onFrame` получает borrowed view `{ time, progress, width, velocity, delta }`:

- объект действителен ТОЛЬКО внутри callback и переиспользуется; для хранения
  скопируйте нужные числа;
- максимум один callback на доставленный main-thread frame — очередь и backlog
  после freeze отсутствуют;
- ноль frame-аллокаций;
- `velocity` — правая производная serialized `W(t)`;
- исключение callback не отменяет визуальный transition;
- без `onFrame` не планируется ни одного rAF.

Ограничения: callback приходит на доставленные кадры главного потока, а не на
каждый compositor frame; во время блокировки главного потока callback не
исполняется (движение при этом продолжается на compositor).

## Input policy и scroll anchor

- `inputPolicy`: `'finish'` (default) — первый значимый input intent раскрывает
  committed DOM завершением; `'cancel'` — отменой; `'block'` — игнорирует input
  до терминального состояния. Подписка реализуется швом `onInputIntent`;
  cleanup ровно один раз в finalize.
- `scrollAnchor`: `'preserve-start'` (default) — позиция читается ДО commit и
  корректируется внутри commit barrier; `'none'` — без коррекции.

## View Transition host

Same-document View Transitions — предпочтительный host, но capability
определяется экспериментом (`document.startViewTransition` может отсутствовать
— тогда commit применяется напрямую):

- уникальное bounded `view-transition-name` из монотонной последовательности
  (глобальных статичных имён нет, коллизия невозможна в пределах realm);
- generated CSS отключает UA-анимации `::view-transition-group/image-pair/
  old/new`; весь CSS (UA-disable + 5 effects-анимаций) инжектится в один
  временный stylesheet и снимается ровно один раз в terminal cleanup; style
  element после завершения не остаётся;
- без динамического кода: инжект только через `textContent` (нет
  `eval`/`Function`); генерируемый `<style>` подчиняется `style-src` — строгий
  CSP без `'unsafe-inline'`/nonce может заблокировать stylesheet;
- host-сбой не оставляет partial owner — транзакция терминализируется.

Representation: сопряжённая геометрия `G·F·R = 1` живёт в самом pseudo-tree —
group-бокс несёт внешний scale `G(t) = W(t)/B` (base `B = W1` — committed
ширина, сертифицируется чтением group-бокса после VT-ready), snapshot-плоскости
несут counter-scale `R` и monotonic blend opacity; `image-pair` с
`overflow: hidden` клипит контент по движущейся границе. WAAPI-pseudoElement в
Chromium не исполняется (анимация создаётся, но не влияет на рендер), поэтому
нативный tier — только generated CSS: compositor-driven transform/opacity,
независимые от главного потока (доказательство — freeze-стенд ниже).

## Виртуализация и число effects

Число native effects постоянно (5) и не зависит от 100 / 10 000 / 1 000 000
логических строк. Материализация строк — bounded-инвариант потребителя
(viewport capacity + overscan): Future Layout не материализует логические
строки сам и не обещает мгновенную работу произвольных 10 000 DOM-узлов.
Доказательный стенд: `browser/18-surface-freeze.spec.ts` (busy-window ≥ 1000 ms
ПОСЛЕ старта представления: compositor-контроли движутся, rAF control и observer
замерли; видео пишется browser process'ом, JSON receipt прикладывается
артефактом). Закон Chromium, зафиксированный стендом: CSS-анимации, закоммиченные
в том же кадре, что и блокировка, до compositor не доходят — freeze моделирует
джанк активной фазы, не гонку инжекта против блокировки.

## Active vs startup cost

Startup — capture old, microtask-commit, barrier, capture new,
capability-эксперимент и compile артефакта (serialized P → Q → A с
непрерывным доказательством); это разовая работа ДО active phase. Active
phase — исполнение постоянных 5 effects на compositor + observer-наблюдение
(≤ 1 callback/кадр, без аллокаций). Ширина/ descendant-записей в active phase
нет: движение выражается transform/opacity.

## Browser capability matrix

| Возможность | Использование |
|---|---|
| `document.startViewTransition` | host-эксперимент; отсутствует — commit без VT, контракт сохранён (snap) |
| CSS-анимации псевдодерева + serialized `linear()` | native tier: 5 generated effects на compositor |
| `getComputedStyle(::view-transition-group(...))` | сертификация pseudo-модели (base `B = W1`, placement) |
| reduced-motion media query | snap |
| CSS `view-transition-name` | bounded имя на время транзакции |

## Size

Generated CSS host'а входит в consumer total size
(`surfaceSizeAccounting()`). Гейты шипятся от факта с документированной
хронологией в `scripts/size-gate.mjs` (SSOT чисел); динамические байты сюда не
копируются. Профили: compiled native surface (initial + reachable — см.
`FULL_ANIMATE_GATE_BYTES`), mixed animate+compositor consumer
(`ANIMATE_COMPOSITOR_MIXED_GATE_BYTES`).

## Compiler

Conservative lowering `animate(..., { layout: 'project' })` в versioned
`SurfaceProgram` (`surface/1`, deep-frozen IR): любое сомнение
(динамические аргументы, не-width props, невалидный spring, непроецируемые
опции) оставляет runtime path с явной причиной. Erasure: solver/parser не
попадают в граф скомпилированного потребителя — приёмка
`scripts/compiler-acceptance.mjs` (байт-идентичный вывод без плагина).

## Точные ограничения (не обещаем)

- callbacks НЕ приходят на каждый compositor frame;
- startup НЕ независим от DOM (capture/verify читают цель);
- View Transition сам по себе НЕ гарантирует off-main;
- hit-testing НЕ следует визуальному snapshot (committed DOM сразу конечный);
- произвольные 10 000 DOM-узлов НЕ «работают мгновенно» — bounded
  материализация на стороне потребителя;
- V1: одна bounded-цель на вызов; селекторы и списки целей — обычный
  runtime path.
