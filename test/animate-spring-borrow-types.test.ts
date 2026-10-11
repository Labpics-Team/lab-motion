/** Реальный typecheck: только чтение базиса/результата, без caller-owned out. */
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('не предоставляет consumer право записи в базис и результат проекции', () => {
  const root = resolve(import.meta.dirname, '..');
  const file = resolve(root, 'src/animate/__borrow_contract__.ts');
  const source = [
    "import type { SurfaceBatch } from './surface-batch.js';",
    "import { readSpringFromBasisUnchecked, sampleSpringFromBasisUnchecked } from '../internal/read-spring.js';",
    'declare const batch: SurfaceBatch;',
    'const basis = batch._springBasis({ mass: 1, stiffness: 100, damping: 20 }, 0);',
    'const result = readSpringFromBasisUnchecked(basis, 0, 100, 0);',
    'void [basis._value, result.value, result.velocity];',
    'basis._value = 17;',
    'result.value = 17;',
    'sampleSpringFromBasisUnchecked(basis, 0, basis);',
  ].join('\n');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(name) === file
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((error) => error.category === ts.DiagnosticCategory.Error);
  // Чтения, импорты и весь dependency graph — positive control: иных ошибок нет.
  expect(errors.map((error) => ({
    code: error.code,
    file: error.file?.fileName,
    line: error.file?.getLineAndCharacterOfPosition(error.start!).line,
  }))).toEqual([
    { code: 2540, file, line: 6 },
    { code: 2540, file, line: 7 },
    { code: 2554, file, line: 8 },
  ]);
}, 15_000);
