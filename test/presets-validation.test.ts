/**
 * test/presets-validation.test.ts — compilePreset(): валидация структурно
 * невалидных спек → MotionParamError (дисциплина invalid-param-error.test.ts).
 *
 * Контракт (t1 ch01-motion-presets, эпик ds-icons):
 *   compilePreset — единственная точка валидации ./presets; samplePreset —
 *   горячий путь без повторных проверок. Всё невалидное падает ЗДЕСЬ, громко
 *   и по-русски, а не тихо превращается в NaN на кадре.
 *
 * TDD RED-proof: файл написан до реализации; после реализации — убрать любую
 * проверку в compilePreset → соответствующий тест RED.
 *
 * Классы: А (unit-валидация каждого правила).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { compilePreset, type PresetSpec } from '../src/presets/index.js';

function base(patch: Record<string, unknown>): PresetSpec {
  return {
    duration: 1,
    tracks: [{ property: 'scale', values: [1, 2] }],
    ...patch,
  } as PresetSpec;
}

describe('presets — compilePreset: валидация', () => {
  it('А: duration ≤ 0 / NaN / Infinity → MotionParamError', () => {
    for (const duration of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => compilePreset(base({ duration }))).toThrow(MotionParamError);
    }
  });

  it('А: tracks пустой или отсутствует → MotionParamError', () => {
    expect(() => compilePreset(base({ tracks: [] }))).toThrow(MotionParamError);
    expect(() => compilePreset({ duration: 1 } as unknown as PresetSpec)).toThrow(MotionParamError);
  });

  it('А: неизвестное property → MotionParamError', () => {
    expect(() =>
      compilePreset(base({ tracks: [{ property: 'blur', values: [0, 1] }] })),
    ).toThrow(MotionParamError);
  });

  it('А: дубликат property в tracks → MotionParamError', () => {
    expect(() =>
      compilePreset(
        base({
          tracks: [
            { property: 'scale', values: [1, 2] },
            { property: 'scale', values: [2, 1] },
          ],
        }),
      ),
    ).toThrow(MotionParamError);
  });

  it('А: values короче 2 или с не-конечным элементом → MotionParamError', () => {
    expect(() =>
      compilePreset(base({ tracks: [{ property: 'x', values: [1] }] })),
    ).toThrow(MotionParamError);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() =>
        compilePreset(base({ tracks: [{ property: 'x', values: [0, bad] }] })),
      ).toThrow(MotionParamError);
    }
  });

  it('А: times — несовпадение длины, невозрастание, края ≠ 0/1 → MotionParamError', () => {
    const t = (times: number[]) =>
      compilePreset(base({ tracks: [{ property: 'x', values: [0, 1, 2], times }] }));
    expect(() => t([0, 1])).toThrow(MotionParamError);
    expect(() => t([0, 0.7, 0.5])).toThrow(MotionParamError);
    expect(() => t([0.1, 0.5, 1])).toThrow(MotionParamError);
    expect(() => t([0, 0.5, 0.9])).toThrow(MotionParamError);
    expect(() => t([0, Number.NaN, 1])).toThrow(MotionParamError);
  });

  it('А: easing-массив неверной длины → MotionParamError', () => {
    expect(() =>
      compilePreset(
        base({
          tracks: [{ property: 'x', values: [0, 1, 2], easing: [(v: number) => v] }],
        }),
      ),
    ).toThrow(MotionParamError);
  });

  it('А: repeat дробный/отрицательный/NaN → MotionParamError; Infinity — валиден', () => {
    for (const repeat of [-1, 0.5, Number.NaN]) {
      expect(() => compilePreset(base({ repeat }))).toThrow(MotionParamError);
    }
    expect(() => compilePreset(base({ repeat: Infinity }))).not.toThrow();
  });

  it('А: repeatType вне перечня → MotionParamError', () => {
    expect(() => compilePreset(base({ repeatType: 'yoyo' }))).toThrow(MotionParamError);
  });

  it('А: delay/repeatDelay отрицательные или не-конечные → MotionParamError', () => {
    for (const bad of [-0.1, Number.NaN, Infinity]) {
      expect(() => compilePreset(base({ delay: bad }))).toThrow(MotionParamError);
      expect(() => compilePreset(base({ repeatDelay: bad }))).toThrow(MotionParamError);
    }
  });

  it('А: ошибка длительности имеет стабильный код', () => {
    try {
      compilePreset(base({ duration: -1 }));
      expect.unreachable('должно было бросить');
    } catch (e) {
      expect(e).toBeInstanceOf(MotionParamError);
      expect((e as MotionParamError).code).toBe('LM047');
    }
  });
});
