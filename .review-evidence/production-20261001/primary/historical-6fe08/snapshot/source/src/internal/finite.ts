/** Канонический finite-страж runtime-границы; нормализует -0. */
export function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value + 0 : 0;
}

/** Канонический finite-страж вычислительного ядра; сохраняет IEEE-754 -0. */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
