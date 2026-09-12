import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  nanoArtifactLiteral,
  planNanoOpacityLowering,
  planSurfaceLowering,
  type AstNode,
  type NanoLoweringPlan,
} from '../src/compiler/core.js';

const planners: readonly {
  readonly source: string;
  readonly call: string;
  readonly plan: (ast: AstNode, code: string) => NanoLoweringPlan | undefined;
}[] = [
  {
    source: '@labpics/motion/nano',
    call: 'animate(el, { opacity: 0.5 });',
    plan: (ast, code) => planNanoOpacityLowering(ast, code, nanoArtifactLiteral),
  },
  {
    source: '@labpics/motion/animate',
    call: "animate(el, { width: [100, 140] }, { layout: 'project' });",
    plan: planSurfaceLowering,
  },
];

async function instrument(code: string) {
  const ast = await parseAstAsync(code) as unknown as AstNode;
  const fn = (ast.body as AstNode[]).find((node) => node.type === 'FunctionDeclaration')!;
  const body = fn.body as AstNode;
  let visits = 0;
  // Proxy только считает перечисления полей настоящего блока AST;
  // тип, значения и порядок его полей не меняются.
  const measuredBody = new Proxy(body, {
    ownKeys(target) {
      visits++;
      return Reflect.ownKeys(target);
    },
  });
  const measured: AstNode = {
    ...ast,
    body: (ast.body as AstNode[]).map((node) => node === fn ? { ...node, body: measuredBody } : node),
  };
  return { ast: measured, visits: () => visits };
}

for (const { source, call, plan } of planners) {
  describe(`владение импортом ${source}`, () => {
    it('не обходит вложенный AST без прямого импорта animate', async () => {
      const code = `import { animate as other } from '${source}';
function unrelated(value) { return value + 1; }
${call}`;
      const probe = await instrument(code);
      expect(plan(probe.ast, code)).toBeUndefined();
      expect(probe.visits()).toBe(0);
    });

    it('контроль: видит настоящий обход после импорта в конце модуля', async () => {
      const code = `function unrelated(value) { return value + 1; }
${call}
import { animate } from '${source}';`;
      const probe = await instrument(code);
      expect(plan(probe.ast, code)).toBeDefined();
      expect(probe.visits()).toBeGreaterThan(0);
    });

    it('сохраняет отказ при вложенном затенении перед поздним импортом', async () => {
      const code = `function unrelated(animate) { ${call} }
import { animate } from '${source}';`;
      const probe = await instrument(code);
      expect(plan(probe.ast, code)).toBeUndefined();
      expect(probe.visits()).toBeGreaterThan(0);
    });
  });
}
