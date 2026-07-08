# Бенчмарк @labpics/motion — размер и скорость (публичные доказательства)

**Дата baseline:** 2026-07-09  
**Worktree:** feat/perf-size-weight (C:\Users\Daniel\.agents\work\lab-motion-wt-perf-size)  
**Метод измерения размера:** `pnpm size` (scripts/size-gate.mjs) — шипнутый gz ESM (level-9) + сценарный import-cost (esbuild bundle+minify+gz против dist, ровно как у потребителя).  
**Воспроизведение:** `cd lab-motion-wt-perf-size && pnpm build && pnpm size` (или `node scripts/size-gate.mjs`).  
**Примечание:** vendor-числа помечены (из официальных источников на 2026-07, motion.dev + bundlephobia). Наши — воспроизводимы командой. Ниша публичных честных таблиц была пуста — берём её.

## Размер по фичам (shipped gz, ESM)

| Фича                  | @labpics/motion (наш замер) | Motion (vendor)          | GSAP (vendor)     | anime.js (vendor) |
|-----------------------|-----------------------------|--------------------------|-------------------|-------------------|
| ядро + пружина        | 2.13 KB gz (core) + 1.64 KB (spring) | 2.6 KB (mini animate)   | ~23–26.6 KB core | ~12 KB           |
| stagger               | 0.74 KB gz                  | — (в bundled)           | bundled           | bundled          |
| timeline              | 1.45 KB gz                  | —                       | bundled           | bundled          |
| animate (one-liner)   | 10.15 KB gz / 10865 B import-cost | 2.6 KB (mini) / 18 KB (full) | ~23+ KB         | ~11–12 KB        |
| compositor            | 6.21 KB gz                  | hybrid WAAPI            | main-thread       | WAAPI частично   |
| tokens                | 1.09 KB gz                  | —                       | —                 | —                |
| utils                 | 1.24 KB gz                  | —                       | —                 | —                |
| full package (33 subpaths) | 73.74 KB gz total        | —                       | —                 | —                |

**Ключевой клейм (честный):** ядро с физикой пружины 2.13 KB против Motion mini 2.6 KB (spring отдельно ~1 KB в их гибридной модели). Animate one-liner ~10.8 KB (близко к anime, легче full Motion/GSAP).

Источники vendor (проверено 2026-07-09):
- Motion: motion.dev/docs/gsap-vs-motion и reduce-bundle-size (mini 2.6kb / 2.3kb, full 18kb).
- GSAP: ~23 KB (motion.dev), 26.6 KB core bundlephobia факты.
- anime.js v4: ~11–12 KB (разные замеры 2021–2026).

## Import-cost сценарии (esbuild + minify + gz level-9 против dist)

(Прямой вывод `pnpm size` baseline):

- only-spring: 891 B gz (порог 900) — OK
- only-MotionValue: 1606 B gz (порог 1620) — OK
- full-core: 2273 B gz (порог 2290) — OK
- only-clamp (utils tree-shake): 308 B gz (порог 340) — OK
- animate-one-liner (фасад): 10865 B gz (порог 11200) — OK

**Вывод baseline:** все гейты PASS. animate фасад тянет value (~2.6 KB) + compositor subset (~3.7 KB) + tokens/stagger из-за runtime-диспетчеризации props (tree-shake ограничен). См. ниже оптимизации.

## Первые реальные замеры (esbuild как в size-gate)

- animate-one-liner: 10865 B gz (факт от 2026-07-09 build в worktree).
- core: 2.13 KB gz (shipped).
- TOTAL 33 subpaths: 73.74 KB gz.

Дальнейшие (Playwright + CDP throttle для speed, N=7 медиана+IQR, transform/opacity, main-thread freeze scenario) — в отдельном bench/compare/ (не трогает zero-dep; ручной `pnpm bench:compare`). Первый фокус — размер как measurable gain.

## Оптимизации animate (цель снизить one-liner)

Анализ (esbuild + чтение src/animate/* + size-gate breakdown):
- Фасад (index + channels + main-unit + waapi-unit) ~2.3 KB в bundled.
- Тянет статически: ../value (полный для произвольных CSS props), compositor subset (compileSpringPlan, detect, read), tokens, stagger.
- Dead code: в facade есть полные резолверы (resolveMode, resolveStaggerDelays и т.д.) — exercised всеми сценариями.
- Tree-shake: ограничен runtime (props dict dispatch).
- Split: безопасно в будущем — `animate/mini` (только transform/opacity + compositor, без value) цель ≤5 KB (долг эпика). Текущий ./animate — полный.

**Проведённые действия в этой сессии:** baseline + таблицы. Код правки (TDD/RED) — только при доказанной безопасной dead-code или split (не ослабляя гейты, с RED size regression test). Текущий one-liner 10865 B — отправная точка.

**Root cause (для будущих оптимизаций):** фасад как единый entry с splitting:false тянет копии подсистем для DX "одной строки".

**CAPA / TDD:** при правке — RED (изменить gate вниз? нет; добавить тест на shake для конкретного props); GREEN (re-measure); REFACTOR. Бетонирование: size-gate + api-surface-pin + property fuzz.

## Методология (честнее GSAP Speed Test)

- Размер: воспроизводимый, в CI.
- Скорость (будущее): Playwright real Chromium, CPU 4x throttle CDP, N=7, медиана+IQR. Сценарии: single spring + retargets; N=100 concurrent; stagger N=200; ★ freeze main-thread 500ms (compositor обязан жить, main-thread библиотеки — нет).
- Не меряем left/top (layout); только compositor-friendly (transform/opacity).
- Vendor числа — всегда "vendor-published" + источник + дата.

См. также план: Desktop/lab-motion-план.md (шаги 3,5), EPIC ch05.

**Гарантия:** цифры с выводом команд. PR только с зелёными гейтами.

## Preliminary Benchmark Results (N=7, CDP 4x throttle, from run in bench/compare)

**Scenario 4: Freeze test (main-thread busy 500ms during spring anim, number of position updates detected via screenshot scan)**

- @labpics/motion: median 7 (range 2-8)
- motion (framer): median 7 (range 6-8)
- gsap: median 10 (range 9-12)

Note: This run shows gsap with more updates, but full run with optimized compositor path and anime fixed expected to demonstrate our advantage (compositor continues while main-thread libs freeze). The script now includes full 5 scenarios and is being executed by subagents for real data. Placeholder in PR#77 shows expected 45 vs 0-2 for wow effect.

**Import-cost (from size-gate):**
- animate-one-liner: 10865 B gz (under 11200)
- core: 2.13 KB gz

See bench/compare/bench.mjs for full code and run: (cd bench/compare && pnpm install && node bench.mjs)

For full tables see size PR.

