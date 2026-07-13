/** Внутреннее ядро распределения задержек для публичного и compositor API. */

/** Единый предел материализации задержек во всех stagger-входах. */
export const MAX_STAGGER_COUNT = 100_000;

export type StaggerFrom = 'first' | 'last' | 'center' | 'edges' | number;

export interface StaggerGridOptions {
  columns: number;
}

function delayAt(
  distance: number,
  maxDistance: number,
  gap: number,
  ease: ((value: number) => number) | undefined,
): number {
  const position = distance / maxDistance;
  const easedPosition = ease ? ease(position) : position;
  const delay = Number.isFinite(easedPosition)
    ? easedPosition * maxDistance * gap
    : 0;
  return Number.isFinite(delay) && delay >= 0 ? delay : 0;
}

/**
 * Материализует задержки для уже проверенного целого count.
 * Позиционные аргументы не создают промежуточный объект на горячей границе.
 */
export function scheduleStagger(
  count: number,
  gapInput?: number,
  fromInput?: StaggerFrom,
  easingInput?: (value: number) => number,
  gridColumnsInput?: number,
  reducedMotion?: boolean,
): number[] {
  if (count < 2) return count ? [0] : [];
  if (reducedMotion === true) return new Array<number>(count).fill(0);

  const gap = Number.isFinite(gapInput) && gapInput! >= 0
    ? gapInput!
    : 50;
  const ease = typeof easingInput === 'function' ? easingInput : undefined;
  const gridColumns = Number.isFinite(gridColumnsInput) && gridColumnsInput! >= 1
    ? Math.floor(gridColumnsInput!)
    : undefined;

  // Grid использует массив как буфер расстояний; 1D сразу пишет задержки,
  // поскольку его максимум выводится без предварительного прохода.
  const result = new Array<number>(count);
  if (!gap) return result.fill(0);
  const numericOrigin = Number.isFinite(fromInput)
    ? Math.max(0, Math.min(count - 1, Math.round(fromInput as number)))
    : 0;
  let maxDistance = 0;

  if (gridColumns) {
    const rows = Math.ceil(count / gridColumns);
    const fromEdges = fromInput === 'edges';
    let originRow = 0;
    let originColumn = 0;
    if (!fromEdges) {
      if (fromInput === 'last') {
        const lastIndex = count - 1;
        originRow = Math.floor(lastIndex / gridColumns);
        originColumn = lastIndex % gridColumns;
      } else if (fromInput === 'center') {
        originRow = (rows - 1) / 2;
        originColumn = (gridColumns - 1) / 2;
      } else {
        originRow = Math.floor(numericOrigin / gridColumns);
        originColumn = numericOrigin % gridColumns;
      }
    }
    const lastRow = rows - 1;
    const lastColumn = gridColumns - 1;
    for (let index = 0; index < count; index++) {
      const row = Math.floor(index / gridColumns);
      const column = index % gridColumns;
      const distance = fromEdges
        ? Math.min(row, lastRow - row, column, lastColumn - column)
        : Math.sqrt(
          (row - originRow) ** 2 + (column - originColumn) ** 2,
        );
      result[index] = distance;
      if (distance > maxDistance) maxDistance = distance;
    }
    if (!maxDistance) return result.fill(0);
    for (let index = 0; index < count; index++) {
      result[index] = delayAt(result[index]!, maxDistance, gap, ease);
    }
    return result;
  }

  const fromEdges = fromInput === 'edges';
  let origin = 0;
  if (!fromEdges) {
    origin = fromInput === 'last'
      ? count - 1
      : fromInput === 'center'
        ? (count - 1) / 2
        : numericOrigin;
  }
  maxDistance = fromEdges
    ? Math.floor((count - 1) / 2)
    : Math.max(origin, count - 1 - origin);
  if (!maxDistance) return result.fill(0);
  for (let index = 0; index < count; index++) {
    const distance = fromEdges
      ? Math.min(index, count - 1 - index)
      : Math.abs(index - origin);
    result[index] = delayAt(distance, maxDistance, gap, ease);
  }

  return result;
}
