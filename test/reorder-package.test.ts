import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { reorderRecipe } from '../browser/fixtures/reorder-recipe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
it('публичный nested entry: ESM/CJS/types и буквальный DOM-рецепт', () => {
  expect(existsSync(join(root, 'dist/behaviors/reorder/index.d.ts')), 'сначала build').toBe(true);
  const dir = mkdtempSync(join(root, '.reorder-types-'));
  try {
    const file = join(dir, 'consumer.mts');
    writeFileSync(file, `import {createReorder, type ReorderController} from '@labpics/motion/behaviors/reorder';
      const s:ReorderController<'a'|'b'>=createReorder({items:[{key:'a'},{key:'b'}],onReorder(keys,p){keys satisfies readonly ('a'|'b')[];}});
      s.update([{key:'a'}]); s.start('a')?.step('next');
      // @ts-expect-error stable identity не расширяется произвольным key
      s.start('missing');
      // @ts-expect-error нет внутреннего data commit
      s.commit(['a']);
      // @ts-expect-error строки не являются координатами
      s.start('a')?.move({x:'0',y:1});
      // @ts-expect-error object key не поддерживается
      createReorder({items:[{key:{}}],onReorder(){}});`);
    const recipe = join(dir, 'recipe.mts'); writeFileSync(recipe, reorderRecipe(root));
    const program = ts.createProgram([file, recipe], { noEmit: true, strict: true, skipLibCheck: true,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, types: ['node'], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    for (const esm of [true, false]) {
      const smoke = `${esm ? "import {createReorder} from '@labpics/motion/behaviors/reorder'" : "const {createReorder}=require('@labpics/motion/behaviors/reorder')"};
        const s=createReorder({items:[{key:'a',rect:{x:0,y:0,width:1,height:1}},{key:'b',rect:{x:0,y:2,width:1,height:1}}],onReorder(keys){if(keys.join('')!=='ba')throw Error('order');}});
        s.start('a').step('next');s.destroy();if(s.start('a'))throw Error('late');console.log('reorder: PASS');`;
      expect(execFileSync(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', smoke], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toContain('reorder: PASS');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('метафайл: reorder не тянет solver/scheduler/DOM, старый behaviors не тянет reorder', async () => {
  const emit = async (name: string, entry: string) => {
    const file = join(root, `dist/${entry}/index.js`);
    expect(existsSync(file), 'сначала build').toBe(true);
    const out = await build({ stdin: { contents: `import {${name}} from ${JSON.stringify(file)}; console.log(${name});`, resolveDir: root },
      bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, metafile: true });
    return { code: out.outputFiles[0]!.text, inputs: Object.keys(out.metafile!.inputs) };
  };
  const optional = await emit('createReorder', 'behaviors/reorder'); const prior = await emit('createBottomSheet', 'behaviors');
  expect(optional.inputs.filter(p => !p.includes('<stdin>'))).toEqual(['dist/behaviors/reorder/index.js']);
  expect(optional.code).not.toMatch(/requestAnimationFrame|document\.|getBoundingClientRect|setTimeout|MotionValue/);
  expect(optional.code).toContain('reorder:'); expect(prior.code).not.toContain('reorder:');
});
