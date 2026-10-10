// Публичный root API из сборки проверяемого пакета.
import { animate } from '../../../dist/motion/index.js';

export const name = '@labpics/motion';

function norm(c) {
  return { cancel() { try { c.stop(); } catch { /* уже завершена */ } } };
}

/** Линейный tween x→px за durMs — общий знаменатель всех четырёх библиотек. */
export function start(els, px, durMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: 'linear' }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: 'linear', stagger: gapMs }));
}
