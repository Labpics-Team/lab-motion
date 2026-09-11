/**
 * compiler/vite.ts — Vite/Rollup-адаптер build-time lowering (#208).
 *
 * `motionCompiler()` — build-tool entry (не runtime-tier): transform-hook
 * парсит модуль штатным `this.parse` (acorn Rollup), передаёт ESTree ядру
 * (§13.5: ядро parse-независимо) и применяет байтовые правки.
 *
 * Sourcemap строится по границам правок и LF, без посимвольного JS-прохода:
 * сохранённые байты исходника идут сегмент-в-сегмент (включая многострочные
 * вызовы, чьи правки СХЛОПЫВАЮТ строки), замена целиком отображается в начало
 * своей правки, а дописанный в конец hoisted-импорт executor остаётся
 * неотображённым (это не пользовательский код). `sources` обязан нести id
 * модуля: пустой источник Vite нормализует в null, и композиция карт теряла
 * бы все маппинги последующих трансформов.
 */

import {
  planNanoOpacityLowering,
  planSurfaceLowering,
  type AstNode,
  type NanoLoweringEdit,
} from '../core.js';
import { nanoDefaultArtifactLiteral } from '../nano-default-artifact.js';

interface TransformResult {
  readonly code: string;
  readonly map: {
    readonly version: 3;
    readonly mappings: string;
    readonly sources: readonly string[];
    readonly sourcesContent: readonly string[];
    readonly names: readonly string[];
  };
}

interface RollupTransformContext {
  parse(code: string): unknown;
  warn(message: string): void;
}

/** Минимальный структурный контракт плагина: не тянем типы vite в d.ts. */
export interface MotionCompilerPlugin {
  readonly name: string;
  transform(
    this: RollupTransformContext,
    code: string,
    id: string,
  ): TransformResult | undefined;
}

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value: number): string {
  let signed = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = signed & 31;
    signed >>>= 5;
    if (signed > 0) digit |= 32;
    out += VLQ[digit]!;
  } while (signed > 0);
  return out;
}

/**
 * Точная карта версии 3 для applyEdits того же списка правок. Карте важны
 * только границы правок и LF: остальные символы меняют лишь колонку, поэтому
 * диапазоны продвигаются арифметически между найденными переводами строк.
 * Замены не содержат '\n' по построению — нарушение равно ошибке сборки, не
 * тихой порче карты.
 */
function buildMap(
  code: string,
  edits: readonly NanoLoweringEdit[],
  id: string,
): TransformResult['map'] {
  for (const edit of edits) {
    if (edit.replacement.includes('\n')) {
      throw new Error('lab-motion compiler: замена не может содержать перевод строки');
    }
  }
  let mappings = '';
  let separator = '';
  let genColumn = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let previousGenColumn = 0;
  let previousLine = 0;
  let previousColumn = 0;
  const segment = (): void => {
    // sourceIndex всегда 0 и не меняется: VLQ(0) === 'A'.
    mappings += separator + vlq(genColumn - previousGenColumn) + 'A'
      + vlq(originalLine - previousLine) + vlq(originalColumn - previousColumn);
    separator = ',';
    previousGenColumn = genColumn;
    previousLine = originalLine;
    previousColumn = originalColumn;
  };
  // Курсор LF общий для всех последовательных диапазонов: один и тот же
  // хвост исходника не сканируется повторно на каждой границе правки.
  let nextNewline = code.indexOf('\n');
  /** Продвинуть непустой диапазон; kept=true синхронно двигает generated-позицию. */
  const advance = (from: number, to: number, kept: boolean): void => {
    if (from >= to) return;
    if (kept) segment();
    let cursor = from;
    while (nextNewline >= 0 && nextNewline < to) {
      const newline = nextNewline;
      if (kept) {
        genColumn += newline - cursor;
        mappings += ';';
        separator = '';
        genColumn = 0;
        previousGenColumn = 0;
      }
      originalLine++;
      originalColumn = 0;
      cursor = newline + 1;
      nextNewline = code.indexOf('\n', cursor);
      if (kept && cursor < to) segment();
    }
    const tail = to - cursor;
    originalColumn += tail;
    if (kept) genColumn += tail;
  };
  let cursor = 0;
  for (const edit of edits) {
    advance(cursor, edit.start, true);
    segment();
    genColumn += edit.replacement.length;
    advance(edit.start, edit.end, false);
    cursor = edit.end;
  }
  advance(cursor, code.length, true);
  // Хвост '\nimport ...;\n': обе новые generated-строки не имеют source mapping.
  mappings += ';;';
  return {
    version: 3,
    mappings,
    sources: [id],
    sourcesContent: [code],
    names: [],
  };
}

function applyEdits(code: string, edits: readonly NanoLoweringEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return out + code.slice(cursor);
}

/** Быстрый отсев до парсинга: модуль вообще не упоминает целевые субпути. */
const QUICK_FILTERS = ['@labpics/motion/nano', '@labpics/motion/animate'];

export function motionCompiler(): MotionCompilerPlugin {
  return {
    name: 'lab-motion:lowering',
    // Дефолтная фаза, а не enforce:'pre': до транспиляции хук получал сырой
    // TypeScript, this.parse падал, и TS/TSX-модули молча оставались без
    // lowering. После vite:oxc сюда приходит уже JavaScript.
    transform(code, id) {
      if (id.includes('\0') || !QUICK_FILTERS.some((f) => code.includes(f))) return undefined;
      let program: unknown;
      try {
        program = this.parse(code);
      } catch (error) {
        // Модуль упоминает наши субпути, но не парсится на фазе, где обязан
        // быть JavaScript, — сломанный вход, а не «чужой синтаксис».
        // Диагностика не глотается; имя плагина и позицию Rollup допишет сам.
        this.warn(`lowering пропущен: ${error}`);
        return undefined;
      }
      const ast = program as AstNode;
      // Оба планировщика требуют прямой импорт с одним локальным именем `animate`.
      // Валидный ESM не может объявить его дважды, поэтому применим максимум один план;
      // его правки уже отсортированы ядром, в том числе для вложенных вызовов.
      const plan = planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral)
        ?? planSurfaceLowering(ast, code);
      if (plan === undefined) return undefined;
      const edits = plan.edits;
      const transformed = applyEdits(code, edits)
        + `\nimport { ${plan.importName} as ${plan.importLocal} } from ${JSON.stringify(plan.importSource)};\n`;
      return { code: transformed, map: buildMap(code, edits, id) };
    },
  };
}
