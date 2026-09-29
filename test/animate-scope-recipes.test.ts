import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

it('runnable DOM setup снимает listener при броске; React recipe рендерится без DOM на сервере', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-recipes-'));
  try {
    const sourceUrl = new URL('../browser/fixtures/scope-recipes.mjs', import.meta.url).href;
    const { writeScopeRecipeSources } = await import(sourceUrl);
    writeScopeRecipeSources(root, dir);
    const file = join(dir, 'entry.ts'); const out = join(dir, 'run.cjs');
    writeFileSync(file, `
      import assert from 'node:assert/strict';
      import {createElement} from 'react';
      import {renderToString} from 'react-dom/server';
      import {ScopedCard} from './react-card.js';
      import {mountCardMotion} from './card-motion.js';
      assert.equal(typeof document, 'undefined');
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
    await build({ absWorkingDir: root, entryPoints: [file], outfile: out, platform: 'node', format: 'cjs', bundle: true,
      alias: { '@labpics/motion/animate': join(root, 'dist/animate/index.cjs'),
        react: require.resolve('react'), 'react-dom/server': require.resolve('react-dom/server') },
    });
    expect(execFileSync(process.execPath, [out], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toContain('scope-recipes: PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
