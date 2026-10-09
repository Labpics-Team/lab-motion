import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('runnable DOM setup снимает listener при броске; React recipe рендерится без DOM на сервере', async () => {
  mkdirSync(join(root, 'scratchpad'), { recursive: true });
  const dir = mkdtempSync(join(root, 'scratchpad', 'scope recipes '));
  try {
    const sourceUrl = new URL('../browser/fixtures/scope-recipes.mjs', import.meta.url).href;
    const { packScopeRecipePackage, writeScopeRecipeSources } = await import(sourceUrl);
    const { packageRoot, receipt } = packScopeRecipePackage(root, dir);
    writeScopeRecipeSources(packageRoot, dir);
    const cookbook = readFileSync(join(packageRoot, 'docs/recipes.md'), 'utf8');
    const groupRecipe = cookbook.match(/```typescript\n([^`]*?export function mountGroupMotion[^]*?)\n```/)?.[1];
    expect(groupRecipe).toBeTruthy();
    writeFileSync(join(dir, 'group-motion.ts'), groupRecipe!);
    expect(receipt.tarball.sha256).toMatch(/^[a-f0-9]{64}$/);
    const config = join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: {
      noEmit: true, strict: true, skipLibCheck: true, lib: ['es2022', 'dom'],
      module: 'nodenext', moduleResolution: 'nodenext', types: ['react'],
    }, files: ['card-motion.ts', 'react-card.ts', 'solid-card.ts', 'compositor-sheet.ts', 'compositor-pager.ts',
      'presence-dialog.ts', 'reorder-component.ts', 'group-motion.ts'] }));
    for (const compiler of ['typescript5', 'typescript']) {
      try {
        execFileSync(process.execPath, [join(root, 'node_modules', compiler, 'bin', 'tsc'), '--project', config],
          { cwd: root, encoding: 'utf8', timeout: 60_000 });
      } catch (error: any) {
        throw new Error(`${compiler} отверг packed literal recipes:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
      }
    }
    const file = join(dir, 'entry.ts'); const out = join(dir, 'run.cjs');
    writeFileSync(file, `
      import assert from 'node:assert/strict';
      import {createElement} from 'react';
      import {renderToString} from 'react-dom/server';
      import {ScopedCard} from './react-card.js';
      import {mountCardMotion} from './card-motion.js';
      import {mountCompositorSheet} from './compositor-sheet.js';
      import {mountCompositorPager} from './compositor-pager.js';
      assert.equal(typeof document, 'undefined');
      assert.equal(typeof mountCompositorSheet,'function');
      assert.equal(typeof mountCompositorPager,'function');
      const html=renderToString(createElement(ScopedCard));
      assert(html.includes('data-replay')); assert(html.includes('motion-target'));
      const listeners=new Set(); let calls=0;
      const failure=new Error('host setup failed');
      const button={addEventListener(_name,fn){listeners.add(fn)},removeEventListener(_name,fn){listeners.delete(fn)}};
      const target={style:{setProperty(){},getPropertyValue(){return ''}},animate(){calls++;throw failure}};
      const host={querySelector(){return button},querySelectorAll(){return [target]}};
      assert.throws(()=>mountCardMotion(host),e=>e===failure);
      assert.equal(calls,1); assert.equal(listeners.size,0,'setup без controls оставил listener');
      console.log('scope-recipes: PASS');
    `);
    const result = await build({ absWorkingDir: root, entryPoints: [file], outfile: out, platform: 'node', format: 'cjs', bundle: true,
      metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs).map(path => resolve(root, path));
    expect(inputs.some(path => path.startsWith(packageRoot + sep))).toBe(true);
    expect(inputs.filter(path => path.startsWith(join(root, 'dist') + sep)
      || path.startsWith(join(root, 'src') + sep))).toEqual([]);
    expect(execFileSync(process.execPath, [out], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toContain('scope-recipes: PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
