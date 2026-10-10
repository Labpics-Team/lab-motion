// Узкий нативный переход CSS transform через публичный Nano.
import { animate } from '../../../dist/nano/index.js';

export const name = '@labpics/motion/nano';

export function start(elements, px, durationMs) {
  const controls = animate(elements, { transform: 'translateX(' + px + 'px)' }, {
    duration: durationMs, ease: 'linear',
  });
  return {
    finished() { return controls.finished; },
    cancel() { for (const animation of controls) animation.cancel(); },
  };
}
