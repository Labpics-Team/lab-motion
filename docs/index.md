---
layout: doc
sidebar: false
aside: false
prev: false
next: false
pageClass: motion-home
title: Lab Motion
titleTemplate: false
---

# Анимация для интерфейсов.

Пружины, жесты и переходы между состояниями. JavaScript, TypeScript и ваш фреймворк.

[Начать](getting-started.md) [Справочник API](api.md)

## Один импорт

```typescript
import { animate, scope, sequence, layout, value } from '@labpics/motion';

animate('.card', { x: 160, opacity: 1 });
```

Задайте движение и время его жизни. Исполнитель, продолжение при новой цели
и освобождение ресурсов остаются внутри библиотеки.

[Первый компонент](getting-started.md) · [Контролы и ошибки](api.md) ·
[Примеры интеграции](recipes.md) · [Миграция](migration.md).
