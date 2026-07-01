/**
 * test/presets-reduced-motion.test.ts — reduced-motion CHARACTER-switch
 * runPreset() (t3 ch01-motion-presets, инвариант North #4 subpath ./presets).
 *
 * Контракт:
 *   - Конечный repeat → мгновенный снэп к ФИНАЛЬНОЙ позе (t=totalDuration).
 *   - repeat=Infinity (ambient-луп) → НЕЙТРАЛЬНАЯ поза (сэмпл t=0): вечный
 *     цикл не имеет финала, «reduced» = покажи статичную иконку, не крути.
 *   - Поза эмитируется РОВНО один раз (onUpdate вызван 1 раз), промис резолвится.
 *     Это CHARACTER-switch, НЕ hard-off: потребитель ПОЛУЧАЕТ валидную позу.
 *
 * TDD RED-proof:
 *   1. Заменить reduce-ветку на «ничего не эмитировать» (hard-off) →
 *      тесты «эмитирует позу ровно один раз» RED.
 *   2. Заменить нейтральную позу на финальную для Infinity →
 *      «Infinity → нейтральная поза» RED (blink: финал==нейтраль, поэтому
 *      тест использует НЕсимметричную спеку, где t=0 и финал различимы).
 *   3. Убрать раннюю reduce-ветку целиком → «loop не стартует» RED.
 *
 * Классы: А (unit обе ветки), Д (mutation proof выше).
 */

import { describe, expect, it } from 'vitest';
import { runPreset, type PresetSpec, type PresetValues } from '../src/presets/index.js';

const reduceMedia = (query: string) => ({
  matches: query === '(prefers-reduced-motion: reduce)',
});

/** НЕсимметричная спека: поза t=0 (x=3) ≠ финальная поза (x=10). */
const asymmetric: PresetSpec = {
  duration: 1,
  tracks: [{ property: 'x', values: [3, 7, 10] }],
};

describe('presets — runPreset: reduced-motion CHARACTER-switch', () => {
  it('А: конечный repeat → снэп к ФИНАЛЬНОЙ позе, ровно один onUpdate, промис резолвится', async () => {
    const frames: PresetValues[] = [];
    let scheduled = 0;
    const controls = runPreset(asymmetric, {
      onUpdate: (v) => frames.push({ ...v }),
      matchMedia: reduceMedia,
      requestFrame: () => {
        scheduled++;
        return 1;
      },
    });
    await controls;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.x).toBe(10);
    expect(controls.progress).toBe(1);
    // Loop не стартовал вовсе — CHARACTER-switch синхронный
    expect(scheduled).toBe(0);
  });

  it('А: repeat=Infinity → НЕЙТРАЛЬНАЯ поза (сэмпл t=0), ровно один onUpdate', async () => {
    const frames: PresetValues[] = [];
    const controls = runPreset(
      { ...asymmetric, repeat: Infinity },
      {
        onUpdate: (v) => frames.push({ ...v }),
        matchMedia: reduceMedia,
        requestFrame: () => 1,
      },
    );
    await controls;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.x).toBe(3); // нейтраль, НЕ финал
  });

  it('А: reduce с delay — delay игнорируется, снэп немедленный', async () => {
    const frames: PresetValues[] = [];
    const controls = runPreset(
      { ...asymmetric, delay: 5 },
      {
        onUpdate: (v) => frames.push({ ...v }),
        matchMedia: reduceMedia,
        requestFrame: () => 1,
      },
    );
    await controls;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.x).toBe(10);
  });

  it('А: no-preference → обычное воспроизведение (reduce-ветка не срабатывает)', () => {
    const frames: PresetValues[] = [];
    const queue: Array<(ts?: number) => void> = [];
    runPreset(asymmetric, {
      onUpdate: (v) => frames.push({ ...v }),
      matchMedia: () => ({ matches: false }),
      requestFrame: (cb) => {
        queue.push(cb);
        return queue.length;
      },
    });
    let ts = 0;
    for (let i = 0; i < 10 && queue.length > 0; i++) {
      ts += 16;
      queue.shift()!(ts);
    }
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[frames.length - 1]!.x).not.toBe(10);
  });

  it('А: matchMedia бросает → трактуется как no-preference (SSR-стойкость)', () => {
    const queue: Array<(ts?: number) => void> = [];
    expect(() =>
      runPreset(asymmetric, {
        matchMedia: () => {
          throw new Error('нет DOM');
        },
        requestFrame: (cb) => {
          queue.push(cb);
          return queue.length;
        },
      }),
    ).not.toThrow();
    expect(queue.length).toBeGreaterThan(0); // луп стартовал
  });
});
