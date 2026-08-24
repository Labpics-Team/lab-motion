// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { animateMock } = vi.hoisted(() => ({ animateMock: vi.fn() }));

vi.mock('@labpics/motion/animate', () => ({ animate: animateMock }));

type Controls = {
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
};

let activeDispose: (() => void) | undefined;
let hidden = false;
let mediaListeners: Set<() => void>;
let controls: Controls[];
let observerEntries: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;
let observerDisconnects: number;

function fixture(): void {
  document.body.innerHTML = `
    <button data-action="toggle-motion" aria-pressed="false">Reduce motion</button>
    <p data-site-status></p>
    <article data-card="spring"><span data-state>ready</span></article>
    <article data-card="stagger"><span data-state>ready</span></article>
    <article data-card="retarget"><span data-state>ready</span></article>
    <div class="hero-stage"><div data-preview="hero-orb"></div></div>
    <div data-preview="spring-object"></div>
    <span data-stagger-item></span>
    <div data-preview="retarget-object"></div>
    <p data-retarget-copy></p>
    <button data-action="replay-spring"></button>
    <button data-action="replay-stagger"></button>
    <button data-action="retarget"></button>
    <button data-action="reset-retarget"></button>
    <button data-copy></button>
    <code data-copy-source>example</code>
    <p data-copy-status></p>
  `;
}

beforeEach(() => {
  fixture();
  hidden = false;
  mediaListeners = new Set();
  controls = [];
  observerEntries = [];
  observerDisconnects = 0;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    }),
  });
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observerEntries.push(callback);
      }

      observe(): void {
        observerEntries.at(-1)?.([{ isIntersecting: true }]);
      }

      disconnect(): void {
        observerDisconnects += 1;
      }
    },
  });
  animateMock.mockReset();
  animateMock.mockImplementation(() => {
    const value: Controls = { cancel: vi.fn(), finished: new Promise<void>(() => {}) };
    controls.push(value);
    return value;
  });
});

afterEach(() => {
  activeDispose?.();
  activeDispose = undefined;
  vi.restoreAllMocks();
});

describe('showcase lifecycle ownership', () => {
  it('reinstall replaces listeners and disposer makes the runtime inert', async () => {
    const { installShowcase } = await import('../site/src/scripts/showcase.js');
    const firstDispose = installShowcase();
    expect(animateMock).toHaveBeenCalledTimes(3);

    activeDispose = installShowcase();
    expect(firstDispose).toBeTypeOf('function');
    expect(activeDispose).toBeTypeOf('function');
    expect(controls.slice(0, 3).every((value) => value.cancel.mock.calls.length === 1)).toBe(true);
    expect(mediaListeners.size).toBe(1);

    animateMock.mockClear();
    document.querySelector<HTMLElement>('[data-action="toggle-motion"]')!.click();
    expect(animateMock).toHaveBeenCalledTimes(3);

    activeDispose!();
    activeDispose = undefined;
    animateMock.mockClear();
    document.querySelector<HTMLElement>('[data-action="toggle-motion"]')!.click();
    expect(animateMock).not.toHaveBeenCalled();
    expect(mediaListeners.size).toBe(0);
  });

  it('stops work while hidden and restarts one preview set when visible', async () => {
    const { installShowcase } = await import('../site/src/scripts/showcase.js');
    activeDispose = installShowcase();
    const initial = [...controls];

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(initial.every((value) => value.cancel.mock.calls.length === 1)).toBe(true);

    animateMock.mockClear();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(animateMock).toHaveBeenCalledTimes(3);
  });

  it('stops the hero when its stage leaves the viewport and disconnects the observer', async () => {
    const { installShowcase } = await import('../site/src/scripts/showcase.js');
    activeDispose = installShowcase();
    expect(observerEntries).toHaveLength(1);
    const initialHero = controls[0]!;

    observerEntries[0]!([{ isIntersecting: false }]);
    expect(initialHero.cancel).toHaveBeenCalledTimes(1);

    observerEntries[0]!([{ isIntersecting: true }]);
    expect(animateMock).toHaveBeenCalledTimes(4);

    activeDispose!();
    expect(observerDisconnects).toBeGreaterThan(0);
  });

  it('ignores late finished notifications after disposal', async () => {
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    animateMock.mockImplementationOnce(() => {
      const value: Controls = { cancel: vi.fn(), finished: new Promise<void>(() => {}) };
      controls.push(value);
      return value;
    });
    animateMock.mockImplementationOnce(() => {
      const value: Controls = { cancel: vi.fn(), finished };
      controls.push(value);
      return value;
    });
    const { installShowcase } = await import('../site/src/scripts/showcase.js');
    activeDispose = installShowcase();
    expect(document.querySelector('[data-card="spring"] [data-state]')?.textContent).toBe('running');
    activeDispose();
    resolveFinished();
    await finished;
    await Promise.resolve();
    expect(document.querySelector('[data-card="spring"] [data-state]')?.textContent).toBe('running');
  });
});
