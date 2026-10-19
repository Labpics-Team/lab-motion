import { describe, expect, it } from 'vitest';
import { properties } from '../src/motion/model.js';

describe('однопроходная нормализация authored-каналов', () => {
  it('сохраняет имя входа в диагностике и отвергает коллизии до исполнения', () => {
    expect(() => properties({ transform: 1 })).toThrow('transform');
    expect(() => properties({ '--gain': Number.NaN })).toThrow('--gain');
    expect(() => properties({ scaleX: 1, 'scale-x': 2 })).toThrow('scaleX');
    expect(() => properties({ scale: [1, 2], 'scale-x': 4 })).toThrow('scaleX');
  });
  it('создаёт ровно одну числовую проекцию для каждого разрешённого канала', () => {
    expect(properties({ scale: [1, 2], skewY: 5 }).map(channel => channel.key))
      .toEqual(['scaleX', 'scaleY', 'skewY']);
    expect(properties({ '--opacity-level': [0, 1] })[0]).toMatchObject({
      key: '--opacity-level', authored: true, values: [0, 1],
    });
  });
});
