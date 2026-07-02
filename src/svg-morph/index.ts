/**
 * svg-morph/index.ts — морфинг путей (subpath ./svg-morph).
 *
 * Закрывает S17 суперсета (класс GSAP MorphSVGPlugin / anime.js morphTo;
 * у Motion морфа нет — конкурентный ров, D10): interpolatePath(dFrom, dTo)
 * → (p) => d-строка промежуточной формы.
 *
 * Два режима:
 * - ТОЧНЫЙ: структуры команд совпадают (типы и арности, без дуг A/a — их
 *   флаги неинтерполируемы) → покомпонентная линейная интерполяция значений,
 *   ноль потери качества (кривые остаются кривыми).
 * - РЕСЭМПЛИНГ: структуры разные → обе формы сэмплируются равномерно по длине
 *   через createMotionPath; samples задаёт число точек ВЫХОДНОЙ полилинии
 *   (внутренняя дискретизация форм — фиксированная сетка ./svg). Для пары
 *   замкнутых путей стартовые точки ВЫРАВНИВАЮТСЯ: перебор циклического
 *   сдвига И направления обхода (пути из разных редакторов часто с
 *   противоположным winding), минимизируется Σd² — иначе морф
 *   «проворачивается» или схлопывается через центр.
 *
 * СОСТАВНЫЕ пути (несколько M/m — дырки, буква «O»): морф ПЕР-ПОДКОНТУРНЫЙ
 * (класс GSAP MorphSVG segments / flubber separate-combine). Подконтуры
 * сопоставляются ПО ПОРЯДКУ определения (детерминизм; авторы иконок управляют
 * соответствием порядком в d); каждая пара морфится своим режимом
 * (точный/ресэмплинг). При разном числе лишние подконтуры появляются/исчезают
 * через точку-центроид последнего реального партнёра противоположной стороны
 * (enter/exit). Ведущий относительный m абсолютизируется при разбиении.
 *
 * Скоуп-пределы:
 * - ОТКРЫТЫЕ пути с совпадающей структурой морфятся покомпонентно как есть,
 *   без пере-выравнивания — у открытого пути нет winding'а, а реверс менял бы
 *   семантику «какая точка стартует анимацию»; направление соответствия
 *   задаёт потребитель порядком точек.
 * - ОТНОСИТЕЛЬНЫЕ команды (l/c/…) в точном режиме lerp'аются посегментно как
 *   есть (дельты линейны — геометрия корректна); смешанная нотация (L vs l)
 *   считается РАЗНОЙ структурой и уходит в ресэмплинг.
 *
 * Эндпоинты честные: p<=0 → оригинальный dFrom, p>=1 → оригинальный dTo
 * (ни ресэмплинг, ни форматирование не трогают крайние формы).
 *
 * Инварианты: детерминизм (фиксированная сетка, без рандома), CSS-safe
 * (координаты конечны — стражи createMotionPath, NaN p → 0), SSR-safe,
 * zero-deps, MotionParamError рано (мусор/невалидный samples).
 */

import { createMotionPath, parsePath, type SVGCommand } from '../svg/index.js';
import { MotionParamError } from '../errors.js';

export interface InterpolatePathOptions {
  /** Точек сэмплирования в режиме ресэмплинга. Целое >= 2. По умолчанию 64. */
  readonly samples?: number;
}

const DEFAULT_SAMPLES = 64;

/** Округление до 4 знаков + схлопывание -0 (компактно и детерминированно). */
function fmt(n: number): string {
  const r = Number(n.toFixed(4));
  return String(r + 0 === 0 ? 0 : r);
}

function isClosed(cmds: readonly SVGCommand[]): boolean {
  const last = cmds[cmds.length - 1];
  return last !== undefined && last.type.toUpperCase() === 'Z';
}

function hasArcs(cmds: readonly SVGCommand[]): boolean {
  return cmds.some((c) => c.type.toUpperCase() === 'A');
}

function sameStructure(a: readonly SVGCommand[], b: readonly SVGCommand[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.type !== b[i]!.type || a[i]!.values.length !== b[i]!.values.length) return false;
  }
  return true;
}

function clamp01(p: number): number {
  if (Number.isNaN(p)) return 0;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

interface Alignment {
  readonly points: readonly Pt[];
  readonly offset: number;
  readonly reversed: boolean;
}

/**
 * Выравнивание замкнутых контуров: циклический сдвиг o и направление обхода
 * подбираются минимизацией Σ‖from_i − to_i‖². Возвращает точки from,
 * переиндексированные под to, и найденную пару (offset, reversed) — по ней
 * решается допустимость точного режима (только тождественное соответствие).
 */
function alignClosed(from: readonly Pt[], to: readonly Pt[]): Alignment {
  const K = from.length;
  let best = Infinity;
  let bestOffset = 0;
  let bestReversed = false;
  for (const reversed of [false, true]) {
    for (let o = 0; o < K; o++) {
      let sum = 0;
      for (let i = 0; i < K; i++) {
        const j = reversed ? (o - i + 2 * K) % K : (o + i) % K;
        const dx = from[j]!.x - to[i]!.x;
        const dy = from[j]!.y - to[i]!.y;
        sum += dx * dx + dy * dy;
        if (sum >= best) break; // ранний выход — детерминизм не страдает
      }
      if (sum < best) {
        best = sum;
        bestOffset = o;
        bestReversed = reversed;
      }
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < K; i++) {
    const j = bestReversed ? (bestOffset - i + 2 * K) % K : (bestOffset + i) % K;
    out.push(from[j]!);
  }
  return { points: out, offset: bestOffset, reversed: bestReversed };
}

function emitPolyline(points: readonly Pt[], closed: boolean): string {
  const parts: string[] = [`M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`];
  for (let i = 1; i < points.length; i++) {
    parts.push(`L ${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`);
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

/**
 * Разбивает команды на подконтуры (границы — M/m); ведущий относительный m
 * каждой группы абсолютизируется по текущей точке, поэтому каждая группа —
 * самостоятельный d-фрагмент. Прочие команды группы не трогаются (их база —
 * точки внутри группы).
 */
function splitSubpaths(cmds: readonly SVGCommand[]): SVGCommand[][] {
  const groups: SVGCommand[][] = [];
  let cur: SVGCommand[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of cmds) {
    const upper = c.type.toUpperCase();
    const rel = c.type !== upper;
    const v = c.values;
    if (upper === 'M') {
      if (cur.length > 0) groups.push(cur);
      const mx = rel ? cx + v[0]! : v[0]!;
      const my = rel ? cy + v[1]! : v[1]!;
      cur = [{ type: 'M', values: [mx, my] }];
      cx = mx;
      cy = my;
      sx = mx;
      sy = my;
      continue;
    }
    cur.push(c);
    switch (upper) {
      case 'L':
      case 'T':
        cx = rel ? cx + v[0]! : v[0]!;
        cy = rel ? cy + v[1]! : v[1]!;
        break;
      case 'H':
        cx = rel ? cx + v[0]! : v[0]!;
        break;
      case 'V':
        cy = rel ? cy + v[0]! : v[0]!;
        break;
      case 'C':
        cx = rel ? cx + v[4]! : v[4]!;
        cy = rel ? cy + v[5]! : v[5]!;
        break;
      case 'S':
      case 'Q':
        cx = rel ? cx + v[2]! : v[2]!;
        cy = rel ? cy + v[3]! : v[3]!;
        break;
      case 'A':
        cx = rel ? cx + v[5]! : v[5]!;
        cy = rel ? cy + v[6]! : v[6]!;
        break;
      case 'Z':
        cx = sx;
        cy = sy;
        break;
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/** Полная точность (не fmt): фрагмент идёт в parsePath повторно, не в эмит. */
function cmdsToD(cmds: readonly SVGCommand[]): string {
  return cmds
    .map((c) => (c.values.length > 0 ? `${c.type} ${c.values.map(String).join(' ')}` : c.type))
    .join(' ');
}

/** Центроид формы по K равномерным сэмплам (точка появления/исчезновения). */
function centroidOf(d: string, K: number): Pt {
  const mp = createMotionPath(d);
  let x = 0;
  let y = 0;
  for (let i = 0; i < K; i++) {
    const q = mp.at(i / (K - 1));
    x += q.x;
    y += q.y;
  }
  return { x: x / K, y: y / K };
}

/**
 * Составной морф: пары по порядку → рекурсивный interpolatePath на каждой;
 * непарные подконтуры растут из / стягиваются в центроид последнего реального
 * партнёра противоположной стороны. Эндпоинты отдают оригинальные строки.
 */
function compoundFn(
  dFrom: string,
  dTo: string,
  fromGroups: readonly SVGCommand[][],
  toGroups: readonly SVGCommand[][],
  samples: number,
): (p: number) => string {
  const P = Math.max(fromGroups.length, toGroups.length);
  const parts: Array<(p: number) => string> = [];
  for (let i = 0; i < P; i++) {
    const gF = fromGroups[i];
    const gT = toGroups[i];
    if (gF && gT) {
      parts.push(interpolatePath(cmdsToD(gF), cmdsToD(gT), { samples }));
      continue;
    }
    const real = (gF ?? gT)!;
    const realD = cmdsToD(real);
    // Точка enter/exit — центроид последнего подконтура ПРОТИВОПОЛОЖНОЙ
    // стороны: исчезающий стягивается в систему координат цели, появляющийся
    // рождается из неё.
    const partner = gF ? toGroups[toGroups.length - 1]! : fromGroups[fromGroups.length - 1]!;
    const c = centroidOf(cmdsToD(partner), samples);
    const mp = createMotionPath(realD);
    const closedSub = isClosed(real);
    const realPts: Pt[] = Array.from({ length: samples }, (_, k) => {
      const t = closedSub ? k / samples : k / (samples - 1);
      const { x, y } = mp.at(t);
      return { x, y };
    });
    const growing = gT !== undefined; // нет во from → рождается
    parts.push((p: number): string => {
      const w = growing ? p : 1 - p; // вес реальной формы
      const pts = realPts.map((q) => ({
        x: c.x + (q.x - c.x) * w,
        y: c.y + (q.y - c.y) * w,
      }));
      return emitPolyline(pts, closedSub);
    });
  }
  return (p: number): string => {
    const t = clamp01(p);
    if (t <= 0) return dFrom;
    if (t >= 1) return dTo;
    return parts.map((f) => f(t)).join(' ');
  };
}

/**
 * Морф dFrom → dTo. Возвращает чистую функцию p∈[0,1] → d-строка
 * (p клампится, NaN→0; p<=0/p>=1 отдают оригинальные строки).
 */
export function interpolatePath(
  dFrom: string,
  dTo: string,
  options: InterpolatePathOptions = {},
): (p: number) => string {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isInteger(samples) || samples < 2) {
    throw new MotionParamError(
      `interpolatePath: samples должен быть целым >= 2, получено ${samples}`,
    );
  }
  const cmdsFrom = parsePath(dFrom);
  const cmdsTo = parsePath(dTo);

  // Составной путь с любой стороны → пер-подконтурный морф.
  const fromGroups = splitSubpaths(cmdsFrom);
  const toGroups = splitSubpaths(cmdsTo);
  if (fromGroups.length > 1 || toGroups.length > 1) {
    return compoundFn(dFrom, dTo, fromGroups, toGroups, samples);
  }

  const closed = isClosed(cmdsFrom) && isClosed(cmdsTo);
  const exactCandidate = sameStructure(cmdsFrom, cmdsTo) && !hasArcs(cmdsFrom);

  const exactFn = (): ((p: number) => string) => {
    return (p: number): string => {
      const t = clamp01(p);
      if (t <= 0) return dFrom;
      if (t >= 1) return dTo;
      const parts: string[] = [];
      for (let i = 0; i < cmdsFrom.length; i++) {
        const a = cmdsFrom[i]!;
        const b = cmdsTo[i]!;
        const vals = a.values.map((v, k) => fmt(v + (b.values[k]! - v) * t));
        parts.push(vals.length > 0 ? `${a.type} ${vals.join(' ')}` : a.type);
      }
      return parts.join(' ');
    };
  };

  // Открытые пути без циклической неоднозначности: совпала структура → точный.
  if (exactCandidate && !closed) return exactFn();

  // Ресэмплинг: равномерная по длине полилиния обеих форм.
  const mpFrom = createMotionPath(dFrom);
  const mpTo = createMotionPath(dTo);
  const K = samples;
  const at = (mp: typeof mpFrom, i: number): Pt => {
    // замкнутый контур сэмплируется без дублирующей точки t=1
    const t = closed ? i / K : i / (K - 1);
    const { x, y } = mp.at(t);
    return { x, y };
  };
  let fromPts: Pt[] = Array.from({ length: K }, (_, i) => at(mpFrom, i));
  const toPts: Pt[] = Array.from({ length: K }, (_, i) => at(mpTo, i));
  if (closed) {
    const aligned = alignClosed(fromPts, toPts);
    // Точный режим допустим лишь при ТОЖДЕСТВЕННОМ соответствии вершин:
    // совпавшая структура с другим стартом/обходом lerp'ает вершины к чужим
    // углам (фигура схлопывается через центр) — тогда честнее ресэмплинг
    // с найденным выравниванием.
    if (exactCandidate && aligned.offset === 0 && !aligned.reversed) return exactFn();
    fromPts = [...aligned.points];
  }

  return (p: number): string => {
    const t = clamp01(p);
    if (t <= 0) return dFrom;
    if (t >= 1) return dTo;
    const pts: Pt[] = fromPts.map((f, i) => ({
      x: f.x + (toPts[i]!.x - f.x) * t,
      y: f.y + (toPts[i]!.y - f.y) * t,
    }));
    return emitPolyline(pts, closed);
  };
}
