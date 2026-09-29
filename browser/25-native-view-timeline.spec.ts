import { expect, test } from './fixtures/harness';

test('native ViewTimeline: reveal следует view progress без listener/rAF Lab Motion', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animateViewWaapi, supportsViewTimeline } = await import('/dist/waapi/index.js');
    const scroller = document.createElement('div');
    scroller.style.cssText = 'width:200px;height:200px;overflow:auto;position:relative';
    const content = document.createElement('div');
    content.style.cssText = 'height:1000px;position:relative';
    const subject = document.createElement('div');
    subject.style.cssText = 'position:absolute;top:400px;width:40px;height:100px;opacity:0';
    content.append(subject);
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

    const supported = supportsViewTimeline();
    const animation = animateViewWaapi(subject, {
      property: 'opacity', values: [0, 1],
    }, {
      subject,
      axis: 'block',
      rangeStart: 'cover 0%',
      rangeEnd: 'cover 100%',
    }) as Animation | undefined;

    window.requestAnimationFrame = nativeRaf;
    scroller.addEventListener = nativeAdd as typeof scroller.addEventListener;

    if (!supported) {
      const unsupported = animation === undefined && rafCalls === 0 && scrollListeners === 0;
      scroller.remove();
      return { supported, unsupported, early: null, late: null, rafCalls, scrollListeners };
    }

    const settle = () => new Promise<void>(resolve => nativeRaf(() => nativeRaf(() => resolve())));
    scroller.scrollTop = 200;
    await settle();
    const early = Number(getComputedStyle(subject).opacity);
    scroller.scrollTop = 500;
    await settle();
    const late = Number(getComputedStyle(subject).opacity);
    animation?.cancel();
    scroller.remove();
    return { supported, unsupported: false, early, late, rafCalls, scrollListeners };
  });

  expect(result.rafCalls).toBe(0);
  expect(result.scrollListeners).toBe(0);
  if (result.supported) {
    expect(result.early).not.toBeNull();
    expect(result.late).not.toBeNull();
    expect(result.late!).toBeGreaterThan(result.early! + 0.5);
  } else {
    expect(result.unsupported).toBe(true);
  }
});
