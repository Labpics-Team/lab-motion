import { describe, expect, it } from 'vitest';
import { FIXED_DT_S } from '../src/internal/constants.js';
import { defaultRequestFrame } from '../src/internal/request-frame.js';

function restoreGlobal(
  name: 'requestAnimationFrame' | 'setTimeout',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

describe('defaultRequestFrame SSOT', () => {
  it('сохраняет динамический lookup rAF, два чтения getter и receiver-free вызов', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const callback = (): void => {};
    let reads = 0;
    let receiver: unknown = globalThis;
    let received: unknown;
    const requestFrame = function (this: unknown, cb: unknown): number {
      receiver = this;
      received = cb;
      return 0;
    };
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      get() {
        reads++;
        return requestFrame;
      },
    });

    try {
      expect(defaultRequestFrame(callback)).toBe(0);
      expect(reads).toBe(2);
      expect(receiver).toBeUndefined();
      expect(received).toBe(callback);
    } finally {
      restoreGlobal('requestAnimationFrame', descriptor);
    }
  });

  it('без rAF читает setTimeout один раз, без receiver и с точным fixed-step delay', () => {
    const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const timerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const callback = (): void => {};
    let rafReads = 0;
    let timerReads = 0;
    let receiver: unknown = globalThis;
    let received: unknown;
    let delay: unknown;
    const timer = function (this: unknown, cb: unknown, ms: unknown): number {
      receiver = this;
      received = cb;
      delay = ms;
      return 0;
    };
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      get() {
        rafReads++;
        return undefined;
      },
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      get() {
        timerReads++;
        return timer;
      },
    });

    try {
      expect(defaultRequestFrame(callback)).toBe(0);
      expect(rafReads).toBe(1);
      expect(timerReads).toBe(1);
      expect(receiver).toBeUndefined();
      expect(received).toBe(callback);
      expect(delay).toBe(FIXED_DT_S * 1000);
    } finally {
      restoreGlobal('requestAnimationFrame', rafDescriptor);
      restoreGlobal('setTimeout', timerDescriptor);
    }
  });
});
