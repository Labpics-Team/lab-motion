import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameRequester } from '../src/internal/frame-requester.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('internal frame requester — hostile one-shot ownership', () => {
  it('does not let a late old callback consume the next normal reservation', () => {
    const callbacks: Array<(timestamp?: number) => void> = [];
    const ticks: Array<number | undefined> = [];
    let request!: () => void;
    request = createFrameRequester((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    }, (timestamp) => {
      ticks.push(timestamp);
      if (ticks.length === 1) request();
    });

    request();
    callbacks[0]!(10);
    expect(callbacks).toHaveLength(2);

    callbacks[0]!(20);
    expect(ticks).toEqual([10]);

    callbacks[1]!(30);
    expect(ticks).toEqual([10, 30]);
  });

  it('accepts only the first delivery from one host request', () => {
    let deliver: ((timestamp?: number) => void) | undefined;
    const ticks: Array<number | undefined> = [];
    const request = createFrameRequester((callback) => {
      deliver = callback;
      return 1;
    }, (timestamp) => ticks.push(timestamp));

    request();
    deliver!(10);
    deliver!(20);

    expect(ticks).toEqual([10]);
  });

  it('does not invent a frame when an async host has not delivered one', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const request = createFrameRequester(() => 1, tick);

    request();
    vi.runAllTimers();

    expect(tick).not.toHaveBeenCalled();
  });

  it('coalesces handle=0 fallback requests into one pending delivery', () => {
    vi.useFakeTimers();
    const schedule = vi.fn(() => 0);
    const tick = vi.fn();
    const request = createFrameRequester(schedule, tick);

    request();
    request();
    vi.runAllTimers();

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not leak a synchronous delivery when the host then throws', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const request = createFrameRequester((callback) => {
      callback(10);
      throw new Error('host failed after delivery');
    }, tick);

    expect(request).toThrow('host failed after delivery');
    vi.runAllTimers();

    expect(tick).not.toHaveBeenCalled();
  });

  it('revokes a retained callback when the host throws before delivery', () => {
    let retained: ((timestamp?: number) => void) | undefined;
    const tick = vi.fn();
    const request = createFrameRequester((callback) => {
      retained = callback;
      throw new Error('host failed before delivery');
    }, tick);

    expect(request).toThrow('host failed before delivery');
    retained!(10);

    expect(tick).not.toHaveBeenCalled();
  });

  it('revokes the host callback after handle=0 selects the fallback owner', () => {
    vi.useFakeTimers();
    let retained: ((timestamp?: number) => void) | undefined;
    const tick = vi.fn();
    const request = createFrameRequester((callback) => {
      retained = callback;
      return 0;
    }, tick);

    request();
    vi.runAllTimers();
    retained!(10);

    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenLastCalledWith(undefined);
  });
});
