/**
 * ./in-view — нативный IntersectionObserver-адаптер.
 *
 * RED proof: до реализации отдельного subpath модуль отсутствует. Дальше тесты
 * пинят snapshot целей, one-shot/leave lifecycle, fail-closed LM-границы и
 * rollback на синхронно-враждебном host-е.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as inViewApi from '../src/in-view/index.js';
import { MotionParamError } from '../src/in-view/index.js';

type HostHooks = {
  readonly construct?: (
    observer: FakeIntersectionObserver,
    callback: IntersectionObserverCallback,
  ) => void;
  readonly observe?: (observer: FakeIntersectionObserver, target: Element) => void;
  readonly unobserve?: (observer: FakeIntersectionObserver, target: Element) => void;
  readonly disconnect?: (observer: FakeIntersectionObserver) => void;
};

let hostHooks: HostHooks = {};

class FakeElement {
  readonly nodeType = 1;
  constructor(readonly name: string) {}
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  disconnectCalls = 0;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
    hostHooks.construct?.(this, callback);
  }

  observe(target: Element): void {
    this.observed.push(target);
    hostHooks.observe?.(this, target);
  }

  unobserve(target: Element): void {
    this.unobserved.push(target);
    hostHooks.unobserve?.(this, target);
  }

  disconnect(): void {
    this.disconnectCalls++;
    hostHooks.disconnect?.(this);
  }

  emit(...entries: IntersectionObserverEntry[]): void {
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

function element(name: string): Element {
  return new FakeElement(name) as unknown as Element;
}

function entry(
  target: Element,
  isIntersecting: boolean,
  intersectionRatio = isIntersecting ? 1 : 0,
): IntersectionObserverEntry {
  return { target, isIntersecting, intersectionRatio } as IntersectionObserverEntry;
}

function installHost(hooks: HostHooks = {}): void {
  hostHooks = hooks;
  FakeIntersectionObserver.instances.length = 0;
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal(
    'IntersectionObserver',
    FakeIntersectionObserver as unknown as typeof IntersectionObserver,
  );
}

function observer(): FakeIntersectionObserver {
  const current = FakeIntersectionObserver.instances.at(-1);
  expect(current).toBeDefined();
  return current!;
}

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MotionParamError);
  expect((caught as MotionParamError).code).toBe(code);
}

afterEach(() => {
  hostHooks = {};
  FakeIntersectionObserver.instances.length = 0;
  vi.unstubAllGlobals();
});

describe('./in-view public boundary', () => {
  it('SSR-safe import экспортирует capability и её физический error constructor', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expect(Object.keys(inViewApi).sort()).toEqual(['MotionParamError', 'inView']);
    expect(typeof inViewApi.inView).toBe('function');
    expect(typeof inViewApi.MotionParamError).toBe('function');
  });

  it('снимает selector/array-like один раз и передаёт root/margin/amount host-у', () => {
    installHost();
    const a = element('a');
    const b = element('b');
    const outsider = element('outsider');
    let lengthReads = 0;
    const live = {
      0: a,
      1: b,
      get length() {
        lengthReads++;
        return 2;
      },
    };
    vi.stubGlobal('document', { querySelectorAll: () => live });
    const root = element('root');
    const entered: Element[] = [];

    const stop = inViewApi.inView(
      '.card',
      (target) => {
        entered.push(target);
        return () => undefined;
      },
      { root, margin: '10px 20px', amount: 0.5 },
    );

    expect(lengthReads).toBe(1);
    expect(observer().observed).toEqual([a, b]);
    expect(observer().options).toEqual({
      root,
      rootMargin: '10px 20px',
      threshold: 0.5,
    });

    live[0] = outsider;
    observer().emit(entry(a, true, 0.5), entry(outsider, true, 1));
    expect(entered).toEqual([a]);
    stop();
  });

  it('без onLeave работает one-shot; amount:0 сохраняет семантику "some"', () => {
    installHost();
    const target = element('target');
    const entered: Element[] = [];
    const stop = inViewApi.inView(target, (el) => void entered.push(el), { amount: 0 });

    expect(observer().options?.threshold).toBe(0);
    observer().emit(entry(target, false, 0));
    observer().emit(entry(target, true, 0));
    observer().emit(entry(target, true, 1));

    expect(entered).toEqual([target]);
    expect(observer().unobserved).toEqual([target]);
    expect(observer().disconnectCalls).toBe(1);
    stop();
    expect(observer().disconnectCalls).toBe(1);
  });

  it('возвращённый onLeave делает target повторяемым, stop чистит активный вход один раз', () => {
    installHost();
    const target = element('target');
    const log: string[] = [];
    const leaveEntries: Array<IntersectionObserverEntry | undefined> = [];
    const stop = inViewApi.inView(target, () => {
      log.push('enter');
      return (info) => {
        log.push('leave');
        leaveEntries.push(info);
      };
    });

    observer().emit(entry(target, true));
    observer().emit(entry(target, true));
    const naturalLeave = entry(target, false);
    observer().emit(naturalLeave);
    observer().emit(entry(target, false));
    observer().emit(entry(target, true));
    stop();
    stop();

    expect(log).toEqual(['enter', 'leave', 'enter', 'leave']);
    expect(leaveEntries).toEqual([naturalLeave, undefined]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('пустой snapshot не требует DOM host и возвращает idempotent stop', () => {
    const stop = inViewApi.inView([], () => undefined);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  it('ошибочные target/options/callback/host закрываются стабильными LM-кодами', () => {
    vi.stubGlobal('Element', FakeElement);
    const target = element('target');
    expectCode(() => inViewApi.inView('.missing', () => undefined), 'LM149');
    expectCode(() => inViewApi.inView({ nodeType: 1 } as Element, () => undefined), 'LM147');
    expectCode(() => inViewApi.inView({ length: NaN } as never, () => undefined), 'LM146');
    expectCode(() => inViewApi.inView(target, () => undefined, null as never), 'LM156');
    expectCode(() => inViewApi.inView(target, () => undefined, { amount: NaN }), 'LM156');
    expectCode(() => inViewApi.inView(target, () => undefined, { amount: -0.01 }), 'LM156');
    expectCode(() => inViewApi.inView(target, () => undefined, { amount: 1.01 }), 'LM156');
    expectCode(() => inViewApi.inView(target, null as never), 'LM156');
    expectCode(() => inViewApi.inView(target, () => undefined), 'LM149');

    installHost();
    expectCode(() => inViewApi.inView(target, () => undefined, {
      root: { nodeType: 9 } as unknown as Document,
    }), 'LM156');
    expect(FakeIntersectionObserver.instances).toHaveLength(0);

    const syntax = new DOMException('invalid rootMargin', 'SyntaxError');
    installHost({ construct: () => { throw syntax; } });
    expectCode(() => inViewApi.inView(target, () => undefined, { margin: 'garbage' }), 'LM156');
  });
});

describe('./in-view hostile host and callback lifecycle', () => {
  it('нормализует constructor-сбой; синхронный constructor callback откатывает ресурс', () => {
    const target = element('target');
    installHost({ construct: () => { throw new Error('ctor'); } });
    expectCode(() => inViewApi.inView(target, () => undefined), 'LM149');

    const hostileSyntax = new DOMException('host', 'SyntaxError');
    installHost({ construct: () => { throw hostileSyntax; } });
    expectCode(() => inViewApi.inView(target, () => undefined), 'LM149');

    let entered = 0;
    installHost({
      construct: (current, callback) => {
        callback([entry(target, true)], current as unknown as IntersectionObserver);
      },
    });
    expectCode(() => inViewApi.inView(target, () => void entered++), 'LM149');
    expect(entered).toBe(0);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('observe-сбой второго target делает transactional rollback через disconnect', () => {
    const a = element('a');
    const b = element('b');
    installHost({
      observe: (_current, target) => {
        if (target === b) throw new Error('observe');
      },
    });

    expectCode(() => inViewApi.inView([a, b], () => undefined), 'LM149');
    expect(observer().observed).toEqual([a, b]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('синхронный callback из observe считается нарушением host-контракта', () => {
    const target = element('target');
    let entered = 0;
    installHost({
      observe: (current) => {
        current.emit(entry(target, true));
      },
    });

    expectCode(() => inViewApi.inView(target, () => void entered++), 'LM149');
    expect(entered).toBe(0);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('бросивший onEnter снимается, соседи получают batch, первичная ошибка не маскируется', () => {
    installHost();
    const a = element('a');
    const b = element('b');
    const primary = new Error('consumer');
    const entered: Element[] = [];
    inViewApi.inView([a, b], (target) => {
      entered.push(target);
      if (target === a) throw primary;
    });

    expect(() => observer().emit(entry(a, true), entry(b, true))).toThrow(primary);
    expect(entered).toEqual([a, b]);
    expect(observer().unobserved).toEqual([a, b]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('batch primary переживает later one-shot с hostile disconnect', () => {
    const primary = Object.freeze({ kind: 'batch-primary' });
    installHost({ disconnect: () => { throw new Error('disconnect'); } });
    const a = element('a');
    const b = element('b');
    const entered: Element[] = [];
    inViewApi.inView([a, b], (target) => {
      entered.push(target);
      if (target === a) throw primary;
    });

    let caught: unknown;
    try {
      observer().emit(entry(a, true), entry(b, true));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(primary);
    expect(entered).toEqual([a, b]);
    expect(observer().unobserved).toEqual([a, b]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('batch primary переживает later hostile entry getter', () => {
    const primary = Object.freeze({ kind: 'getter-primary' });
    installHost();
    const a = element('a');
    const b = element('b');
    inViewApi.inView([a, b], (target) => {
      if (target === a) throw primary;
    });
    const hostile = {
      target: b,
      get isIntersecting() {
        throw new Error('entry getter');
      },
      intersectionRatio: 1,
    } as unknown as IntersectionObserverEntry;

    let caught: unknown;
    try {
      observer().emit(entry(a, true), hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(primary);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('без prior failure hostile one-shot disconnect остаётся LM149', () => {
    installHost({ disconnect: () => { throw new Error('disconnect'); } });
    const target = element('target');
    inViewApi.inView(target, () => undefined);

    expectCode(() => observer().emit(entry(target, true)), 'LM149');
    expect(observer().unobserved).toEqual([target]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('hostile unobserve/disconnect не маскируют exact primary из onEnter', () => {
    const primary = Object.freeze({ kind: 'primary' });
    installHost({
      unobserve: () => { throw new Error('unobserve'); },
      disconnect: () => { throw new Error('disconnect'); },
    });
    const target = element('target');
    inViewApi.inView(target, () => { throw primary; });

    let caught: unknown;
    try {
      observer().emit(entry(target, true));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(primary);
    expect(observer().unobserved).toEqual([target]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('нефункциональный onLeave fail-closed, target после ошибки не остаётся живым', () => {
    installHost({ disconnect: () => { throw new Error('disconnect'); } });
    const target = element('target');
    inViewApi.inView(target, (() => 42) as never);

    expectCode(() => observer().emit(entry(target, true)), 'LM156');
    expect(observer().unobserved).toEqual([target]);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('onEnter может вызвать stop; поздно возвращённый cleanup выполняется немедленно', () => {
    installHost();
    const target = element('target');
    let cleanupCalls = 0;
    let stop = () => undefined;
    stop = inViewApi.inView(target, () => {
      stop();
      return () => void cleanupCalls++;
    });

    observer().emit(entry(target, true));
    expect(cleanupCalls).toBe(1);
    expect(observer().disconnectCalls).toBe(1);
    stop();
    expect(cleanupCalls).toBe(1);
  });

  it('getter записи не может вызвать onEnter после terminal stop', () => {
    installHost();
    const target = element('target');
    let entered = 0;
    let cleanupCalls = 0;
    const stop = inViewApi.inView(target, () => {
      entered++;
      return () => void cleanupCalls++;
    });
    const hostile = {
      target,
      get isIntersecting() {
        stop();
        return true;
      },
      intersectionRatio: 1,
    } as unknown as IntersectionObserverEntry;

    observer().emit(hostile);
    expect(entered).toBe(0);
    expect(cleanupCalls).toBe(0);
    expect(observer().disconnectCalls).toBe(1);
  });

  it('реентрантная доставка IO fail-closed и не теряет поздний cleanup', () => {
    installHost();
    const target = element('target');
    let entered = 0;
    let cleanupCalls = 0;
    let recursiveError: unknown;
    const stop = inViewApi.inView(target, () => {
      entered++;
      try {
        observer().emit(entry(target, true));
      } catch (error) {
        recursiveError = error;
      }
      return () => void cleanupCalls++;
    });

    observer().emit(entry(target, true));
    expect(entered).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(recursiveError).toBeInstanceOf(MotionParamError);
    expect((recursiveError as MotionParamError).code).toBe('LM149');
    expect(observer().disconnectCalls).toBe(1);
    stop();
    expect(cleanupCalls).toBe(1);
  });

  it('reentrant stop остаётся terminal и пытается выполнить все cleanup', () => {
    installHost();
    const a = element('a');
    const b = element('b');
    const primary = new Error('cleanup');
    const log: string[] = [];
    let stop = () => undefined;
    stop = inViewApi.inView([a, b], (target) => () => {
      log.push((target as unknown as { name: string }).name);
      stop();
      if (target === a) throw primary;
    });
    observer().emit(entry(a, true), entry(b, true));

    expect(() => stop()).toThrow(primary);
    expect(log).toEqual(['a', 'b']);
    expect(observer().disconnectCalls).toBe(1);
    expect(() => stop()).not.toThrow();
  });

  it('disconnect-сбой нормализуется после cleanup; повторный stop уже no-op', () => {
    installHost({ disconnect: () => { throw new Error('disconnect'); } });
    const target = element('target');
    let cleanupCalls = 0;
    const stop = inViewApi.inView(target, () => () => void cleanupCalls++);
    observer().emit(entry(target, true));

    expectCode(stop, 'LM149');
    expect(cleanupCalls).toBe(1);
    expect(observer().disconnectCalls).toBe(1);
    expect(() => stop()).not.toThrow();
  });
});
