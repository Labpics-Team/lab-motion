/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: АНАЛИТИЧЕСКИЙ ODE-солвер пружины (spring + internal/solver) —
 * математическое сердце движка, доказанно сильное по mutation (baseline
 * 2026-07-02: solver 86.5%, spring 79.7%, агрегат ~83.7%). Здесь tripwire
 * осмыслен: break=75 ловит эрозию силы сьюта на ядре.
 *
 * НАМЕРЕННО вне первого скоупа (не гейминг — задокументировано):
 * - keyframes/index.ts: baseline-прогон Stryker вскрыл 49.5% (174 выживших) —
 *   реальная слабость покрытия; включение утянуло бы агрегат до 58% и
 *   обесценило break. Сначала отдельная закалка тестов keyframes (spawned
 *   task), ПОТОМ в scope. Это Stryker, делающий свою работу на первом прогоне.
 * - motion-value/drive (stateful) и субпути/биндинги: пинятся тяжёлыми
 *   differential/frame-сьютами + per-PR диверсиями; их mutation дорог
 *   (полный core-набор = 895 мутантов → ~46 мин). Расширять при нужде.
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
  mutate: ['src/spring.ts', 'src/internal/solver.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 75 },
};
