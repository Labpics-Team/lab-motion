# Первый переход

Установите пакет, выберите элемент и задайте его новое положение.

## Установка

```bash
pnpm add @labpics/motion
```

Для npm используйте `npm install @labpics/motion`.

Пакет содержит ESM, CommonJS и типы TypeScript. Серверная среда требует
Node.js 22 или новее; браузерный код рассчитан на ES2022 и `WeakRef`.
Фреймворк нужен только при использовании соответствующего биндинга.

## Анимация элемента

Добавьте на страницу элемент:

```html
<div class="card">Карточка</div>
```

После создания элемента запустите переход:

```typescript
import { animate } from '@labpics/motion/animate';

const controls = animate('.card', { x: 160, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
});

await controls.finished;
```

`x` задаёт горизонтальное смещение в пикселях. Можно передать элемент напрямую
или использовать CSS-селектор для нескольких элементов.

Для перехода заданной длительности замените `spring` на `duration`:

```typescript
animate('.card', { opacity: 0 }, { duration: 200 });
```

В `animate` длительность, задержка и `stagger` задаются в миллисекундах.

## Управление

```typescript
controls.pause();
controls.play();
controls.cancel();
```

`cancel()` останавливает переход и сохраняет текущее положение. Для новой цели
вызовите `animate` снова. Условия переноса скорости между типами значений
описаны в [справочнике API](api.md).

## Очистка

Для нескольких анимаций внутри компонента используйте общую область:

```typescript
import { createAnimateScope } from '@labpics/motion/animate';

export function mountMotion(root: HTMLElement) {
  const motion = createAnimateScope(root);
  motion.animate('.card', { opacity: 1 });

  return () => motion.destroy();
}
```

Вызовите возвращённую функцию при удалении компонента. Селекторы разрешаются
внутри `root`, а `destroy()` отменяет оставшиеся анимации.
Собственные обработчики событий приложение освобождает отдельно.

В [рецептах](recipes.md) есть примеры подключения к жизненному циклу
React и Solid, обработки жестов и анимации расположения.

## Какой вход выбрать

`@labpics/motion/animate` подходит для DOM-анимаций с управлением и JS-путём
при недоступности подходящего нативного исполнения.

`@labpics/motion/nano` использует нативный WAAPI и возвращает браузерные
`Animation`. Перед подключением проверьте его
[требования к браузеру](api.md#контракт-nano).

`MotionValue` из `@labpics/motion` хранит анимируемое число. Приложение или
биндинг решает, как отобразить его значение.

## Следующие шаги

[API](api.md) содержит карту возможностей.
[Рецепты](recipes.md) показывают их применение.
[Миграция](migration.md) описывает отличия от Motion и Anime.js.
