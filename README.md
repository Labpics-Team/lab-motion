# @labpics/motion

A production-ready, dependency-free, and highly optimized spring physics and transition engine.

Part of the Labpics design system ecosystem, built for incredible speed and accessibility.

## Features

- **Zero Runtime Dependencies**: Tiny footprint (~1.9 KB gzipped).
- **CSS-Safe**: Strictly guards against NaN and Infinity values (using robust finite clamp guards and fuzzing).
- **Reduced-Motion Aware**: Employs `prefers-reduced-motion` at the core level to automatically short-circuit transitions.
- **Deterministic Solver**: Pure mathematical solvers that are independent of DOM, clock, or window.
- **API Pinning**: Strictly maintained API signatures.

## Installation

```bash
pnpm add @labpics/motion
```

## Usage

### Spring Simulation

```typescript
import { spring } from '@labpics/motion';

const result = spring({ mass: 1, stiffness: 100, damping: 10 }, 0.5); // t is in seconds
console.log(result.value); // Position value
console.log(result.velocity); // Velocity value
```

### Animating Elements (drive API)

```typescript
import { drive } from '@labpics/motion';

drive({
  from: 0,
  to: 100,
  spring: { mass: 1, stiffness: 100, damping: 10 },
  onStep: (value) => {
    element.style.transform = `translateX(${value}px)`;
  },
  matchMedia: window.matchMedia.bind(window), // Inject window seams for accessibility/reduced motion
});
```

## License

MIT
