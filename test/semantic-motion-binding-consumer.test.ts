import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

// Пакетные проверки принимают уже собранный артефакт, не пересобирают общий
// dist параллельно с другими тестами. Канонический порядок: pnpm build → pnpm test.
beforeAll(() => {
  for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
    expect(existsSync(`dist/bindings/${file}`), `Сначала выполните pnpm build: отсутствует dist/bindings/${file}`).toBe(true);
  }
});

it('упакованный потребитель: ESM/CJS/SSR, literal recipe и TS5/6 типы', () => {
  const work = mkdtempSync(join(tmpdir(), 'semantic-binding-consumer-'));
  try {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { encoding: 'utf8', timeout: 30_000 }));
    const installed = join(work, 'node_modules/@labpics/motion'); mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, pack.filename), '-C', installed, '--strip-components=1']);
    writeFileSync(join(work, 'package.json'), '{"type":"module"}');
    writeFileSync(join(work, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import * as esm from '@labpics/motion/bindings';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('@labpics/motion/bindings');
assert.equal(typeof document, 'undefined');
for (const module of [esm, cjs]) {
  assert.deepEqual(Object.keys(module).sort(), ['MotionParamError', 'createMotionBinding']);
  let writes = 0, cancels = 0;
  const view = module.createMotionBinding(n => ({ panel: { opacity: n } }), {
    panel: () => { writes++; return {cancel() {cancels++;}}; }
  });
  view.update(1); view.update(1);
  assert.equal(writes, 1);
  assert.throws(() => view.update(NaN), e => e instanceof module.MotionParamError && e.code === 'LM174');
  view.destroy(); view.update(0);
  assert.equal(cancels, 1); assert.equal(writes, 1); assert.equal(view.state, 'destroyed');
}
console.log('semantic-binding-consumer: PASS');
`);
    expect(execFileSync(process.execPath, [join(work, 'consumer.mjs')], { encoding: 'utf8', timeout: 30_000 })).toContain('semantic-binding-consumer: PASS');
    const docs = readFileSync('docs/recipes.md', 'utf8');
    const recipe = docs.match(/```typescript\n([^`]*?export function bindUploadMotion[^]*?)\n```/)?.[1];
    expect(recipe).toBeTruthy(); writeFileSync(join(work, 'recipe.ts'), recipe!);
    const navigation = docs.match(/```typescript\n([^`]*?export function bindNavigationMotion[^]*?)\n```/)?.[1];
    expect(navigation).toBeTruthy(); writeFileSync(join(work, 'navigation.ts'), navigation!);
    expect(readFileSync(join(installed, 'docs/bindings.md'), 'utf8')).toContain('createMotionBinding');
    expect(readFileSync(join(installed, 'dist/bindings/index.d.ts'), 'utf8')).not.toContain('NoInfer');
    writeFileSync(join(work, 'consumer.ts'), `
import {createMotionBinding, type MotionBindingControls} from '@labpics/motion/bindings';
import {animate} from '@labpics/motion/animate';
interface Model { pressed: boolean; progress: number }
const project = (s: Model) => ({ panel: {scale: s.pressed ? .97 : 1}, bar: {scaleX:s.progress} });
const view: MotionBindingControls<Model> = createMotionBinding(project, {
  panel: goal => animate(document.body, goal),
  bar: goal => {
    const n: number = goal.scaleX; void n;
    // @ts-expect-error the accepted snapshot is immutable
    goal.scaleX = 1;
  },
});
view.update({pressed:false,progress:.25});
// @ts-expect-error semantic input requires progress
view.update({pressed:false});
// Port inference comes only from the projected role shape, without a public NoInfer dependency.
createMotionBinding((n: number) => ({only: {x: n}}), {only: goal => {
  const x: number = goal.x; void x;
  // @ts-expect-error a port cannot invent a property absent from the projected role
  goal.y;
}});
// @ts-expect-error a missing port is not optional
createMotionBinding(project, {panel: goal => animate(document.body, goal)});
// @ts-expect-error a misspelled port must not silently go unused
createMotionBinding(project, {panel: () => {}, bar: () => {}, ghost: () => {}});
// @ts-expect-error nested target values are commands/objects, not scalar state
createMotionBinding((n: number) => ({a: {x:[0,n]}}), {a: () => {}});
// @ts-expect-error async apply cannot transfer a late resource
createMotionBinding((n: number) => ({a: {x:n}}), {a: async () => ({cancel(){}})});
`);
    for (const compiler of ['typescript', 'typescript5']) {
      execFileSync(process.execPath, [resolve(`node_modules/${compiler}/bin/tsc`), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'false', join(work, 'consumer.ts'), join(work, 'recipe.ts'), join(work, 'navigation.ts')], { cwd: work, encoding: 'utf8', timeout: 30_000 });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 60_000);

for (const format of ['js', 'cjs']) it(`terminal ${format} освобождает рецепт, ports и handles`, () => {
  const work = mkdtempSync(join(tmpdir(), 'semantic-binding-retention-'));
  try {
    const script = join(work, 'gc.mjs');
    writeFileSync(script, `
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {createMotionBinding} = await import(pathToFileURL(process.argv[2]));
function setup(dispose) {
  const marker = {data: new Uint8Array(100)};
  const weak = new WeakRef(marker);
  const view = createMotionBinding(n => {void marker.data; return {panel:{x:n}};}, {
    panel: () => ({cancel() {void marker.data;}}),
  });
  view.update(1); if(dispose) view.destroy();
  return {weak,view};
}
const dead = setup(true), live = setup(false);
globalThis.held = [dead.view, live.view];
for(let i=0;i<32;i++){await new Promise(setImmediate);global.gc();}
assert.equal(dead.weak.deref(), undefined);
assert.notEqual(live.weak.deref(), undefined, 'positive control: a live owner retains the resource');
live.view.destroy();
for(let i=0;i<32;i++){await new Promise(setImmediate);global.gc();}
assert.equal(live.weak.deref(), undefined);
console.log('retention PASS');
`);
    expect(execFileSync(process.execPath, ['--expose-gc', script, resolve(`dist/bindings/index.${format}`)], { encoding: 'utf8', timeout: 30_000 })).toContain('retention PASS');
  } finally { rmSync(work, { recursive: true, force: true }); }
});
