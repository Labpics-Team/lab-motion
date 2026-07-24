/**
 * units.ts — CSS-юнитное парсирование, интерполяция и относительные значения.
 *
 * Чистые функции. Нет DOM, нет window, нет глобального состояния.
 * SSR-безопасно.
 *
 * Инварианты:
 *   V1. FINITENESS GUARD: interpolate НИКОГДА не возвращает NaN/Infinity.
 *       Переполнение range (to−from→±∞ при |from|+|to|>MAX_VALUE) →
 *       зажато через clampFinite до ±MAX_VALUE.
 *       t=Infinity → t=1 (конечная позиция); t=NaN → t=0 (позиция старта).
 *   V2. SSR-safe: window/document не используются ни при импорте, ни при вызове.
 *   V3. Zero runtime deps.
 *   V4. TypeScript strict — нет `any` в публичном API.
 */

// ── Внутренний страж конечности (зеркало spring.ts / easing/index.ts) ──────
/** @internal */
export function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/**
 * Страж hostile-t: конечный t зажимается в [0,1]; NaN → 0 (позиция старта);
 * ±Infinity → 1/0 (конечная/стартовая позиция). Единая копия для всех
 * интерполяторов ./value.
 * @internal
 */
export function clampProgress(t: number): number {
  return Number.isFinite(t)
    ? t <= 0 ? 0 : t >= 1 ? 1 : t
    : Number.isNaN(t) ? 0
    : t > 0 ? 1 : 0;
}

// ── AST-типы ─────────────────────────────────────────────────────────────────

/**
 * Числовое CSS-значение с опциональным юнитом.
 * Примеры: "100px" → { kind:'unit', value:100, unit:'px' }
 *          "0.5"   → { kind:'unit', value:0.5, unit:'' }
 */
export interface ParsedUnit {
  readonly kind: 'unit';
  readonly value: number;
  readonly unit: string;
}

/**
 * Относительное CSS-значение: +=10px или -=5.
 * Семантика: прибавить/вычесть `amount` из текущего значения.
 */
export interface ParsedRelative {
  readonly kind: 'relative';
  readonly op: '+' | '-';
  readonly amount: number;
  readonly unit: string;
}

/**
 * CSS custom property: var(--имя) или var(--имя, fallback).
 */
export interface ParsedVar {
  readonly kind: 'var';
  readonly name: string;
  readonly fallback: string | undefined;
}

// ── Регулярки ─────────────────────────────────────────────────────────────────

// Числа: целые, дробные, научная нотация, со знаком
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
// Поддерживаемые CSS-юниты
const UNIT = '(?:px|%|deg|rem|vh|vw|em|rad|turn|ms|s|fr|)';

const UNIT_RE = new RegExp(`^(${NUM})(${UNIT})$`, 'i');
const RELATIVE_RE = new RegExp(`^([+-])=(${NUM})(${UNIT})$`, 'i');
// ЛИНЕЙНЫЙ (не catastrophic-backtracking) var()-регекс: ровно ОДИН
// неограниченный квантификатор на fallback-хвост (`[\s\S]*`), захваченный
// "сырым" (пробелы вокруг триммятся в коде через .trim(), не в самой
// регулярке). Прежняя форма `\s*([\s\S]*?)\s*` перед `\)` даёт ДВА
// квантификатора над пересекающимися классами символов (whitespace ⊂
// [\s\S]) — экспоненциальный backtracking на pathological-входе без
// закрывающей скобки (см. test/value-var-redos.test.ts).
const VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/i;
// Defense-in-depth: разумный потолок длины входа до .exec любой из
// регулярок выше (ни одна легитимная CSS-переменная/fallback не
// приближается к этому размеру).
const MAX_PARSE_LENGTH = 4096;

// ── Парсинг ───────────────────────────────────────────────────────────────────

type UnitAST = ParsedUnit | ParsedRelative | ParsedVar;

/**
 * Единый parser-контур. `diagnostic=false` превращает обе ошибки в undefined;
 * константный флаг позволяет tree-shaker полностью удалить публичные строки из
 * графа фасада, не создавая второй реализации грамматики.
 */
function parseUnitImpl(value: string | number, diagnostic: boolean): UnitAST | undefined {
  if (typeof value === 'number') {
    return { kind: 'unit', value: clampFinite(value), unit: '' };
  }

  const s = value.trim();

  if (s.length > MAX_PARSE_LENGTH) {
    if (diagnostic) {
      throw new RangeError(
        `@labpics/motion value: CSS-значение слишком длинное (${s.length} символов, максимум ${MAX_PARSE_LENGTH})`,
      );
    }
    return undefined;
  }

  // CSS var()
  const varMatch = VAR_RE.exec(s);
  if (varMatch) {
    return {
      kind: 'var',
      name: varMatch[1],
      fallback: varMatch[2]?.trim(),
    };
  }

  // Относительные +=/-=
  const relMatch = RELATIVE_RE.exec(s);
  if (relMatch) {
    return {
      kind: 'relative',
      op: relMatch[1] as '+' | '-',
      amount: clampFinite(parseFloat(relMatch[2])),
      unit: relMatch[3].toLowerCase(),
    };
  }

  // Числовое + юнит
  const unitMatch = UNIT_RE.exec(s);
  if (unitMatch) {
    return {
      kind: 'unit',
      value: clampFinite(parseFloat(unitMatch[1])),
      unit: unitMatch[2].toLowerCase(),
    };
  }

  if (diagnostic) {
    throw new RangeError(`@labpics/motion value: не удалось распарсить CSS-значение "${value}"`);
  }
  return undefined;
}

/** Внутренний no-throw seam для фасадов, которые имеют свою диагностику. */
export function tryParseUnit(value: string | number): UnitAST | undefined {
  return parseUnitImpl(value, false);
}

/**
 * Парсит CSS-значение юнита/относительного значения/var() в типизированный AST.
 *
 * Поддерживаемые форматы:
 *   - Числа:           `42`, `3.14`, `-1.5e2`
 *   - С юнитом:        `"100px"`, `"50%"`, `"360deg"`, `"2rem"`, `"1.5vh"`, …
 *   - Относительные:   `"+=10"`, `"-=5"`, `"+=10px"`, `"-=5%"`
 *   - CSS var():       `"var(--my-var)"`, `"var(--my-var, 10px)"`
 *
 * @throws RangeError если значение не распознаётся
 */
export function parseUnit(value: string | number): UnitAST {
  return parseUnitImpl(value, true)!;
}

// ── Интерполяция ──────────────────────────────────────────────────────────────

/**
 * Линейная интерполяция между двумя CSS-значениями юнитного типа.
 *
 * Правила:
 *  - ParsedUnit + ParsedUnit → lerp числовой части, юнит из `to`.
 *  - ParsedRelative → разрешается как ±amount от нуля (база 0), затем lerp.
 *  - ParsedVar → дискретный свап: `from` при t < 0.5, `to` при t >= 0.5.
 *
 * FINITENESS GUARD (V1):
 *   range = to.value − from.value может переполниться в ±Infinity при
 *   |from.value| + |to.value| > MAX_VALUE. Результат зажимается
 *   clampFinite → вывод ВСЕГДА конечен.
 *   t=Infinity → 1 (конец); t=NaN → 0 (старт).
 *
 * @param from     - начальное разобранное значение
 * @param to       - конечное разобранное значение
 * @param t        - нормированный прогресс [0..1]; hostile-t безопасен
 * @returns интерполированное значение в виде строки (с юнитом) или числа
 */
export function interpolateUnit(
  from: ParsedUnit | ParsedRelative | ParsedVar,
  to: ParsedUnit | ParsedRelative | ParsedVar,
  t: number,
): string | number {
  // Страж hostile-t
  const progress = clampProgress(t);

  // var() → дискретный свап
  if (from.kind === 'var' || to.kind === 'var') {
    return progress < 0.5 ? unitToString(from) : unitToString(to);
  }

  const fromVal = resolveUnitValue(from);
  const toVal = resolveUnitValue(to);

  // Lerp с защитой переполнения (V1)
  const range = toVal - fromVal;
  const raw = fromVal + range * progress;
  const result = clampFinite(raw);

  // После guard-а выше оба типа имеют .unit: string — юнит из `to`, откат на
  // `from` ('' falsy). Assertion нужна: TS не сужает по || внутри if-return.
  const unit = (to as ParsedUnit | ParsedRelative).unit || (from as ParsedUnit | ParsedRelative).unit;

  return unit === '' ? result : `${result}${unit}`;
}

/** Разрешает относительное/абсолютное значение в число (база = 0). */
function resolveUnitValue(v: ParsedUnit | ParsedRelative | ParsedVar): number {
  if (v.kind === 'unit') return v.value;
  if (v.kind === 'relative') return v.op === '+' ? v.amount : -v.amount;
  return 0; // var() → 0 (резерв; нормально не достигается после проверки выше)
}

/** Сериализует ParsedUnit/Relative/Var обратно в строку. @internal */
export function unitToString(v: ParsedUnit | ParsedRelative | ParsedVar): string {
  // Кламп закрывает hand-constructed AST (V1); разобранные значения уже
  // конечны, для них это no-op.
  if (v.kind === 'unit') return `${clampFinite(v.value)}${v.unit}`;
  if (v.kind === 'relative') return `${v.op}=${clampFinite(v.amount)}${v.unit}`;
  return v.fallback !== undefined ? `var(${v.name}, ${v.fallback})` : `var(${v.name})`;
}
