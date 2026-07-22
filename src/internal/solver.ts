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
 *
 * Каноническая pole-space форма (#226): α = c/m/2, ω² = k/m, Δ = ω²−α²;
 * ветвление по знаку Δ (>0 under, ==0 critical, <0 over). Медленный
 * overdamped-полюс — резольвентным тождеством r_slow = −ω²/(α+√(−Δ)):
 * прежняя запись −ω₀(ζ−√(ζ²−1)) страдала catastrophic cancellation и при
 * ζ ≳ 1e8 теряла полюс целиком (неподвижная кривая). Обе стороны near-critical
 * непрерывно сходятся к критической форме — branch-политика без magic-epsilon.
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
    // Канонические pole-коэффициенты (#226): α = c/m/2 (деление ДО половинения —
    // 2·m переполняется при конечных scale-equivalent m/k/c, канон nano SSOT),
    // ω² = k/m, Δ = ω²−α². Ветвление по знаку Δ; обе стороны near-critical
    // непрерывно сходятся к критической форме, поэтому magic-epsilon не нужен.
    const alpha = c / m / 2;
    const omega2 = k / m;
    const delta = omega2 - alpha * alpha;
    if (delta > 0) {
      const omegaD = Math.sqrt(delta);
      const decay = Math.exp(-alpha * t);
      const cosD = Math.cos(omegaD * t);
      const sinD = Math.sin(omegaD * t);
      const B = (v0 - alpha) / omegaD;
      const mode = B * sinD - cosD;
      value = 1 + decay * mode;
      velocity =
        decay * (-alpha * mode + omegaD * (sinD + B * cosD));
      if (basis !== undefined) {
        basis._valueV0 = decay * sinD / omegaD;
        basis._velocityV0 = decay * (cosD - alpha * sinD / omegaD);
      }
    } else if (delta === 0) {
      const decay = Math.exp(-alpha * t);
      const B = v0 - alpha;
      const mode = B * t - 1;
      value = 1 + mode * decay;
      velocity = decay * (B - alpha * mode);
      if (basis !== undefined) {
        basis._valueV0 = t * decay;
        basis._velocityV0 = decay * (1 - alpha * t);
      }
    } else {
      // Две огромные модальные амплитуды при |v0|≈MAX взаимно уничтожаются у
      // t≈0. Разделение конечной базы и линейного вклада v0 сохраняет x'(0)=v0
      // без epsilon-переключателя и одновременно является базисом пакета.
      const split = Math.sqrt(-delta);
      // Медленный полюс через резольвентное тождество r_slow·r_fast = ω²:
      // −ω²/(α+split) ≡ −α+split, но БЕЗ катастрофического вычитания близких
      // чисел (#226: старая форма −ω₀(ζ−√(ζ²−1)) теряла полюс при ζ ≳ 1e8).
      const rSlow = -omega2 / (alpha + split);
      const rFast = -alpha - split;
      // r_slow − r_fast = 2·split точно — вычитание полюсов у critical
      // сокращало бы α-части и возвращало cancellation в новом месте.
      const poleGap = 2 * split;
      const e1 = Math.exp(rSlow * t);
      // exp(r_slow·t)−exp(r_fast·t) округляется в ноль у t≈0. Форма от
      // медленной моды и expm1 сохраняет предел valueV0→t, velocityV0→1.
      const modalDelta = Math.expm1(-poleGap * t);
      const valueV0 = (-e1 * modalDelta) / poleGap;
      const velocityV0 = e1 * (1 - (rFast * modalDelta) / poleGap);
      // −expm1(r_fast·t) сохраняет малую базовую позицию вместо 1−exp(r_fast·t).
      value = -Math.expm1(rFast * t) + (rFast + v0) * valueV0;
      // r_slow·r_fast = ω² — точное тождество Виета вместо произведения полюсов.
      velocity = omega2 * valueV0 + v0 * velocityV0;
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
  // Те же канонические pole-коэффициенты, что solveSpring (#226) — бит-в-бит
  // одинаковые формулы и порядок операций обязательны для равенства значений.
  const alpha = c / m / 2;
  const omega2 = k / m;
  const delta = omega2 - alpha * alpha;

  if (delta > 0) {
    const omegaD = Math.sqrt(delta);
    const B = (v0 - alpha) / omegaD;
    return (t) =>
      t <= 0 ? 0 : 1 + Math.exp(-alpha * t) * (-Math.cos(omegaD * t) + B * Math.sin(omegaD * t));
  }
  if (delta === 0) {
    const B = v0 - alpha;
    return (t) => (t <= 0 ? 0 : 1 + (-1 + B * t) * Math.exp(-alpha * t));
  }
  const split = Math.sqrt(-delta);
  const rSlow = -omega2 / (alpha + split);
  const rFast = -alpha - split;
  const poleGap = 2 * split;
  return (t) => {
    if (t <= 0) return 0;
    const e1 = Math.exp(rSlow * t);
    const valueV0 = (-e1 * Math.expm1(-poleGap * t)) / poleGap;
    return -Math.expm1(rFast * t) + (rFast + v0) * valueV0;
  };
}
