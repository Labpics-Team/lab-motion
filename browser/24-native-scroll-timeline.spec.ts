import { expect, test } from './fixtures/harness';

test('native ScrollTimeline: поддерживаемый host двигает property без listener/rAF Lab Motion', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animateScrollWaapi, supportsScrollTimeline } = await import('/dist/waapi/index.js');
    const scroller = document.createElement('div');
    scroller.style.cssText = 'width:200px;height:100px;overflow:auto;position:relative';
    const content = document.createElement('div');
    content.style.cssText = 'height:1000px;position:relative';
    const target = document.createElement('div');
    target.style.cssText = 'position:sticky;top:0;width:20px;height:20px;opacity:0';
    content.append(target);
    scroller.append(content);
    document.body.append(scroller);

    let rafCalls = 0;
    let scrollListeners = 0;
    const nativeRaf = window.requestAnimationFrame;
    const nativeAdd = scroller.addEventListener.bind(scroller);
    window.requestAnimationFrame = ((...args: Parameters<typeof requestAnimationFrame>) => {
      rafCalls++;
      return nativeRaf(...args);
    }) as typeof requestAnimationFrame;
    scroller.addEventListener = ((type: string, ...args: unknown[]) => {
      if (type === 'scroll') scrollListeners++;
      return (nativeAdd as (...args: unknown[]) => void)(type, ...args);
    }) as typeof scroller.addEventListener;

    const supported = supportsScrollTimeline();
    const animation = animateScrollWaapi(target, {
      property: 'opacity', values: [0, 1],
    }, { source: scroller, axis: 'block' }) as Animation | undefined;

    window.requestAnimationFrame = nativeRaf;
    scroller.addEventListener = nativeAdd as typeof scroller.addEventListener;

    if (!supported) {
      const unsupported = animation === undefined && rafCalls === 0 && scrollListeners === 0;
      scroller.remove();
      return { supported, unsupported, top: null, bottom: null, rafCalls, scrollListeners };
    }

    const settle = () => new Promise<void>(resolve => nativeRaf(() => nativeRaf(() => resolve())));
    scroller.scrollTop = 0;
    await settle();
    const top = Number(getComputedStyle(target).opacity);
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    await settle();
    const bottom = Number(getComputedStyle(target).opacity);
    animation?.cancel();
    scroller.remove();
    return { supported, unsupported: false, top, bottom, rafCalls, scrollListeners };
  });

  expect(result.rafCalls).toBe(0);
  expect(result.scrollListeners).toBe(0);
  if (result.supported) {
    expect(result.top).not.toBeNull();
    expect(result.bottom).not.toBeNull();
    expect(result.top!).toBeLessThan(0.1);
    expect(result.bottom!).toBeGreaterThan(0.9);
  } else {
    expect(result.unsupported).toBe(true);
  }
});
