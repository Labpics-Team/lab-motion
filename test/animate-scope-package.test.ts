import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('новая public capability и её типы доступны через установленную export-границу', () => {
  expect(existsSync(join(root, 'dist/animate/index.d.ts')), 'сначала pnpm build').toBe(true);
  const dir = mkdtempSync(join(root, '.scope-types-'));
  try {
    const source = `
      import { createAnimateScope, type AnimateScope, type AnimateScopeRoot, type AnimateControls } from '@labpics/motion/animate';
      const host: AnimateScopeRoot = document.createElement('section');
      const scope: AnimateScope = createAnimateScope(host);
      createAnimateScope(document); createAnimateScope(document.createElement('div').attachShadow({mode: 'open'}));
      const control: AnimateControls = scope.animate('.item', { x: [0, 100] }, { duration: 100 });
      control.pause(); control.seek(40); control.play(); void control.finished; scope.destroy();
      // @ts-expect-error у scope нет второго playback API
      scope.play();
      // @ts-expect-error root обязан иметь querySelectorAll
      createAnimateScope({});
      // @ts-expect-error входы scope сохраняют типы animate
      scope.animate('.item', { x: [0, 100] }, { duration: 'slow' });
      // @ts-expect-error выбор области не даёт object-target capability
      scope.animate(1, { opacity: 1 });
    `;
    const file = join(dir, 'consumer.mts'); writeFileSync(file, source);
    const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, types: ['node'], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    // Положительный ESM/CJS/SSR consumer использует реальный self-export пакета;
    // DOM globals отсутствуют, scope создаётся только с переданным query-host.
    const smoke = `const m=require('@labpics/motion/animate');
      const s=m.createAnimateScope({querySelectorAll(){return []}});s.destroy();
      s.animate('.late',new Proxy({},{get(){throw Error('late input')}})).finished.then(()=>console.log('scope-package: PASS'));`;
    expect(execFileSync(process.execPath, ['-e', smoke], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toContain('scope-package: PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('scope вырезается из обычного animate consumer; использование scope — positive control', async () => {
  const file = join(root, 'dist/animate/index.js');
  const emit = async (name: string) => {
    const output = await build({ stdin: { contents: `import {${name}} from ${JSON.stringify(file)}; console.log(${name});`, resolveDir: root },
      bundle: true, minify: true, format: 'esm', platform: 'browser', write: false });
    return output.outputFiles[0]!.text;
  };
  const ordinary = await emit('animate'); const scoped = await emit('createAnimateScope');
  expect(ordinary).not.toContain('root.querySelectorAll must be a function');
  expect(ordinary).not.toContain('animate scope cleanup failed');
  expect(scoped).toContain('root.querySelectorAll must be a function');
  expect(scoped).toContain('animate scope cleanup failed');
});
