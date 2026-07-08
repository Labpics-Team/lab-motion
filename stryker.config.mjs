/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: АНАЛИТИЧЕСКОЕ ЯДРО — ODE-солвер пружины (spring + internal/solver) +
 * интерполяция/цикл кейфреймов (keyframes) + stateful-цикл MotionValue +
 * closed-form затухание/инерция (decay). Сердце движка, доказанно сильное по mutation:
 *   - solver 86.5%, spring 79.7%, keyframes 88.84% (S34: 49.5%→78.1% — валидация
 *     accept-путей, yoyo-направление ≥3 циклов, CSS-safety при патологичном easing,
 *     setTimeout-фоллбек, pause/play; S44: 78.13%→88.84% — законы dt/ts-клока,
 *     граница natural-complete, достижимый MAX_FRAMES-cap при repeat=Infinity,
 *     post-settle дисциплина, перманентность фоллбека, default-rAF seam).
 *   - motion-value 87.01% (S39: 64.97%→87.01%, закалка тик-цикла — направление
 *     range, degenerate-сходимость, velocity-критерий, clamp-границы, snapTo-
 *     конъюнкты, post-emit re-entrancy, finite-net overflow-recovery, v0-нормализация,
 *     default-rAF; bounded-оракулы ≪ MAX_FRAMES + оракулы на счётчик эмиссий).
 *   - decay 88.79% (S40: 63.55%→88.79%, закалка — overflow amplitude/rest ±MAX_VALUE,
 *     accept-пути knobs power/timeConstant/restDelta, сообщения ошибок, matchMedia
 *     query + throwing-graceful; прямые оракулы, closed-form без cap-маскировки).
 *   - value/color 87.96% (S41: 73.77%→87.96%, закалка — hex/rgb/hsl-парсинг, HSL↔RGB
 *     канонические цвета, interpolate-каналы через EXACT-string, hue-wraparound на t≠0.5,
 *     clamp/parsePct; прямые known-value оракулы, probe-заземление точных значений).
 *   - internal/sliding-window 87.50% (S42: 70.83%→87.50%, закалка трима окна оценщика
 *     скорости — пустой вход, граница cutoff строгая, sparse→последняя пара; прямые
 *     оракулы на выходной массив).
 *   - tween 85.00% (S43: 75.00%→85.00%, закалка линейной интерполяции — клампинг
 *     эндпоинтов t<0→from / t>1→to без экстраполяции; прямые оракулы).
 *   - минимум по файлам = spring 79.7% → взвешенный агрегат ≥79%, break=76 —
 *     безопасный пол (эрозию ловит; точный агрегат считает scheduled-прогон).
 *     ВНИМАНИЕ: при эрозии минимального файла ниже ~79% фраза «агрегат ≥79%» станет
 *     ложной раньше, чем сработает глобальный break=76 (нет per-file break в Stryker).
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
  mutate: ['src/spring.ts', 'src/internal/solver.ts', 'src/keyframes/index.ts', 'src/motion-value.ts', 'src/decay.ts', 'src/value/color.ts', 'src/internal/sliding-window.ts', 'src/tween.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 76 },
};
