/**
 * test/presets-text-number.test.ts — текстовые/числовые сахара subpath
 * ./presets (порт ценного из PR#79 языком дома: чистые мапперы «прогресс →
 * строка» + тонкие раннеры поверх runPreset).
 *
 * Классы: А (чистые мапперы, unit), Б (детерминизм / reduced-motion /
 * regression на rng-leak из PR#79), В (валидация MotionParamError).
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import {
  formatNumber,
  runNumber,
  runScramble,
  runTypewriter,
  scrambleAt,
  splitText,
  tickerCells,
  typewriterAt,
} from '../src/presets/index.js';

// ── Тестовая инфраструктура ──────────────────────────────────────────────────

/**
 * Ручная помпа кадров: cb(undefined) → фиксированный шаг 1/60 внутри runPreset
 * (детерминированная шкала без реального времени). Именно ОЧЕРЕДЬ, а не
 * синхронный вызов cb на месте: реентерабельный вызов гасится _tickActive-гардом
 * runPreset, и луп бы замер на первом же кадре.
 */
function createFramePump(): {
  requestFrame: (cb: (ts?: number) => void) => number;
  pump: () => void;
} {
  const queue: Array<(ts?: number) => void> = [];
  return {
    requestFrame: (cb) => queue.push(cb), // length >= 1 → без timeout-fallback
    pump: () => {
      let guard = 0;
      while (queue.length > 0 && guard < 10_000) {
        queue.shift()?.();
        guard++;
      }
    },
  };
}

/** matchMedia-стаб «пользователь просит reduced-motion». */
const reduceOn = (query: string): { matches: boolean } => ({
  matches: query.includes('prefers-reduced-motion'),
});

// ── splitText ────────────────────────────────────────────────────────────────

describe('presets/splitText', () => {
  it('А: chars — Unicode-safe, суррогатные пары не рвутся', () => {
    expect(splitText('a👍б')).toEqual(['a', '👍', 'б']);
  });

  it('А: words — join("") восстанавливает исходную строку бит-в-бит', () => {
    const src = 'привет  мир\nи ещё';
    const parts = splitText(src, 'words');
    expect(parts.join('')).toBe(src);
    expect(parts).toContain('привет');
    expect(parts).toContain('мир');
  });

  it('А: пустая строка → пустой массив', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('', 'words')).toEqual([]);
  });

  it('В: не-строка и неизвестный режим → MotionParamError', () => {
    expect(() => splitText(42 as never)).toThrow(MotionParamError);
    expect(() => splitText('x', 'lines' as never)).toThrow(MotionParamError);
  });
});

// ── typewriterAt ─────────────────────────────────────────────────────────────

describe('presets/typewriterAt', () => {
  const parts = splitText('Привет!');

  it('А: края — p=0 → "", p=1 → полный текст', () => {
    expect(typewriterAt(parts, 0)).toBe('');
    expect(typewriterAt(parts, 1)).toBe('Привет!');
  });

  it('А: монотонность — каждый кадр является префиксом полного текста', () => {
    let prevLen = 0;
    for (let i = 0; i <= 20; i++) {
      const frame = typewriterAt(parts, i / 20);
      expect('Привет!'.startsWith(frame)).toBe(true);
      expect(frame.length).toBeGreaterThanOrEqual(prevLen);
      prevLen = frame.length;
    }
  });

  it('А: хостильный прогресс клэмпится — NaN → "", 2 → полный текст', () => {
    expect(typewriterAt(parts, Number.NaN)).toBe('');
    expect(typewriterAt(parts, 2)).toBe('Привет!');
    expect(typewriterAt(parts, -1)).toBe('');
  });
});

// ── scrambleAt ───────────────────────────────────────────────────────────────

describe('presets/scrambleAt', () => {
  it('Б: чистая функция — (text, p, seed) → бит-идентичный кадр (fix rng-leak PR#79)', () => {
    const a = scrambleAt('Дешифровка', 0.4, { seed: 42 });
    const b = scrambleAt('Дешифровка', 0.4, { seed: 42 });
    expect(a).toBe(b);
  });

  it('Б: разные seed → разный шум', () => {
    const text = 'абвгдежзиклмнопрстуфхцчшщэюя0123';
    expect(scrambleAt(text, 0, { seed: 1 })).not.toBe(scrambleAt(text, 0, { seed: 2 }));
  });

  it('А: p=1 → точный текст, длина в глифах сохраняется всегда', () => {
    const text = 'Привет 👍';
    expect(scrambleAt(text, 1)).toBe(text);
    for (const p of [0, 0.3, 0.7]) {
      expect(Array.from(scrambleAt(text, p)).length).toBe(Array.from(text).length);
    }
  });

  it('А: раскрытый префикс совпадает с целью, шум — из заданного алфавита', () => {
    const text = 'абвгде';
    const frame = Array.from(scrambleAt(text, 0.5, { alphabet: 'xy' }));
    expect(frame.slice(0, 3).join('')).toBe('абв');
    for (const ch of frame.slice(3)) {
      expect(['x', 'y']).toContain(ch);
    }
  });

  it('А: пустой текст → пустая строка', () => {
    expect(scrambleAt('', 0.5)).toBe('');
  });
});

// ── formatNumber / tickerCells ───────────────────────────────────────────────

describe('presets/formatNumber + tickerCells', () => {
  it('А: Intl-форматирование с локалью и опциями', () => {
    expect(formatNumber(1234.5, { locales: 'en-US' })).toBe('1,234.5');
    expect(
      formatNumber(99, { locales: 'en-US', format: { style: 'currency', currency: 'USD' } }),
    ).toBe('$99.00');
  });

  it('А: tickerCells — все глифы строки, включая разделители', () => {
    expect(tickerCells(formatNumber(1234567, { locales: 'en-US' }))).toEqual([
      '1', ',', '2', '3', '4', ',', '5', '6', '7',
    ]);
  });

  it('А: tickerCells не выбрасывает нелатинские цифры (арабо-индийские и т.п.)', () => {
    // Регэксп-фильтр «только ASCII-цифры» из PR#79 потерял бы все три ячейки.
    expect(tickerCells('١٢٣')).toEqual(['١', '٢', '٣']);
  });

  it('В: неконечное value → MotionParamError (не эмитим "NaN" в UI)', () => {
    expect(() => formatNumber(Number.NaN)).toThrow(MotionParamError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
  });
});

// ── runTypewriter ────────────────────────────────────────────────────────────

describe('presets/runTypewriter', () => {
  it('Б: полный прогон — монотонные префиксы, финал = полный текст', async () => {
    const { requestFrame, pump } = createFramePump();
    const text = 'Привет, мир!';
    const frames: string[] = [];
    const controls = runTypewriter(text, (s) => frames.push(s), { requestFrame });
    pump();
    await controls;
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)).toBe(text);
    let prevLen = 0;
    for (const f of frames) {
      expect(text.startsWith(f)).toBe(true);
      expect(f.length).toBeGreaterThanOrEqual(prevLen);
      prevLen = f.length;
    }
  });

  it('Б: reduced-motion — ровно один эмит полного текста, кадры не планируются', async () => {
    const { requestFrame, pump } = createFramePump();
    const frames: string[] = [];
    const controls = runTypewriter('Привет', (s) => frames.push(s), {
      requestFrame,
      matchMedia: reduceOn,
    });
    pump(); // очередь должна быть пуста — луп не стартовал
    await controls;
    expect(frames).toEqual(['Привет']);
  });

  it('А: пустой текст завершается корректно (floor длительности — один кадр)', async () => {
    const { requestFrame, pump } = createFramePump();
    const frames: string[] = [];
    const controls = runTypewriter('', (s) => frames.push(s), { requestFrame });
    pump();
    await controls;
    expect(frames).toEqual(['']);
  });

  it('В: невалидные onUpdate/duration/mode → MotionParamError', () => {
    expect(() => runTypewriter('x', null as never)).toThrow(MotionParamError);
    expect(() => runTypewriter('x', () => {}, { duration: -1 })).toThrow(MotionParamError);
    expect(() => runTypewriter('x', () => {}, { mode: 'lines' as never })).toThrow(
      MotionParamError,
    );
  });
});

// ── runScramble ──────────────────────────────────────────────────────────────

describe('presets/runScramble', () => {
  it('Б: два прогона с одним seed → бит-идентичные последовательности кадров', async () => {
    const run = async (): Promise<string[]> => {
      const { requestFrame, pump } = createFramePump();
      const frames: string[] = [];
      const controls = runScramble('Дешифровка', (s) => frames.push(s), {
        requestFrame,
        seed: 7,
      });
      pump();
      await controls;
      return frames;
    };
    const [a, b] = [await run(), await run()];
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b);
  });

  it('Б: финальный кадр — точный текст; reduced-motion — один эмит текста', async () => {
    const { requestFrame, pump } = createFramePump();
    const frames: string[] = [];
    const controls = runScramble('Готово', (s) => frames.push(s), { requestFrame });
    pump();
    await controls;
    expect(frames.at(-1)).toBe('Готово');

    const rmFrames: string[] = [];
    await runScramble('Готово', (s) => rmFrames.push(s), {
      requestFrame: createFramePump().requestFrame,
      matchMedia: reduceOn,
    });
    expect(rmFrames).toEqual(['Готово']);
  });

  it('В: невалидные text/seed/alphabet/duration → MotionParamError', () => {
    const noop = (): void => {};
    expect(() => runScramble(42 as never, noop)).toThrow(MotionParamError);
    expect(() => runScramble('x', noop, { seed: Number.NaN })).toThrow(MotionParamError);
    expect(() => runScramble('x', noop, { alphabet: '' })).toThrow(MotionParamError);
    expect(() => runScramble('x', noop, { duration: -5 })).toThrow(MotionParamError);
  });
});

// ── runNumber ────────────────────────────────────────────────────────────────

describe('presets/runNumber', () => {
  it('Б: ведёт from→to монотонно, финал — ровно to с Intl-строкой', async () => {
    const { requestFrame, pump } = createFramePump();
    const values: number[] = [];
    const formatted: string[] = [];
    const controls = runNumber(
      0,
      100,
      (s, v) => {
        formatted.push(s);
        values.push(v);
      },
      { requestFrame, locales: 'en-US' },
    );
    pump();
    await controls;
    expect(values.at(-1)).toBe(100);
    expect(formatted.at(-1)).toBe('100');
    let prev = Number.NEGATIVE_INFINITY;
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('Б: reduced-motion — ровно один эмит конечного значения', async () => {
    const emits: Array<[string, number]> = [];
    await runNumber(0, 42, (s, v) => emits.push([s, v]), {
      requestFrame: createFramePump().requestFrame,
      matchMedia: reduceOn,
      locales: 'en-US',
    });
    expect(emits).toEqual([['42', 42]]);
  });

  it('А: формат валюты применяется к финалу', async () => {
    const { requestFrame, pump } = createFramePump();
    let last = '';
    const controls = runNumber(0, 99, (s) => (last = s), {
      requestFrame,
      locales: 'en-US',
      format: { style: 'currency', currency: 'USD' },
    });
    pump();
    await controls;
    expect(last).toBe('$99.00');
  });

  it('В: неконечные from/to и невалидная duration → MotionParamError', () => {
    const noop = (): void => {};
    expect(() => runNumber(Number.NaN, 1, noop)).toThrow(MotionParamError);
    expect(() => runNumber(0, Number.POSITIVE_INFINITY, noop)).toThrow(MotionParamError);
    expect(() => runNumber(0, 1, noop, { duration: -1 })).toThrow(MotionParamError);
  });
});
