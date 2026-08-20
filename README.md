# Lab Motion

**Движок анимаций на физике пружин.** Ядро ~2 КБ gzip, ноль зависимостей,
9 фреймворков — и compositor-путь, на котором анимация продолжает движение,
даже когда главный поток занят.

[![npm](https://img.shields.io/npm/v/%40labpics%2Fmotion)](https://www.npmjs.com/package/@labpics/motion)
[![CI](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml/badge.svg)](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40labpics%2Fmotion)](LICENSE)

Lab Motion — headless-движок: чистая математика движения (аналитический
spring-солвер, кейфреймы, инерция, FLIP) отделена от DOM. Рендер делает ваш
колбэк или готовый биндинг; время инжектируется — прогоны воспроизводимы
бит-в-бит.

## Установка

```bash
pnpm add @labpics/motion
```

Node ≥ 22, ESM и CJS, типы в комплекте. Фреймворк для биндинга — optional
peer. Git-установка не поддерживается (`dist/` собирается, в репозитории его
нет) — установка из тарбола описана в [справочнике](docs/api.md).

## Быстрый старт

Один вызов — каскад карточек едет пружиной:

```typescript
import { animate } from '@labpics/motion/animate';

await animate('.card', { x: 240, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
  stagger: 40,
}).finished;
```

Реактивное значение: новая цель в полёте подхватывает позицию **и скорость**
— перехваты без рывка:

```typescript
import { MotionValue } from '@labpics/motion';

const x = new MotionValue({ initial: 0, spring: { mass: 1, stiffness: 200, damping: 20 } });
x.onChange((v) => { el.style.transform = `translateX(${v}px)`; });
x.setTarget(240); // повторный setTarget в любой момент — продолжение, не телепорт
```

В React — то же самое одним хуком:

```tsx
import { useSpring } from '@labpics/motion/react';

function Card({ open }: { open: boolean }) {
  const x = useSpring(open ? 240 : 0, { mass: 1, stiffness: 200, damping: 20 });
  return <div style={{ transform: `translateX(${x}px)` }} />;
}
```

Больше runnable-рецептов (drag с инерцией, FLIP, presence, скролл-сценарии,
bottom sheet) — в [docs/recipes.md](docs/recipes.md).

## Живая витрина

Статическая витрина в `site/` показывает три публичных контракта движка:
аналитическую пружину, координированный stagger и C¹-ретаргет (перехват цели
без разрыва траектории). Все превью используют только публичный
`@labpics/motion/animate`, без внутренних путей.

```bash
pnpm build
pnpm site:build
pnpm site:preview   # отдаёт site/dist на локальном сервере
```

Каждое превью уважает `prefers-reduced-motion` и корректно освобождает
слушатели при перенавигации.

## Почему Lab Motion

- **Пружины, не длительности.** Замкнутая форма вместо покадровой симуляции:
  O(1) на кадр, честный overshoot, непрерывность C¹ при перехвате — движение
  продолжается из текущей позиции и скорости.
- **Анимация переживает занятый главный поток.** Автономный переход
  компилируется в нативный WAAPI-план (CSS `linear()` в Chromium/Firefox,
  адаптивные кадры в WebKit) и живёт на compositor-потоке. Ретаргет и хендофф
  обратно в живую пружину — без разрыва траектории.
  → [docs/compositor.md](docs/compositor.md)
- **Платите только за импортированное.** Каждая возможность — отдельный
  субпуть; точный `sideEffects`-allowlist, неиспользуемое вырезает
  tree-shaking, размер ядра отслеживается в CI.
- **9 фреймворков, одно ядро.** React, Preact, Vue, Svelte, Solid, Angular,
  Qwik, Lit, Web Components. Биндинг — тонкая прослойка; ядро про фреймворки
  не знает.
- **Layout-анимации всех уровней.** FLIP; вложенный projection — потомки и
  border-radius не искажаются в полёте; smart-animate по `data-motion-key`
  (жанр Figma); zero-config `autoAnimate`.
  → [docs/projection.md](docs/projection.md), [docs/smart.md](docs/smart.md)
- **Жесты и мобильные поведения.** Drag с инерцией и rubber-band, bottom
  sheet, carousel, pull-to-refresh, drag-dismiss — headless state machines,
  цель выбирается по положению **и** скорости.
  → [docs/behaviors.md](docs/behaviors.md)
- **Компилятор на этапе сборки.** Vite-плагин выпекает статические вызовы в
  готовые WAAPI-артефакты: солвер и парсер не попадают в бандл потребителя.
  → [docs/compiler.md](docs/compiler.md)
- **Доступность и SSR всерьёз.** `prefers-reduced-motion` меняет характер
  движения (снап/фейд), а не выключает его грубо; импорт любого субпутя
  SSR-safe; `NaN`/`Infinity` никогда не попадают в CSS — гарантии запечатаны
  фаззинг-тестами в CI.

## Карта пакета

Импорт — `@labpics/motion` (ядро) или `@labpics/motion/<субпуть>`.
Корневой экспорт + 41 субпутей (входов `exports` в `package.json` — 42):

| Группа | Субпути |
| --- | --- |
| Ядро анимации | `./nano` (WAAPI ≤ 1 КБ), `./animate` (one-liner фасад), `./frame`, `./driver`, `./compositor`, `./compositor/stagger`, `./waapi`, `./auto` |
| Значения и физика | `./value`, `./spring`, `./decay`, `./easing`, `./keyframes`, `./stagger`, `./timeline`, `./presets`, `./tokens`, `./utils` |
| Доменные эффекты | `./flip`, `./projection`, `./smart`, `./gestures`, `./behaviors`, `./scroll`, `./in-view`, `./presence`, `./svg`, `./svg-morph`, `./a11y`, `./surface` (приватный executor compiled-поверхности) |
| Биндинги | `./react`, `./preact`, `./vue`, `./svelte`, `./solid`, `./angular`, `./qwik`, `./lit`, `./wc` |
| Build-tool | `./compiler/vite` (плагин), `./compiler/runtime` (исполнитель, вставляется плагином) |

Что даёт каждый субпуть — в справочнике [docs/api.md](docs/api.md).

## Compositor-путь в двух словах

```typescript
import { CompositorSpring } from '@labpics/motion/compositor';

const panel = new CompositorSpring({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'transform', from: 0, to: 240,
  target: el, format: (v) => `translateX(${v}px)`,
  apply: (val) => { el.style.transform = String(val); }, // только на fallback-пути
});
panel.start();          // браузер ведёт пружину без участия главного потока
panel.retarget(120);    // дискретное прерывание: новая кривая из текущей точки
const live = panel.handoffToLive(); // палец перехватил — продолжает rAF-пружина
```

Без WAAPI контроллер прозрачно деградирует в живую rAF-пружину — публичный
API один. Фазовая модель (когда compositor, когда главный поток),
fallback-матрица и границы гарантий — [docs/compositor.md](docs/compositor.md).

## Layout в двух словах

```typescript
import { smartTransition } from '@labpics/motion/smart';

// пометьте узлы: <div data-motion-key="card-3">…</div>
await smartTransition(container, () => {
  reorderAndSwapLayout(); // мутируйте DOM как угодно
}).finished;              // matched едут FLIP'ом, entered/exited — фейдами
```

Continuity переживает пересоздание узла: идентичность — строковый ключ, а не
ссылка на элемент. → [docs/smart.md](docs/smart.md)

## Компилятор в двух словах

```typescript
// vite.config.ts
import { motionCompiler } from '@labpics/motion/compiler/vite';

export default { plugins: [motionCompiler()] };
```

Статический вызов `./nano` компилируется в готовый артефакт на этапе сборки:
в бандл не попадают ни солвер, ни парсер — только крошечный исполнитель.
Непредставимый вызов консервативно остаётся как есть. Скоуп первого среза и
гарантии — [docs/compiler.md](docs/compiler.md).

## Motion-токены

```typescript
import { duration, easing, spring, springFromDurationBounce } from '@labpics/motion/tokens';

duration.base;                     // 200 (мс)
spring.default;                    // { mass: 1, stiffness: 170, damping: 26 }
springFromDurationBounce(0.35, 0); // восприятие (duration, bounce) → физика
```

Типобезопасный словарь примитивов движения, значения запинены тестами как
контракт. → [docs/tokens.md](docs/tokens.md)

## Размер

Ядро — до 2220 байт gzip, `./nano` — до 1024; размер ядра контролируется в CI.
Актуальные числа не копируются в Markdown — их выдаёт `pnpm size`; методология
и правила сравнения — [docs/benchmark.md](docs/benchmark.md).

## Миграция с Motion / Anime.js

`./animate` даёт знакомую one-liner форму; карта переноса конкретных вызовов и
список того, что не объединено, — [docs/migration.md](docs/migration.md).

## Документация

| Раздел | Что внутри |
| --- | --- |
| [Рецепты](docs/recipes.md) | Runnable-интеграции: drag, FLIP, presence, скролл, bottom sheet |
| [Справочник API](docs/api.md) | Все 41 субпуть: что даёт каждый вход |
| [Архитектура](docs/architecture.md) | Слои движка, фазовая модель, инварианты, отвергнутые пути |
| [Compositor](docs/compositor.md) | WAAPI-план, ретаргет, хендофф, fallback-матрица, поддержка браузеров |
| [Projection](docs/projection.md) | Вложенный FLIP: дерево узлов, C¹-перехваты, не-цели v1 |
| [Smart-animate](docs/smart.md) | Диф по data-ключу, ghost-протокол, реинкарнация узлов |
| [Behaviors](docs/behaviors.md) | Bottom sheet, carousel, pull-to-refresh, drag-dismiss |
| [Токены](docs/tokens.md) | Словарь движения и каноническая пара (duration, bounce) |
| [Компилятор](docs/compiler.md) | Build-time lowering: скоуп, гарантии, sourcemaps |
| [Ошибки](docs/errors.md) | Каталог кодов `MotionParamError` (`LMddd`) |
| [Бенчмарки](docs/benchmark.md) | Методология измерений и автоматический контроль размера |
| [Миграция](docs/migration.md) | Соответствие вызовов Motion JS и Anime.js |

## Вклад

Рабочий процесс, архитектурные границы и обязательные проверки качества —
[CONTRIBUTING.md](CONTRIBUTING.md). Уязвимости — приватно через
[SECURITY.md](SECURITY.md).

## Лицензия

MIT
