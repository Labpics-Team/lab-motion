// Узкий нативный переход CSS transform через публичный Nano.
import { animate } from '../../../dist/nano/index.js';

export const name = '@labpics/motion/nano';

export function start(elements, px, durationMs, from = null) {
  const target = 'translateX(' + px + 'px)';
  const transform = from === null ? target : ['translateX(' + from + 'px)', target];
  const controls = animate(elements, { transform }, {
    duration: durationMs, ease: 'linear',
  });
  return {
    finished() { return controls.finished; },
    cancel() { for (const animation of controls) animation.cancel(); },
  };
}
