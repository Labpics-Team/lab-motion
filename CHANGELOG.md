# Журнал изменений

Здесь фиксируются заметные потребителю изменения опубликованных версий.

Формат основан на Keep a Changelog. Версионирование следует SemVer; до `1.0.0` несовместимые изменения публичного контракта выпускаются новым minor-релизом.

## [Unreleased]

### Removed

- **Breaking (pre-1.0):** публичные входы `./animate/mini` и `./animate/native`
  удалены вместе с их гейтами и тестами; линейка анимации — ровно два входа:
  `./nano` (platform-trusted, ≤1 КБ) и `./animate` (полный контракт).
  Нишу native закрывает `./nano`; one-liner-сценарии mini живут в `./animate`
  с тем же сигнатурным контрактом. Опубликованный npm `0.1.0` этих subpath не
  содержал — миграция не требуется. Коды `LM145/LM148/LM152–LM155` переведены
  в `retired`.

### Added

- `./nano`: platform-trusted WAAPI to-only вход под hard gate 1 КБ gzip:
  spring/tween, целые `translate/scale/rotate` longhand-каналы, CSS-значения
  силами браузера, delay/stagger, reduced-motion и native `Animation` controls.
  Скрытого layout-read, rAF-fallback, C1-подхвата и hostile-host контракта нет;
  кривые выше общего compiler-ceiling отклоняются до materialization.

### Changed

- Ядро: `drive` и `MotionValue` используют один поздно привязываемый default
  frame-scheduler; дублированный runtime удалён без смены rAF/fallback-семантики.
- `./compositor`: exact-key LRU вынесен в functional state без смены policy;
  общий cache сохраняет O(1) lookup, нулевые аллокации на hit и прежний порядок
  вытеснения, а одноразовая проверка ёмкости складывается при сборке.

### Fixed

- `./presets`: `splitText(..., 'chars')` теперь делит текст по extended
  grapheme clusters через `Intl.Segmenter`, поэтому combining marks, emoji-ZWJ,
  flags, Hangul и Indic conjuncts не рвутся; явный exact-segmenter шов покрывает
  старые среды, а без него сохраняется прежний code-point fallback.
- `./animate`: main-thread stagger сохраняет субкадровую фазу — монотонное
  logical-time и signed local phase не дают малым задержкам (< кадра)
  схлопнуться в один кадровый bucket, overshoot не теряется.
- `./compositor`: WAAPI effect и fallback timer теперь атомарно сменяют единственного
  owner; stale callbacks и реентрантный host-cleanup не могут оживить или отменить
  новый прогон, а `destroy()` разрывает удержание target, effect и timer.
- `./auto`: exit использует единое identity-владение между сессиями; stale
  observer больше не забирает перенесённый узел, а reentrant disconnect
  детерминированно освобождает ghost, handlers, style leases и parent-ссылки.
- `./animate`: uniform/axial scale сохраняет обе оси и точные signed-zero края;
  pause/seek переносит effect-space скорость без скачка, а несовместимые оси
  продолжает независимым main-thread путём вместо ложного общего WAAPI-progress.
- `./animate`: переполнение составной delay отклоняется до host-effects, а
  завершение задержек длиннее диапазона HTML timer сверяется с WAAPI-clock без
  раннего settle, starvation и скачка terminal pose.
- Сборка: параллельная минификация ESM/CJS изолирует настройки Terser, поэтому
  повторный запуск даёт тот же CJS-артефакт, включая strict-семантику и mangling.
- `./animate/native`: host-методы вызываются без доверия к own `.call`,
  доставка завершения не зависит от глобальной `queueMicrotask`, отмена
  разрывает связь вечного host `finished` с DOM, а несходящаяся реентрантная
  компенсация завершается `LM157` вместо ложного успеха.
- `./frame`: единый identity-владелец резервирования гасит stale/двойную доставку,
  любой синхронный `requestFrame` проходит через отменяемый async-trampoline, а
  только ошибка текущего владельца демотирует clock без потери живых подписок.
  `cancelAll()` завершает teardown атомарно; off/once/rollback сразу освобождают
  callback и DOM-ссылки, массовая отписка остаётся линейной.

## [0.3.0] — 2026-07-13

### Added

- `./animate/native`: узкий WAAPI-путь `springTo` для явных пар
  transform/opacity. Отдельная `Animation` на независимый CSS-канал цели
  позволяет вытеснять transform и opacity раздельно; скрытого rAF-fallback нет.
  Chromium/Firefox используют CSS `linear()`, WebKit — явные адаптивные кадры.

- `./react`: `useReducedMotion(): boolean` — реактивно отражает системное
  `prefers-reduced-motion` (фаза I, срез 2, #104): перерендеривает компонент при
  переключении предпочтения на лету. Построен на `useSyncExternalStore` —
  **hydration-safe** (серверный снапшот `false`, совпадает с SSR-разметкой;
  реальное значение читается после commit). Реактивная подписка ПЕРЕИСПОЛЬЗУЕТ
  `./a11y` `createMotionConfig` (системный `matchMedia`-'change' слушатель +
  legacy `addListener`-fallback + leak-safe `destroy()`) — без дублирования логики
  подписки. SSR/Node-safe (`false` без `matchMedia`); matchMedia-шов инжектируется
  для детерминизма тестов. Закрывает пробел «нет подписки на смену matchMedia»,
  отмеченный adversarial-ревью среза 1.
- `./react`: `useMotionStyle` — **effect-binding** хук (фаза I, #104): гонит CSS-
  свойство от пружины БЕЗ ре-рендера компонента на каждом кадре. В отличие от
  `useSpring` (*render value* — компонент рендерится на кадр, чтобы отразить
  число), `useMotionStyle` владеет `MotionValue` и пишет прямо в `element.style`
  внутри подписки `onChange`; компонент рендерится только при смене `target`.
  Возвращает стабильный ref-callback; опции зеркалят Vue-директиву `vMotion`
  (`target`/`property`/`template`/`from`/`spring`/`reducedMotionMode`/
  `requestFrame`) для паритета тонких адаптеров. Retarget сохраняет скорость (C¹),
  reduced-motion = мгновенный CHARACTER-снап без кадров, unmount гасит цикл
  (`unsub`+`destroy`). Доказано в реальном React-рантайме (jsdom + `createRoot`/
  `act`): счётчик render не растёт за 200-кадровую анимацию, а `style` реально
  анимируется (RED при подмене прямой записи на no-op).
- `./behaviors`: новый субпуть — headless state machines типовых мобильных
  взаимодействий поверх ПЕРЕИСПОЛЬЗУЕМЫХ примитивов (ничего не дублировано):
  трекер скорости `./gestures`, проекция момента `./decay` (`.rest`), пружинный
  солвер ядра (доводка value→target с наследованием velocity, C¹), темп-токены
  `./tokens` (дефолтные пружины; роль задаёт потребитель, labui НЕ импортируется).
  Общий контракт `BehaviorState { value, velocity, phase }`
  (`phase ∈ idle|follow|release|settle`); события ввода (`pointerDown`/`Move`/`Up`/
  `Cancel`), `state`-геттер + `subscribe`, программные переходы, идемпотентные
  `cancel()`/`destroy()`. Четыре поведения: **`createBottomSheet`** (snap-точки +
  выбор цели по положению+скорости, follow→доводка без потери velocity, rubber-band
  за крайними snap, `snapTo`, перехват pointer-down); **`createDragDismiss`** (порог
  по смещению/скорости, настраиваемое направление, возврат с унаследованной
  скоростью, детерминизм при pointer-cancel); **`createCarousel`** (ЕДИНЫЙ clock
  позиции+индекса, inertia с доводкой к странице, направление+velocity в выборе,
  RTL и вертикаль, `goTo`/`next`/`prev`); **`createPullToRefresh`** (резистентный
  overscroll, порог активации, `pending` без второго владельца позиции, возврат
  пружиной после async-действия). Инварианты: ОДНА state machine владеет фазой
  (единый generation-токен, ноль параллельных loops); value/velocity конечны (+0);
  reduced-motion = смена характера (мгновенный снап, состояние и результат
  сохранены); SSR-safe (инжектируемый `requestFrame`). Покрытие: example/contract/
  interruption/cancel-destroy/reduced на каждое поведение, property-тесты выбора
  snap/страницы (seeded-LCG, оракул `./decay`), fuzz финитности (≥12 000 злых
  жестов), 2 browser-conformance спеки (pointer capture/cancel на реальном движке).
  Runnable DOM-адаптер и раздел «Behaviors-путь» — в README (#92).

- `./animate/mini`: новый субпуть — лёгкий срез animate с потолком **≤ 5 KB gz**.
  Внутри движок разделяет кодеки свойств и адаптер цели; публичный набор
  фиксирован: числовой transform/opacity, CSS-переменные и DOM-цель. Mini
  не тянет расширенный набор, `./value` и compositor-компилятор (граф проверяется
  import-cost сценарием). Покрытие: transform-шортхенды, `opacity`, CSS-переменные,
  spring/tween в едином прогресс-клоке (значение канала — скаляр/строка/`[from, to]`),
  `delay`/`stagger`, контролы `{ finished, play, pause, seek, cancel,
  stop }`, C¹-подхват value+velocity при повторном запуске (dominant-канал),
  фазы кадра update→render единого `./frame` (чтение once при привязке, запись —
  в render), reduced-motion снап, SSR-safe импорт, fail-fast `MotionParamError`
  ДО записи стиля. Расширенные кодеки и адаптеры проверяются как внутренняя
  архитектура, но не экспортируются как публичный API npm-пакета. Финитность
  проверяется seeded-LCG фаззингом `codec.interpolate`. Compositor-путь в mini
  не включён из-за размерного потолка; полный WAAPI-путь находится в `./animate`.
  Таблица миграции с Motion JS / Anime.js — в README (#103).
- `./smart`: новый субпуть — Figma-подобный smart-animate поверх `./projection`
  (жанр shared-element). Диф ДВУХ снимков дерева по строке-ключу `data-motion-key`
  → `matched`/`entered`/`exited`/`skipped`, оркестрация поверх ОДНОГО
  projection-движка: matched едут FLIP'ом (continuity по строке-ключу переживает
  ПЕРЕСОЗДАНИЕ DOM-узла — перехват берёт аналитический `V(p̂)` и пересеивает
  скорость, C¹), entered — fade-in без transform, exited — ghost-протокол
  (реинсерт `absolute` на padding-box, `removeChild` до резолва `finished`,
  реинкарнация ключа), единый clock. `reduced` = смена характера (matched снап,
  фейды живые), `resolveSmartTier` (`reduced`/`projection`/`ssr`), SSR-инертность,
  fail-fast `MotionParamError` на параметрах и дубликате ключа. API: `captureSmart`,
  `smartTransition`, `resolveSmartTier`, `SMART_KEY_ATTR`. Финитность — fuzz-гейт
  ≥10 000 злых дифов (ни броска, ни NaN/∞/`-0`). Минимальный скоуп #99: нативный
  View Transitions API вырезан (отдельная фаза) (#99).
- `./animate`: tween-режим вычисляет аналитическую скорость канала —
  v = range · ease′(k) / duration (производная изинга — детерминированная
  центральная разность с фиксированным шагом) вместо нуля каждый кадр:
  перехват tween→spring вторым `animate()` наследует импульс, smooth pickup
  стал C¹ на tween-пути, как на spring-пути (#93).
- `./animate`: CSS/value-каналы (цвета, юнитные значения) наследуют скорость
  при перехвате вторым `animate()` — вместо безусловного `v0 = 0` производная
  прогресса ṗ̂ источника проецируется в прогресс-пространство новой
  интерполяции по доминантному компоненту старого спана (канон dominantV0
  WAAPI-пути): юнитные значения и коллинеарные цветовые ретаргеты — точный C¹,
  явная пара `[from, to]` по-прежнему отключает подхват; `var()`/relative/
  несовместимые виды AST — C⁰ (скорость не определена → покой) (#93).
- `./animate`: связная векторная группа каналов (`x`/`y`/`scale`, …) —
  контракт единого времени закреплён характеризационными тестами: одна группа
  = один rAF-цикл (или одна WAAPI-кривая), каждый кадр — атомарный вектор с
  одного `t`, перехват снимает когерентный вектор `(value, velocity)` всех
  каналов с одного `t̂`, группа оседает единым кадром (#93; поведение уже
  держалось конструкцией — без изменений рантайма).
- `./driver`: геттер `AnimationControls.velocity` — аналитическое чтение
  скорости live-рана (units/s) в произвольный момент, симметрично `progress`
  и по канону `MotionValue.velocity`: hidden-state скорость траектории
  (clamp-режим не влияет), в покое и после завершения — ровно 0 (#93).
- `./gestures`: второй аргумент `pointerDown(p, pickup?)` у `DragControls` —
  внешний прайор скорости захвата `{vx, vy}` (px/s) для элемента, летящего
  ЧУЖИМ аниматором (compositor/WAAPI-ран): жест наследует живой импульс,
  немедленный release продолжает движение (C¹, #93, строка матрицы
  «compositor → gesture»). Явный pickup авторитетен и замещает внутренний
  glide-прайор; вырожденные компоненты (NaN/±∞/не-число) → ровно 0. Прямой
  связки gestures→compositor нет (субпути независимы) — рецепт: снять
  скорость `readCompositorSpring` в pointerdown и передать (README, докблок).
- `./presence`: наследование импульса при прерывании (C¹, #93, строка матрицы
  «exit → enter»). Колбэки фаз получают `(done, interrupted, capture)`:
  `capture(read)` регистрирует живой снимок текущего рана (непрозрачный `S`,
  по умолчанию пара `PresenceSnapshot { value, velocity }`), при прерывании
  (enter во время exiting / симметрично exit во время entering) машина
  синхронно читает его и передаёт новой фазе — reversed continuation вместо
  телепорта/старта с нуля. Снимок читается только из живой прерываемой фазы
  (после done — не наследуется), reduced-motion его не читает (без импульса);
  регистратор прерванной фазы инертен (generation-гард). Обратная
  совместимость полная: прежние колбэки `(done) => …` работают без изменений.
- `./gestures`: опция `snapBackSpring` у `createDrag` — при касании границы
  `bounds` инерционным глайдом остаточная скорость передаётся пружинному
  snap-back (iOS-манера: короткий overshoot за границу и упругий возврат
  ровно на неё), стык decay|spring непрерывен по позиции и скорости (C¹).
  Отсутствие опции = прежнее поведение (жёсткий clamp на границе);
  невалидная пружина → `MotionParamError` синхронно из `createDrag` (#93).

### Changed

- `CompositorStaggerGroup.handoffToLive` теперь всегда проверяет индекс: после
  `destroy()` существующий ребёнок возвращает инертный `MotionValue`, а
  отсутствующий стабильно завершает вызов с `LM020` вместо искусственного
  значения без владельца.

- До `1.0` несовместимое изменение: `compileStaggerPlan` и
  `CompositorStaggerGroup` перенесены из `./compositor` в
  `./compositor/stagger`. Новый фасад также экспортирует `compileSpringPlan` и
  `CompositorSpring`, чтобы одиночные и групповые переходы использовали один
  consumer-entry. Deprecated alias не оставлен: он вернул бы групповой граф в
  базовый compositor.

- `MotionParamError` получил добавочное поле `.code` и экспортируемый тип
  `MotionParamErrorCode`. Внутренние сообщения теперь содержат только `LMddd`,
  без отражения входных значений; причины и исправления находятся в каталоге.
  Разбор старого prose/detail-текста `message` несовместим, ветвление по `.code`
  стабильно; строковый публичный конструктор сохраняет текст с `LM000`.

- `./animate`, `./animate/mini`, framework bindings и web component используют
  один общий фазовый frame-loop. Массовый запуск больше не создаёт отдельный
  `requestAnimationFrame` и отдельный Promise на каждую группу.
- `drive` и `MotionValue` переиспользуют один буфер результата солвера на весь
  прогон; `./stagger` считает расстояния в одном массиве. Горячий кадр не
  создаёт result-объект, а каскад не держит второй буфер размера группы.
- Compositor-компилятор учитывает начальную скорость в горизонте и бюджете сетки,
  хранит exact IEEE-754 ключи в ограниченном LRU и сохраняет стартовую касательную.
- `compileSpringPlan` в WebKit выдаёт исполнимые явные кадры; `nodes` теперь
  являются свежим снимком фактически сериализованных остановок в пределах
  `tolerance`, а повторная компиляция переиспользует подготовленную кривую из кэша.

- npm-артефакт получил раздельные ESM/CJS declaration-ветки для всех экспортов,
  `typesVersions` для legacy TypeScript resolver, точный `sideEffects`-allowlist,
  честный Preact floor `10.3.1` и consumer-гейты на реальные байты tarball.
- Релиз собирает tgz один раз, после всех гейтов фиксирует тег, публикует только
  опечатанный artifact через OIDC и проверяет registry integrity и SLSA provenance.

- Минимальный runtime-контракт поднят до Node.js 22: ветки 18 и 20 больше не
  получают security-исправления, а CI и package-manager работают на поддерживаемой
  LTS-линии. Это несовместимое изменение следующего minor-релиза.

- **`./gestures`: захват летящего объекта наследует скорость глайда** (#93,
  осознанный фикс дефекта C¹-контракта). `pointerDown` во время инерционного
  глайда теперь засевает velocity tracker текущей скоростью глайда (прайор в
  скользящем окне): немедленный release без движения продолжает движение,
  а не обнуляет его. Прежнее наблюдаемое поведение (press→release во время
  глайда убивал скорость) считалось дефектом; удержание пальца дольше окна
  трекера (0.1 s) по-прежнему естественно гасит скорость до нуля.

### Fixed

- WebKit получает явные ключевые кадры: пружина продолжает движение при
  блокировке главного потока. ESM-файлы `dist` используют браузерные относительные
  импорты общего frame-loop и загружаются напрямую из CDN.
- Full/mini/WAAPI одинаково сохраняют паузу при `seek`; `NaN` и `±Infinity`
  игнорируются. Медленные пружины не завершаются искусственно после 2000 кадров,
  а нулевой диапазон не теряет унаследованный импульс.

- Framework bindings при reduced motion атомарно снэпают состояние без
  отложенного stale-кадра; React-адаптер сохраняет владельца `MotionValue` при
  StrictMode replay и уничтожает его только при настоящем unmount.
- Удалён цикл `compositor ↔ stagger`; новый статический гейт запрещает возврат
  циклических импортов.
- Headless-типы больше не требуют `lib.dom`, а npm-runtime не содержит ссылок
  на исключённые sourcemap-файлы.

- `MotionValue`: `NaN`/`±Infinity` в `opts.initialVelocity` больше не
  трактуются молча как «нет сида» — конструктор бросает `MotionParamError`
  синхронно, как для `initial`/`spring` (паритет с `drive()`; нота ревью #112).

## [0.2.0] — 2026-07-10

### Added

- Субпуть `./projection` — вложенный FLIP-движок: чистая геометрия (transform
  родителя не искажает детей и border-radius), headless-драйвер с velocity
  continuity при перехвате (`seek`/`release` под жест) и тонкий DOM-адаптер
  (page-space, composed-обход открытых shadow root'ов, граница
  batch clear→measure→start).
- `./tokens`: `springFromDurationBounce(durationS, bounce)` — каноническая
  пара восприятия (модель SwiftUI/Motion.dev) → `SpringParams` с гарантией
  оседания; ДС-пружины `spring.smooth` и `spring.expressive`.
- Воспроизводимый release-процесс с проверкой версии, полным набором гейтов и npm provenance.
- Политики вклада и безопасности, шаблоны issues и pull requests.
- Регулярный mutation-прогон критического численного ядра.

### Changed

- **Словарь motion-токенов сведён с SSOT дизайн-системы labui** (minor по
  политике до 1.0). Миграция: `duration.normal` → `duration.base`; шкала
  длительностей 150/250/400/600 → **100/200/300/500** мс; изинги
  `easing.entrance`/`easing.exit` → `easing.decelerate`/`easing.accelerate`
  (официальные кривые M3), `easing.standard` → `cubic-bezier(0.2, 0, 0, 1)`,
  `easing.emphasized` → единственная кривая с overshoot
  `cubic-bezier(0.38, 1.21, 0.22, 1)`; полоса `distanceScale` → 100→300 мс.
- CI выполняется на изолированном GitHub-hosted runner с минимальными разрешениями и отменой устаревших прогонов.

## [0.1.0] — 2026-07-09

### Added

- Первая публичная версия `@labpics/motion`.
- Headless-ядро пружин, tween, `drive` и `MotionValue`.
- Модульные точки входа для timeline, gestures, scroll, presence, FLIP, SVG, WAAPI, compositor, токенов и framework bindings.
- Размерные, contract, property, fuzz, package-smoke и mutation-проверки.
