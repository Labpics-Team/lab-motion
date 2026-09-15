import { expect, it, vi } from "vitest";
import { inView } from "../src/in-view/index.js";

it("owns live target membership with one lifecycle Set", () => {
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
