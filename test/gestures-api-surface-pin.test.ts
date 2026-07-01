/**
 * test/gestures-api-surface-pin.test.ts
 * Класс: А — гвоздь контракта публичной поверхности ./gestures (в обе стороны).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Удалить любой экспорт → «missing»-половина RED.
 * Добавить новый экспорт/метод без пина → «exhaustive»-половина RED.
 */

import { describe, expect, it } from 'vitest';
import * as gestures from '../src/gestures/index.js';
import { createDrag, createHover, createPan, createPress, createVelocityTracker } from '../src/gestures/index.js';

describe('gestures-api-surface-pin: экспорты модуля (исчерпывающе)', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(gestures).sort()).toEqual(
      ['createDrag', 'createHover', 'createPan', 'createPress', 'createVelocityTracker'],
    );
  });

  it('все экспорты — функции', () => {
    for (const f of [createDrag, createHover, createPan, createPress, createVelocityTracker]) {
      expect(typeof f).toBe('function');
    }
  });
});

describe('gestures-api-surface-pin: формы возвращаемых контроллеров (исчерпывающе)', () => {
  it('VelocityTracker', () => {
    expect(Object.keys(createVelocityTracker()).sort()).toEqual(['push', 'reset', 'velocity']);
  });

  it('PressRecognizer', () => {
    expect(Object.keys(createPress()).sort()).toEqual(
      ['keyDown', 'keyUp', 'pointerCancel', 'pointerDown', 'pointerMove', 'pointerUp', 'pressing'],
    );
  });

  it('HoverRecognizer', () => {
    expect(Object.keys(createHover()).sort()).toEqual(['enter', 'hovering', 'leave']);
  });

  it('PanRecognizer', () => {
    expect(Object.keys(createPan()).sort()).toEqual(
      ['panning', 'pointerCancel', 'pointerDown', 'pointerMove', 'pointerUp'],
    );
  });

  it('DragControls', () => {
    expect(Object.keys(createDrag()).sort()).toEqual(
      ['dragging', 'gliding', 'pointerCancel', 'pointerDown', 'pointerMove', 'pointerUp', 'stop', 'x', 'y'],
    );
  });
});

describe('gestures-api-surface-pin: SSR-safe', () => {
  // vitest environment=node: window/document отсутствуют. Сам факт import
  // вверху файла + создание всех распознавателей без DOM = доказательство.
  it('создание всех распознавателей в node env не бросает', () => {
    expect(() => {
      createVelocityTracker();
      createPress();
      createHover();
      createPan();
      createDrag();
    }).not.toThrow();
  });
});
