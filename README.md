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

## Первый переход

```typescript
import { animate } from '@labpics/motion/animate';

const controls = animate('.card', { x: 160, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
});

await controls.finished;
```

`animate` принимает элемент или CSS-селектор. Возвращённые controls позволяют
приостановить, продолжить или отменить переход. Для новой цели вызовите
`animate` снова.

Подробнее: [начало работы](docs/getting-started.md), [API](docs/api.md), [рецепты](docs/recipes.md).

## Что импортировать

| Задача | Импорт |
| --- | --- |
| DOM-анимация с управлением | `@labpics/motion/animate` |
| Минимальный нативный WAAPI-путь | `@labpics/motion/nano` |
| Анимируемое числовое значение | `MotionValue` из `@labpics/motion` |
| Жесты | `@labpics/motion/gestures` |
| Появление и уход элементов | `@labpics/motion/presence` |
| Изменение расположения | `@labpics/motion/projection`, `@labpics/motion/smart` |
| Реакция на прокрутку и видимость | `@labpics/motion/scroll`, `@labpics/motion/in-view` |

Биндинги доступны для React, Preact, Vue, Svelte, Solid, Angular, Qwik, Lit
и Web Components. Сигнатуры и требования находятся в [справочнике](docs/api.md).

## Документация

[Руководства и справочник](docs/index.md) помогают выбрать API, настроить
переходы и подключить движение к жизненному циклу компонента.
[Миграция](docs/migration.md) описывает перенос с Motion и Anime.js.

Для `animate` предусмотрен JS-путь при недоступности подходящего нативного
исполнения. У `nano` собственные требования к WAAPI;
[проверьте их перед выбором](docs/api.md#контракт-nano).

Размер зависит от импортов. В исходном репозитории команда `pnpm size` измеряет
отдельные входы. Методика описана в [руководстве по бенчмаркам](docs/benchmark.md).

## Разработка

[Участие в проекте](https://github.com/Labpics-Team/lab-motion/blob/main/CONTRIBUTING.md).
[Сообщить об уязвимости](https://github.com/Labpics-Team/lab-motion/blob/main/SECURITY.md).

MIT. Labpics.
