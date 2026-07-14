import { expect, test } from './fixtures/harness';

test('nano исполняет spring/tween/stagger на native WAAPI и сохраняет финал', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/nano/index.js');
    const elements = Array.from({ length: 3 }, () => {
      const element = document.createElement('div');
      element.style.translate = '0px 0px';
      element.style.rotate = '0deg';
      element.style.opacity = '1';
      element.style.backgroundColor = 'rgb(0, 0, 0)';
      document.body.appendChild(element);
      return element;
    });

    const spring = animate(elements, { translate: '120px 0px', rotate: 90 }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      delay: 20,
      stagger: 15,
    });
    const native = spring.every((animation: Animation) => animation instanceof Animation);
    const delays = spring.map((animation: Animation) => animation.effect!.getTiming().delay);
    const firstTiming = spring[0].effect!.getTiming();
    spring[0].pause();
    spring[0].currentTime = Number(firstTiming.delay) + Number(firstTiming.duration) / 2;
    const interior = Number.parseFloat(getComputedStyle(elements[0]).translate);
    const t = Number(firstTiming.duration) / 2000;
    const omega = Math.sqrt(170);
    const alpha = 26 / 2;
    const beta = Math.sqrt(omega * omega - alpha * alpha);
    const analytic = 120 * (1 - Math.exp(-alpha * t)
      * (Math.cos(beta * t) + alpha / beta * Math.sin(beta * t)));
    for (const animation of spring) animation.finish();
    await spring.finished;
    const springFinal = elements.map((element) => {
      const style = getComputedStyle(element);
      return { translate: style.translate, rotate: style.rotate };
    });

    const tween = animate(elements, { opacity: 0.5, backgroundColor: 'rgb(255, 0, 0)' }, {
      duration: 180,
      ease: 'linear',
      stagger: 10,
    });
    for (const animation of tween) animation.finish();
    await tween.finished;
    const tweenFinal = elements.map((element) => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, background: style.backgroundColor };
    });
    const retained = elements.map((element) => element.getAnimations().length);
    for (const element of elements) element.remove();
    return { native, delays, interior, analytic, springFinal, tweenFinal, retained };
  });

  expect(result.native).toBe(true);
  expect(result.delays).toEqual([20, 35, 50]);
  expect(Math.abs(result.interior - result.analytic)).toBeLessThanOrEqual(0.4);
  expect(result.springFinal).toEqual(Array(3).fill({ translate: '120px', rotate: '90deg' }));
  expect(result.tweenFinal).toEqual(Array(3).fill({
    opacity: '0.5',
    background: 'rgb(255, 0, 0)',
  }));
  expect(result.retained).toEqual([0, 0, 0]);
});

test('nano reduced motion схлопывает duration и delay без wall-clock ожидания', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/nano/index.js');
    const element = document.createElement('div');
    document.body.appendChild(element);
    const controls = animate(element, { translate: '100px 0px' }, {
      duration: 500,
      delay: 200,
      reducedMotion: true,
    });
    const timing = controls[0].effect!.getTiming();
    controls[0].finish();
    await controls.finished;
    element.remove();
    return { duration: timing.duration, delay: timing.delay };
  });

  expect(result).toEqual({ duration: 0, delay: 0 });
});

test('nano чистит native effect после каждого replay и не занимает onfinish', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/nano/index.js');
    const element = document.createElement('div');
    document.body.append(element);
    const controls = animate(element, { opacity: 0.25 }, { duration: 100 });
    const animation = controls[0]!;
    let finishes = 0;
    animation.onfinish = () => { finishes += 1; };

    animation.finish();
    await controls.finished;
    await new Promise((resolve) => setTimeout(resolve));
    const first = { finishes, opacity: getComputedStyle(element).opacity, state: animation.playState };

    const replayed = new Promise((resolve) => {
      animation.addEventListener('finish', resolve, { once: true });
    });
    animation.play();
    animation.finish();
    await replayed;
    await new Promise((resolve) => setTimeout(resolve));

    return { first, finishes, opacity: getComputedStyle(element).opacity, state: animation.playState };
  });

  expect(result).toEqual({
    first: { finishes: 1, opacity: '0.25', state: 'idle' },
    finishes: 2,
    opacity: '0.25',
    state: 'idle',
  });
});
