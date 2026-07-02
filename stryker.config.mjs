/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: АНАЛИТИЧЕСКОЕ ЯДРО — ODE-солвер пружины (spring + internal/solver) +
 * интерполяция/цикл кейфреймов (keyframes). Математическое сердце движка,
 * доказанно сильное по mutation:
 *   - solver 86.5%, spring 79.7%, keyframes 78.1% (S34: 49.5%→78.1%, закалка
 *     mutation-тестами — валидация accept-путей, yoyo-направление ≥3 циклов,
 *     CSS-safety при патологичном easing, setTimeout-фоллбек, pause/play).
 *   - агрегат ~79.5%. break=76 ловит эрозию силы сьюта, ~3.5pt запас.
 * Остаток выживших keyframes — задокументированные ЭКВИВАЛЕНТНЫЕ ('mirror'
 * yoyo'ит и без нормализации; границы, сеттлящие на кадр позже) и НЕДОСТИЖИМЫЕ
 * defensive-клампы (localT/phaseP всегда в [0,1]; MAX_FRAMES=100k); догон до
 * 100% был бы таймер-театром (Гудхарт).
 *
 * НАМЕРЕННО вне скоупа: motion-value/drive (stateful) и субпути/биндинги —
 * пинятся тяжёлыми differential/frame-сьютами + per-PR диверсиями; их mutation
 * дорог (полный core-набор → ~46 мин). Расширять при нужде.
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
  mutate: ['src/spring.ts', 'src/internal/solver.ts', 'src/keyframes/index.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 76 },
};
