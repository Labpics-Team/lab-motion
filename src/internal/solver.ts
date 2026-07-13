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

/** Коэффициенты линейного решения по начальной скорости. */
export interface MutableSpringBasis {
  _value: number;
  _valueV0: number;
  _velocity: number;
  _velocityV0: number;
}

export function solveSpring(
  params: SpringParams,
  t: number,
  v0: number,
  out?: { value: number; velocity: number },
  basis?: MutableSpringBasis,
): { value: number; velocity: number } {
  const { mass: m, stiffness: k, damping: c } = params;
  let value: number;
  let velocity: number;
  if (t <= 0) {
    value = 0;
    velocity = v0;
    if (basis !== undefined) {
      basis._valueV0 = 0;
      basis._velocityV0 = 1;
    }
  } else {
    const omega0 = Math.sqrt(k / m);
    // ζ = c/(2√(km)) = c/(2m·ω₀): тождество снимает второй sqrt горячего пути.
    const zeta = c / (2 * m * omega0);
    if (zeta < 1) {
      const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
      const decay = Math.exp(-zeta * omega0 * t);
      const cosD = Math.cos(omegaD * t);
      const sinD = Math.sin(omegaD * t);
      const B = (v0 - zeta * omega0) / omegaD;
      const mode = B * sinD - cosD;
      value = 1 + decay * mode;
      velocity =
        decay * (-zeta * omega0 * mode + omegaD * (sinD + B * cosD));
      if (basis !== undefined) {
        basis._valueV0 = decay * sinD / omegaD;
        basis._velocityV0 = decay * (cosD - zeta * omega0 * sinD / omegaD);
      }
    } else if (zeta === 1) {
      const decay = Math.exp(-omega0 * t);
      const B = v0 - omega0;
      const mode = B * t - 1;
      value = 1 + mode * decay;
      velocity = decay * (B - omega0 * mode);
      if (basis !== undefined) {
        basis._valueV0 = t * decay;
        basis._velocityV0 = decay * (1 - omega0 * t);
      }
    } else {
      // Две огромные модальные амплитуды при |v0|≈MAX взаимно уничтожаются у
      // t≈0. Разделение конечной базы и линейного вклада v0 сохраняет x'(0)=v0
      // без epsilon-переключателя и одновременно является базисом пакета.
      const sqrtTerm = Math.sqrt(zeta * zeta - 1);
      const r1 = -omega0 * (zeta - sqrtTerm);
      const r2 = -omega0 * (zeta + sqrtTerm);
      const denominator = r1 - r2;
      const e1 = Math.exp(r1 * t);
      // exp(r1·t)−exp(r2·t) округляется в ноль у t≈0. Форма от медленной
      // моды и expm1 сохраняет предел valueV0→t, velocityV0→1 на всей шкале.
      const modalDelta = Math.expm1(-denominator * t);
      const valueV0 = (-e1 * modalDelta) / denominator;
      const velocityV0 = e1 * (1 - (r2 * modalDelta) / denominator);
      // −expm1(r2·t) сохраняет малую базовую позицию вместо 1−exp(r2·t).
      value = -Math.expm1(r2 * t) + (r2 + v0) * valueV0;
      velocity = r1 * r2 * valueV0 + v0 * velocityV0;
      if (basis !== undefined) {
        basis._valueV0 = valueV0;
        basis._velocityV0 = velocityV0;
      }
    }
  }

  if (basis !== undefined) {
    basis._value = value;
    // У старта −0 — нейтральный элемент, сохраняющий знак входного v0 при
    // последующем сложении basis._velocity + v0·basis._velocityV0.
    basis._velocity = t <= 0 ? -0 : velocity;
  }

  if (!out) return { value, velocity };
  out.value = value;
  out.velocity = velocity;
  return out;
}

const basisSample = { value: 0, velocity: 0 };

/**
 * Строит линейный по v0 базис тем же физическим ядром. Внутренний output-seam
 * дописывает производные коэффициенты из уже посчитанных exp/sin/cos, поэтому
 * пакет каналов платит ровно за один solve без второй копии трёх режимов.
 */
export function sampleSpringBasisUnchecked(
  params: SpringParams,
  t: number,
  out: MutableSpringBasis,
): MutableSpringBasis {
  solveSpring(params, t, 0, basisSample, out);
  return out;
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
  const denominator = r1 - r2;
  return (t) => {
    if (t <= 0) return 0;
    const e1 = Math.exp(r1 * t);
    const valueV0 = (-e1 * Math.expm1(-denominator * t)) / denominator;
    return -Math.expm1(r2 * t) + (r2 + v0) * valueV0;
  };
}
