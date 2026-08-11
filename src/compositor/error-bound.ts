/**
 * src/compositor/error-bound.ts — Вычисление гарантированной верхней границы ошибки
 * реконструкции CSS linear() в единицах результата (result units, например CSS px).
 *
 * Оценка точности: гарантированная верхняя граница (bound ≥ true error) и одновременно
 * достаточно тесная (bound ≤ 2 × true error), позволяющая выполнять предварительный
 * запрос до эмиссии для сопряжения поверхностей (surface lowering).
 */

import { MotionParamError } from '../errors.js';
import { makeSpringValueSampler, solveSpring } from '../internal/solver.js';
import { settleTimeUpperBound, type SpringParams } from '../spring.js';

// PATCH_PROBE
/**
 * Переводит бюджет результата в нормализованный допуск до кэша и сегментера.
 * Нулевой span не делится: статический канал не ограничивает общую кривую.
 */
export function effectiveSpringTolerance(
  normalizedTolerance: number,
  from: number,
  to: number,
  maxValueError: number | undefined,
): number {
  if (maxValueError === undefined) return normalizedTolerance;
  if (!Number.isFinite(maxValueError) || maxValueError <= 0) {
    throw new MotionParamError('LM172');
  }
  const span = Math.abs(to - from);
  return span === 0
    ? normalizedTolerance
    : Math.min(normalizedTolerance, maxValueError / span);
}

export interface LinearStop {
  readonly progress: number;
  readonly percent: number;
}

export interface MaxValueErrorOptions {
  readonly spring: SpringParams;
  readonly scale?: number;
  readonly from?: number;
  readonly to?: number;
  readonly v0?: number;
  readonly durationMs?: number;
}

/**
 * Парсит CSS linear() строку в список стопов { progress, percent }.
 */
export function parseCssLinear(css: string): LinearStop[] {
  let str = css.trim();
  if (str.startsWith('linear(') && str.endsWith(')')) {
    str = str.slice(7, -1).trim();
  }
  if (!str) return [];

  const rawStops = str.split(',').map((s) => s.trim()).filter(Boolean);
  if (rawStops.length === 0) return [];

  interface RawStop {
    progress: number;
    percents: number[];
  }

  const parsed: RawStop[] = [];
  for (const raw of rawStops) {
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const progress = Number.parseFloat(parts[0]!);
    if (!Number.isFinite(progress)) continue;

    const percents: number[] = [];
    for (let i = 1; i < parts.length; i++) {
      const pStr = parts[i]!;
      if (pStr.endsWith('%')) {
        const val = Number.parseFloat(pStr.slice(0, -1));
        if (Number.isFinite(val)) percents.push(val);
      }
    }
    parsed.push({ progress, percents });
  }

  if (parsed.length === 0) return [];

  const expanded: { progress: number; percent: number | undefined }[] = [];
  for (const item of parsed) {
    if (item.percents.length === 0) {
      expanded.push({ progress: item.progress, percent: undefined });
    } else {
      for (const pct of item.percents) {
        expanded.push({ progress: item.progress, percent: pct });
      }
    }
  }

  if (expanded.length === 0) return [];

  if (expanded[0]!.percent === undefined) {
    expanded[0]!.percent = 0;
  }
  if (expanded[expanded.length - 1]!.percent === undefined) {
    expanded[expanded.length - 1]!.percent = 100;
  }

  let lastExplicitIdx = 0;
  for (let i = 1; i < expanded.length; i++) {
    if (expanded[i]!.percent !== undefined) {
      const startPct = expanded[lastExplicitIdx]!.percent!;
      const endPct = expanded[i]!.percent!;
      const count = i - lastExplicitIdx;
      for (let j = lastExplicitIdx + 1; j < i; j++) {
        expanded[j]!.percent = startPct + (endPct - startPct) * ((j - lastExplicitIdx) / count);
      }
      lastExplicitIdx = i;
    }
  }

  const result: LinearStop[] = [];
  let maxPct = 0;
  for (const item of expanded) {
    const pct = Math.max(maxPct, item.percent ?? maxPct);
    maxPct = pct;
    result.push({ progress: item.progress, percent: pct });
  }

  return result;
}

/**
 * Вычисляет гарантированную верхнюю границу ошибки реконструкции CSS linear()
 * в единицах результата (result units, например px).
 *
 * @param artifactCss       - CSS linear() строка
 * @param paramsOrOptions   - Физика пружины или объект опций MaxValueErrorOptions
 * @param scaleOrFromWidth  - Масштаб результата или начальная ширина (откуда)
 * @param v0OrToWidth       - Нач. скорость v0 или конечная ширина (куда)
 * @param v0                - Нач. скорость v0 (если 3-й и 4-й параметры - from/to)
 * @param durationMs        - Длительность в миллисекундах (опционально)
 */
export function maxValueError(
  artifactCss: string,
  paramsOrOptions: SpringParams | MaxValueErrorOptions,
  scaleOrFromWidth?: number,
  v0OrToWidth?: number,
  v0?: number,
  durationMs?: number,
): number {
  let spring: SpringParams;
  let scale = 1;
  let velocity = 0;
  let durationSec: number | undefined;

  if ('spring' in paramsOrOptions && typeof paramsOrOptions.spring === 'object') {
    const opts = paramsOrOptions;
    spring = opts.spring;
    if (opts.scale !== undefined) {
      scale = Math.abs(opts.scale);
    } else if (opts.from !== undefined && opts.to !== undefined) {
      scale = Math.abs(opts.to - opts.from);
    }
    velocity = opts.v0 ?? 0;
    if (opts.durationMs !== undefined && opts.durationMs > 0) {
      durationSec = opts.durationMs / 1000;
    }
  } else {
    spring = paramsOrOptions as SpringParams;
    if (v0 !== undefined) {
      // (css, spring, fromWidth, toWidth, v0, durationMs)
      if (scaleOrFromWidth !== undefined && v0OrToWidth !== undefined) {
        scale = Math.abs(v0OrToWidth - scaleOrFromWidth);
      }
      velocity = v0;
      if (durationMs !== undefined && durationMs > 0) {
        durationSec = durationMs / 1000;
      }
    } else if (v0OrToWidth !== undefined) {
      // (css, spring, scale, v0)
      if (scaleOrFromWidth !== undefined) {
        scale = Math.abs(scaleOrFromWidth);
      }
      velocity = v0OrToWidth;
    } else if (scaleOrFromWidth !== undefined) {
      // (css, spring, scale)
      scale = Math.abs(scaleOrFromWidth);
    }
  }

  if (scale === 0) return 0;

  const stops = parseCssLinear(artifactCss);
  if (stops.length < 2) return 0;

  if (durationSec === undefined || durationSec <= 0) {
    durationSec = settleTimeUpperBound(spring, velocity);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;

  const sampleValue = makeSpringValueSampler(spring, velocity);
  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  const cOverM = spring.damping / spring.mass;

  let maxErrorNormalized = 0;

  for (let i = 0; i < stops.length - 1; i++) {
    const sA = stops[i]!;
    const sB = stops[i + 1]!;
    const tA = (sA.percent / 100) * durationSec;
    const tB = (sB.percent / 100) * durationSec;
    const dt = tB - tA;
    if (dt <= 0) continue;

    const pA = sA.progress;
    const pB = sB.progress;

    const subSteps = Math.max(16, Math.ceil(dt * omega0 * 10));
    const h = dt / subSteps;

    let segMaxSubError = 0;
    let segMaxAcc = 0;

    for (let j = 0; j <= subSteps; j++) {
      const frac = j / subSteps;
      const t = tA + frac * dt;
      const pLinear = pA + (pB - pA) * frac;

      const pSpring = sampleValue(t);
      const err = Math.abs(pSpring - pLinear);
      if (err > segMaxSubError) segMaxSubError = err;

      const res = solveSpring(spring, t, velocity);
      const acc = Math.abs(omega0 * omega0 * (1 - res.value) - cOverM * res.velocity);
      if (acc > segMaxAcc) segMaxAcc = acc;
    }

    const taylorBound = (h * h / 8) * segMaxAcc;
    const segErrorBound = segMaxSubError + taylorBound;

    if (segErrorBound > maxErrorNormalized) {
      maxErrorNormalized = segErrorBound;
    }
  }

  return scale * maxErrorNormalized;
}
