/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: аналитическое ядро — spring/solver, keyframes, MotionValue, decay,
 * value/color, sliding-window, tween и чистая projection-геометрия. Точные
 * результаты принадлежат HTML-артефакту каждого scheduled-прогона и не
 * дублируются здесь устаревающими числами.
 *
 * Остаток выживших keyframes/motion-value/decay — задокументированные ЭКВИВАЛЕНТНЫЕ
 * ('mirror' yoyo'ит и без нормализации; границы `<`↔`<=`; gen ++/--; `!==undefined`
 * избыточен с isFinite) и НЕДОСТИЖИМЫЕ defensive-ветки (MAX_FRAMES-cap для валидных
 * пружин; finite-net поверх clamp; velocity-конъюнкт снап-guard; Infinity-short-circuit
 * = формула в пределе); догон до 100% — театр (Гудхарт).
 *
 * НАМЕРЕННО вне скоупа: drive (обёртка над MotionValue) и субпути/биндинги —
 * пинятся тяжёлыми differential/frame-сьютами + per-PR диверсиями. Расширять при нужде.
 *
 * `break` — регрессионный порог: планировщик валит прогон, если mutation score
 * падает НИЖЕ него (эрозия силы сьюта). Значение — консервативный пол
 * проверенного baseline, а НЕ цель 100%
 * (константа Гудхарта: 100% геймится, часть выживших — не-поведенческие
 * мутации текста ошибок / недостижимые defensive-ветки).
 *
 * pnpm-изоляция: плагин раннера объявлен явным именем (дефолтный glob
 * '@stryker-mutator/*' не резолвится под изолированным node_modules pnpm).
 */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  // Wall-clock тесты выполняются обычным CI. Инструментированный код Stryker
  // намеренно медленнее и не должен подменять функциональный mutation-оракул.
  vitest: { configFile: 'vitest.stryker.config.ts' },
  // Чистая projection-геометрия входит в тот же scheduled baseline, что физика.
  mutate: ['src/spring.ts', 'src/internal/solver.ts', 'src/keyframes/index.ts', 'src/motion-value.ts', 'src/decay.ts', 'src/value/color.ts', 'src/internal/sliding-window.ts', 'src/tween.ts', 'src/projection/geometry.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 76 },
};
