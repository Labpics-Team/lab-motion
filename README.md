# Lab Motion

Библиотека анимаций для веб-интерфейсов: пружины, жесты, переходы между
состояниями и управление движением. JavaScript и TypeScript, без runtime-зависимостей.

[![npm](https://img.shields.io/npm/v/%40labpics%2Fmotion)](https://www.npmjs.com/package/@labpics/motion)
[![CI](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml/badge.svg)](https://github.com/Labpics-Team/lab-motion/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40labpics%2Fmotion)](LICENSE)

## Установка

```bash
pnpm add @labpics/motion
```

ESM, CommonJS и типы TypeScript включены. Для серверного использования нужен
Node.js 22 или новее; для браузерного runtime нужны ES2022 и `WeakRef`.
Биндинги подключают фреймворк через optional peer dependency.

## Первое движение

```typescript
import { animate } from '@labpics/motion';

const move = animate('.card', { x: 160, opacity: 1 });
const result = await move.finished;
```

Задайте цель. Библиотека выбирает подходящее исполнение и возвращает одинаковые
контролы: `pause`, `play`, `seek`, `stop`, `finish`. Новая цель продолжает движение,
а явный массив значений проигрывает авторскую траекторию.

## Компонент

```typescript
import { scope } from '@labpics/motion';

const ui = scope(document.querySelector('.panel')!);
ui.animate('.item', { opacity: [0, 1], y: [8, 0] }, { duration: 180, stagger: 25 });
ui.on('.replay', 'click', () => ui.animate('.item', { x: [0, -4, 4, 0] }));

// При удалении компонента:
ui.dispose();
```

Область локализует селекторы и освобождает движения, обработчики, значения и
дочерние области. Системное уменьшенное движение учитывается автоматически.
Остановка старого controller не отменяет движение, которым уже владеет новый.

## Возможности

`animate` задаёт движение. `scope` связывает его с компонентом. `sequence`
объединяет шаги одной временной шкалой. `layout` показывает переход между
состояниями DOM. `value` предоставляет реактивное анимируемое число.
Все эти функции доступны из `@labpics/motion`.

[Начало работы](docs/getting-started.md) · [API](docs/api.md) ·
[Изменения версии](docs/migration.md) · [Устройство исполнения](docs/architecture.md).

В репозитории `pnpm size` проверяет полный достижимый код потребительских сборок.
Размер и производительность зависят от использованных возможностей; методика
измерений описана в [руководстве по бенчмаркам](docs/benchmark.md).

## Разработка

[Участие в проекте](https://github.com/Labpics-Team/lab-motion/blob/main/CONTRIBUTING.md).
[Сообщить об уязвимости](https://github.com/Labpics-Team/lab-motion/blob/main/SECURITY.md).

MIT. Labpics.
