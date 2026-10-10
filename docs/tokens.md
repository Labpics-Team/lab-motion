# Пресеты движения

`@labpics/motion/tokens` предоставляет необязательные именованные длительности,
кривые и пружины. Их значения принадлежат пакету и сохраняются между patch-релизами.
Дизайн-система владеет своими ролями и настройками независимо от этого словаря.

## Использование

```typescript
import { animate } from '@labpics/motion';
import { duration, spring, distanceScale } from '@labpics/motion/tokens';

animate('.panel', { x: 0 }, { spring: spring.smooth });
animate('.label', { opacity: 1 }, { duration: duration.fast });
distanceScale(200); // 200 мс в стандартной полосе 0–400 px
```

Для собственной темы передайте обычные опции. Их можно хранить рядом с компонентом
или преобразовать из токенов приложения; регистрация темы в движке не требуется.

```typescript
import { animate, type MotionOptions } from '@labpics/motion';

const panelTransition = {
  spring: { mass: 1, stiffness: 280, damping: 32 },
} satisfies MotionOptions;

animate('.panel', { y: 0 }, panelTransition);
```

Создавайте отдельные объекты для настройки пресетов. Изменение публичного
пружинного пресета не меняет defaults ядра; явные опции относятся к своему вызову.

```typescript
import { spring } from '@labpics/motion/tokens';

const compactPanel = { ...spring.smooth, damping: 40 };
```

## Численные параметры

`springFromDurationBounce(durationS, bounce)` переводит период в секундах и
коэффициент `bounce` из диапазона `[0, 1)` в физические параметры. При `mass = 1`:
`ω₀ = 2π / durationS`, `stiffness = ω₀²`, `damping = 2(1 − bounce)ω₀`.
Время фактического оседания зависит от физики и допуска исполнителя.
Неконечные и недопустимые параметры отклоняются.

`easing` предоставляет CSS-строку и функцию одной кривой. Для root `animate`
используйте поддерживаемое имя, четыре координаты Безье или функцию; для
нативного CSS/WAAPI подходит поле `css`. `staggerGap` задаёт задержки в миллисекундах.

Runtime не импортирует словарь. Прямой импорт `./tokens` и возможности,
использующие его пресеты, оплачивают только достижимый код после tree shaking.
Цена конкретного потребителя проверяется командой `pnpm size`.
