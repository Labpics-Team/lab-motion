# Lab Motion

**Headless motion engine for interruptible interface animation.** Lab Motion keeps
position and velocity when a target changes, has no runtime dependencies, and can
hand suitable work to the browser instead of running JavaScript on every frame.

[![npm](https://img.shields.io/npm/v/%40labpics%2Fmotion)](https://www.npmjs.com/package/@labpics/motion)
[![CI](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml/badge.svg)](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40labpics%2Fmotion)](LICENSE)

## Установка

```bash
pnpm add @labpics/motion
```

Для серверного использования нужен Node 22 или новее. Браузерный runtime рассчитан
на ES2022 и `WeakRef`. Пакет поставляет ESM, CJS и TypeScript-типы. Биндинги
фреймворков подключаются как optional peer dependencies.

## Первый переход

```typescript
import { animate } from '@labpics/motion/animate';

const controls = animate('.card', { x: 240, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
  stagger: 40,
});

await controls.finished;
```

`animate` подходит для обычных DOM-переходов: transforms, opacity, CSS-свойства,
spring или tween, задержки и stagger. Controls можно остановить, приостановить,
продолжить или перемотать.

## Цель меняется во время движения

```typescript
import { MotionValue } from '@labpics/motion';

const x = new MotionValue({
  initial: 0,
  spring: { mass: 1, stiffness: 200, damping: 20 },
});

x.onChange((value) => {
  el.style.transform = `translateX(${value}px)`;
});

x.setTarget(240);
x.setTarget(80);
```

Второй `setTarget` продолжает движение из текущего состояния. Для drag, навигации
и других прерываемых интерфейсов не нужно вручную переносить скорость между
анимациями.

## React

```tsx
import { useSpring } from '@labpics/motion/react';

function Card({ open }: { open: boolean }) {
  const x = useSpring(open ? 240 : 0, {
    mass: 1,
    stiffness: 200,
    damping: 20,
  });

  return <div style={{ transform: `translateX(${x}px)` }} />;
}
```

Те же примитивы доступны для React, Preact, Vue, Svelte, Solid, Angular, Qwik,
Lit и Web Components.

## Что импортировать

| Задача | Импорт |
| --- | --- |
| Обычная DOM-анимация | `@labpics/motion/animate` |
| Минимальный WAAPI-путь | `@labpics/motion/nano` |
| Живые значения | `@labpics/motion`, `@labpics/motion/value` |
| Drag, pan, press, hover | `@labpics/motion/gestures` |
| Bottom sheet, carousel, dismiss, reorder | `@labpics/motion/behaviors` |
| FLIP и layout transitions | `@labpics/motion/flip`, `@labpics/motion/projection`, `@labpics/motion/smart` |
| Presence | `@labpics/motion/presence` |
| Scroll и in-view | `@labpics/motion/scroll`, `@labpics/motion/in-view` |
| Build-time оптимизация | `@labpics/motion/compiler/vite` |

Полная карта экспортов и сигнатур находится в [справочнике API](docs/api.md).

## Поведение

- Повторная цель продолжает активное движение вместо старта с нулевой скорости.
- Подходящие автономные переходы могут исполняться через WAAPI. Если capability
  недоступна, публичный контракт сохраняется на JS-пути.
- `prefers-reduced-motion` меняет характер перехода и сохраняет функциональный
  результат.
- DOM, layout, gestures и framework bindings используют общее ядро, поэтому
  компоненту не нужен отдельный scheduler или копия физики.
- Возможности разделены по субпутям, чтобы bundler мог вырезать неиспользуемое.

## Рецепты

Практические интеграции собраны в [recipes.md](docs/recipes.md): drag с инерцией,
FLIP, presence, scroll, bottom sheet, carousel, reorder, React и Solid lifecycle.

## Документация

| Раздел | Для чего |
| --- | --- |
| [API](docs/api.md) | Публичные входы и контракты |
| [Рецепты](docs/recipes.md) | Готовые схемы интеграции |
| [Behaviors](docs/behaviors.md) | Sheet, carousel, dismiss, reorder |
| [Presence](docs/presence.md) | Появление, уход и прерывание |
| [Projection](docs/projection.md) | Вложенные layout-переходы |
| [Smart](docs/smart.md) | Shared-element переходы по ключу |
| [Compositor](docs/compositor.md) | WAAPI-путь и fallback |
| [Compiler](docs/compiler.md) | Vite build-time оптимизация |
| [Tokens](docs/tokens.md) | Motion-токены и преобразования |
| [Ошибки](docs/errors.md) | Коды `MotionParamError` |
| [Миграция](docs/migration.md) | Перенос с Motion JS и Anime.js |
| [Архитектура](docs/architecture.md) | Устройство движка |
| [Бенчмарки](docs/benchmark.md) | Методика измерений и размер |

## Размер и производительность

Размер проверяется отдельно для публичных entrypoints. Актуальные числа не
копируются в Markdown: в исходном репозитории их печатает `pnpm size`, а методика
сравнения описана в [benchmark.md](docs/benchmark.md).

## Разработка

Правила участия находятся в
[CONTRIBUTING.md](https://github.com/Labpics-Team/lab-motion/blob/main/CONTRIBUTING.md).
Уязвимости сообщаются по
[SECURITY.md](https://github.com/Labpics-Team/lab-motion/blob/main/SECURITY.md).

## Лицензия

MIT
