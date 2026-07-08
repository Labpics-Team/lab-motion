/**
 * internal/solver.ts — единый аналитический солвер пружины (все три режима),
 * общий для spring.ts (v0=0) и motion-value.ts (smooth pickup, произвольный v0).
 *
 * До выноса ядро несло ДВЕ копии решения ODE — дубль расползался бы при
 * тюнинге одной без другой и стоил ~четверть веса ядра.
 *
 * Нормализованная задача: m·x'' + c·x' + k·x = k, x(0)=0, x'(0)=v0.
 * Возвращает СЫРЫЕ числа без finite-стражей — политика стражей у вызывающих
 * РАЗНАЯ (spring.ts: clampFinite NaN→0; motion-value: value→1, velocity→0)
 * и сохранена на их сторонах бит-в-бит.
 */
import { type SpringParams } from './types.js';

export function solveSpring(
  params: SpringParams,
  t: number,
  v0: number,
): { value: number; velocity: number } {
  const { mass: m, stiffness: k, damping: c } = params;

  if (t <= 0) {
    return { value: 0, velocity: v0 };
  }

  const omega0 = Math.sqrt(k / m);
  // ζ = c/(2√(km)) = c/(2m·ω₀) — тождество √(km) = m·√(k/m) снимает второй
  // sqrt с горячего пути (солвер зовётся на каждый кадр каждого значения).
  const zeta = c / (2 * m * omega0);

  let value: number;
  let velocity: number;

  if (zeta < 1) {
    // Недодемпфированный: u(t) = e^{−ζω₀t}(A·cos ω_d t + B·sin ω_d t),
    // u = x − 1, A = −1, B = (v0 − ζω₀·1·(−1)·(−1))/ω_d = (v0 − ζω₀)/ω_d.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega0 * t);
    const A = -1;
    const B = (v0 - zeta * omega0) / omegaD;
    const cosD = Math.cos(omegaD * t);
    const sinD = Math.sin(omegaD * t);
    const u = decay * (A * cosD + B * sinD);
    value = 1 + u;
    velocity =
      decay * (-zeta * omega0 * (A * cosD + B * sinD) + omegaD * (-A * sinD + B * cosD));
  } else if (zeta === 1) {
    // Критический: u(t) = (A + B·t)e^{−ω₀t}, A = −1, B = v0 − ω₀.
    const A = -1;
    const B = v0 - omega0;
    const decay = Math.exp(-omega0 * t);
    value = 1 + (A + B * t) * decay;
    velocity = decay * (B - omega0 * (A + B * t));
  } else {
    // Передемпфированный: u(t) = A1·e^{r1 t} + A2·e^{r2 t},
    // A1 = (v0 + r2)/(r1 − r2), A2 = −1 − A1.
    const sqrtTerm = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega0 * (zeta - sqrtTerm);
    const r2 = -omega0 * (zeta + sqrtTerm);
    const A1 = (v0 + r2) / (r1 - r2);
    const A2 = -1 - A1;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    value = 1 + A1 * e1 + A2 * e2;
    velocity = A1 * r1 * e1 + A2 * r2 * e2;
  }

  return { value, velocity };
}

/**
 * Фабрика ПОЗИЦИОННОГО сэмплера для ОДНОЙ пружины: считает инварианты
 * (omega0/zeta/omegaD/A/B) ОДИН раз и возвращает монопоморфный (t) → value.
 *
 * Зачем отдельно от solveSpring: горячий путь компилятора (segmenter.buildSpringNodes)
 * зовёт солвер ~сотни раз с ОДНИМИ И ТЕМИ ЖЕ params+v0 на разных t — инварианты там
 * петле-инвариантны, а velocity не нужна. Хойст инвариантов + отказ от velocity и
 * объекта-обёртки = меньше работы на узел сетки. solveSpring НЕ тронут (per-frame путь
 * остаётся мономорфно-инлайнимым — прекомпьют инвариантов В НЁМ замерен как −24.6%).
 * Значение бит-в-бит равно solveSpring(...).value (те же формулы, тот же порядок).
 */
export function makeSpringValueSampler(
  params: SpringParams,
  v0: number,
): (t: number) => number {
  const { mass: m, stiffness: k, damping: c } = params;
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * m * omega0);

  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const zw = zeta * omega0;
    const B = (v0 - zw) / omegaD;
    return (t) =>
      t <= 0 ? 0 : 1 + Math.exp(-zw * t) * (-Math.cos(omegaD * t) + B * Math.sin(omegaD * t));
  }
  if (zeta === 1) {
    const B = v0 - omega0;
    return (t) => (t <= 0 ? 0 : 1 + (-1 + B * t) * Math.exp(-omega0 * t));
  }
  const sqrtTerm = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega0 * (zeta - sqrtTerm);
  const r2 = -omega0 * (zeta + sqrtTerm);
  const A1 = (v0 + r2) / (r1 - r2);
  const A2 = -1 - A1;
  return (t) => (t <= 0 ? 0 : 1 + A1 * Math.exp(r1 * t) + A2 * Math.exp(r2 * t));
}
