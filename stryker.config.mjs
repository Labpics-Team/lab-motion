/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: АНАЛИТИЧЕСКОЕ ЯДРО — ODE-солвер пружины (spring + internal/solver) +
 * интерполяция/цикл кейфреймов (keyframes) + stateful-цикл MotionValue +
 * closed-form затухание/инерция (decay). Сердце движка, доказанно сильное по mutation:
 *   - solver 86.5%, spring 79.7%, keyframes 78.1% (S34: 49.5%→78.1%, закалка
 *     mutation-тестами — валидация accept-путей, yoyo-направление ≥3 циклов,
 *     CSS-safety при патологичном easing, setTimeout-фоллбек, pause/play).
 *   - motion-value 87.01% (S39: 64.97%→87.01%, закалка тик-цикла — направление
 *     range, degenerate-сходимость, velocity-критерий, clamp-границы, snapTo-
 *     конъюнкты, post-emit re-entrancy, finite-net overflow-recovery, v0-нормализация,
 *     default-rAF; bounded-оракулы ≪ MAX_FRAMES + оракулы на счётчик эмиссий).
 *   - decay 88.79% (S40: 63.55%→88.79%, закалка — overflow amplitude/rest ±MAX_VALUE,
 *     accept-пути knobs power/timeConstant/restDelta, сообщения ошибок, matchMedia
 *     query + throwing-graceful; прямые оракулы, closed-form без cap-маскировки).
 *   - минимум по файлам = keyframes 78.1% (на границе) → взвешенный агрегат ≥78%,
 *     break=76 — безопасный пол (эрозию ловит; точный агрегат считает scheduled-прогон).
 *     ВНИМАНИЕ: при эрозии keyframes ниже 78% фраза «агрегат ≥78%» станет ложной
 *     раньше, чем сработает глобальный break=76 (нет per-file break в Stryker).
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
 * падает НИЖЕ него (эрозия силы сьюта). Значение — от замеренного baseline
 * минус запас (см. Graphiti «lab-motion: S33 Stryker baseline»); НЕ цель 100%
 * (константа Гудхарта: 100% геймится, часть выживших — не-поведенческие
 * мутации текста ошибок / недостижимые defensive-ветки).
 *
 * pnpm-изоляция: плагин раннера объявлен явным именем (дефолтный glob
 * '@stryker-mutator/*' не резолвится под изолированным node_modules pnpm).
 */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  mutate: ['src/spring.ts', 'src/internal/solver.ts', 'src/keyframes/index.ts', 'src/motion-value.ts', 'src/decay.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 76 },
};
