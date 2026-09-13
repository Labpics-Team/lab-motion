import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('N-tracks: реальные package exports, readonly types, ESM/CJS и SSR без globals', () => {
  expect(existsSync(join(root, 'dist/animate/index.d.ts')), 'сначала pnpm build').toBe(true);
  const dir = mkdtempSync(join(root, '.keyframe-types-'));
  try {
    const source = `
      import { animate, type AnimateOptions, type AnimateProps, type AnimateControls } from '@labpics/motion/animate';
      const el = document.createElement('div');
      const options: AnimateOptions = { duration: 800, times: [0, .25, .75, 1] as const, ease: [t => t*t, t => t, t => 1-(1-t)**2] as const };
      const props: AnimateProps = { x: [0, 120, -40, 0] as const, opacity: [0, 1, 1, 0] as const };
      const result: AnimateControls = animate(el, props, options);
      result.pause(); result.seek(400); result.play(); result.stop(); void result.finished;
      animate(el, { width: ['0px', '10px', '0px'], color: ['#000', '#fff', '#000'] }, { duration: 1000 });
      // @ts-expect-error segment easing обязан быть функцией
      animate(el, props, { ease: ['linear', 'linear', 'linear'] });
      // @ts-expect-error metadata не является property-transition объектом
      animate(el, { x: { to: [0, 1, 0], duration: 200 } });
      // @ts-expect-error times должны быть числами
      animate(el, props, { times: [0, '.25', .75, 1] });
    `;
    const file = join(dir, 'consumer.mts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      noEmit: true, strict: true, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
      types: ['node'], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const body = `
      assert.equal(typeof globalThis.document, 'undefined');
      const writes=[];
      const el={style:{getPropertyValue(){return ''},setProperty(k,v){writes.push([k,v])}}};
      const c=animate(el,{x:[0,100,0],width:['0px','200px','0px']},{duration:1000,requestFrame(){return 1}});
      c.seek(250);
      assert.deepEqual(writes,[['transform','translateX(50px)'],['width','100px']]);
      c.pause();c.seek(750);c.cancel();
      c.finished.then(()=>console.log('keyframe-package: PASS'));
    `;
    for (const mode of ['module', 'commonjs']) {
      const prelude = mode === 'module'
        ? `import assert from 'node:assert/strict';import {animate} from '@labpics/motion/animate';`
        : `const assert=require('node:assert/strict');const {animate}=require('@labpics/motion/animate');`;
      const output = execFileSync(process.execPath, [`--input-type=${mode}`, '-e', prelude + body], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
      });
      expect(output).toContain('keyframe-package: PASS');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
