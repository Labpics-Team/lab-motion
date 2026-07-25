/**
 * stryker.config.mjs — mutation-тестирование ПО РАСПИСАНИЮ (не per-PR).
 *
 * Скоуп: аналитическое ядро — spring/solver, keyframes, MotionValue, decay,
 * value/color, sliding-window, tween и чистая projection-геометрия. Точные
 * результаты принадлежат HTML-артефакту каждого scheduled-прогона и не
 * дублируются здесь устаревающими числами.
 *
 * Остаток выживших keyframes/motion-value/decay — задокументированные ЭКВИВАЛЕНТНЫЕ
 * (границы `<`↔`<=`; gen ++/--; `!==undefined` избыточен с isFinite) и
 * НЕДОСТИЖИМЫЕ defensive-ветки (MAX_FRAMES-cap для валидных
 * пружин; finite-net поверх clamp; velocity-конъюнкт снап-guard; Infinity-short-circuit
 * = формула в пределе); догон до 100% — театр (Гудхарт).
 *
 * ОХВАТ РАСШИРЕН 2026-07-25. Прежняя формулировка «субпути пинятся тяжёлыми
 * differential/frame-сьютами» проверки не выдержала: аудит нашёл в
 * compositor/segmenter.ts нарушение публичного контракта maxValueError вдвое
 * (терминальный снап не входил в бюджет реконструкции) — при зелёных
 * differential-сьютах и 4000 зелёных тестах. Замер того же файла Stryker-ом:
 * score 80.08, 41 выживший мутант, 6 мутантов БЕЗ ПОКРЫТИЯ вообще. Оракул,
 * который нашёл бы дыру, просто не смотрел в эту сторону.
 *
 * Поэтому в скоуп добавлено аналитическое ядро compositor-пути (сегментер,
 * компиляция кривой, сериализованное сэмплирование) и кадровый батч фасада —
 * то есть чистые модули с наибольшей ценой ошибки. Остальные субпути и
 * биндинги пока вне скоупа осознанно: их цена ошибки локальна, а стоимость
 * прогона нелинейна (один segmenter.ts — 8 минут).
 *
 * НАМЕРЕННО вне скоупа: drive (обёртка над MotionValue) и биндинги —
 * пинятся тяжёлыми differential/frame-сьютами + per-PR диверсиями.
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
  mutate: [
    // Аналитическое ядро (исходный скоуп).
    'src/spring.ts',
    'src/internal/solver.ts',
    'src/internal/frame-requester.ts',
    'src/internal/schedule-v1.ts',
    'src/internal/repeat-cursor.ts',
    'src/internal/sample-keyframes.ts',
    'src/keyframes/index.ts',
    'src/motion-value.ts',
    'src/decay.ts',
    'src/value/color.ts',
    'src/internal/sliding-window.ts',
    'src/tween.ts',
    'src/projection/geometry.ts',
    // Compositor-путь (добавлен 2026-07-25 — см. шапку): здесь живёт бюджет
    // реконструкции пружина → CSS linear(), нарушение которого не видно ни
    // одному функциональному тесту без специально построенного корпуса.
    'src/compositor/segmenter.ts',
    'src/compositor/curve.ts',
    'src/compositor/sample.ts',
    // Кадровый батч фасада: кэш spring-basis раздаёт ОДИН базис всем юнитам
    // кадра, поэтому ошибка в его ключе стоит целой группы анимаций.
    'src/animate/surface-batch.ts',
  ],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  concurrency: 4,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 76 },
};
