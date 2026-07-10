# Журнал изменений

Здесь фиксируются заметные потребителю изменения опубликованных версий.

Формат основан на Keep a Changelog. Версионирование следует SemVer; до `1.0.0` несовместимые изменения публичного контракта выпускаются новым minor-релизом.

## [Unreleased]

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
