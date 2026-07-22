# Документация @labpics/motion

> Роль: справка — карта документации пакета (входная точка).

## Начало

- [Быстрый старт](./getting-started.md) — установка, первая анимация, выбор входа.
- [Рецепты](./recipes.md) — runnable-интеграции: drag, FLIP, handoff, scroll.

## Миграция «за 15 минут»

- [С Framer Motion / Motion](./migration/framer-motion.md)
- [С GSAP](./migration/gsap.md)
- [С Anime.js v4](./migration/animejs.md)

## Справка по субпутям

Каждая страница: назначение, точные сигнатуры с единицами и дефолтами,
бросаемые коды ошибок, контракты (SSR / reduced-motion / финитность /
детерминизм), компилируемые примеры.

| Страница | Субпути |
| --- | --- |
| [core](./reference/core.md) | `.` |
| [animate](./reference/animate.md) | `./animate` |
| [nano](./reference/nano.md) | `./nano` |
| [compiler](./reference/compiler.md) | `./compiler/vite`, `./compiler/runtime` |
| [spring](./reference/spring.md) | `./spring` |
| [compositor](./reference/compositor.md) | `./compositor`, `./compositor/stagger`, `./waapi` |
| [easing](./reference/easing.md) | `./easing` |
| [value](./reference/value.md) | `./value` |
| [driver-frame](./reference/driver-frame.md) | `./driver`, `./frame` |
| [utils](./reference/utils.md) | `./utils` |
| [tokens-presets](./reference/tokens-presets.md) | `./tokens`, `./presets` |
| [stagger](./reference/stagger.md) | `./stagger` |
| [timeline-keyframes](./reference/timeline-keyframes.md) | `./timeline`, `./keyframes` |
| [decay](./reference/decay.md) | `./decay` |
| [scroll-in-view](./reference/scroll-in-view.md) | `./scroll`, `./in-view` |
| [gestures](./reference/gestures.md) | `./gestures` |
| [presence](./reference/presence.md) | `./presence` |
| [flip](./reference/flip.md) | `./flip` |
| [projection](./reference/projection.md) | `./projection` |
| [smart](./reference/smart.md) | `./smart` |
| [svg](./reference/svg.md) | `./svg`, `./svg-morph` |
| [a11y](./reference/a11y.md) | `./a11y` |
| [auto](./reference/auto.md) | `./auto` |
| [behaviors](./reference/behaviors.md) | `./behaviors` |
| [adapters](./reference/adapters.md) | `./react`, `./vue`, `./svelte`, `./solid`, `./preact`, `./angular`, `./lit`, `./wc`, `./qwik` |

## Объяснения (почему так)

- [Закрытая форма пружины и полюсное пространство](./explanations/spring-math.md)
- [C¹-непрерывность перехвата](./explanations/c1-continuity.md)
- [Фазовая модель main/compositor](./explanations/compositor-model.md)
- [Методология размера](./explanations/size-methodology.md)

## Контракты и процессы

- [Каталог ошибок LMxxx](./errors.md) — коды, причины, исправления.
- [Бенчмарки и правила измерения](./benchmark.md) — числа не живут в Markdown.
- [Нейминг-канон](./NAMING.md) — сверяется гейтом docs-drift.
- [Релизы](./RELEASES.md).

## Машиночитаемое

- `api-manifest.json` (корень пакета) — exports/размеры/справка, генерируется
  `pnpm manifest`/`pnpm build`; drift защищён тестом.
- `llms.txt` — краткая карта выбора API для агентов, генерируется из манифеста.
