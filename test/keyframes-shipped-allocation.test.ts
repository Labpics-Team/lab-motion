import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function findIndexedCallIifes(source: string, fileName: string): string[] {
  const ast = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const offenders: string[] = [];

  const containsIndexedCall = (node: ts.Node): boolean => {
    let found = false;
    const inspect = (candidate: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(candidate) &&
        ts.isElementAccessExpression(unwrap(candidate.expression))) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, inspect);
    };
    inspect(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const isIife = ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
      const bodyContainsIndexedCall = isIife && containsIndexedCall(callee.body);
      const wrapsIndexedCall = node.arguments.some((argument) => {
        const candidate = unwrap(argument);
        return ts.isCallExpression(candidate) &&
          ts.isElementAccessExpression(unwrap(candidate.expression));
      });
      if (isIife && (bodyContainsIndexedCall || wrapsIndexedCall)) {
        offenders.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return offenders;
}

describe('keyframes shipped sampler — allocation structure', () => {
  it('detects indexed easing calls in IIFE bodies and wrapped arguments', () => {
    const offenders = findIndexedCallIifes(`
      (() => easings[i](t))();
      ((value) => value)(easings[i](t));
    `, 'detector-fixture.js');

    expect(offenders).toHaveLength(2);
  });

  it('does not wrap an indexed easing call in a per-sample IIFE', () => {
    const path = resolve(import.meta.dirname, '../dist/keyframes/index.js');
    const source = readFileSync(path, 'utf8');
    const offenders = findIndexedCallIifes(source, path);

    expect(offenders, 'Terser must not recreate a FunctionExpression on every sample').toEqual([]);
  });
});
