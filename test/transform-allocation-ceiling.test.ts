/**
 * Transform hot path: побитный паритет строки; AST закрывает прямой синтаксис
 * контейнеров внутри точных методов, runtime отдельно считает Map и identity
 * lifecycle-state. Аллокации строк, closures и вызываемых функций не измерены.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { animate as animateBase } from '../src/animate/index.js';
import { buildTransform } from '../src/value/index.js';
import type { TransformState } from '../src/value/transform.js';
import { clampFinite } from '../src/value/units.js';
import { fakeEl, makeClock, withLiveEngine } from './animate-facade-helpers.js';

// Харнесс R3b: rAF-пути исполняет композируемый live-движок (см. helpers).
const animate = withLiveEngine(animateBase as never);

function referenceBuildTransform(state: TransformState): string {
  const parts: string[] = [];
  const x = clampFinite(state.x ?? 0);
  const y = clampFinite(state.y ?? 0);
  if (x !== 0 || y !== 0) {
    if (x !== 0 && y === 0) parts.push(`translateX(${x}px)`);
    else if (x === 0 && y !== 0) parts.push(`translateY(${y}px)`);
    else parts.push(`translate(${x}px, ${y}px)`);
  }
  if (state.scale !== undefined) {
    const scale = clampFinite(state.scale);
    if (scale !== 1) parts.push(`scale(${scale})`);
  } else {
    const scaleX = clampFinite(state.scaleX ?? 1);
    const scaleY = clampFinite(state.scaleY ?? 1);
    if (scaleX !== 1 || scaleY !== 1) {
      if (scaleX === scaleY) parts.push(`scale(${scaleX})`);
      else {
        parts.push(`scaleX(${scaleX})`);
        if (scaleY !== 1) parts.push(`scaleY(${scaleY})`);
      }
    }
  }
  const rotate = clampFinite(state.rotate ?? 0);
  if (rotate !== 0) parts.push(`rotate(${rotate}deg)`);
  const skewX = clampFinite(state.skewX ?? 0);
  const skewY = clampFinite(state.skewY ?? 0);
  if (skewX !== 0 && skewY !== 0) parts.push(`skew(${skewX}deg, ${skewY}deg)`);
  else if (skewX !== 0) parts.push(`skewX(${skewX}deg)`);
  else if (skewY !== 0) parts.push(`skewY(${skewY}deg)`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}

const FIELDS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY'] as const;
const HOSTILE = [-Infinity, -Number.MAX_VALUE, -1, -0, 0, 0.5, 1, 2, Number.MAX_VALUE, Infinity, NaN];

describe('buildTransform: exact concat differential', () => {
  it('совпадает на всех 256 комбинациях присутствующих полей', () => {
    for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
      const state: Record<string, number> = {};
      for (let i = 0; i < FIELDS.length; i++) {
        if ((mask & (1 << i)) !== 0) state[FIELDS[i]!] = HOSTILE[(mask + i * 3) % HOSTILE.length]!;
      }
      expect(buildTransform(state), `mask=${mask}`).toBe(referenceBuildTransform(state));
    }
  });

  it('совпадает для каждого hostile IEEE-754 значения в каждом поле', () => {
    for (const field of FIELDS) {
      for (const value of HOSTILE) {
        const state = { x: 3, y: -4, scaleX: 2, scaleY: 0.5, rotate: 7, skewX: 8, skewY: 9 };
        delete (state as Record<string, unknown>)['scale'];
        (state as Record<string, number>)[field] = value;
        expect(buildTransform(state), `${field}=${String(value)}`).toBe(referenceBuildTransform(state));
      }
    }
  });

  it('сохраняет порядок и кратность чтения accessor-полей', () => {
    const make = (): { state: TransformState; reads: string[] } => {
      const reads: string[] = [];
      const state = {} as Record<string, number>;
      for (const field of FIELDS) {
        let calls = 0;
        Object.defineProperty(state, field, {
          enumerable: true,
          get() {
            reads.push(field);
            calls++;
            return field === 'scale' ? (calls === 1 ? 2 : 3) : 1;
          },
        });
      }
      return { state, reads };
    };
    const expected = make();
    const actual = make();
    expect(buildTransform(actual.state)).toBe(referenceBuildTransform(expected.state));
    expect(actual.reads).toEqual(expected.reads);
    expect(actual.reads).toEqual(['x', 'y', 'scale', 'scale', 'rotate', 'skewX', 'skewY']);

    const makeAxisScale = (): { state: TransformState; reads: string[] } => {
      const reads: string[] = [];
      const values: Record<string, number | undefined> = {
        x: 0, y: 0, scale: undefined, scaleX: 2, scaleY: 3, rotate: 0, skewX: 0, skewY: 0,
      };
      const state = {} as Record<string, number>;
      for (const field of FIELDS) {
        Object.defineProperty(state, field, {
          get() {
            reads.push(field);
            return values[field];
          },
        });
      }
      return { state, reads };
    };
    const axes = makeAxisScale();
    expect(buildTransform(axes.state)).toBe('scaleX(2) scaleY(3)');
    expect(axes.reads).toEqual(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY']);
  });
});

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    result.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return result;
}

function namedFunction(file: ts.SourceFile, name: string): ts.Node {
  const found = descendants(file).find((node) =>
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(file) === name,
  );
  if (found === undefined) throw new Error(`Не найдена функция ${name}`);
  return found;
}

function directContainerSyntax(file: ts.SourceFile, root: ts.Node): string[] {
  const constructors = new Set([
    'Array',
    'Map',
    'Object',
    'Set',
    'WeakMap',
    'WeakSet',
  ]);
  const factories = new Set([
    'Array.from',
    'Array.of',
    'Object.assign',
    'Object.create',
    'Object.entries',
    'Object.fromEntries',
    'Object.keys',
    'Object.values',
  ]);
  return descendants(root).flatMap((node) => {
    if (ts.isArrayLiteralExpression(node)) return ['array literal'];
    if (ts.isObjectLiteralExpression(node)) return ['object literal'];
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (constructors.has(node.expression.text) || node.expression.text.endsWith('Array'))
    ) return [`new ${node.expression.text}`];
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) ||
        factories.has(node.expression.getText(file)))
    ) return [`factory ${node.expression.getText(file)}`];
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /parts/i.test(node.name.text)
    ) return [`parts container ${node.name.text}`];
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'push' || node.expression.name.text === 'join')
    ) return [`${node.expression.name.text} container call`];
    return [];
  });
}

describe('transform hot path: direct-container AST gate', () => {
  it('AST-детектор ловит запрещённые формы и не помечает переиспользование state', () => {
    const fixture = ts.createSourceFile(
      'allocation-fixture.ts',
      `
        function hot() {
          const parts = [];
          parts.push('x');
          return { map: new Map(), typed: new Float64Array(1) };
        }
        function reuse() {
          const state = shared;
          return format(state);
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(new Set(directContainerSyntax(fixture, namedFunction(fixture, 'hot')))).toEqual(new Set([
      'parts container parts',
      'array literal',
      'push container call',
      'object literal',
      'new Map',
      'new Float64Array',
    ]));
    expect(directContainerSyntax(fixture, namedFunction(fixture, 'reuse'))).toEqual([]);
  });

  it('buildTransform не содержит прямого parts/object/Map/Array-синтаксиса', () => {
    const file = source('src/value/transform.ts');
    expect(directContainerSyntax(file, namedFunction(file, 'buildTransform'))).toEqual([]);
  });

  it('горячие кадровые методы live не содержат прямых локальных контейнеров', () => {
    // Наследник гейтов MainUnit._write / WaapiUnit._valueAt: кадровый цикл
    // живого движка (шаг, тики полос, запись вектора) не аллоцирует.
    const live = source('src/animate/live.ts');
    for (const name of ['_step', '_tickLanes', '_tweenFrame', '_flushWrites', '_writeNumeric']) {
      expect(directContainerSyntax(live, namedFunction(live, name)), name).toEqual([]);
    }
  });

  it('_holdInline юнита не содержит прямого локального контейнера', () => {
    const unit = source('src/animate/compositor-unit.ts');
    expect(directContainerSyntax(unit, namedFunction(unit, '_holdInline'))).toEqual([]);
  });
});

function countHotMapAllocations(run: () => void): number {
  const NativeMap = globalThis.Map;
  let allocations = 0;
  class CountingMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries);
      allocations++;
    }
  }
  (globalThis as { Map: MapConstructor }).Map = CountingMap as MapConstructor;
  try {
    run();
  } finally {
    (globalThis as { Map: MapConstructor }).Map = NativeMap;
  }
  return allocations;
}

describe.each([1, 1000])('transform Map/state evidence: N=$samples', (samples) => {
  it('live-кадры tween: одна запись вектора на кадр, ноль Map-аллокаций', () => {
    // Наследник evidence-пинов MainUnit/WaapiUnit: кадровый цикл живого
    // движка пишет группу одной transform-декларацией и не строит Map.
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 240], rotate: [0, 90] }, {
      duration: 1_000_000,
      ease: (t: number) => t,
      requestFrame: clock.requestFrame,
    });

    const maps = countHotMapAllocations(() => {
      for (let i = 0; i < samples; i++) clock.step(16);
    });

    expect(target.writes).toHaveLength(samples); // один setProperty на кадр
    expect(target.writes.every((w) => w.prop === 'transform')).toBe(true);
    expect(maps).toBe(0);
    controls.cancel();
  });

  it('live-кадры spring: вектор x/rotate — одна запись на кадр, ноль Map', () => {
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, { x: [0, 240], rotate: [0, 90] }, {
      spring: { mass: 1, stiffness: 100, damping: 10 },
      requestFrame: clock.requestFrame,
    });

    const maps = countHotMapAllocations(() => {
      for (let i = 0; i < samples; i++) clock.step(16);
    });

    expect(target.writes.length).toBeLessThanOrEqual(samples);
    expect(target.writes.length).toBeGreaterThan(0);
    expect(target.writes.every((w) => w.prop === 'transform')).toBe(true);
    expect(maps).toBe(0);
    controls.cancel();
  });
});
