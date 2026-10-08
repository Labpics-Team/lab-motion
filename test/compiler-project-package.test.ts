import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { buildCompilerProject } from '../browser/fixtures/compiler-project.mjs';

it('документированный проект собирается и типизируется из настоящего пакета', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'motion compiler consumer-'));
  try {
    const result = await buildCompilerProject(resolve('.'), join(directory, 'out'), join(directory, 'project'));
    expect(result.outputs.compiled.modules).toEqual(['dist/compiler/runtime/index.js', 'dist/compiler/surface/index.js']);
    // Общий бюджет compiled-пути не зависит от будущего ускорения полного runtime.
    expect(result.outputs.compiled.gzipBytes).toBeLessThanOrEqual(5000);
    expect(result.outputs.compiled.gzipBytes).toBeLessThan(result.outputs.runtime.gzipBytes);
    const program = ts.createProgram([result.entry], { noEmit: true, strict: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
