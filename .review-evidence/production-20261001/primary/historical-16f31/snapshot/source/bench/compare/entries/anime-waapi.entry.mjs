// Лучший native-путь anime.js: отдельный WAAPI-движок + явный transform.
import { waapi } from 'animejs/waapi';

export const name = 'anime.js WAAPI transform';

export function start(els, px, durMs) {
  const controls = waapi.animate(els, {
    transform: ['translateX(0px)', `translateX(${px}px)`],
    duration: durMs,
    ease: 'linear',
  });
  return {
    cancel() {
      try { controls.cancel(); } catch { /* noop */ }
    },
  };
}
