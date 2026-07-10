# Журнал изменений

Здесь фиксируются заметные потребителю изменения опубликованных версий.

Формат основан на Keep a Changelog. Версионирование следует SemVer; до `1.0.0` несовместимые изменения публичного контракта выпускаются новым minor-релизом.

## [Unreleased]

### Added

- `./animate/mini`: новый субпуть — ЛЁГКИЙ срез animate (потолок **≤ 5 KB gz** =
  5120 B; факт 5113 B gz shipped / 5287 B gz import-cost) поверх **адаптерной архитектуры**
  целей/свойств. Внутренняя граница — `PropertyCodec` (parse/interpolate/
  serialize/canComposite) и `TargetAdapter` (read/surfaceOf/compose/apply) в общем
  реестре (`createRegistry`): движок дергает кодек/адаптер и НИКОГДА не ветвится по
  имени свойства — новый вид входит РЕГИСТРАЦИЕЙ, а не ростом switch. mini
  регистрирует минимум (числовой transform/opacity + CSS-переменная + DOM-адаптер)
  и НЕ тянет full-набор/`./value`/compositor-компилятор (граф проверяется
  import-cost сценарием). Покрытие: transform-шортхенды, `opacity`, CSS-переменные,
  spring/tween в ЕДИНОМ прогресс-клоке (значение канала — скаляр/строка/`[from, to]`;
  keyframe-массивы и per-property переходы — субпуть `./animate`, НЕ mini),
  `delay`/`stagger`, контролы `{ finished, play, pause, seek, cancel,
  stop }`, C¹-подхват value+velocity при повторном запуске (dominant-канал),
  фазы кадра update→render единого `./frame` (чтение once при привязке, запись —
  в render), reduced-motion снап, SSR-safe импорт, fail-fast `MotionParamError`
  ДО записи стиля. Расширенный набор (`createFullRegistry`): кодек цвета (reuse
  `./value`), SVG-атрибут-адаптер, plain-object адаптер (**ноль DOM** — цель =
  чистое JS-состояние) — contract-тесты на CSS-переменные, SVG-атрибуты и
  plain-object. Финитность — seeded-LCG фаззинг `codec.interpolate` (≥12 000 на
  кодек). ГРАНИЦА первой версии (потолок 5 KB): compositor-offload (WAAPI через
  compileSpringPlan) в mini НЕ включён — floor «compositor+codecs+registry+frame»
  = 5186 gz БЕЗ движка, физически не под 5120; полный WAAPI-путь — в `./animate`.
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

- **`./gestures`: захват летящего объекта наследует скорость глайда** (#93,
  осознанный фикс дефекта C¹-контракта). `pointerDown` во время инерционного
  глайда теперь засевает velocity tracker текущей скоростью глайда (прайор в
  скользящем окне): немедленный release без движения продолжает движение,
  а не обнуляет его. Прежнее наблюдаемое поведение (press→release во время
  глайда убивал скорость) считалось дефектом; удержание пальца дольше окна
  трекера (0.1 s) по-прежнему естественно гасит скорость до нуля.

### Fixed

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
