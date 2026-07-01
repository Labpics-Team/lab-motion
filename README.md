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

### Keyframes (`@labpics/motion/keyframes`)

Интерполяция значения через несколько опорных точек (не только from→to), с
явными или авто-распределёнными долями, per-сегментным easing и повтором
(loop / reverse-yoyo). Headless — сам не трогает DOM, эмитит через `onStep`.

```typescript
import { keyframes } from '@labpics/motion/keyframes';
import { easeOut } from '@labpics/motion/easing';

const controls = keyframes({
  values: [0, 100, 50, 100],   // опорные точки
  times: [0, 0.3, 0.6, 1],     // доли [0,1]; необязательно — иначе авто-равномерно
  duration: 1.2,               // секунды на один цикл
  easing: easeOut,              // один на все сегменты, либо массив per-segment
  repeat: 2,                    // 2 доп. повтора (Infinity — бесконечно)
  repeatType: 'reverse',        // 'loop' | 'reverse' | 'mirror' (yoyo)
  matchMedia: window.matchMedia.bind(window), // prefers-reduced-motion
  onStep: (value) => { element.style.transform = `translateX(${value}px)`; },
});

controls.pause();
controls.seek(0.5);
await controls; // резолвится при complete()/cancel()/естественном завершении
```

При `prefers-reduced-motion: reduce` анимация мгновенно снэпается к
последнему keyframe (не hard-off) — repeat/direction игнорируются.

## Лицензия

MIT
