# Справочник субпутей @labpics/motion

> Роль: справка — карта всех публичных входов пакета и их контрактов.
> Число входов выводится из `package.json` и проверяется автоматически
> (`check-docs-drift` по NAMING.md, `test/readme-facts.test.ts` по README);
> состав экспортов запинен api-surface-pin тестами. Группировка — канон
> [NAMING.md](NAMING.md).

Импорт — `@labpics/motion` (ядро) или `@labpics/motion/<субпуть>`.
Корневой экспорт + 41 субпуть; неиспользуемые субпути вырезаются
tree-shaking'ом: `sideEffects` — точный allowlist из двух авто-регистрирующих
входов (`./lit`, `./wc`).

## Требования и артефакт

Node ≥ 22; ESM и CJS, по-файловые декларации типов. Runtime-зависимостей нет;
фреймворк для биндинга — optional peer (объявлены для 8 фреймворков, `./wc` не
требует ничего).

Установка из исходников — только тарболом (`dist/` собирается, в git его нет):
`pnpm build && pnpm pack`, затем `pnpm add /путь/к/labpics-motion-<версия>.tgz`.
Целостность артефакта у потребителя доказывают `pnpm pack:smoke` (тарбол →
чистый проект → ESM/CJS-импорт всех входов без обязательного peer, файлы каждой
export-ветки) и `pnpm pack:compat` (TypeScript/Vite, SSR, tree shaking, точный
минимальный Preact peer).

## Ядро и управление

| Импорт | Что даёт |
|---|---|
| `@labpics/motion` | `spring` (аналитический closed-form солвер), `tween`, `drive` (декларативный запуск), `MotionValue` (реактивное значение со smooth-pickup), `MotionParamError` |
| `…/driver` | Scrubbable-контроллер: `play/pause/reverse/seek/timeScale/progress` + thenable |
| `…/frame` | Единый frame-шедулер: `createFrameLoop` / синглтон `frame` — один rAF на кадр, фазы read→update→render против layout-thrash, SSR-safe; `asRequestFrame(loop)` сажает `MotionValue`/`drive` на общий кадр. **Биндинги используют его по умолчанию** (как shared-ticker у Framer Motion/GSAP); инжекция своего `requestFrame` переопределяет |
| `…/nano` | **Platform-trusted WAAPI to-only ≤ 1 КБ gzip**: spring/tween, `delay`/`stagger`, reduced-motion, сами `Animation` как контролы; полный контракт и границы — ниже |
| `…/animate` | Фасад-one-liner: `animate(target, props, options)` — цели по каналам (`x`/`y`/`scale`/`rotate`, `opacity`, CSS-свойства), режим `{ spring }` или `{ duration, ease }`, `delay`/`stagger`, контролы `{ finished, play, pause, seek, cancel, stop }`. Массивы N>=3, `times` и per-segment `ease` используют тот же lifecycle; ядро от фасада не растёт |

### Пример: scrub-контроллер

```typescript
import { createDriver } from '@labpics/motion/driver';

const anim = createDriver({ from: 0, to: 1, spring: { mass: 1, stiffness: 200, damping: 24 },
  onStep: (v) => { el.style.opacity = String(v); } });
anim.pause();
anim.seek(0.5);
await anim; // thenable
```

### Контракт `./nano`

`./nano` — platform-trusted to-only WAAPI-вход с ограничением размера до 1 КБ gzip;
контролы — сами `Animation`. Числа — миллисекунды; `translate/scale/rotate` —
целые нативные CSS longhand-каналы, цвета/фильтры/единицы интерполирует
браузер. CSS `x/y` не трактуются как оси `translate` (nano не читает layout,
чтобы угадывать вторую ось) — transform-шортхенды `x/y` принадлежат полному
`./animate`. Нужны нативные `Element.animate`, `Animation.commitStyles` и CSS
`linear()`; скрытого rAF-fallback, C1-подхвата и защиты от
hostile/polyfill-host здесь нет. Физические параметры должны задавать конечную
затухающую пружину: длительность и плотность `linear()` выводятся из её
полюсов и допуска реконструкции, без wall-clock cap; кривая выше общего
compiler-ceiling отклоняется до синхронной материализации. Defensive-граница,
C1-подхват, fallback и живой solver для сверхдлинных кривых — контракт полного
`./animate`.

```typescript
import { animate } from '@labpics/motion/nano';

const moves = animate('.card', { translate: '240px', rotate: 8, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
  stagger: 40,
});
moves[0]?.pause(); // каждый элемент — нативный Animation
await moves.finished;
```

## Математика значений

| Импорт | Что даёт |
|---|---|
| `…/easing` | Каталог кривых: named-кривые, `cubicBezier`, `steps`, кастомные функции |
| `…/value` | CSS-значения: парсинг/интерполяция единиц (px/%/deg/rem/vh), цветов (hex/rgb/hsl), transform-компонент, `var()`, относительных значений |
| `…/utils` | Value-mapping примитивы (headless-ядро Framer Motion / GSAP): `mapRange`, `interpolate` (N-стоповый маппер: клампинг, per-segment easing, кастомный `mixer`), `clamp`, `wrap`, `snap`, `mix`, `pipe`. Каррируемые config-first, финитность гарантирована |
| `…/spring` | Эргономика пружин: `fromBounce` (duration+bounce ∈ [−1,1], канон SwiftUI ⊇ Motion [0,1]), `fromVisualDuration`, `springPresets` (канон react-spring), `springAsEasing` |

## Композиция движения

| Импорт | Что даёт |
|---|---|
| `…/keyframes` | Ключевые кадры: массивы, offsets, per-keyframe easing, repeat/reverse/yoyo |
| `…/timeline` | Оркестрация: `createTimeline` — сегменты, `seek/progress/totalDuration`, thenable |
| `…/stagger` | Каскадные задержки: списки и 2D-сетки, from/направления/easing |
| `…/decay` | Инерция: аналитическое затухание (drag-momentum, инерционный скролл) |
| `…/presets` | Словарь generic-движений «от смысла» (иконки): 10 фабрик (`pulse`, `blink`, `wiggle`, `spin`, `breathe`, `pop`, `bounceY`, `drift`, `fadeSlide`, `drawOn`), мультитрековые кейфреймы, `runPreset` с виртуальным временем, `presetToWaapi`; текстовые/числовые сахара — `splitText`/`typewriterAt`/`scrambleAt`, `formatNumber` (Intl) + `tickerCells`, раннеры `runTypewriter`/`runScramble`/`runNumber` |
| `…/svg` | SVG: `parsePath`/`pathLength`, draw-математика штриха (`drawPath`), движение вдоль пути (`createMotionPath`) |
| `…/svg-morph` | Морфинг путей: `interpolatePath(dFrom, dTo)` — точный режим при совпадающей структуре, ресэмплинг с выравниванием при разной |

## Взаимодействие и layout

| Импорт | Что даёт |
|---|---|
| `…/gestures` | `createPress` (tap + клавиатурный путь Enter/Space), `createHover`, `createPan`, `createDrag` (границы + rubber-band + инерция + reduced-motion) |
| `…/behaviors` | Headless state machines типовых мобильных взаимодействий: `createBottomSheet`, `createDragDismiss`, `createCarousel`, `createPullToRefresh`. Единый контракт `BehaviorState { value, velocity, phase }`. Подробно — [behaviors.md](behaviors.md) |
| `…/scroll` | Headless-прогресс страницы/target-с-офсетами (семантика Motion), чистая in-view машина, скорость, scrub-клей к timeline |
| `…/in-view` | Нативный `IntersectionObserver`-адаптер: selector/Element/список, custom root/margin/amount, one-shot либо парный enter/leave cleanup; возвращает idempotent `stop` |
| `…/presence` | Enter/exit lifecycle: «доиграй exit-анимацию → потом убирай из DOM», прерывания, `swapPresence` (wait/sync) |
| `…/flip` | Layout-анимация FLIP: инверсия first→last, пружинный «доезд», коррекция scale-искажений (`correctRadius`, `counterScale`) |
| `…/projection` | Вложенный FLIP-движок (жанр Framer projection): transform родителя не искажает детей и border-radius; `projectAt` (чистая математика), `createProjection` (headless-драйвер), `createDomProjection` (DOM-адаптер). Подробно — [projection.md](projection.md) |
| `…/smart` | Smart-animate поверх `./projection` (жанр Figma smart-animate / shared-element): диф двух снимков дерева по `data-motion-key`. Подробно — [smart.md](smart.md) |
| `…/auto` | Zero-config FLIP: `autoAnimate(parent)` — add/remove/move детей анимируются сами; reduced-motion меняет характер (move→снап), не выключает |
| `…/a11y` | `createMotionConfig` — политика reduced-motion (`system`/`always`/`never`), меняет характер анимации, не выключает |

## Compositor-путь и токены

| Импорт | Что даёт |
|---|---|
| `…/waapi` | Низкоуровневый мост: `compileWaapi`/`animateWaapi` (кейфреймы движка → нативный `Element.animate`), `easingToLinear` (любой easing → CSS `linear()`), `supportsWaapi` |
| `…/compositor` | Базовый compositor-компилятор: `compileSpringLinear`, `compileSpringPlan`, `CompositorSpring`, ретаргет, хендофф и fallback-матрица. Подробно — [compositor.md](compositor.md) |
| `…/compositor/stagger` | Самодостаточный групповой compositor-фасад: `compileStaggerPlan`, `CompositorStaggerGroup` и связанные `compileSpringPlan`/`CompositorSpring` из одного entry |
| `…/tokens` | Motion-токены: `duration`, `easing`, `spring`, `staggerGap`, `distanceScale`. Подробно — [tokens.md](tokens.md) |

## Build-tool

| Импорт | Что даёт |
|---|---|
| `…/compiler/vite` | `motionCompiler()` — Vite/Rollup-плагин build-time lowering статических вызовов `./nano` и `animate(..., { layout: 'project' })` (сертификация артефакта на сборке). Подробно — [compiler.md](compiler.md), [future-layout.md](future-layout.md) |
| `…/compiler/runtime` | Исполнитель compiled-вызовов nano; импорт вставляет плагин, вручную не используется |
| `…/surface` | Приватный executor compiled-поверхностей (≤1 KB gz); импорт вставляет плагин, вручную не используется |

## Биндинги

Peer-фреймворк ставит потребитель; все биндинги по умолчанию едут на общем
кадре `./frame`.

| Импорт | Что даёт |
|---|---|
| `…/react` | `useSpring`, `useMotionValue`, `useMotionStyle` (effect-binding: пишет в `style` через ref без render на кадр — аналог `vMotion`), `useReducedMotion` (реактивное системное `prefers-reduced-motion`, hydration-safe) |
| `…/preact` | `useSpring`, `useMotionValue` (зеркало react-биндинга поверх `preact/hooks`) |
| `…/solid` | `createSpring`, `createMotionValue` (сигналы, авто-уборка через `onCleanup`) |
| `…/vue` | `useSpring`, `useMotionValue`, директива `vMotion` |
| `…/svelte` | `springStore` |
| `…/angular` | Angular (v16+): `injectSpring`, `injectMotionValue` (Signals + DestroyRef) |
| `…/qwik` | `useSpring` — управление сигналом `target` (резюм-safe), MotionValue = noSerialize, пересоздаётся на клиенте |
| `…/lit` | `MotionController` (ReactiveController), `LabMotionSpringElement` |
| `…/wc` | Vanilla web-component `<lab-spring>` без зависимостей — путь для Astro/Stencil/HTML-first стеков |

## Ошибки

```typescript
import { MotionParamError, spring } from '@labpics/motion';

try {
  spring({ mass: -1, stiffness: 100, damping: 10 }, 0);
} catch (error) {
  if (error instanceof MotionParamError) {
    if (error.code === 'LM088') console.error('Масса должна быть больше нуля');
    else console.error(`Ошибка движения: ${error.code}`);
  }
}
```

Сообщения движка содержат только стабильный код `LMddd` (входные значения не
отражаются): ветвитесь по `error.code`, причина и исправление — в
[каталоге кодов](errors.md). Тип `MotionParamErrorCode` экспортируется из
корня; совместимый `new MotionParamError('текст')` сохраняет текст и получает
код `LM000`. Для `instanceof` импортируйте constructor из того же физического
entry, что и проверяемую функцию: корневой entry намеренно не связывает
независимые bundle-графы.

## Многоточечные переходы в `./animate`

```typescript
import { animate } from '@labpics/motion/animate';
import { easeOut, linear, easeIn } from '@labpics/motion/easing';

const run = animate(element, {
  x: [0, 120, -40, 0],
  opacity: [0, 1, 1, 0],
}, { duration: 800, times: [0, .25, .75, 1], ease: [easeOut, linear, easeIn] });
run.pause();
run.seek(400); // миллисекунды активного track; пауза сохраняется
run.play();
await run.finished;
```

Значение свойства — конечная цель, пара `[from, to]` или массив из N≥3 stops.
Поддержаны прежние numeric/transform/CSS codecs; массив не меняет смысл CSS-юнитов
или цветов. Первый stop явный: входная скорость старого движения не изменяет
авторскую траекторию. Последующее пружинное перенаправление, напротив, получает
текущее значение и скорость выбранного сегмента.

Без `times` позиции распределены равномерно. С общей `times` или `ease[]` каждый
канал имеет одну authored topology N; scalar и pair означают N=2. Без общей
metadata разные свойства могут иметь разные N. Один `ease` применяется к каждому
сегменту, массив функций имеет N−1 элементов. N-track без easing линеен; без
`duration` используется прежний `duration.base` (200 мс). Обычная from/to-пара без
metadata сохраняет прежний spring/tween выбор и standard easing.

`times` не убывают, начинаются с 0 и заканчиваются 1. Точный interior duplicate
выбирает правый stop и правый ненулевой интервал; endpoints p≤0/p≥1 возвращают
именно первый/последний stop, до easing. Поэтому authored jump не называется C¹.
На гладком сегменте native linear slope точен, производная произвольной JS easing
оценивается существующей ограниченной разностью full-animate. Разность никогда
не пересекает соседний скачок. Не-конечный результат easing заменяется линейным прогрессом. Не-конечная
оценка производной заменяется нулём, как в прежнем tween; эти проверки относятся
к своим точкам sampling. На terminal pose скорость нулевая.

Explicit `spring` несовместим с N-track (`LM136`). Массивы — dense own slots;
длина и элементы считываются до selector/layout/host writes. Бюджет — 100000
входных stops и 100000 expanded stops `targets × channels`; `scale` раскрывается
в две оси. Metadata arrays тоже bounded. Sparse, сверхлимитные или недопустимые
массивы дают `LM173`; несовпадение topology, невалидные offsets/easing используют
коды из [каталога ошибок](errors.md). При пустых props metadata всё ещё проверяется.

Linear numeric transform/opacity surfaces с переносимой одинаковой function-list
исполняются одной WAAPI Animation на поверхность, без собственного rAF в steady
state. JS easing, повторные offsets, несовместимые transform lists и CSS codecs
остаются на существующем SurfaceBatch, не на втором scheduler. Capability является
деталью исполнения; hardware/compositor residency любого свойства не обещается.
Объединение шкал также bounded: если native data превысили бы 100000
значений `offsets × channels`, используется исходный sampler без expansion.
При непредставимом оставшемся delay от огромного отрицательного native clock
`play()` выдаёт `LM139` до host-effects; paused run можно восстановить `seek()`.

`delay`, `stagger`, `play/pause/seek/cancel/stop`, один `finished` и один natural
`onComplete` сохраняются. Native pause/play и seek продолжают исходный authored
track, не создают новую пружину. Cancel сохраняет текущую позу, а не возвращает
первый stop. После завершения controls инертны; replay — новый `animate`.
Reduced motion публикует последний stop без rAF/WAAPI reservation и игнорирует
задержки. Реентрантные seek/pause/cancel отзывают старое вычисление; derivative
capture использует reservation того же owner и не допускает его вложенную замену.

Это runtime-контракт. Существующий compiler не понижает новые N-вызовы: при
сомнении сохраняется обычный runtime, а не другая трактовка tracks. Wire MotionProgram
остаётся versioned; JS functions и прочие невыразимые формы не объявляются portable.
Repeat, per-property transition objects и sequences этим API не добавляются.
