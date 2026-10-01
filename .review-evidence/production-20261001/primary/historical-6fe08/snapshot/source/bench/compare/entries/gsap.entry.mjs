// Адаптер GSAP — реальный пакет из npm.
import { gsap } from 'gsap';

export const name = 'gsap';

function norm(t) {
  return { cancel() { try { t.kill(); } catch { /* noop */ } } };
}

export function start(els, px, durMs) {
  return norm(gsap.to(els, { x: px, duration: durMs / 1000, ease: 'none' }));
}

export function startStagger(els, px, durMs, gapMs) {
  return norm(gsap.to(els, { x: px, duration: durMs / 1000, ease: 'none', stagger: gapMs / 1000 }));
}
