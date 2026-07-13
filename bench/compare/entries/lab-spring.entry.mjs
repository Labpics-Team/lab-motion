// Адаптер @labpics/motion в SPRING-режиме — компоситорный путь фасада
// (WaapiUnit: spring + transform/opacity + tier 'compositor', см. src/animate/index.ts).
// Это НЕ участник tween-матрицы: пружина несравнима с линейным tween напрямую,
// ряд существует ради S5 — проверки продуктового клейма «compositor переживает
// фриз main-thread». Ключевая метрика — «кадров в окне фриза».
import { animate } from '../../../dist/animate/index.js';

export const name = '@labpics/motion (spring→WAAPI)';

// Мягкая пружина: аналитическое оседание ~1.7с (ζ≈0.63, ω₀≈6.3), чтобы во всём
// окне фриза S5 (300–1200мс) движение продолжалось — досевшая пружина не даёт
// компоситору новых кадров, и контроль выродился бы сам собой.
const SPRING = { stiffness: 40, damping: 8, mass: 1 };

function norm(c) {
  return { cancel() { try { c.cancel(); } catch { /* уже завершена */ } } };
}

/** durMs игнорируется намеренно: spring и duration взаимоисключающие в фасаде. */
export function start(els, px) {
  return norm(animate(els, { x: px }, { spring: SPRING }));
}

export function startStagger(els, px, _durMs, gapMs) {
  return norm(animate(els, { x: px }, { spring: SPRING, stagger: gapMs }));
}
