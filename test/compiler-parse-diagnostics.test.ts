import { describe, expect, it, vi } from 'vitest';

import { motionCompiler } from '../src/compiler/vite/index.js';

/**
 * Этап C брифа: отказ парсера не глотается как успешный no-op. Модуль,
 * упоминающий наши субпути, но не разбираемый на фазе, где обязан быть
 * JavaScript, — сломанный вход: сборка получает предупреждение, а не тишину.
 */
describe('motionCompiler: parse failure виден в диагностике', () => {
  it('warn вызывается, lowering честно пропускается', () => {
    const plugin = motionCompiler();
    const warn = vi.fn();
    const result = (plugin.transform as (this: unknown, c: string, id: string) => unknown).call(
      { parse: () => { throw new Error('boom'); }, warn },
      "import { animate } from '@labpics/motion/nano'; ???",
      '/app/broken.js',
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('lowering пропущен');
  });

  it('модуль без целевых субпутей не трогает парсер вовсе', () => {
    const plugin = motionCompiler();
    const parse = vi.fn();
    const warn = vi.fn();
    const result = (plugin.transform as (this: unknown, c: string, id: string) => unknown).call(
      { parse, warn },
      'export const x = 1;',
      '/app/other.js',
    );
    expect(result).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
