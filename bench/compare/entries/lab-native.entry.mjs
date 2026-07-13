import { springTo } from '../../../dist/animate/native/index.js';

// Та же физика, что у lab-spring: окно S5 сравнивает два Lab WAAPI-пути, а не
// короткий default с продолжающейся пружиной. duration не подменяет физику.
const SPRING = { stiffness: 40, damping: 8, mass: 1 };

export const name = '@labpics/motion native springTo';

export function start(elements, x) {
  return springTo(elements, { x: [0, x] }, { spring: SPRING, reducedMotion: false });
}
