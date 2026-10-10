import { expect, it } from 'vitest';
import { MotionError, physics, snapshot, timing } from '../src/motion/model.js';
import { MotionParamError, errorCode } from '../src/errors.js';
import { validateErrorCatalog } from '../scripts/check-error-catalog.mjs';

it('публичные классы сохраняют имена и используют общий идентификатор причины', () => {
  for (const ErrorType of [MotionError, MotionParamError]) {
    const coded = new ErrorType('LM191');
    expect(coded.code).toBe('LM191');
    expect(coded.message).toBe('LM191');
    expect(coded.name).toBe(ErrorType.name);
    const external = new ErrorType('Ошибка приложения');
    expect(external.message).toBe('Ошибка приложения');
    expect(external.code).toBe('LM000');
  }
  expect(errorCode('LM999')).toBe('LM000');
});

it('невалидные состояния различаются стабильной причиной', () => {
  for (const [run, code] of [
    [() => snapshot([,], 'values'), 'LM189'],
    [() => physics({ bounce: 1 }), 'LM192'],
    [() => timing({ spring: { bounce: 0 }, duration: 100 } as never), 'LM191'],
  ] as const) {
    try { run(); throw new Error('ожидался отказ'); }
    catch (error) { expect(error).toBeInstanceOf(MotionError); expect((error as MotionError).code).toBe(code); }
  }
});

it('каталог проверяет root-коды, отсутствующие причины и динамические строки', () => {
  const catalogText = '| LM000 | external | text | code | reserved |\n| LM191 | model | conflict | choose one | active |';
  const check = (source: string) => validateErrorCatalog({ catalogText, sources: [['src/model.ts', source]] });
  expect(check("throw new MotionError('LM191');")).toEqual([]);
  expect(check("throw new MotionError('LM192');").join()).toContain('отсутствует');
  expect(check('throw new MotionError(reason);').join()).toContain('статический код');
  expect(check("import { MotionError as Problem } from './model.js'; throw new Problem('LM191');").join()).toContain('runtime-escape');
});
