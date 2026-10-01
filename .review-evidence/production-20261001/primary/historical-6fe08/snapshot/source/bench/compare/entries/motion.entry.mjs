// Адаптер Motion (motion.dev) — реальный пакет из npm.
import { animate, stagger } from 'motion';

export const name = 'motion';

function norm(c) {
  return { cancel() { try { c.cancel ? c.cancel() : c.stop(); } catch { /* noop */ } } };
}

export function start(els, px, durMs) {
  return norm(animate(els, { x: px }, { duration: durMs / 1000, ease: 'linear' }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(animate(els, { x: px }, { duration: durMs / 1000, ease: 'linear', delay: stagger(gapMs / 1000) }));
}
