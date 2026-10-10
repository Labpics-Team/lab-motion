// Root API: пружина с той же физикой, что независимый контракт S5.
// Пружинный ряд проверяется отдельно от линейных переходов.
import { animate } from '../../../dist/motion/index.js';

export const name = '@labpics/motion (spring→WAAPI)';

// Мягкая пружина: аналитическое оседание ~1.7с (ζ≈0.63, ω₀≈6.3), чтобы во всём
// окне фриза S5 (300–1200мс) движение продолжалось — досевшая пружина не даёт
// компоситору новых кадров, и контроль выродился бы сам собой.
const SPRING = { stiffness: 40, damping: 8, mass: 1 };

function norm(c) {
  return { finished() { return c.finished; }, cancel() { try { c.stop(); } catch { /* уже завершена */ } } };
}

/** durMs игнорируется намеренно: spring и duration взаимоисключающие в фасаде. */
export function start(els, px) {
  return norm(animate(els, { x: px }, { spring: SPRING }));
}

export function startStagger(els, px, _durMs, gapMs) {
  return norm(animate(els, { x: px }, { spring: SPRING, stagger: gapMs }));
}
