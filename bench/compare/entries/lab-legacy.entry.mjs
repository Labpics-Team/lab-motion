// Прежний публичный ./animate для зарегистрированного baseline, не новый root.
import { animate } from '../../../dist/animate/index.js';

export const name = '@labpics/motion';

function norm(c) {
  return { cancel() { c.cancel(); } };
}

export function start(els, px, durMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: (t) => t }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(animate(els, { x: px }, { duration: durMs, ease: (t) => t, stagger: gapMs }));
}
