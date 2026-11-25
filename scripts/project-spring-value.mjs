// Project the positional evaluator from the canonical solver, preserving the
// operations/order of its scalar expressions. No runtime generator or eval.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const input = new URL('../src/internal/solver.ts', import.meta.url);
const output = new URL('../src/internal/spring-value.generated.ts', import.meta.url);
const source = ts.createSourceFile(fileURLToPath(input), readFileSync(input, 'utf8'), ts.ScriptTarget.Latest, true);
const solver = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'solveSpring');
assert(solver?.body, 'canonical solveSpring body required');
const text = n => n.getText(source);
const block = n => { assert(ts.isBlock(n), 'expected explicit block'); return [...n.statements]; };
const declarations = s => {
  assert(ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const), 'projection requires const declarations');
  return [...s.declarationList.declarations];
};
const definition = d => {
  assert(ts.isIdentifier(d.name) && d.initializer, 'projection requires scalar initialized local');
  return [d.name.text, d.initializer];
};
// The projection accepts only side-effect-free scalar arithmetic and Math
// operations. Unsupported value expressions fail closed, rather than guess.
function names(n, out = new Set()) {
  if (ts.isIdentifier(n)) out.add(n.text);
  else if (ts.isNumericLiteral(n)) {}
  else if (ts.isParenthesizedExpression(n)) names(n.expression, out);
  else if (ts.isPrefixUnaryExpression(n)) {
    assert(n.operator===ts.SyntaxKind.MinusToken||n.operator===ts.SyntaxKind.PlusToken,'non-arithmetic unary operation');
    names(n.operand,out);
  }
  else if (ts.isBinaryExpression(n)) {
    assert(['+','-','*','/'].includes(text(n.operatorToken)), 'non-arithmetic expression');
    names(n.left,out); names(n.right,out);
  } else if (ts.isCallExpression(n)) {
    assert(ts.isPropertyAccessExpression(n.expression) && text(n.expression.expression)==='Math'
      && ['sqrt','exp','expm1','sin','cos'].includes(n.expression.name.text), 'non-pure expression');
    for(const arg of n.arguments) names(arg,out);
  } else throw Error('Unsupported scalar expression: '+text(n));
  return out;
}
const body=block(solver.body);
// There must be one and only one value assignment in each of the three
// modal branches and at t <= 0. The positional slice cannot silently omit
// a later mutation of a variable it reads.
const valueWrites=[];
function writes(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment && node.operatorToken.kind<=ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
    assert(['value','velocity'].includes(node.left.text) && node.operatorToken.kind===ts.SyntaxKind.EqualsToken,'unexpected mutable scalar '+text(node.left));
    if(node.left.text==='value')valueWrites.push(node);
  }
  if (ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))
    assert(node.operator!==ts.SyntaxKind.PlusPlusToken&&node.operator!==ts.SyntaxKind.MinusMinusToken,'mutable scalar update');
  ts.forEachChild(node,writes);
}
writes(solver.body);
assert.equal(valueWrites.length,4,'expected exactly four positional assignments');
const start=body.find(s=>ts.isIfStatement(s) && text(s.expression)==='t <= 0');
assert(start && text(start.thenStatement).includes('value = 0;') && start.elseStatement, 'initial law changed');
const outer=block(start.elseStatement);
const split=outer.findIndex(ts.isIfStatement);
assert(split>0 && split===outer.length-1,'expected modal dispatch');
const common=outer.slice(0,split).flatMap(declarations).map(definition);
for(const [,e] of common) assert(!names(e).has('t'),'common invariant depends on time');
const destructure=body[0];
assert(ts.isVariableStatement(destructure) && text(destructure)==='const { mass: m, stiffness: k, damping: c } = params;', 'parameter snapshot changed');
const lines=['// Generated from solver.ts by scripts/project-spring-value.mjs. Do not edit.',
 "import type { SpringParams } from './types.js';",'',
 'export function makeSpringValueSampler(params: SpringParams, v0: number): (t: number) => number {',
 '  '+text(destructure), ...common.map(([id,e])=>'  const '+id+' = '+text(e)+';')];
function emitMode(branch,indent) {
  const stmts=block(branch);
  const at=stmts.findIndex(s=>ts.isExpressionStatement(s)&&ts.isBinaryExpression(s.expression)&&text(s.expression.left)==='value'&&s.expression.operatorToken.kind===ts.SyntaxKind.EqualsToken);
  assert(at>=0,'no positional assignment');
  const expr=stmts[at].expression.right, defs=stmts.slice(0,at).flatMap(declarations).map(definition);
  const required=names(expr), keep=[];
  for(let i=defs.length;i--;){
    const [id,e]=defs[i];
    if(required.has(id)){keep.unshift([id,e]);for(const x of names(e))required.add(x);}
  }
  const dynamic=new Set(['t']), stat=[], dyn=[];
  for(const [id,e] of keep){
    if([...names(e)].some(x=>dynamic.has(x))){dynamic.add(id);dyn.push([id,e]);}
    else stat.push([id,e]);
  }
  const declaration=([id,e])=>'const '+id+' = '+text(e)+';';
  lines.push(...stat.map(x=>indent+declaration(x)));
  lines.push(indent+'return t => {',indent+'  if (t <= 0) return 0;',
    ...dyn.map(x=>indent+'  '+declaration(x)),indent+'  return '+text(expr)+';',indent+'};');
}
let node=outer[split];
while(ts.isIfStatement(node)){
  assert(ts.isBinaryExpression(node.expression)&&['zeta < 1','zeta === 1'].includes(text(node.expression)),'unexpected modal dispatch');
  lines.push('  if ('+text(node.expression)+') {');emitMode(node.thenStatement,'    ');lines.push('  }');
  node=node.elseStatement;assert(node,'missing modal fallback');
}
emitMode(node,'  ');lines.push('}','');
const generated=lines.join('\n');
if(process.argv.includes('--check')){
  assert.equal(readFileSync(output,'utf8').replace(/\r\n/g,'\n'),generated,'stale positional solver; regenerate with node scripts/project-spring-value.mjs');
}else writeFileSync(output,generated);
