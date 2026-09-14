# Справочник субпутей @labpics/motion

> Роль: справка — карта всех публичных входов пакета и их контрактов.
> Число входов выводится из `package.json` и проверяется автоматически
> (`check-docs-drift` по NAMING.md, `test/readme-facts.test.ts` по README);
> состав экспортов запинен api-surface-pin тестами. Группировка — канон
> [NAMING.md](NAMING.md).

Импорт — `@labpics/motion` (ядро) или `@labpics/motion/<субпуть>`.
Корневой экспорт + 42 субпути; неиспользуемые субпути вырезаются
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


## Область анимаций компонента

`createAnimateScope(root): AnimateScope` — дополнительный экспорт `./animate`.
`root` реализует `AnimateScopeRoot.querySelectorAll(selector): ArrayLike<unknown>`:
подходят Element, Document и ShadowRoot. Неверный query-host даёт `TypeError`.
Factory ничего не анимирует и не читает глобальный document.

- `scope.animate(target, props, options?)` возвращает обычный `AnimateControls`.
  Строка сначала разрешается относительно root, затем результат проходит защитную
  границу полного animate. Selector errors остаются host errors; явные targets
  проходят без query и не ограничиваются потомками root.
- `scope.destroy()` отказывает новым запускам, отменяет учтённые handles и снимает
  root. Вызовы после destroy возвращают завершённый no-op, не читая входы.
  Повторный destroy бездействует. Незавершённый reentrant setup отменяется после
  возврата controls; host reservation дренируется одной микрозадачей, без rAF.
- `finished`, natural/onComplete, reduced motion и ownership сохраняют контракт
  animate. Завершённые handles удаляются из учёта. Нет автоматического revert
  стилей, удаления listeners или отмены чужого successor.
- Синхронные cleanup errors: одна пробрасывается буквально, несколько дают
  `AggregateError`; остаточные ошибки финального прохода передаются `reportError`
  среды, если он доступен. Неисправный host не получает обещания полного rollback.

Сценарии DOM, React и Solid с одним cleanup приведены в
[рецептах компонентной области](recipes.md#анимации-принадлежащие-компоненту).

## Ядро и управление

| Импорт | Что даёт |
|---|---|
| `@labpics/motion` | `spring` (аналитический closed-form солвер), `tween`, `drive` (декларативный запуск), `MotionValue` (реактивное значение со smooth-pickup), `MotionParamError` |
| `…/driver` | Scrubbable-контроллер: `play/pause/reverse/seek/timeScale/progress` + thenable |
| `…/frame` | Единый frame-шедулер: `createFrameLoop` / синглтон `frame` — один rAF на кадр, фазы read→update→render против layout-thrash, SSR-safe; `asRequestFrame(loop)` сажает `MotionValue`/`drive` на общий кадр. **Биндинги используют его по умолчанию** (как shared-ticker у Framer Motion/GSAP); инжекция своего `requestFrame` переопределяет |
| `…/nano` | **Platform-trusted WAAPI to-only ≤ 1 КБ gzip**: spring/tween, `delay`/`stagger`, reduced-motion, сами `Animation` как контролы; полный контракт и границы — ниже |
| `…/animate` | Фасад-one-liner: `animate(target, props, options)` и `createAnimateScope(root)` — цели по каналам (`x`/`y`/`scale`/`rotate`, `opacity`, CSS-свойства), режим `{ spring }` или `{ duration, ease }`, `delay`/`stagger`, контролы `{ finished, play, pause, seek, cancel, stop }`. Это базовый single-transition DX-срез; ядро от него не растёт |

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
| `…/behaviors` | Headless state machines типовых мобильных взаимодействий: `createBottomSheet`, `createDragDismiss`, `createCarousel`, `createPullToRefresh`. Их общий контракт `BehaviorState { value, velocity, phase }`; отдельный `createStateCascade` разрешает цели конкурирующих визуальных намерений по свойствам. Подробно — [behaviors.md](behaviors.md) |
| `…/scroll` | Headless-прогресс страницы/target-с-офсетами (семантика Motion), чистая in-view машина, скорость, scrub-клей к timeline |
| `…/in-view` | Нативный `IntersectionObserver`-адаптер: selector/Element/список, custom root/margin/amount, one-shot либо парный enter/leave cleanup; возвращает idempotent `stop` |
| `…/presence` | [Управляемый вход/выход](presence.md): `createPresenceTransition`, группа исполнителей и одна цель видимости; ручной `createPresence`, `swapPresence` (wait/sync) |
| `…/flip` | Layout-анимация FLIP: инверсия first→last, пружинный «доезд», коррекция scale-искажений (`correctRadius`, `counterScale`) |
| `…/projection` | Вложенный FLIP-движок (жанр Framer projection): transform родителя не искажает детей и border-radius; `projectAt` (чистая математика), `createProjection` (headless-драйвер), `createDomProjection` (DOM-адаптер). Подробно — [projection.md](projection.md) |
| `…/smart` | Smart-animate поверх `./projection` (жанр Figma smart-animate / shared-element): диф двух снимков дерева по `data-motion-key`. Подробно — [smart.md](smart.md) |
| `…/auto` | Zero-config FLIP: `autoAnimate(parent)` — add/remove/move детей анимируются сами; reduced-motion меняет характер (move→снап), не выключает |
| `…/a11y` | `createMotionConfig` — политика reduced-motion (`system`/`always`/`never`), меняет характер анимации, не выключает |

## Compositor-путь и токены

| Импорт | Что даёт |
|---|---|
| `…/waapi` | Низкоуровневый native-мост: `compileWaapi`/`animateWaapi`; `animateScrollWaapi`/`animateViewWaapi` отдают scroll/view-progress → property нативным progress timelines без собственного покадрового JS и без скрытого fallback; capability probes явные |
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

## Управляемая перестановка `./behaviors/reorder`

`createReorder({ items, axis?, direction?, onReorder })` — опциональный headless
resolver. Не импортируется корнем, `./animate`, `./nano` или `./behaviors`.
Типы: `ReorderKey`, `ReorderItem`, `ReorderOptions`, `ReorderController`,
`ReorderSession`, `ReorderProposal`, `ReorderAxis`, `ReorderStep`.

`items` — snapshot в подтверждённом порядке приложения: `{ key, rect? }`.
Key — string или конечный number; сравнение Map/SameValueZero (0 и -0 один key).
Неизмеренные и нулевые прямоугольники не являются drop targets. Координаты
и размеры — конечные дробные числа с абсолютным значением не выше
`Number.MAX_SAFE_INTEGER`; размеры неотрицательны, центр тоже в диапазоне.
Размер snapshot до 100000, проверяется до индексных getters. Структурные ошибки
дают `TypeError`, числовой envelope — `RangeError`; это не физические параметры
и не новый численный код `MotionParamError`. Исключения getters/callback сохраняются.

`axis` — `x`, `y`, `both` или `auto` (дефолт). Auto: одинаковый y центров → x,
иначе одинаковый x → y, иначе both; в пустом snapshot both. Разновысокие карточки
могут требовать явного axis. `direction` — ltr по умолчанию, rtl меняет logical
порядок горизонтальной клавиатуры; в 2D стрелки выбирают геометрическую полуплоскость.

`start(key)` возвращает session только для измеренного ненулевого slot.
Новый допустимый start отзывает старую session; неизвестный key её не прерывает.
`session.move({x,y})` получает **желаемый центр карточки**, не delta и не обязательно
точку указателя. Выбирается ближайший центр slot в заданных осях. На равенстве
побеждает собственный slot, затем первый в подтверждённом порядке. Приложение
отвечает за bounds/scroll/перевод координат; resolver не выполняет DOM-read.

`session.step` принимает previous/next/first/last и left/right/up/down. Logical
шаг не перескакивает через неизмеренную соседнюю цель. В 2D физическая стрелка
выбирает ближайший измеренный центр в открытой полуплоскости направления.
Pointer и keyboard используют одну вставку перемещаемого key в индекс target.

`onReorder(frozenKeys, frozenProposal)` вызывается только при новом предложении,
**не подтверждает** порядок. Proposal содержит key/over/from/to. После принятия
приложение вызывает `update(items)` с фактическим порядком и geometry. Update
отзывает proposal, сохраняет session по key, отменяет её при исчезновении
key/geometry. До async commit проверяйте `isCurrent(proposal)`: это проверка
точной identity последнего предложения, не сравнение индексов старого массива.
Возврат pointer в собственный slot тоже отзывает предложение.

`session.end/cancel`, `controller.cancel` прекращают ввод без отката уже принятых
данных. Callback throw отменяет только ту же session и пробрасывает исходную
ошибку; созданная вложенным callback новая session не теряется. Input snapshot
атомарен: успешный вложенный update выигрывает, неуспешный не отзывает внешний.
`destroy` идемпотентен, освобождает snapshot/callback; stale session и вызовы
update/start после него инертны. Завершённая session не удерживает owner.

В resolver нет scheduler/animation/DOM/global registry. Snapshot стоит O(N),
pointer scan O(N), unchanged intent не выделяет массив/Map и не вызывает
callback. Новое предложение создаёт O(N) permutation; потребительская animation
и DOM-перестановка оплачиваются отдельно.

[Исполняемый list/grid-рецепт с projection, pointer, keyboard и cleanup](recipes.md#перестановка-списка-или-сетки).
