import { expect, test } from './fixtures/harness';

test('живые rAF: поток целей двигает DOM через один общий кадр и освобождает цикл', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { MotionValue } = await import('/dist/index.js');
    const { createFrameLoop, asRequestFrame } = await import('/dist/frame/index.js');
    let requests = 0;
    let writes = 0;
    const loop = createFrameLoop({ requestFrame: callback => {
      requests++;
      return requestAnimationFrame(callback);
    } });
    const elements = Array.from({ length: 8 }, () => {
      const element = document.createElement('div');
      element.style.cssText = 'width:10px;height:10px;transform:translateX(0px)';
      document.body.appendChild(element);
      return element;
    });
    const values = elements.map(element => {
      const value = new MotionValue({
        initial: 0, spring: { mass: 1, stiffness: 100, damping: 20 },
        clamp: false, requestFrame: asRequestFrame(loop),
      });
      value.onChange(x => { writes++; element.style.transform = `translateX(${x}px)`; });
      value.setTarget(100);
      return value;
    });
    const samples: Array<{ timestamp: number; target: number; x: number; v: number; screenX: number }> = [];
    let boundaryChanged = false;
    let target = 100;
    await new Promise<void>(resolve => {
      const stopInput = loop.read(() => {
        target++;
        for (const value of values) {
          const x = value.value;
          const v = value.velocity;
          value.setTarget(target);
          boundaryChanged ||= value.value !== x || value.velocity !== v;
        }
      });
      const stopRender = loop.render(timestamp => {
        const value = values[0]!;
        samples.push({
          timestamp: timestamp!, target, x: value.value, v: value.velocity,
          screenX: new DOMMatrixReadOnly(getComputedStyle(elements[0]!).transform).e,
        });
        if (samples.length === 24) {
          stopInput();
          stopRender();
          values.forEach(current => current.destroy());
          resolve();
        }
      });
    });
    // Уже зарезервированный тик может прийти, но не пишет и не создаёт следующий.
    const lastWrites = writes;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const idleRequests = requests;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const stable = requests === idleRequests && writes === lastWrites;
    const allSame = values.every(value => value.value === samples.at(-1)!.x && value.velocity === samples.at(-1)!.v);
    loop.cancelAll();
    elements.forEach(element => element.remove());
    return { samples, boundaryChanged, allSame, stable, requests, writes };
  });
  expect(result.boundaryChanged).toBe(false);
  expect(result.allSame).toBe(true);
  expect(result.stable).toBe(true);
  expect(result.requests).toBe(25); // 24 опубликованных кадра + один stale, не 8×24
  expect(result.writes).toBe(8 * 25); // подписка + 24 кадра на значение
  let x = 0;
  let v = 0;
  let previous = result.samples[0]!.timestamp;
  for (const sample of result.samples) {
    // ОДУ x'' + 20x' + 100(x − target) = 0, независимо от production-солвера.
    const dt = (sample.timestamp - previous) / 1000;
    const y = x - sample.target;
    const b = v + 10 * y;
    const decay = Math.exp(-10 * dt);
    x = sample.target + (y + b * dt) * decay;
    v = (v - 10 * b * dt) * decay;
    expect(sample.x).toBeCloseTo(x, 7);
    expect(sample.v).toBeCloseTo(v, 7);
    // CSS matrix() сериализуется с меньшей точностью, чем состояние JS.
    expect(Math.abs(sample.screenX - sample.x)).toBeLessThan(0.001);
    previous = sample.timestamp;
  }
  expect(result.samples.at(-1)!.x).toBeGreaterThan(1);
});
