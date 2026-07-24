/**
 * Независимый референс-парсер CSS linear() по css-easing-2 (#232).
 *
 * НЕ импортирует production-код: служит второй, независимой реализацией
 * грамматики для round-trip доказательств эмиттера (включая implicit-позиции,
 * двойные проценты и монотонизацию — то, чем канонизация #232 собирается
 * пользоваться). Числа парсит стандартным Number.
 */

export interface LinearStop {
  /** Input-позиция в процентах [обычно 0..100]. */
  readonly input: number;
  /** Output-прогресс. */
  readonly output: number;
}

interface RawPoint {
  output: number;
  input: number | undefined;
}

/**
 * Разбирает содержимое linear(...) в канонический список стопов по алгоритму
 * спеки: (1) точка = число + 0..2 процентов, двойной процент дублирует точку;
 * (2) первый/последний без позиции получают 0%/100%; (3) пропущенные позиции
 * распределяются линейно между ближайшими явными; (4) позиции монотонизируются
 * running-max-ом. Бросает на синтаксически невалидной строке.
 */
export function parseCssLinear(easing: string): LinearStop[] {
  const match = easing.trim().match(/^linear\((.*)\)$/s);
  if (!match) throw new Error(`не linear(): ${easing}`);
  const points: RawPoint[] = [];
  for (const segment of match[1]!.split(',')) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t !== '');
    if (tokens.length < 1 || tokens.length > 3) {
      throw new Error(`точка не <number> <percentage>{0,2}: "${segment}"`);
    }
    const output = Number(tokens[0]);
    if (!Number.isFinite(output)) throw new Error(`не число: "${tokens[0]}"`);
    const percents = tokens.slice(1).map((token) => {
      const m = token.match(/^(-?[\d.eE+-]+)%$/);
      if (!m) throw new Error(`не процент: "${token}"`);
      const value = Number(m[1]);
      if (!Number.isFinite(value)) throw new Error(`не конечный процент: "${token}"`);
      return value;
    });
    if (percents.length === 0) points.push({ output, input: undefined });
    else for (const input of percents) points.push({ output, input });
  }
  if (points.length < 2) throw new Error('linear() требует ≥2 стопов');

  // Шаг 2 спеки: края без позиции.
  if (points[0]!.input === undefined) points[0]!.input = 0;
  if (points[points.length - 1]!.input === undefined) {
    points[points.length - 1]!.input = 100;
  }
  // Шаг 3: линейное распределение пропущенных позиций между явными соседями.
  let anchor = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.input === undefined) continue;
    const gap = i - anchor;
    if (gap > 1) {
      const from = points[anchor]!.input!;
      const to = points[i]!.input!;
      for (let k = 1; k < gap; k++) {
        points[anchor + k]!.input = from + ((to - from) * k) / gap;
      }
    }
    anchor = i;
  }
  // Шаг 4: монотонизация running-max-ом.
  let runningMax = -Infinity;
  return points.map((p) => {
    runningMax = Math.max(runningMax, p.input!);
    return { input: runningMax, output: p.output };
  });
}

/** Сэмплирует канонические стопы в позиции percent (правосторонний kink). */
export function sampleLinearStops(stops: readonly LinearStop[], percent: number): number {
  if (percent <= stops[0]!.input) return stops[0]!.output;
  const last = stops[stops.length - 1]!;
  if (percent >= last.input) return last.output;
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]!;
    if (percent <= b.input) {
      const a = stops[i - 1]!;
      const dx = b.input - a.input;
      if (dx === 0) return b.output;
      return a.output + ((b.output - a.output) * (percent - a.input)) / dx;
    }
  }
  return last.output;
}
