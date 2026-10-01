// Лучший native-путь Motion: mini + явный transform без CSS-variable шортхенда x.
import { animate } from 'motion/mini';

export const name = 'motion/mini transform';

export function start(els, px, durMs) {
  const controls = animate(
    els,
    { transform: ['translateX(0px)', `translateX(${px}px)`] },
    { duration: durMs / 1000, ease: 'linear' },
  );
  return {
    cancel() {
      try { controls.cancel ? controls.cancel() : controls.stop(); } catch { /* noop */ }
    },
  };
}
