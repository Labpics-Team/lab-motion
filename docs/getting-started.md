# Быстрый старт @labpics/motion

> Роль: справка — установка, первая анимация, выбор входа.

## Установка

```bash
pnpm add @labpics/motion
```

Node ≥ 22. Runtime-зависимостей нет; фреймворк нужен только соответствующему
биндингу (`./react`, `./vue`, …) как optional peer.

## Первая анимация — одна строка

```typescript
import { animate } from '@labpics/motion/animate';

animate('.hero', { x: 240, opacity: 1 });
```

Селектор резолвится в момент вызова (SSR-safe), путь исполнения выбирается
автоматически: пружина уходит на compositor-поток через WAAPI + CSS `linear()`
(ноль кадров main-thread), окружения без нужных возможностей получают
rAF-путь с той же замкнутой формой, `prefers-reduced-motion` — мгновенный
финал без кадров.

Все длительности и задержки в публичных опциях — **МИЛЛИСЕКУНДЫ**
(Framer/Motion считают в секундах — при миграции умножайте на 1000).

## Пружина из ощущений

Дефолтный режим `animate` — пружина. Думаете в «длительность + упругость»?

```typescript
import { animate } from '@labpics/motion/animate';
import { fromBounce } from '@labpics/motion/spring';

animate('.card', { y: 0 }, { spring: fromBounce({ duration: 0.5, bounce: 0.3 }) });
```

`fromBounce` — точное преобразование канона SwiftUI (duration в секундах —
это физическая координата пружины, не опция фасада). Есть и другие точные
конструкторы: `fromVisualDuration` (время первого касания цели), `fromPeak`
(первый перелёт + время пика), `fromOscillation` (период + half-life) — см.
[reference/spring](./reference/spring.md).

## Keyframes

```typescript
import { animate } from '@labpics/motion/animate';

animate('.dot', { x: [0, 120, -40, 0], opacity: [0, 1, 1, 0] }, {
  duration: 800,
  times: [0, 0.25, 0.75, 1],
});
```

Кортеж длины ≥ 3 — трек: все стопы явные, `times` задаёт offsets (или
равномерная сетка), `ease` принимает массив per-segment функций.

## Ожидание завершения

```typescript
import { animate } from '@labpics/motion/animate';

const el = document.querySelector('.hero') as HTMLElement;
await animate(el, { opacity: 1 });     // thenable — как у Motion
```

Контролы: `play/pause/seek/cancel/stop` и промис `finished`.

## Какой вход мне нужен?

| Ситуация | Вход |
| --- | --- |
| Типовые DOM-переходы, перехваты, keyframes | `@labpics/motion/animate` |
| Минимальный вес, to-only, native WAAPI | `@labpics/motion/nano` |
| Статические вызовы без runtime-цены | плагин `@labpics/motion/compiler/vite` |
| Значение ведётся пальцем/скроллом | `.` (MotionValue) + `./gestures`/`./scroll` |
| Свой рендер (canvas, WebGL, три.js) | `.` (`drive`, `spring`) — ядро не знает про DOM |

`./nano` — та же математика пружины (spring → CSS `linear()` на лету), но
to-only контракт и native Animation-контролы; фасадные transform-шортхенды
`x`/`y` там намеренно запрещены типами — пишите `translate`. Компилятор
опускает статические вызовы nano-грамматики в готовый артефакт на сборке —
браузер не получает ни солвер, ни парсер.

## Reduced motion из коробки

Все входы читают `prefers-reduced-motion` в момент вызова: движение
заменяется мгновенной публикацией финального значения (политика пакета —
менять ХАРАКТЕР, не ломать функциональность). Шов `matchMedia` инжектируем —
тестируется детерминированно.

## Дальше

- [Карта документации](./README.md)
- [Миграция с Framer Motion](./migration/framer-motion.md), [GSAP](./migration/gsap.md), [Anime.js](./migration/animejs.md)
- [Почему перехват не дёргается (C¹)](./explanations/c1-continuity.md)
- [Куда уходит анимация (main/compositor)](./explanations/compositor-model.md)
