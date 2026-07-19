/**
 * compiler/vite.ts — Vite/Rollup-адаптер build-time lowering (#208).
 *
 * `motionCompiler()` — build-tool entry (не runtime-tier): transform-hook
 * парсит модуль штатным `this.parse` (acorn Rollup), передаёт ESTree ядру
 * (§13.5: ядро parse-независимо) и применяет байтовые правки.
 *
 * Sourcemap без вмешательства в исходные позиции: правки строго заменяют
 * фрагменты ВНУТРИ существующих строк (обрамление вызова), а единственная
 * вставка — hoisted-импорт executor — дописывается В КОНЕЦ файла (ESM
 * поднимает импорты, семантика неизменна). Поэтому карта — отображение
 * сегментов исходной строки с точным сдвигом колонок после каждой правки.
 */

import {
  COMPILED_IMPORT_NAME,
  nanoArtifactLiteral,
  planNanoOpacityLowering,
  type AstNode,
  type NanoLoweringEdit,
} from '../core.js';

interface TransformResult {
  readonly code: string;
  readonly map: {
    readonly version: 3;
    readonly mappings: string;
    readonly sources: readonly string[];
    readonly names: readonly string[];
  };
}

interface RollupTransformContext {
  parse(code: string): unknown;
}

/** Минимальный структурный контракт плагина: не тянем типы vite в d.ts. */
export interface MotionCompilerPlugin {
  readonly name: string;
  readonly enforce: 'pre';
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
 * Идентичная карта строк с колонковыми сдвигами: для каждой исходной строки
 * эмитим сегменты [genCol, 0, line, srcCol] вокруг правок этой строки.
 */
function buildMap(code: string, edits: readonly NanoLoweringEdit[]): TransformResult['map'] {
  const lineStarts: number[] = [0];
  for (let index = 0; index < code.length; index++) {
    if (code.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  const lineOf = (offset: number): [line: number, column: number] => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return [low, offset - lineStarts[low]!];
  };

  let previousGenColumn = 0;
  let previousLine = 0;
  let previousColumn = 0;
  const segment = (genColumn: number, line: number, column: number): string => {
    const encoded = vlq(genColumn - previousGenColumn) + vlq(0) +
      vlq(line - previousLine) + vlq(column - previousColumn);
    previousGenColumn = genColumn;
    previousLine = line;
    previousColumn = column;
    return encoded;
  };

  const lines: string[][] = lineStarts.map(() => []);
  for (let line = 0; line < lineStarts.length; line++) {
    previousGenColumn = 0;
    let shift = 0;
    const start = lineStarts[line]!;
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : code.length;
    lines[line]!.push(segment(0, line, 0));
    for (const edit of edits) {
      const [editLine, editColumn] = lineOf(edit.start);
      if (editLine !== line) continue;
      const [endLine, endColumn] = lineOf(edit.end);
      if (endLine !== line) continue; // правки ядра не пересекают строки
      shift += edit.replacement.length - (edit.end - edit.start);
      if (endColumn + shift >= 0 && end - start > endColumn) {
        lines[line]!.push(segment(endColumn + shift, line, endColumn));
      }
    }
  }
  return {
    version: 3,
    mappings: lines.map((segments) => segments.join(',')).join(';'),
    sources: [''],
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

/** Быстрый отсев до парсинга: модуль вообще не упоминает nano-субпуть. */
const QUICK_FILTER = '@labpics/motion/nano';

export function motionCompiler(): MotionCompilerPlugin {
  return {
    name: 'lab-motion:nano-lowering',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('\0') || !code.includes(QUICK_FILTER)) return undefined;
      let program: unknown;
      try {
        program = this.parse(code);
      } catch {
        return undefined; // не наш синтаксис — пусть падает штатный пайплайн
      }
      const plan = planNanoOpacityLowering(program as AstNode, nanoArtifactLiteral);
      if (plan === undefined) return undefined;
      const transformed = applyEdits(code, plan.edits) +
        `\nimport { ${COMPILED_IMPORT_NAME} as ${plan.importLocal} } from ${JSON.stringify(plan.importSource)};\n`;
      return { code: transformed, map: buildMap(code, plan.edits) };
    },
  };
}
