import { expect, it, vi } from "vitest";
import { inView } from "../src/in-view/index.js";

it("владеет живыми target через один lifecycle Set", () => {
  const NativeSet = globalThis.Set;
  let allocations = 0;
  let positiveControl = 0;
  let measured = 0;

  class CountingSet<T> extends NativeSet<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      allocations += 1;
    }
  }

  class FakeElement {}
  class FakeIntersectionObserver {
    constructor(_callback: IntersectionObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("Set", CountingSet);

  try {
    new CountingSet();
    positiveControl = allocations;
    allocations = 0;

    const stop = inView(
      [
        new FakeElement() as unknown as Element,
        new FakeElement() as unknown as Element,
      ],
      () => () => undefined,
    );
    measured = allocations;
    stop();
  } finally {
    vi.unstubAllGlobals();
  }

  expect(positiveControl).toBe(1);
  expect(measured).toBe(2);
});

it("не возвращает освобождённый one-shot target в частично живой owner", () => {
  class FakeElement {}
  let callback: IntersectionObserverCallback | undefined;
  const observed: Element[] = [];
  const unobserved: Element[] = [];
  let disconnects = 0;

  class FakeIntersectionObserver {
    constructor(current: IntersectionObserverCallback) {
      callback = current;
    }
    observe(target: Element) {
      observed.push(target);
    }
    unobserve(target: Element) {
      unobserved.push(target);
    }
    disconnect() {
      disconnects += 1;
    }
  }

  const entry = (target: Element): IntersectionObserverEntry => ({
    target,
    isIntersecting: true,
    intersectionRatio: 1,
  }) as IntersectionObserverEntry;

  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

  try {
    const first = new FakeElement() as unknown as Element;
    const second = new FakeElement() as unknown as Element;
    const entered: Element[] = [];
    const leave = vi.fn();
    const stop = inView([first, second], (target) => {
      entered.push(target);
      return target === first ? undefined : leave;
    });

    expect(observed).toEqual([first, second]);
    const deliver = callback;
    if (deliver === undefined) throw new Error("IntersectionObserver callback не установлен");

    deliver([entry(first)], {} as IntersectionObserver);
    expect(entered).toEqual([first]);
    expect(unobserved).toEqual([first]);
    expect(disconnects).toBe(0);

    deliver([entry(first), entry(second)], {} as IntersectionObserver);
    expect(entered).toEqual([first, second]);
    expect(unobserved).toEqual([first]);
    expect(disconnects).toBe(0);

    stop();
    expect(disconnects).toBe(1);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(undefined);
  } finally {
    vi.unstubAllGlobals();
  }
});