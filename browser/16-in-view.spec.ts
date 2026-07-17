/** Реальный IntersectionObserver: custom root, enter/leave и terminal stop. */

import { expect, test } from './fixtures/harness';

test('custom root определяет enter/leave независимо от page viewport', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { inView } = await import('/dist/in-view/index.js');
    const root = document.createElement('div');
    root.style.cssText = [
      'position:relative',
      'width:100px',
      'height:100px',
      'overflow:hidden',
    ].join(';');
    const target = document.createElement('div');
    target.style.cssText = [
      'position:absolute',
      'inset:0 auto auto 0',
      'width:20px',
      'height:20px',
    ].join(';');
    root.appendChild(target);
    document.body.appendChild(root);

    const events: string[] = [];
    let entered!: () => void;
    let left!: () => void;
    const enterSignal = new Promise<void>((resolve) => { entered = resolve; });
    const leaveSignal = new Promise<void>((resolve) => { left = resolve; });
    const stop = inView(target, () => {
      events.push('enter');
      entered();
      return () => {
        events.push('leave');
        left();
      };
    }, { root, amount: 'all' });

    await enterSignal;
    // Target остаётся внутри page viewport, но целиком выходит из custom root.
    target.style.top = '150px';
    await leaveSignal;
    stop();
    stop();
    const targetTop = target.getBoundingClientRect().top;
    const viewportHeight = innerHeight;
    root.remove();
    return { events, targetTop, viewportHeight };
  });

  expect(result.events).toEqual(['enter', 'leave']);
  expect(result.targetTop).toBeLessThan(result.viewportHeight);
});

test('caller input получает DOM-boundary code и публичную cross-entry identity', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { inView, MotionParamError } = await import('/dist/in-view/index.js');
    const capture = (run: () => void) => {
      try {
        run();
        return { code: null, identity: false };
      } catch (error) {
        return {
          code: (error as { code?: string }).code ?? null,
          identity: error instanceof MotionParamError,
        };
      }
    };
    const target = document.createElement('div');
    return {
      target: capture(() => inView({ nodeType: 1 } as Element, () => undefined)),
      root: capture(() => inView(target, () => undefined, {
        root: { nodeType: 9 } as unknown as Document,
      })),
      margin: capture(() => inView(target, () => undefined, { margin: 'garbage' })),
    };
  });

  expect(result).toEqual({
    target: { code: 'LM147', identity: true },
    root: { code: 'LM156', identity: true },
    margin: { code: 'LM156', identity: true },
  });
});

test('Node intrinsic и nodeType spoof не обходят WebIDL brand boundary', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { inView, MotionParamError } = await import('/dist/in-view/index.js');
    const capture = (run: () => void) => {
      try {
        run();
        return 'ok';
      } catch (error) {
        return error instanceof MotionParamError ? error.code : 'foreign';
      }
    };
    const originalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')!;
    const live = document.createElement('div');

    let throwingNode;
    try {
      Object.defineProperty(globalThis, 'Node', {
        configurable: true,
        get: () => { throw new Error('hostile Node getter'); },
      });
      throwingNode = capture(() => inView(live, () => undefined));
    } finally {
      Object.defineProperty(globalThis, 'Node', originalNode);
    }

    class FakeNode {
      getRootNode() { return this; }
    }
    let replacedNode;
    let replacedNodeFake;
    try {
      Object.defineProperty(globalThis, 'Node', {
        configurable: true,
        value: FakeNode,
      });
      replacedNode = capture(() => inView(live, () => undefined));
      replacedNodeFake = capture(() => inView({ nodeType: 1 } as Element, () => undefined));
    } finally {
      Object.defineProperty(globalThis, 'Node', originalNode);
    }

    const spoofedElement = document.createElement('div');
    Object.defineProperty(spoofedElement, 'nodeType', { value: 9 });
    const elementTarget = capture(() => inView(spoofedElement, () => undefined)());

    const spoofedDocument = new DOMParser().parseFromString('<main></main>', 'text/html');
    Object.defineProperty(spoofedDocument, 'nodeType', { value: 1 });
    const documentRoot = capture(() => inView(live, () => undefined, {
      root: spoofedDocument,
    })());
    const documentTarget = capture(() => inView(
      spoofedDocument as unknown as Element,
      () => undefined,
    ));

    return {
      documentRoot,
      documentTarget,
      elementTarget,
      replacedNode,
      replacedNodeFake,
      throwingNode,
    };
  });

  expect(result).toEqual({
    documentRoot: 'ok',
    documentTarget: 'LM147',
    elementTarget: 'ok',
    replacedNode: 'LM147',
    replacedNodeFake: 'LM147',
    throwingNode: 'LM147',
  });
});

test('detached cross-realm Document сохраняет native root brand', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { inView } = await import('/dist/in-view/index.js');
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
      const view = iframe.contentWindow!;
      const Parser = Reflect.get(view, 'DOMParser') as typeof DOMParser;
      const detached = new Parser().parseFromString('<main></main>', 'text/html');
      const target = document.createElement('div');

      const native = new IntersectionObserver(() => undefined, { root: detached });
      native.observe(target);
      native.disconnect();

      const stop = inView(target, () => undefined, { root: detached });
      stop();
      return { defaultViewIsNull: detached.defaultView === null, nodeType: detached.nodeType };
    } finally {
      iframe.remove();
    }
  });

  expect(result).toEqual({ defaultViewIsNull: true, nodeType: 9 });
});

test('detached cross-realm Element сохраняет native root/target brand без duck typing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { inView, MotionParamError } = await import('/dist/in-view/index.js');
    const capture = (run: () => void) => {
      try {
        run();
        return { code: null, identity: false };
      } catch (error) {
        return {
          code: (error as { code?: string }).code ?? null,
          identity: error instanceof MotionParamError,
        };
      }
    };
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
      const view = iframe.contentWindow!;
      const Parser = Reflect.get(view, 'DOMParser') as typeof DOMParser;
      const detached = new Parser().parseFromString(
        '<main><span></span></main>',
        'text/html',
      );
      const root = detached.querySelector('main')!;
      const target = detached.querySelector('span')!;

      const native = new IntersectionObserver(() => undefined, { root });
      native.observe(target);
      native.disconnect();

      const accepted = capture(() => inView(target, () => undefined, { root })());
      const live = document.createElement('div');
      const proxied = new Proxy(live, {});
      return {
        accepted,
        defaultViewIsNull: detached.defaultView === null,
        fakeTarget: capture(() => inView({ nodeType: 1 } as Element, () => undefined)),
        fakeRoot: capture(() => inView(live, () => undefined, {
          root: { nodeType: 1 } as Element,
        })),
        proxyTarget: capture(() => inView(proxied, () => undefined)),
        proxyRoot: capture(() => inView(live, () => undefined, { root: proxied })),
      };
    } finally {
      iframe.remove();
    }
  });

  expect(result).toEqual({
    accepted: { code: null, identity: false },
    defaultViewIsNull: true,
    fakeTarget: { code: 'LM147', identity: true },
    fakeRoot: { code: 'LM156', identity: true },
    proxyTarget: { code: 'LM147', identity: true },
    proxyRoot: { code: 'LM156', identity: true },
  });
});

test('rootMargin делегирует нативную грамматику без локального whitelist', async ({ page }) => {
  const margins = await page.evaluate(async () => {
    const { inView } = await import('/dist/in-view/index.js');
    const target = document.createElement('div');
    // Пустая строка — валидный zero-token margin по алгоритму spec и Chromium;
    // прежний локальный regex ошибочно отклонял бы её до native parser.
    const accepted = ['', '1px 2%'];
    for (const margin of accepted) {
      const stop = inView(target, () => undefined, { margin });
      stop();
    }
    return accepted;
  });

  expect(margins).toEqual(['', '1px 2%']);
});
