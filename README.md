# @labpics/motion

Движок пружинной физики и переходов без runtime-зависимостей. Часть дизайн-системы Labpics.

## Как собрать

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build      # → dist/index.js + dist/index.d.ts
pnpm test
```

## Как потреблять

```typescript
import { spring, tween, drive, MotionParamError } from '@labpics/motion';
```

### Пружина (spring)

```typescript
import { spring } from '@labpics/motion';

const result = spring({ mass: 1, stiffness: 100, damping: 10 }, 0.5); // t в секундах
console.log(result.value);    // позиция
console.log(result.velocity); // скорость
```

### Анимация элемента (drive)

```typescript
import { drive } from '@labpics/motion';

drive({
  from: 0,
  to: 100,
  spring: { mass: 1, stiffness: 100, damping: 10 },
  onStep: (value) => {
    element.style.transform = `translateX(${value}px)`;
  },
  matchMedia: window.matchMedia.bind(window), // инъекция для prefers-reduced-motion
});
```

### Интерполяция (tween)

```typescript
import { tween } from '@labpics/motion';

const value = tween({ from: 0, to: 1, duration: 300, easing: 'ease-in-out' }, 150);
```

### Ошибки

```typescript
import { MotionParamError } from '@labpics/motion';

try {
  spring({ mass: -1, stiffness: 100, damping: 10 }, 0);
} catch (e) {
  if (e instanceof MotionParamError) console.error(e.message);
}
```

## Лицензия

MIT
