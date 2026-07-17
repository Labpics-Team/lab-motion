import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

describe('keyframes shipped sampler — allocation structure', () => {
  it('does not wrap an indexed easing call in a per-sample IIFE', () => {
    const path = resolve(import.meta.dirname, '../dist/keyframes/index.js');
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const offenders: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const isIife = ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
        const wrapsIndexedCall = node.arguments.some((argument) => {
          const candidate = unwrap(argument);
          return ts.isCallExpression(candidate) &&
            ts.isElementAccessExpression(unwrap(candidate.expression));
        });
        if (isIife && wrapsIndexedCall) offenders.push(node.getText(ast));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(offenders, 'Terser must not recreate a FunctionExpression on every sample').toEqual([]);
  });
});
