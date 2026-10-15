// Лучший native-путь Motion: mini + явный transform без CSS-variable шортхенда x.
import { animate } from 'motion/mini';

export const name = 'motion/mini transform';

export function start(els, px, durMs, from = 0) {
  const controls = animate(
    els,
    { transform: from === null ? `translateX(${px}px)` : [`translateX(${from}px)`, `translateX(${px}px)`] },
    { duration: durMs / 1000, ease: 'linear' },
  );
  return {
    finished() { return controls.finished; },
    cancel() {
      try { controls.cancel ? controls.cancel() : controls.stop(); } catch { /* noop */ }
    },
  };
}
