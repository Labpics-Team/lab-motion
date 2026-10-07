---
layout: home
title: Lab Motion
titleTemplate: false
hero:
  name: Lab Motion
  text: Анимация для интерфейсов.
  tagline: Пружины, жесты и переходы между состояниями. JavaScript, TypeScript и ваш фреймворк.
  actions:
    - theme: brand
      text: Начать
      link: /getting-started
    - theme: alt
      text: Справочник API
      link: /api
---

## Первый переход

```typescript
import { animate } from '@labpics/motion/animate';

animate('.card', { x: 160, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
});
```

Задайте новое положение. Lab Motion рассчитает движение и вернёт управление
для паузы, продолжения и отмены.

[Установка и первый пример →](getting-started.md)

## Найдите нужный инструмент

**Анимация и управление.** Начните с `animate` для DOM или `MotionValue`
для числовых значений. [Выбрать API →](api.md)

**Появление и изменение расположения.** Управляйте входом и выходом элементов,
перестановкой и переходами между видами.
[Presence](presence.md), [projection](projection.md), [shared elements](smart.md).

**Интеграция.** Подключите движение к состоянию компонента и освободите ресурсы
при его удалении. [Рецепты →](recipes.md)

**Нативное исполнение.** Используйте браузерные анимации и оптимизацию
статических вызовов во время сборки.
[Compositor](compositor.md), [компилятор Vite](compiler.md).
