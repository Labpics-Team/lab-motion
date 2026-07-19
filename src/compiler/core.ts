/**
 * compiler/core.ts — parse-независимое ядро build-time lowering (#208).
 *
 * Скоуп ровно один: статический вызов `animate(target, { opacity: N })` из
 * direct named import '@labpics/motion/nano' без опций. Всё остальное —
 * консервативный отказ: source остаётся семантически исходным.
 *
 * Пайплайн артефакта: nano SSOT (springLinear) → кандидат MotionProgram V1 →
 * parseMotionProgramV1 (единственный оракул доверия) → проекция обратно в
 * `{ frame, durationMs, cssLinear }` с обязательным bit-exact сверением
 * с исходным nano-артефактом. Любое расхождение после доказанного match —
 * ошибка сборки, не silent fallback.
 *
 * Ядро не знает о Vite/Rollup: адаптеры передают ESTree-совместимый Program
 * (узлы со start/end) и применяют возвращённые байтовые правки сами.
 */

import {
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  parseMotionProgramV1,
  type MotionProgramCurveV1,
  type MotionProgramV1,
} from '../internal/motion-program.js';
import { springLinear } from '../nano/spring-linear.js';

// ─── Артефакт ────────────────────────────────────────────────────────────────

export interface CompiledNanoOpacityArtifact {
  readonly frame: { readonly opacity: number };
  readonly durationMs: number;
  readonly cssLinear: string;
}

/** Разбор канонической linear()-строки nano обратно в узлы (точный round-trip). */
function linearPoints(cssLinear: string): number[] {
  if (!cssLinear.startsWith('linear(') || !cssLinear.endsWith(')')) {
    throw new Error('lab-motion compiler: неканоническая linear()-строка nano');
  }
  return cssLinear.slice(7, -1).split(',').map(Number);
}

/**
 * Строит доверенный артефакт compiled-nano для `{ opacity }`-вызова.
 * Бросает (ошибка сборки) при непредставимой программе или расхождении
 * проекции с nano SSOT.
 */
export function compileNanoOpacityArtifact(opacity: number): CompiledNanoOpacityArtifact {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
    throw new Error('lab-motion compiler: opacity обязана быть конечным числом');
  }
  const [durationMs, cssLinear] = springLinear();
  const points = linearPoints(cssLinear);
  const count = points.length - 1;

  // Кусочно-линейная кривая V1 из тех же узлов, что CSS linear()-строка:
  // последовательные пары (offset, value), offset₀=0, offsetN=1.
  const samples: number[] = [1];
  for (let index = 0; index <= count; index++) {
    samples.push(index / count, points[index]!);
  }
  const curve = samples as unknown as MotionProgramCurveV1;

  const candidate = [
    1,
    MOTION_PROGRAM_FEATURE_V1.currentValues,
    [],
    // Индекс 0 канонически зарезервирован линейной кривой.
    [0, curve],
    [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.opacity, 0]],
    [[
      0,
      0,
      durationMs,
      0,
      MOTION_PROGRAM_DIRECTION_V1.normal,
      0,
      MOTION_PROGRAM_COMPOSITE_V1.replace,
      [[0, 1, [0], [1, [0, opacity]], 1, MOTION_PROGRAM_CODEC_V1.scalar]],
    ]],
  ];
  // Единственный оракул доверия — канонический V1-парсер пакета.
  const program: MotionProgramV1 = parseMotionProgramV1(candidate);

  // Проекция обратно: артефакт обязан бит-в-бит совпасть с nano SSOT.
  const track = program[5][0]!;
  const segment = track[7][0]!;
  const to = segment[3];
  const parsedCurve = program[3][segment[4]];
  const projected: number[] = [];
  if (parsedCurve !== 0 && parsedCurve !== undefined) {
    for (let index = 2; index < parsedCurve.length; index += 2) {
      projected.push(parsedCurve[index] as number);
    }
  }
  if (
    track[2] !== durationMs ||
    to[0] !== 1 || to[1]![0] !== 0 || to[1]![1] !== opacity ||
    `linear(${projected})` !== cssLinear
  ) {
    throw new Error('lab-motion compiler: проекция V1 разошлась с nano SSOT');
  }
  return { frame: { opacity }, durationMs, cssLinear };
}

// ─── Нормализованный AST-контракт (§13.5) ────────────────────────────────────

/** Минимальный структурный узел: адаптер обязан дать type + байтовые границы. */
export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface NanoLoweringEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface NanoLoweringPlan {
  /** Непересекающиеся правки в порядке возрастания start. */
  readonly edits: readonly NanoLoweringEdit[];
  /** Локальное имя executor-биндинга; адаптер добавляет hoisted-импорт. */
  readonly importLocal: string;
  /** Субпуть executor-импорта. */
  readonly importSource: string;
  /** Число НЕтрансформированных вызовов nano-animate (для manifest). */
  readonly runtimeCalls: number;
}

const NANO_SOURCE = '@labpics/motion/nano';
export const COMPILED_IMPORT_SOURCE = '@labpics/motion/compiler/runtime';
export const COMPILED_IMPORT_NAME = 'animateCompiled';
const IMPORT_LOCAL = '__labMotionNanoCompiled';

function walk(node: unknown, visit: (node: AstNode, parent: AstNode | undefined) => void, parent?: AstNode): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parent);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as AstNode;
  if (typeof record.type !== 'string') return;
  visit(record, parent);
  for (const key of Object.keys(record)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walk(record[key], visit, record);
  }
}

/** Identifier занимает binding-позицию (объявляет имя), а не читает его. */
function bindsName(node: AstNode, parent: AstNode | undefined, name: string): boolean {
  if (node.type !== 'Identifier' || node.name !== name || parent === undefined) return false;
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id === node || (parent.params as unknown[] | undefined)?.includes(node) === true;
    case 'ArrowFunctionExpression':
      return (parent.params as unknown[]).includes(node);
    case 'CatchClause':
      return parent.param === node;
    // Деструктуризация: любое появление в паттернах — binding.
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
    case 'AssignmentPattern':
      return true;
    case 'Property':
      // Property внутри ObjectPattern неотличим от объектного литерала без
      // scope-анализа: любое value-совпадение — сомнение → консервативный отказ.
      return parent.value === node;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return parent.local === node;
    default:
      return false;
  }
}

/**
 * Планирует lowering модуля. undefined — трансформировать нечего либо
 * консервативный отказ целиком (shadowing/коллизия локального имени).
 */
export function planNanoOpacityLowering(
  program: AstNode,
  artifactLiteral: (opacity: number) => string,
): NanoLoweringPlan | undefined {
  let importedPlain = false;
  const importNodes = new Set<AstNode>();
  let doubt = false;
  let localNameCollision = false;

  walk(program, (node, parent) => {
    if (node.type === 'ImportDeclaration') {
      const source = node.source as AstNode | undefined;
      if (source?.value === NANO_SOURCE) {
        for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
          importNodes.add(spec);
          if (
            spec.type === 'ImportSpecifier' &&
            (spec.imported as AstNode).type === 'Identifier' &&
            (spec.imported as AstNode).name === 'animate' &&
            (spec.local as AstNode).name === 'animate'
          ) {
            importedPlain = true;
          }
        }
      }
    }
    if (node.type === 'Identifier' && node.name === IMPORT_LOCAL) localNameCollision = true;
    if (
      node.name === 'animate' &&
      !importNodes.has(parent as AstNode) &&
      parent?.type !== 'ImportSpecifier' &&
      bindsName(node, parent, 'animate')
    ) {
      doubt = true; // локальное объявление затеняет импорт где-то в модуле
    }
  });

  if (!importedPlain || doubt || localNameCollision) return undefined;

  const edits: NanoLoweringEdit[] = [];
  let runtimeCalls = 0;

  walk(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode;
    if (callee.type !== 'Identifier' || callee.name !== 'animate') return;
    if (node.optional === true) { runtimeCalls++; return; }
    const args = node.arguments as AstNode[];
    if (args.length !== 2) { runtimeCalls++; return; }
    const [targetArg, propsArg] = args as [AstNode, AstNode];
    if (targetArg.type === 'SpreadElement') { runtimeCalls++; return; }
    const opacity = staticOpacityLiteral(propsArg);
    if (opacity === undefined) { runtimeCalls++; return; }
    edits.push(
      { start: callee.start, end: targetArg.start, replacement: `${IMPORT_LOCAL}(` },
      { start: targetArg.end, end: node.end, replacement: `, ${artifactLiteral(opacity)})` },
    );
  });

  if (edits.length === 0) return undefined;
  return {
    edits,
    importLocal: IMPORT_LOCAL,
    importSource: COMPILED_IMPORT_SOURCE,
    runtimeCalls,
  };
}

/** Ровно `{ opacity: <конечный числовой литерал> }`; иначе undefined (отказ). */
function staticOpacityLiteral(props: AstNode): number | undefined {
  if (props.type !== 'ObjectExpression') return undefined;
  const properties = props.properties as AstNode[];
  if (properties.length !== 1) return undefined;
  const property = properties[0]!;
  if (
    property.type !== 'Property' ||
    property.kind !== 'init' ||
    property.method === true ||
    property.computed === true ||
    property.shorthand === true
  ) return undefined;
  const key = property.key as AstNode;
  if (key.type !== 'Identifier' || key.name !== 'opacity') return undefined;
  const value = property.value as AstNode;
  if (value.type !== 'Literal' || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    return undefined;
  }
  return value.value;
}

/** Компактный литерал артефакта для инъекции в код (детерминированный). */
export function nanoArtifactLiteral(opacity: number): string {
  const artifact = compileNanoOpacityArtifact(opacity);
  return `{o:${artifact.frame.opacity},d:${artifact.durationMs},e:${JSON.stringify(artifact.cssLinear)}}`;
}
