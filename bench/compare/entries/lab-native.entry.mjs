// Узкий нативный переход CSS transform через публичный Native.
import { animate } from '../../../dist/native/index.js';

export const name = '@labpics/motion/native';

export function start(elements, px, durationMs) {
  const controls = animate(elements, { transform: 'translateX(' + px + 'px)' }, {
    duration: durationMs, ease: 'linear',
  });
  return {
    finished() { return controls.finished; },
    cancel() { for (const animation of controls) animation.cancel(); },
  };
}
