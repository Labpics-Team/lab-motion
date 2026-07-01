/**
 * svg/index.ts — SVG-математика путей (subpath ./svg).
 *
 * Закрывает S15 (draw: stroke-dasharray/offset) и S16 (motion-path: точка и
 * угол вдоль пути) суперсета — классы createDrawable/DrawSVG и
 * createMotionPath/MotionPathPlugin у anime.js/GSAP. Морфинг (S17) —
 * сознательно отдельный поздний скоуп.
 *
 * Пайплайн: parsePath (строгая SVG-грамматика, fail-fast) → нормализация в
 * АБСОЛЮТНЫЕ КУБИКИ (L/H/V/Q/T/A/Z → C по каноничным формулам, дуги — через
 * endpoint→center параметризацию W3C) → детерминированная arc-length таблица
 * (фиксированные 32 сэмпла на сегмент) → длина/точка/угол.
 *
 * Инварианты пакета:
 *   V1. CSS-safe: любой выход конечен; drawPath(_, 1).offset строго 0.
 *   V2. Zero-DOM/SSR-safe: чистые функции, ноль платформенных швов.
 *   V3. Детерминизм: фиксированное число сэмплов — бит-в-бит на любой машине.
 *   V4. Fail-fast парсер: мусор → MotionParamError, не тихий мусор в стилях.
 *   V5. Zero runtime deps.
 */

import { MotionParamError } from '../errors.js';

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Команда SVG-пути (как в исходной строке: тип + числа). */
export interface SVGCommand {
  readonly type: string;
  readonly values: readonly number[];
}

/** Точка на пути: координаты + угол касательной (градусы). */
export interface MotionPathPoint {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** Сэмплированный путь: точка/угол по нормированному прогрессу длины. */
export interface MotionPath {
  /** Точка на доле ДЛИНЫ t ∈ [0,1] (равномерная скорость; клампится, NaN→0). */
  at(t: number): MotionPathPoint;
  /** Полная длина пути (px). */
  readonly length: number;
}

/** Стили отрисовки штриха. */
export interface DrawPathResult {
  readonly strokeDasharray: string;
  readonly strokeDashoffset: number;
}

// ─── Стражи ──────────────────────────────────────────────────────────────────

function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ─── Парсер (строгая SVG path-грамматика) ────────────────────────────────────

/** Арность аргументов команд. */
const ARITY: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const NUM_RE = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/;
const WSP_COMMA_RE = /^[\s,]+/;

/**
 * Распарсить d-атрибут в команды. Строгая грамматика: компактный синтаксис
 * («M10-20», «-5.5.5», arc-флаги без пробелов), повтор аргументов
 * (повтор M — это L по спецификации), экспоненты. Мусор/недобор аргументов →
 * MotionParamError (V4).
 */
export function parsePath(d: string): SVGCommand[] {
  let s = String(d);
  const out: SVGCommand[] = [];
  let i = 0;

  const skipSep = (): void => {
    const m = WSP_COMMA_RE.exec(s.slice(i));
    if (m) i += m[0].length;
  };

  const readNumber = (): number => {
    skipSep();
    const m = NUM_RE.exec(s.slice(i));
    if (!m) {
      throw new MotionParamError(
        `parsePath: ожидалось число на позиции ${i} в «${d}»`,
      );
    }
    i += m[0].length;
    const v = parseFloat(m[0]);
    if (!Number.isFinite(v)) {
      throw new MotionParamError(`parsePath: неконечное число «${m[0]}» в «${d}»`);
    }
    return v;
  };

  /** Arc-флаг — РОВНО одна цифра 0/1 (могут стоять впритык: «011»). */
  const readFlag = (): number => {
    skipSep();
    const ch = s[i];
    if (ch !== '0' && ch !== '1') {
      throw new MotionParamError(`parsePath: ожидался arc-флаг 0/1 на позиции ${i} в «${d}»`);
    }
    i++;
    return ch === '1' ? 1 : 0;
  };

  const hasMoreArgs = (): boolean => {
    skipSep();
    if (i >= s.length) return false;
    return NUM_RE.test(s.slice(i));
  };

  skipSep();
  if (i >= s.length) throw new MotionParamError('parsePath: пустой путь');

  let sawMove = false;

  while (i < s.length) {
    skipSep();
    if (i >= s.length) break;
    const cmdCh = s[i];
    const upper = cmdCh.toUpperCase();
    if (!(upper in ARITY)) {
      throw new MotionParamError(`parsePath: неизвестная команда «${cmdCh}» в «${d}»`);
    }
    if (!sawMove && upper !== 'M') {
      throw new MotionParamError(`parsePath: путь обязан начинаться с M/m, встречено «${cmdCh}»`);
    }
    i++;
    const arity = ARITY[upper];

    if (arity === 0) {
      out.push({ type: cmdCh, values: [] });
      continue;
    }

    let first = true;
    do {
      const values: number[] = [];
      for (let a = 0; a < arity; a++) {
        // A: аргументы 3 и 4 — однозначные флаги.
        if (upper === 'A' && (a === 3 || a === 4)) values.push(readFlag());
        else values.push(readNumber());
      }
      // Повтор аргументов у M по спецификации трактуется как L.
      const effType = !first && upper === 'M' ? (cmdCh === 'M' ? 'L' : 'l') : cmdCh;
      out.push({ type: effType, values });
      first = false;
      sawMove = true;
    } while (hasMoreArgs());
  }

  if (out.length === 0) throw new MotionParamError('parsePath: путь без команд');
  return out;
}

// ─── Нормализация в абсолютные кубики ────────────────────────────────────────

/** Кубический сегмент: p0 → p3 с контролями p1, p2. */
interface Cubic {
  readonly x0: number; readonly y0: number;
  readonly x1: number; readonly y1: number;
  readonly x2: number; readonly y2: number;
  readonly x3: number; readonly y3: number;
}

function lineToCubic(x0: number, y0: number, x3: number, y3: number): Cubic {
  return {
    x0, y0,
    x1: x0 + (x3 - x0) / 3, y1: y0 + (y3 - y0) / 3,
    x2: x0 + (2 * (x3 - x0)) / 3, y2: y0 + (2 * (y3 - y0)) / 3,
    x3, y3,
  };
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x3: number, y3: number): Cubic {
  // Каноничное повышение степени: c1 = p0 + 2/3(q−p0), c2 = p3 + 2/3(q−p3).
  return {
    x0, y0,
    x1: x0 + (2 / 3) * (qx - x0), y1: y0 + (2 / 3) * (qy - y0),
    x2: x3 + (2 / 3) * (qx - x3), y2: y3 + (2 / 3) * (qy - y3),
    x3, y3,
  };
}

/**
 * Дуга → кубики: endpoint→center параметризация (W3C SVG F.6.5-F.6.6) +
 * разбиение на сегменты ≤ 90° со стандартной константой контролей.
 */
function arcToCubics(
  x0: number, y0: number,
  rxIn: number, ryIn: number, rotDeg: number,
  largeArc: number, sweep: number,
  x: number, y: number,
): Cubic[] {
  // Вырожденные радиусы — по спецификации это прямая.
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [lineToCubic(x0, y0, x, y)];

  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5.1
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6: коррекция недостаточных радиусов.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }

  // F.6.5.2
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  // F.6.5.3
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  // F.6.5.5-6: углы.
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;

  // Разбиение на сегменты ≤ 90°.
  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segs;
  const t = ((4 / 3) * Math.tan(delta / 4));

  const out: Cubic[] = [];
  let th = theta1;
  let px = x0;
  let py = y0;
  for (let sIdx = 0; sIdx < segs; sIdx++) {
    const th2 = th + delta;
    const cos1 = Math.cos(th);
    const sin1 = Math.sin(th);
    const cos2 = Math.cos(th2);
    const sin2 = Math.sin(th2);
    // Точка и производная на эллипсе (с поворотом phi).
    const ex = (c: number, sn: number): number => cx + rx * cosPhi * c - ry * sinPhi * sn;
    const ey = (c: number, sn: number): number => cy + rx * sinPhi * c + ry * cosPhi * sn;
    const dxTh = (c: number, sn: number): number => -rx * cosPhi * sn - ry * sinPhi * c;
    const dyTh = (c: number, sn: number): number => -rx * sinPhi * sn + ry * cosPhi * c;
    const nx = ex(cos2, sin2);
    const ny = ey(cos2, sin2);
    out.push({
      x0: px, y0: py,
      x1: px + t * dxTh(cos1, sin1), y1: py + t * dyTh(cos1, sin1),
      x2: nx - t * dxTh(cos2, sin2), y2: ny - t * dyTh(cos2, sin2),
      x3: nx, y3: ny,
    });
    th = th2;
    px = nx;
    py = ny;
  }
  return out;
}

/** Нормализовать команды в абсолютные кубики (M создаёт новый субпуть). */
function toCubics(cmds: readonly SVGCommand[]): Cubic[] {
  const out: Cubic[] = [];
  let cx = 0; // текущая точка
  let cy = 0;
  let sx = 0; // старт субпути (для Z)
  let sy = 0;
  let pcx: number | undefined; // отражаемый контроль для S
  let pcy: number | undefined;
  let pqx: number | undefined; // отражаемый контроль для T
  let pqy: number | undefined;

  for (const cmd of cmds) {
    const rel = cmd.type === cmd.type.toLowerCase();
    const T = cmd.type.toUpperCase();
    const v = cmd.values;
    const ax = (idx: number): number => finite(rel ? cx + v[idx] : v[idx]);
    const ay = (idx: number): number => finite(rel ? cy + v[idx] : v[idx]);

    let keepCubicRefl = false;
    let keepQuadRefl = false;

    switch (T) {
      case 'M': {
        cx = ax(0); cy = ay(1); sx = cx; sy = cy;
        break;
      }
      case 'L': {
        const nx = ax(0); const ny = ay(1);
        out.push(lineToCubic(cx, cy, nx, ny));
        cx = nx; cy = ny;
        break;
      }
      case 'H': {
        const nx = finite(rel ? cx + v[0] : v[0]);
        out.push(lineToCubic(cx, cy, nx, cy));
        cx = nx;
        break;
      }
      case 'V': {
        const ny = finite(rel ? cy + v[0] : v[0]);
        out.push(lineToCubic(cx, cy, cx, ny));
        cy = ny;
        break;
      }
      case 'C': {
        const c1x = ax(0); const c1y = ay(1);
        const c2x = ax(2); const c2y = ay(3);
        const nx = ax(4); const ny = ay(5);
        out.push({ x0: cx, y0: cy, x1: c1x, y1: c1y, x2: c2x, y2: c2y, x3: nx, y3: ny });
        pcx = c2x; pcy = c2y; keepCubicRefl = true;
        cx = nx; cy = ny;
        break;
      }
      case 'S': {
        const c1x = pcx !== undefined ? 2 * cx - pcx : cx;
        const c1y = pcy !== undefined ? 2 * cy - (pcy as number) : cy;
        const c2x = ax(0); const c2y = ay(1);
        const nx = ax(2); const ny = ay(3);
        out.push({ x0: cx, y0: cy, x1: c1x, y1: c1y, x2: c2x, y2: c2y, x3: nx, y3: ny });
        pcx = c2x; pcy = c2y; keepCubicRefl = true;
        cx = nx; cy = ny;
        break;
      }
      case 'Q': {
        const qx = ax(0); const qy = ay(1);
        const nx = ax(2); const ny = ay(3);
        out.push(quadToCubic(cx, cy, qx, qy, nx, ny));
        pqx = qx; pqy = qy; keepQuadRefl = true;
        cx = nx; cy = ny;
        break;
      }
      case 'T': {
        const qx = pqx !== undefined ? 2 * cx - pqx : cx;
        const qy = pqy !== undefined ? 2 * cy - (pqy as number) : cy;
        const nx = ax(0); const ny = ay(1);
        out.push(quadToCubic(cx, cy, qx, qy, nx, ny));
        pqx = qx; pqy = qy; keepQuadRefl = true;
        cx = nx; cy = ny;
        break;
      }
      case 'A': {
        const nx = ax(5); const ny = ay(6);
        out.push(...arcToCubics(cx, cy, finite(v[0]), finite(v[1]), finite(v[2]), v[3], v[4], nx, ny));
        cx = nx; cy = ny;
        break;
      }
      case 'Z': {
        if (cx !== sx || cy !== sy) out.push(lineToCubic(cx, cy, sx, sy));
        cx = sx; cy = sy;
        break;
      }
    }

    if (!keepCubicRefl) { pcx = undefined; pcy = undefined; }
    if (!keepQuadRefl) { pqx = undefined; pqy = undefined; }
  }
  return out;
}

// ─── Arc-length таблица ──────────────────────────────────────────────────────

/** Сэмплов на кубик — фиксировано (V3: детерминизм и бит-в-бит на любой машине). */
const SAMPLES_PER_CUBIC = 32;

interface SampledPath {
  /** Точки полилинии. */
  readonly xs: number[];
  readonly ys: number[];
  /** Кумулятивная длина до точки i. */
  readonly cum: number[];
  readonly total: number;
}

function cubicPoint(c: Cubic, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const cc = 3 * mt * t * t;
  const dd = t * t * t;
  return {
    x: a * c.x0 + b * c.x1 + cc * c.x2 + dd * c.x3,
    y: a * c.y0 + b * c.y1 + cc * c.y2 + dd * c.y3,
  };
}

function samplePath(cubics: readonly Cubic[]): SampledPath {
  const xs: number[] = [];
  const ys: number[] = [];
  const cum: number[] = [];
  let total = 0;
  let px: number | undefined;
  let py: number | undefined;

  for (const c of cubics) {
    // Разрыв (новый субпуть после M): предыдущий конец ≠ старт кубика.
    // Скачок БЕЗ длины: точка старта пушится с той же кумулятивной длиной —
    // фантомного сегмента нет, а нулевой отрезок не ловится бинарным
    // поиском изнутри (segLen=0 → интерполяция не «проезжает» разрыв).
    const jump = px !== undefined && (finite(c.x0) !== px || finite(c.y0) !== py);
    for (let k = px === undefined || jump ? 0 : 1; k <= SAMPLES_PER_CUBIC; k++) {
      const { x, y } = cubicPoint(c, k / SAMPLES_PER_CUBIC);
      const fx = finite(x);
      const fy = finite(y);
      if (px !== undefined && !(jump && k === 0)) {
        const dx = fx - (px as number);
        const dy = fy - (py as number);
        total = finite(total + Math.sqrt(dx * dx + dy * dy));
      }
      xs.push(fx);
      ys.push(fy);
      cum.push(total);
      px = fx;
      py = fy;
    }
  }
  return { xs, ys, cum, total };
}

// ─── Публичное API ───────────────────────────────────────────────────────────

/** Полная длина пути (px), детерминированная (V3). */
export function pathLength(d: string): number {
  return samplePath(toCubics(parsePath(d))).total;
}

/**
 * Стили «отрисовки» штриха: strokeDasharray = длина, strokeDashoffset —
 * остаток. progress ≥ 1 → offset СТРОГО 0 (V1, без float-хвоста).
 * Принимает путь строкой или заранее вычисленную длину.
 */
export function drawPath(pathOrLength: string | number, progress: number): DrawPathResult {
  const len = Math.max(0, finite(typeof pathOrLength === 'number' ? pathOrLength : pathLength(pathOrLength)));
  const p = clamp01(progress);
  const offset = p >= 1 ? 0 : finite(len * (1 - p));
  return { strokeDasharray: String(len), strokeDashoffset: offset };
}

/**
 * Сэмплированный путь для движения вдоль него (S16): точка + угол касательной
 * на доле длины t (равномерная скорость по ДЛИНЕ, не по параметру кривой).
 */
export function createMotionPath(d: string): MotionPath {
  const sampled = samplePath(toCubics(parsePath(d)));
  const { xs, ys, cum, total } = sampled;
  const n = xs.length;

  const at = (t: number): MotionPathPoint => {
    if (n === 0) return { x: 0, y: 0, angle: 0 };
    if (n === 1 || total === 0) return { x: xs[0], y: ys[0], angle: 0 };
    const target = clamp01(t) * total;
    // Бинарный поиск первой точки с cum >= target.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i1 = Math.max(1, lo);
    const i0 = i1 - 1;
    const segLen = cum[i1] - cum[i0];
    const frac = segLen > 0 ? (target - cum[i0]) / segLen : 0;
    const x = finite(xs[i0] + (xs[i1] - xs[i0]) * frac);
    const y = finite(ys[i0] + (ys[i1] - ys[i0]) * frac);
    const angle = finite((Math.atan2(ys[i1] - ys[i0], xs[i1] - xs[i0]) * 180) / Math.PI);
    return { x, y, angle };
  };

  return {
    at,
    get length(): number {
      return total;
    },
  };
}
