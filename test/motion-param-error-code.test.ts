import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MotionParamError,
  type MotionParamErrorCode,
} from '../src/index.js';
import { LAST_MOTION_PARAM_ERROR_CODE } from '../src/errors.js';

const code: MotionParamErrorCode = 'LM123';
// @ts-expect-error Код обязан содержать ровно три цифры.
const malformedCode: MotionParamErrorCode = 'LM12';
void malformedCode;

describe('MotionParamError code contract', () => {
  it('не отражает входные значения во внутреннее сообщение', () => {
    const error = new MotionParamError(code);
    expect(error.code).toBe('LM123');
    expect(error.message).toBe('LM123');
    expect(error).toBeInstanceOf(Error);
  });

  it('сохраняет старый публичный строковый конструктор', () => {
    const error = new MotionParamError('bad param');
    expect(error.message).toBe('bad param');
    expect(error.code).toBe('LM000');
  });

  it('не выдаёт неизвестную shaped-строку за код текущего каталога', () => {
    const error = new MotionParamError('LM999');
    expect(error.message).toBe('LM999');
    expect(error.code).toBe('LM000');
  });

  it('держит runtime-границу равной последней строке каталога', () => {
    const catalog = readFileSync(new URL('../docs/errors.md', import.meta.url), 'utf8');
    const codes = [...catalog.matchAll(/^\| `(LM\d{3})` \|/gm)].map((match) => match[1]);
    expect(codes).not.toHaveLength(0);
    expect(codes.at(-1)).toBe(LAST_MOTION_PARAM_ERROR_CODE);
    expect(codes.every((code, index) => code === `LM${String(index).padStart(3, '0')}`))
      .toBe(true);
  });
});
