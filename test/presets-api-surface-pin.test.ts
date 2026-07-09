/**
 * test/presets-api-surface-pin.test.ts — исчерпывающий пин публичной
 * поверхности subpath ./presets (t3 ch01-motion-presets).
 *
 * Любое добавление/удаление/переименование runtime-экспорта — ОСОЗНАННОЕ
 * решение с правкой этого пина (дисциплина *-api-surface-pin репо).
 *
 * Классы: Б (regression pin).
 */

import { describe, expect, it } from 'vitest';
import * as presets from '../src/presets/index.js';

describe('presets — api-surface-pin', () => {
  it('Б: runtime-экспорты — точный список', () => {
    expect(Object.keys(presets).sort()).toEqual([
      'blink',
      'bounceY',
      'breathe',
      'compilePreset',
      'drawOn',
      'drift',
      'fadeSlide',
      'formatNumber',
      'pop',
      'presetToWaapi',
      'presetTotalDuration',
      'pulse',
      'runNumber',
      'runPreset',
      'runScramble',
      'runTypewriter',
      'samplePreset',
      'scrambleAt',
      'spin',
      'splitText',
      'tickerCells',
      'typewriterAt',
      'wiggle',
    ]);
  });

  it('Б: все экспорты — функции', () => {
    for (const [name, value] of Object.entries(presets)) {
      expect(typeof value, name).toBe('function');
    }
  });
});
