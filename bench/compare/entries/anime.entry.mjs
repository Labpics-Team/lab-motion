// Адаптер anime.js v4 — реальный пакет из npm.
import { animate, stagger } from 'animejs';

export const name = 'anime.js';

function norm(a) {
  return { cancel() { try { a.cancel(); } catch { /* noop */ } } };
}

export function start(els, px, durMs) {
  return norm(animate(els, { x: px, duration: durMs, ease: 'linear' }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(animate(els, { x: px, duration: durMs, ease: 'linear', delay: stagger(gapMs) }));
}
