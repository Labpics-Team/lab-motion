# Журнал изменений

Здесь фиксируются заметные потребителю изменения опубликованных версий.

Формат основан на Keep a Changelog. Версионирование следует SemVer; до `1.0.0` несовместимые изменения публичного контракта выпускаются новым minor-релизом.

## [Unreleased]

### Added

- Воспроизводимый release-процесс с проверкой версии, полным набором гейтов и npm provenance.
- Политики вклада и безопасности, шаблоны issues и pull requests.
- Регулярный mutation-прогон критического численного ядра.

### Changed

- CI выполняется на изолированном GitHub-hosted runner с минимальными разрешениями и отменой устаревших прогонов.

## [0.1.0] — 2026-07-09

### Added

- Первая публичная версия `@labpics/motion`.
- Headless-ядро пружин, tween, `drive` и `MotionValue`.
- Модульные точки входа для timeline, gestures, scroll, presence, FLIP, SVG, WAAPI, compositor, токенов и framework bindings.
- Размерные, contract, property, fuzz, package-smoke и mutation-проверки.
