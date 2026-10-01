import { describe, expect, it } from 'vitest';
import {
  createDragDismiss, createPullToRefresh,
  type DismissController, type PullController,
} from '../src/behaviors/index.js';
import { makeClock, pt, reduceMedia } from './behaviors-helpers.js';

describe('./behaviors — getter позднего callback не восстанавливает отозванное намерение', () => {
  for (const kind of ['dismiss', 'refresh'] as const) {
    for (const reduced of [false, true]) {
      function scenario(action?: 'destroy' | 'cancel') {
        const clock = makeClock();
        let control!: DismissController | PullController;
        let reads = 0, calls = 0;
        const receivers: unknown[] = [];
        const callback = function (this: unknown) { calls++; receivers.push(this); };
        // Обычный method call не читает одноимённый public member функции.
        Object.defineProperty(callback, 'call', { get() { throw new Error('не читать callback.call'); } });
        const options = {
          distanceThreshold: 10, threshold: 10, resistance: 1,
          requestFrame: clock.requestFrame, matchMedia: reduced ? reduceMedia : undefined,
          get onDismiss() { reads++; action && control[action](); return callback; },
          get onRefresh() { reads++; action && control[action](); return callback; },
        };
        control = kind === 'dismiss' ? createDragDismiss(options) : createPullToRefresh(options);
        control.pointerDown(pt(0, 0, 0));
        control.pointerMove(pt(0, 20, 0.2));
        control.pointerUp(pt(0, 20, 0.4));
        clock.drain(16);
        return { control, clock, options, receivers, reads, calls };
      }

      for (const action of ['destroy', 'cancel'] as const) {
        it(`${kind}, reduced=${reduced}: getter ${action} отзывает callback`, async () => {
          const result = scenario(action);
          const state = result.control.state;
          await Promise.resolve(); await Promise.resolve();
          result.clock.drain(16);
          expect(result.reads).toBe(1);
          expect(result.calls).toBe(0);
          expect(result.receivers).toEqual([]);
          expect(result.control.state).toBe(state);
        });
      }

      it(`${kind}, reduced=${reduced}: здоровый getter читается один раз и сохраняет receiver`, async () => {
        const result = scenario();
        await Promise.resolve(); await Promise.resolve();
        result.clock.drain(16);
        expect(result.reads).toBe(1);
        expect(result.calls).toBe(1);
        expect(result.receivers).toEqual([result.options]);
        if (kind === 'refresh') expect(result.control.state.phase).toBe('idle');
      });
    }
  }
});
