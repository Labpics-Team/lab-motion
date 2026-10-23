// Узкий native API Motion: mini + явный transform; hybrid x также аппаратный с 14.2.
import { animate } from 'motion/mini';

export const name = 'motion/mini transform';

export function start(els, px, durMs) {
  const controls = animate(
    els,
    { transform: ['translateX(0px)', `translateX(${px}px)`] },
    { duration: durMs / 1000, ease: 'linear' },
  );
  return {
    finished() { return controls.finished; },
    cancel() {
      try { controls.cancel ? controls.cancel() : controls.stop(); } catch { /* noop */ }
    },
  };
}
