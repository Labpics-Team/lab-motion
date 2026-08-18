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
import { tryCompileSurfaceArtifact } from '../future-layout/artifact.js';
import { DEFAULT_SPRING } from '../internal/motion-defaults.js';
import type { SpringParams } from '../spring.js';

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

// ─── Общий nano-артефакт: мультиканальный frame + spring-опции (#221) ────────

/** Статически доказанный вызов nano: канонизированный frame + опции. */
export interface StaticNanoCall {
  readonly props: Readonly<Record<string, string | number>>;
  readonly spring?: NanoSpringRecord | undefined;
  readonly delayMs?: number | undefined;
  readonly staggerMs?: number | undefined;
  readonly reducedMotion?: boolean | undefined;
}

export interface NanoSpringRecord {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}

export interface CompiledNanoArtifact {
  /** Канонизированный frame ровно по закону nano (scale, rotate→deg, прочие как есть). */
  readonly frame: Readonly<Record<string, string | number>>;
  readonly durationMs: number;
  readonly cssLinear: string;
  readonly delayMs: number;
  readonly staggerMs: number;
  readonly reducedMotion: boolean | undefined;
}

/**
 * Канонизация frame — побуквенно закон nano/index.ts: scale и rotate
 * назначаются первыми, rotate получает суффикс deg, остальные ключи копируются
 * в исходном порядке. Расхождение с рантаймом здесь ломает differential-сьют.
 */
function canonicalNanoFrame(props: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const frame: Record<string, string | number> = {};
  if (props['scale'] !== undefined) frame['scale'] = props['scale'];
  if (props['rotate'] !== undefined) frame['rotate'] = `${props['rotate'] as number}deg`;
  for (const property of Object.keys(props)) {
    if (property !== 'scale' && property !== 'rotate') frame[property] = props[property]!;
  }
  return frame;
}

/**
 * Строит доверенный артефакт общего nano-вызова через канонический V1-парсер.
 *
 * Каждый CSS-канал кодируется host-extension каналом [255, stringIndex] со
 * строковой таблицей; числовые значения — скаляром, строковые — token'ом с
 * кодеком webCssOpaque; delay — startMs трека. stagger и reducedMotion в V1
 * не выражаются (это политика исполнителя на элемент), поэтому проверяются
 * литеральной валидацией и не входят в программу.
 *
 * Tween-форма (duration/ease) сюда не попадает вовсе: кривые V1 — только
 * кусочно-линейные сэмплы, нативная easing-строка непредставима без расширения
 * versioned-контракта. До этого расширения tween остаётся runtime-вызовом.
 */
export function compileNanoArtifact(call: StaticNanoCall): CompiledNanoArtifact {
  const frame = canonicalNanoFrame(call.props);
  const channels = Object.keys(frame);
  if (channels.length === 0) {
    throw new Error('lab-motion compiler: пустой frame непонижаем');
  }
  for (const [property, value] of Object.entries(frame)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`lab-motion compiler: значение ${property} обязано быть конечным`);
    }
  }
  // springLinear — SSOT физики: невалидная статическая пружина падает здесь же
  // с его собственной причиной (ошибка сборки, не silent fallback).
  const [durationMs, cssLinear] = springLinear(call.spring);
  const points = linearPoints(cssLinear);
  const count = points.length - 1;
  const samples: number[] = [1];
  for (let index = 0; index <= count; index++) samples.push(index / count, points[index]!);
  const curve = samples as unknown as MotionProgramCurveV1;

  const delayMs = call.delayMs ?? 0;
  const staggerMs = call.staggerMs ?? 0;
  if (!Number.isFinite(delayMs) || !Number.isFinite(staggerMs)) {
    throw new Error('lab-motion compiler: delay и stagger обязаны быть конечными');
  }

  const strings: string[] = [];
  const stringIndex = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing !== -1) return existing;
    strings.push(value);
    return strings.length - 1;
  };

  // Один субъект (slot 0) на все каналы: nano анимирует один элемент. Каждый
  // host-канал — своя поверхность, поэтому общий ownerGroup каноничен.
  const bindings = channels.map((property) =>
    [0, [255, stringIndex(property)] as const, 0] as const);
  const tracks = channels.map((property, index) => {
    const value = frame[property]!;
    const encoded = typeof value === 'number'
      ? ([1, [0, value]] as const)
      : ([1, [2, stringIndex(value)]] as const);
    const codec = typeof value === 'number'
      ? MOTION_PROGRAM_CODEC_V1.scalar
      : MOTION_PROGRAM_CODEC_V1.webCssOpaque;
    return [
      index,
      delayMs,
      durationMs,
      0,
      MOTION_PROGRAM_DIRECTION_V1.normal,
      0,
      MOTION_PROGRAM_COMPOSITE_V1.replace,
      [[0, 1, [0], encoded, 1, codec]],
    ];
  });

  const candidate = [
    1,
    // currentValues: from берётся снапшотом; hostExtensions: каналы адресуются
    // CSS-именами через строковую таблицу — парсер требует объявить фактически
    // используемые возможности.
    MOTION_PROGRAM_FEATURE_V1.currentValues | MOTION_PROGRAM_FEATURE_V1.hostExtensions,
    strings,
    // Индекс 0 канонически зарезервирован линейной кривой.
    [0, curve],
    bindings,
    tracks,
  ];
  // Единственный оракул доверия — канонический V1-парсер пакета.
  const program: MotionProgramV1 = parseMotionProgramV1(candidate);

  // Проекция обратно: каждый канал обязан бит-в-бит совпасть с nano SSOT.
  const parsedStrings = program[2];
  const parsedCurve = program[3][1];
  const projectedPoints: number[] = [];
  if (parsedCurve !== 0 && parsedCurve !== undefined) {
    for (let index = 2; index < parsedCurve.length; index += 2) {
      projectedPoints.push(parsedCurve[index] as number);
    }
  }
  if (`linear(${projectedPoints})` !== cssLinear) {
    throw new Error('lab-motion compiler: кривая V1 разошлась с nano SSOT');
  }
  const projected: Record<string, string | number> = {};
  for (const track of program[5]) {
    const binding = program[4][track[0]]!;
    const channel = binding[1];
    if (typeof channel === 'number' || channel[0] !== 255) {
      throw new Error('lab-motion compiler: неожиданный канал после парсинга');
    }
    const property = parsedStrings[channel[1]]!;
    const to = track[7][0]![3];
    if (to[0] !== 1) throw new Error('lab-motion compiler: to-значение не абсолютно');
    const encoded = to[1]!;
    projected[property] = encoded[0] === 0
      ? (encoded[1] as number)
      : parsedStrings[encoded[1] as number]!;
    if (track[2] !== durationMs || track[1] !== delayMs) {
      throw new Error('lab-motion compiler: тайминг V1 разошёлся с nano SSOT');
    }
  }
  if (JSON.stringify(projected) !== JSON.stringify(frame)) {
    throw new Error('lab-motion compiler: проекция frame разошлась с nano SSOT');
  }

  return { frame, durationMs, cssLinear, delayMs, staggerMs, reducedMotion: call.reducedMotion };
}

/** Компактный литерал общего артефакта для инъекции в код (детерминированный). */
export function nanoCallArtifactLiteral(call: StaticNanoCall): string {
  const artifact = compileNanoArtifact(call);
  const parts = [
    `f:${JSON.stringify(artifact.frame)}`,
    `d:${artifact.durationMs}`,
    `e:${JSON.stringify(artifact.cssLinear)}`,
  ];
  if (artifact.delayMs !== 0) parts.push(`y:${artifact.delayMs}`);
  if (artifact.staggerMs !== 0) parts.push(`g:${artifact.staggerMs}`);
  if (artifact.reducedMotion !== undefined) parts.push(`r:${artifact.reducedMotion}`);
  return `{${parts.join(',')}}`;
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
  /** Экспортируемое имя executor'а в hoisted-импорте. */
  readonly importName: string;
  /** Субпуть executor-импорта. */
  readonly importSource: string;
  /** Число НЕтрансформированных вызовов nano-animate (для manifest). */
  readonly runtimeCalls: number;
}

const NANO_SOURCE = '@labpics/motion/nano';
export const COMPILED_IMPORT_SOURCE = '@labpics/motion/compiler/runtime';
export const COMPILED_IMPORT_NAME = 'animateCompiledNano';
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
 *
 * `code` — байты модуля: ядро остаётся parse-независимым, но верифицирует
 * тривиа-зоны вызова ПОБАЙТНО. Acorn (preserveParens: false) схлопывает
 * скобки вокруг callee/target в сам узел, поэтому только байтовая проверка
 * отличает `animate(el, …)` от `(animate)(el, …)` и `animate((x, y), …)` —
 * первые правки без неё производили битый или тихо неверный вывод.
 */
export function planNanoOpacityLowering(
  program: AstNode,
  code: string,
  artifactLiteral: (opacity: number) => string,
): NanoLoweringPlan | undefined {
  return planNanoCalls(program, code, (propsArg, optionsArg) => {
    if (optionsArg !== undefined) return undefined;
    const opacity = staticOpacityLiteral(propsArg);
    if (opacity === undefined) return undefined;
    return artifactLiteral(opacity);
  });
}

/**
 * Общий обход модуля: precondition-анализ импортов/затенений и байтовая
 * верификация тривиа-зон вызова. tryLiteral возвращает литерал артефакта для
 * доказуемого вызова либо undefined (консервативный отказ, вызов остаётся
 * runtime). Поддерживаются формы с двумя и тремя аргументами.
 */
function planNanoCalls(
  program: AstNode,
  code: string,
  tryLiteral: (propsArg: AstNode, optionsArg: AstNode | undefined) => string | undefined,
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
    if (args.length !== 2 && args.length !== 3) { runtimeCalls++; return; }
    const [targetArg, propsArg, optionsArg] = args as [AstNode, AstNode, AstNode | undefined];
    if (targetArg.type === 'SpreadElement' || optionsArg?.type === 'SpreadElement') {
      runtimeCalls++;
      return;
    }
    const literal = tryLiteral(propsArg, optionsArg);
    if (literal === undefined) { runtimeCalls++; return; }
    // Побайтная верификация тривиа-зон: ровно `(`, `,`, `)` с пробелами.
    // Скобки вокруг callee/target, комментарии и прочая экзотика — отказ.
    const tailStart = optionsArg === undefined ? propsArg.end : optionsArg.end;
    if (
      !/^\s*\(\s*$/.test(code.slice(callee.end, targetArg.start)) ||
      !/^\s*,\s*$/.test(code.slice(targetArg.end, propsArg.start)) ||
      (optionsArg !== undefined && !/^\s*,\s*$/.test(code.slice(propsArg.end, optionsArg.start))) ||
      !/^\s*,?\s*\)$/.test(code.slice(tailStart, node.end))
    ) { runtimeCalls++; return; }
    edits.push(
      { start: callee.start, end: targetArg.start, replacement: `${IMPORT_LOCAL}(` },
      { start: targetArg.end, end: node.end, replacement: `, ${literal})` },
    );
  });

  if (edits.length === 0) return undefined;
  // Walk идёт в pre-order (внешний вызов раньше вложенного в target):
  // сортировка восстанавливает документированный инвариант возрастания start.
  // Пары правок вложенных вызовов лежат целиком МЕЖДУ правками внешнего и
  // после сортировки корректно понижаются вместе с ним.
  edits.sort((a, b) => a.start - b.start);
  return {
    edits,
    importLocal: IMPORT_LOCAL,
    importName: COMPILED_IMPORT_NAME,
    importSource: COMPILED_IMPORT_SOURCE,
    runtimeCalls,
  };
}

/**
 * Статическое извлечение полного nano-вызова (#221): props + опции.
 * undefined — консервативный отказ (динамика/сомнение), вызов остаётся runtime.
 * Ошибки бросает ТОЛЬКО артефактный слой на доказанно-статическом инвалиде.
 */
function staticNanoCallLiteral(propsArg: AstNode, optionsArg: AstNode | undefined): StaticNanoCall | undefined {
  const props = staticPropsLiteral(propsArg);
  if (props === undefined) return undefined;
  if (optionsArg === undefined) return { props };
  const options = staticOptionsLiteral(optionsArg);
  if (options === undefined) return undefined;
  return { props, ...options };
}

/** Числовой/строковый литерал, включая унарный минус. undefined — отказ. */
function staticScalarLiteral(value: AstNode): string | number | undefined {
  if (value.type === 'Literal') {
    const raw = value.value;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') return raw;
    return undefined; // null/true/false/regexp в позиции значения — сомнение
  }
  if (
    value.type === 'UnaryExpression' &&
    value.operator === '-' &&
    (value.argument as AstNode).type === 'Literal'
  ) {
    const raw = (value.argument as AstNode).value;
    if (typeof raw === 'number' && Number.isFinite(raw)) return -raw;
  }
  return undefined;
}

/** Плоский объектный литерал с Identifier-ключами без дублей. undefined — отказ. */
function staticPlainObject(node: AstNode): Map<string, AstNode> | undefined {
  if (node.type !== 'ObjectExpression') return undefined;
  const out = new Map<string, AstNode>();
  for (const property of node.properties as AstNode[]) {
    if (
      property.type !== 'Property' ||
      property.kind !== 'init' ||
      property.method === true ||
      property.computed === true ||
      property.shorthand === true
    ) return undefined;
    const key = property.key as AstNode;
    if (key.type !== 'Identifier') return undefined;
    // Дубликат ключа: last-wins в JS, но это неоднозначная форма — отказ.
    if (out.has(key.name as string)) return undefined;
    out.set(key.name as string, property.value as AstNode);
  }
  return out;
}

function staticPropsLiteral(node: AstNode): Record<string, string | number> | undefined {
  const entries = staticPlainObject(node);
  if (entries === undefined || entries.size === 0) return undefined;
  const props: Record<string, string | number> = {};
  for (const [name, valueNode] of entries) {
    const value = staticScalarLiteral(valueNode);
    if (value === undefined) return undefined;
    // scale и rotate обязаны быть числами: строковый rotate nano молча
    // отбрасывает из frame — воспроизводить эту странность компилятор не будет.
    if ((name === 'scale' || name === 'rotate') && typeof value !== 'number') return undefined;
    props[name] = value;
  }
  return props;
}

type StaticNanoOptions = Pick<StaticNanoCall, 'spring' | 'delayMs' | 'staggerMs' | 'reducedMotion'>;

function staticOptionsLiteral(node: AstNode): StaticNanoOptions | undefined {
  const entries = staticPlainObject(node);
  if (entries === undefined) return undefined;
  const options: {
    spring?: NanoSpringRecord;
    delayMs?: number;
    staggerMs?: number;
    reducedMotion?: boolean;
  } = {};
  for (const [name, valueNode] of entries) {
    switch (name) {
      case 'spring': {
        const spring = staticPlainObject(valueNode);
        if (spring === undefined) return undefined;
        const record: Record<string, number> = {};
        for (const [field, fieldNode] of spring) {
          if (field !== 'mass' && field !== 'stiffness' && field !== 'damping') return undefined;
          const fieldValue = staticScalarLiteral(fieldNode);
          if (typeof fieldValue !== 'number') return undefined;
          record[field] = fieldValue;
        }
        // Частичная пружина валидна: недостающие поля добирает SSOT springLinear.
        options.spring = record as unknown as NanoSpringRecord;
        break;
      }
      case 'delay':
      case 'stagger': {
        const value = staticScalarLiteral(valueNode);
        if (typeof value !== 'number') return undefined;
        if (name === 'delay') options.delayMs = value;
        else options.staggerMs = value;
        break;
      }
      case 'reducedMotion': {
        const value = valueNode;
        if (value.type !== 'Literal' || typeof value.value !== 'boolean') return undefined;
        options.reducedMotion = value.value;
        break;
      }
      // Tween-форма непредставима в V1 (нативная easing-строка) — runtime.
      case 'duration':
      case 'ease':
        return undefined;
      default:
        return undefined; // неизвестная опция — сомнение
    }
  }
  return options;
}

/**
 * Планирует общий lowering модуля (#221): мультиканальный frame + spring-опции.
 * Контракт совпадает с planNanoOpacityLowering; отличие — какой вызов доказуем.
 */
export function planNanoLowering(
  program: AstNode,
  code: string,
  artifactLiteral: (call: StaticNanoCall) => string,
): NanoLoweringPlan | undefined {
  return planNanoCalls(program, code, (propsArg, optionsArg) => {
    const call = staticNanoCallLiteral(propsArg, optionsArg);
    if (call === undefined) return undefined;
    return artifactLiteral(call);
  });
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

// ─── Surface lowering: animate(..., { layout: 'project' }) ───────────────────
//
// Спека «COMPILER»: versioned surface program, immutable representation,
// untrusted input rejection, conservative lowering — любое сомнение оставляет
// корректный runtime path. Lowering НЕ читает solver/parser (erasure): валидация
// пружины выполняется локальными числовыми инвариантами, а полный сертификат
// остаётся за tryCompileSurfaceArtifact в runtime.

/** Любой не-литерал: сомнение → консервативный отказ. */
export interface SurfaceDynamicNode {
  readonly kind: string;
  readonly name?: string;
}

export interface SurfaceIdentifierNode {
  readonly kind: 'identifier';
  readonly name: string;
}

export type SurfaceCallTarget = SurfaceIdentifierNode | SurfaceDynamicNode;

export interface SurfaceCallInput {
  readonly callee: unknown;
  readonly target: unknown;
  readonly props: unknown;
  readonly options?: unknown;
}

export interface SurfaceSpringRecord {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly velocity?: number;
}

/** Versioned IR: explicit named successor contract, не ad-hoc trusted object. */
export interface SurfaceProgram {
  readonly version: 'surface/1';
  readonly target: { readonly kind: 'identifier'; readonly name: string };
  readonly fromWidth: number;
  readonly toWidth: number;
  readonly spring?: SurfaceSpringRecord;
  readonly inputPolicy?: 'finish' | 'cancel' | 'block';
  readonly scrollAnchor?: 'preserve-start' | 'none';
  readonly hasOnFrame?: boolean;
}

export type SurfaceLoweringResult =
  | { readonly lowered: true; readonly program: SurfaceProgram }
  | { readonly lowered: false; readonly reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Любой AST-узел (kind-запись) в выражающей позиции — динамика/сомнение. */
function hasKind(value: unknown): boolean {
  return isPlainRecord(value) && typeof value['kind'] === 'string';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const reject = (reason: string): SurfaceLoweringResult => ({ lowered: false, reason });

/**
 * Консервативное понижение одного вызова animate(..., { layout: 'project' }).
 * Любое сомнение (динамический аргумент, не-width-канал, нечисловые/неположительные
 * концы, NaN/Infinity, динамическая пружина, неизвестная политика) оставляет
 * корректный runtime path — возврат lowered:false с причиной.
 */
export function lowerSurfaceCall(input: SurfaceCallInput): SurfaceLoweringResult {
  if (input === null || typeof input !== 'object') return reject('input-not-call');
  if (input.callee !== 'animate') return reject('callee-not-animate');

  // Optional call / alias / namespace import выражаются не-plain callee.
  const target = input.target;
  if (!isPlainRecord(target) || target['kind'] !== 'identifier' || typeof target['name'] !== 'string') {
    return reject('target-dynamic');
  }

  const props = input.props;
  if (hasKind(props)) return reject('props-not-static');
  if (!isPlainRecord(props)) return reject('props-not-static');
  const keys = Object.keys(props);
  // Ровно один канал width: spread/computed key/duplicate key/getter — сомнение.
  if (keys.length !== 1 || keys[0] !== 'width') return reject('props-not-width');
  const width = props['width'];
  if (!Array.isArray(width) || width.length !== 2) return reject('width-not-pair');
  const fromWidth = width[0];
  const toWidth = width[1];
  if (hasKind(fromWidth) || hasKind(toWidth)) return reject('width-dynamic');
  if (typeof fromWidth !== 'number' || typeof toWidth !== 'number') return reject('width-not-numeric');
  if (!Number.isFinite(fromWidth) || !Number.isFinite(toWidth)) return reject('width-not-finite');
  if (fromWidth <= 0 || toWidth <= 0) return reject('width-not-positive');

  const options = input.options;
  const program: SurfaceProgram = {
    version: 'surface/1',
    target: { kind: 'identifier', name: target['name'] as string },
    fromWidth,
    toWidth,
  } as SurfaceProgram;

  // Режим всегда явный: surface-понижение существует только для
  // animate(..., { layout: 'project' }); отсутствие опций — сомнение.
  if (!isPlainRecord(options) || options['layout'] !== 'project') return reject('layout-not-project');

  // Неизвестные ключи options — сомнение: runtime исполняет их, а lowered-
  // программа нет (скрытая дивергенция семантики). Fail-closed reject.
  for (const key of Object.keys(options)) {
    if (key !== 'layout' && key !== 'spring' && key !== 'inputPolicy'
      && key !== 'scrollAnchor' && key !== 'onFrame') {
      return reject('options-unknown-key');
    }
  }

  const spring = options['spring'];
  if (spring !== undefined) {
    if (hasKind(spring)) return reject('spring-not-static');
    if (!isPlainRecord(spring)) return reject('spring-not-static');
    for (const key of Object.keys(spring)) {
      if (key !== 'mass' && key !== 'stiffness' && key !== 'damping' && key !== 'velocity') {
        return reject('spring-unknown-key');
      }
    }
    const mass = spring['mass'];
    const stiffness = spring['stiffness'];
    const damping = spring['damping'];
    const velocity = spring['velocity'];
    if (hasKind(mass) || hasKind(stiffness) || hasKind(damping) || hasKind(velocity)) {
      return reject('spring-dynamic');
    }
    if (
      typeof mass !== 'number' || typeof stiffness !== 'number' || typeof damping !== 'number'
      || !Number.isFinite(mass) || !Number.isFinite(stiffness) || !Number.isFinite(damping)
      || mass <= 0 || stiffness <= 0 || damping < 0
    ) {
      return reject('spring-invalid');
    }
    // Ненулевая начальная скорость меняет траекторию, а runtime-путь берёт её
    // из живого наблюдателя; у executor'а наблюдателя нет — сомнение → отказ.
    if (velocity !== undefined && velocity !== 0) {
      return reject('velocity-not-executable');
    }
    (program as { spring?: SurfaceSpringRecord }).spring = { mass, stiffness, damping };
  }

  // Политики ввода и скролла принимались в программу, но артефакт их не
  // сериализовал, а executor не исполнял — латентная дивергенция. Fail-closed:
  // любое их наличие оставляет корректный runtime-вызов.
  if (options['inputPolicy'] !== undefined) {
    return reject('input-policy-not-executable');
  }
  if (options['scrollAnchor'] !== undefined) {
    return reject('scroll-anchor-not-executable');
  }

  const onFrame = options['onFrame'];
  if (onFrame !== undefined) {
    if (hasKind(onFrame)) return reject('onframe-dynamic');
    if (typeof onFrame !== 'function') return reject('onframe-not-function');
    (program as { hasOnFrame?: boolean }).hasOnFrame = true;
  }

  return { lowered: true, program: deepFreeze(program) };
}

// ─── Surface lowering: build-time сертификат и план байтовых правок ──────────

export const SURFACE_IMPORT_SOURCE = '@labpics/motion/compiler/surface';
export const SURFACE_IMPORT_NAME = 'runSurface';
const SURFACE_LOCAL = '__labMotionSurface';
const ANIMATE_SOURCE = '@labpics/motion/animate';

/**
 * Литерал сертифицированного артефакта для инжекта в код потребителя.
 * Сертификация НА СБОРКЕ: позитивность (minWidth>0) и reciprocal-бюджет
 * ≤0.25 CSS px доказаны tryCompileSurfaceArtifact, иначе undefined —
 * вызов остаётся на корректном runtime path (fail-closed, как в спеке).
 */
export function surfaceArtifactLiteral(program: SurfaceProgram): string | undefined {
  const spring: SpringParams = program.spring === undefined
    ? DEFAULT_SPRING
    : {
      mass: program.spring.mass,
      stiffness: program.spring.stiffness,
      damping: program.spring.damping,
    };
  const artifact = tryCompileSurfaceArtifact(
    spring,
    program.fromWidth,
    program.toWidth,
    undefined,
    undefined,
    program.spring?.velocity ?? 0,
  );
  if (artifact === undefined) return undefined;
  // P, Q и blend A сериализуются из ОДНОГО SSOT (tryCompileSurfaceArtifact):
  // прежний executor восстанавливал A регулярным выражением из Q и дополнял
  // пары вместо замены — расхождение с runtime достигало 0.738 между стопами.
  // Соседние стопы с одинаковой позицией и разными значениями — не контракт
  // домена, а признак битой строки: такой артефакт не эмитится.
  for (const css of [artifact.easing, artifact.reciprocalEasing, artifact.blendEasing]) {
    if (hasConflictingAdjacentStops(css)) return undefined;
  }
  return `{w0:${program.fromWidth},w1:${program.toWidth},d:${artifact.durationMs},`
    + `p:${JSON.stringify(artifact.easing)},q:${JSON.stringify(artifact.reciprocalEasing)},`
    + `a:${JSON.stringify(artifact.blendEasing)}}`;
}

/**
 * Соседние stops linear() с одинаковой позицией обязаны нести одинаковый
 * output: дубль-пара «v pc%, v pc%» легальна (усиление границы сегмента),
 * разные значения на одной позиции — разрыв, который не является доменным
 * контрактом поверхности.
 */
export function hasConflictingAdjacentStops(cssLinear: string): boolean {
  let previous: readonly string[] = [];
  for (const stop of cssLinear.slice(cssLinear.indexOf('(') + 1, -1).split(',')) {
    const pair = stop.trim().split(' ');
    if (pair[1] !== undefined && pair[1] === previous[1] && pair[0] !== previous[0]) return true;
    previous = pair;
  }
  return false;
}

/** Статический литерал AST → plain-значение; undefined = сомнение. */
function staticValue(node: AstNode): unknown {
  if (node.type === 'Literal') {
    const value = node.value;
    return typeof value === 'number' || typeof value === 'string' ? value : undefined;
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const arg = node.argument as AstNode;
    if (arg.type === 'Literal' && typeof arg.value === 'number') return -arg.value;
    return undefined;
  }
  if (node.type === 'ArrayExpression') {
    const elements = node.elements as Array<AstNode | null>;
    const out: unknown[] = [];
    for (const element of elements) {
      if (element === null || element.type === 'SpreadElement') return undefined;
      const value = staticValue(element);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }
  if (node.type === 'ObjectExpression') {
    const out: Record<string, unknown> = {};
    for (const property of node.properties as AstNode[]) {
      if (
        property.type !== 'Property' || property.kind !== 'init'
        || property.method === true || property.computed === true || property.shorthand === true
      ) return undefined;
      const key = property.key as AstNode;
      const name: string | undefined = key.type === 'Identifier'
        ? String(key.name)
        : key.type === 'Literal' && typeof key.value === 'string' ? key.value
          : undefined;
      if (name === undefined) return undefined;
      const value = staticValue(property.value as AstNode);
      if (value === undefined) return undefined;
      out[name] = value;
    }
    return out;
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    // Нижится только флаг наличия (hasOnFrame); тело не исполняется.
    return (): void => {};
  }
  return undefined;
}

/** Динамический аргумент: маркер, который lowerSurfaceCall отвергает. */
const dynamicNode = (): { kind: string } => ({ kind: 'dynamic' });

/**
 * Планирует lowering surface-вызовов модуля (import { animate } из
 * '@labpics/motion/animate'). undefined — трансформировать нечего либо
 * консервативный отказ (shadowing/коллизия имени). Вызовы с onFrame НЕ
 * нижятся: у compiled-executor'а нет observer-часа (семантика кадра
 * остаётся за runtime path). Несертифицируемый артефакт (позитивность/
 * бюджет недоказуемы) тоже остаётся на runtime path.
 */
export function planSurfaceLowering(
  program: AstNode,
  code: string,
): NanoLoweringPlan | undefined {
  let importedPlain = false;
  const importNodes = new Set<AstNode>();
  let doubt = false;
  let localNameCollision = false;

  walk(program, (node, parent) => {
    if (node.type === 'ImportDeclaration') {
      const source = node.source as AstNode | undefined;
      if (source?.value === ANIMATE_SOURCE) {
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
    if (node.type === 'Identifier' && node.name === SURFACE_LOCAL) localNameCollision = true;
    if (
      node.name === 'animate' &&
      !importNodes.has(parent as AstNode) &&
      parent?.type !== 'ImportSpecifier' &&
      bindsName(node, parent, 'animate')
    ) {
      doubt = true;
    }
  });

  if (!importedPlain || doubt || localNameCollision) return undefined;

  const edits: NanoLoweringEdit[] = [];
  let runtimeCalls = 0;

  walk(program, (node, parent) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode;
    if (callee.type !== 'Identifier' || callee.name !== 'animate') return;
    // Наблюдаемая эквивалентность контролов compiled-пути НЕ доказана
    // (committed/ready/state/tier/play/pause/seek у executor'а нет), поэтому
    // понижается ТОЛЬКО доказанно неиспользуемый результат — голый
    // expression statement. Присваивание, return, await, чтение свойства,
    // аргумент, optional chaining — всё остаётся runtime-вызовом.
    if (parent?.type !== 'ExpressionStatement') { runtimeCalls++; return; }
    if (node.optional === true) { runtimeCalls++; return; }
    const args = node.arguments as AstNode[];
    if (args.length !== 3) { runtimeCalls++; return; }
    const [targetArg, propsArg, optionsArg] = args as [AstNode, AstNode, AstNode];
    if (targetArg.type === 'SpreadElement' || propsArg.type === 'SpreadElement'
      || optionsArg.type === 'SpreadElement') { runtimeCalls++; return; }

    const target = targetArg.type === 'Identifier'
      ? { kind: 'identifier' as const, name: targetArg.name as string }
      : dynamicNode();
    const props = propsArg.type === 'ObjectExpression'
      ? staticValue(propsArg) ?? dynamicNode()
      : dynamicNode();
    const options = optionsArg.type === 'ObjectExpression'
      ? staticValue(optionsArg) ?? dynamicNode()
      : dynamicNode();

    const result = lowerSurfaceCall({ callee: 'animate', target, props, options });
    if (!result.lowered) { runtimeCalls++; return; }
    // onFrame требует observer-час runtime-пути; executor его не несёт.
    if (result.program.hasOnFrame === true) { runtimeCalls++; return; }
    const literal = surfaceArtifactLiteral(result.program);
    if (literal === undefined) { runtimeCalls++; return; }

    // Побайтная верификация тривиа-зон (как в nano-плане): скобки/запятые.
    if (
      !/^\s*\(\s*$/.test(code.slice(callee.end, targetArg.start)) ||
      !/^\s*,\s*$/.test(code.slice(targetArg.end, propsArg.start)) ||
      !/^\s*,\s*$/.test(code.slice(propsArg.end, optionsArg.start)) ||
      !/^\s*\)$/.test(code.slice(optionsArg.end, node.end))
    ) { runtimeCalls++; return; }
    edits.push(
      { start: callee.start, end: targetArg.start, replacement: `${SURFACE_LOCAL}(` },
      { start: targetArg.end, end: node.end, replacement: `, ${literal})` },
    );
  });

  if (edits.length === 0) return undefined;
  edits.sort((a, b) => a.start - b.start);
  return {
    edits,
    importLocal: SURFACE_LOCAL,
    importName: SURFACE_IMPORT_NAME,
    importSource: SURFACE_IMPORT_SOURCE,
    runtimeCalls,
  };
}
