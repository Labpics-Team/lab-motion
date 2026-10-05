import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import { createProjector as createDriverProjector } from '../src/projection/geometry.js';

const first = Object.freeze({ x: 0, y: 10, width: 20, height: 20 });
const last = Object.freeze({ x: 100, y: 30, width: 20, height: 20 });
const offset = (frame: { tx: number; ty: number }) => [frame.tx, frame.ty];

describe('внутренний контракт базиса проекции', () => {
  it('читает коэффициенты владельца, сохраняя публичный scalar-контракт', () => {
    const nodes = Object.freeze([
      Object.freeze({ id: 'surface', first, last, _qx: 12, _qy: -8 }),
    ]);
    const internal = createDriverProjector(nodes);
    const frames = internal.at(0.5, 0.25);
    // Независимый oracle: first + (last-first)*p + correction*q - last.
    expect(offset(frames[0]!)).toEqual([-47, -12]);
    expect(internal.at(0.5, 0)).toBe(frames);
    expect(offset(frames[0]!)).toEqual([-50, -10]);
    expect(offset(projection.createProjector(nodes).at(0.5)[0]!)).toEqual([-50, -10]);
    expect(projection).not.toHaveProperty('createDriverProjector');
    expect(nodes[0]).toEqual({ id: 'surface', first, last, _qx: 12, _qy: -8 });
  });

  it('отсутствие остаточной скорости сохраняет прежнюю траекторию', () => {
    const nodes = Object.freeze([Object.freeze({ id: 'surface', first, last })]);
    const internal = createDriverProjector(nodes);
    expect(offset(internal.at(0.5, 0.25)[0]!)).toEqual([-50, -10]);
    expect(offset(internal.at(1, 0)[0]!)).toEqual([0, 0]);
  });
});
