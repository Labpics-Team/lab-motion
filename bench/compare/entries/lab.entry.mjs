// Адаптер @labpics/motion — реальный фасад ./animate из собранного dist.
// Тот же модуль, что получает потребитель через exports["./animate"].
import { animate } from '../../../dist/animate/index.js';

export const name = '@labpics/motion';

function norm(c) {
  return { cancel() { try { c.cancel(); } catch { /* уже завершена */ } } };
}

/** Линейный tween x→px за durMs — общий знаменатель всех четырёх библиотек. */
export function start(els, px, durMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: (t) => t }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: (t) => t, stagger: gapMs }));
}
