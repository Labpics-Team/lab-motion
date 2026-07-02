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
 * Скоуп-пределы:
 * - ОТКРЫТЫЕ пути с совпадающей структурой морфятся покомпонентно как есть,
 *   без пере-выравнивания — у открытого пути нет winding'а, а реверс менял бы
 *   семантику «какая точка стартует анимацию»; направление соответствия
 *   задаёт потребитель порядком точек.
 * - СОСТАВНЫЕ пути (несколько M) при ресэмплинге склеиваются в ОДИН контур:
 *   пер-подконтурный морф (дырки, буква «O» — класс GSAP MorphSVG segments)
 *   вне скоупа — разбейте составной путь на отдельные path-элементы.
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
