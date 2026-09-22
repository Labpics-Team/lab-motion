/**
 * JOURNEY-01: два реальных браузерных потребителя ./smart.
 * Пакетный импорт отдельно запинен test/journey-package-consumers.test.ts;
 * здесь собранный dist проходит настоящий DOM, фокус, ввод и визуальную C0-границу.
 */
import { expect, test } from './fixtures/harness';

test('card↔details: вложенная геометрия, перенацеливание в полёте, фокус и режимы без движения', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    document.body.innerHTML = `
      <button id="focus">Фокус</button>
      <div id="root" style="position:relative;width:720px;height:640px">
        <article id="card" data-motion-key="card" style="position:absolute;left:0;top:50px;width:120px;height:80px">
          <div id="media" data-motion-key="media" style="position:absolute;left:12px;top:12px;width:48px;height:48px"></div>
        </article>
      </div>`;
    const focus = document.querySelector<HTMLButtonElement>('#focus')!;
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const media = document.querySelector<HTMLElement>('#media')!;
    focus.focus();

    let clicks = 0;
    card.addEventListener('click', () => { clicks++; });
    const queue: Array<(ts?: number) => void> = [];
    let calls = 0;
    let now = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      calls++;
      queue.push(cb);
      return calls;
    };
    const step = (): void => {
      now += 16;
      const batch = queue.splice(0);
      for (const cb of batch) cb(now);
    };
    const drain = (): void => {
      let guard = 0;
      while (queue.length > 0) {
        if (++guard > 4000) throw new Error('браузерные часы не остановились');
        step();
      }
    };
    const options = { requestFrame, radius: false };

    const first = captureSmart(root, options);
    card.style.cssText += ';left:40px;top:30px;width:360px;height:300px';
    media.style.cssText += ';left:40px;top:60px;width:200px;height:120px';
    const h1 = first.animate();
    for (let i = 0; i < 4; i++) step();
    const beforeCard = card.getBoundingClientRect();
    const beforeMedia = media.getBoundingClientRect();
    card.click();
    const focusedDuringFirst = document.activeElement === focus;

    const second = captureSmart(root, options);
    card.style.cssText += ';left:20px;top:50px;width:420px;height:360px';
    media.style.cssText += ';left:44px;top:80px;width:260px;height:160px';
    const h2 = second.animate();
    const boundaryCard = card.getBoundingClientRect();
    const boundaryMedia = media.getBoundingClientRect();
    const focusedAtRetarget = document.activeElement === focus;
    card.click();
    await h1.finished;
    drain();
    await h2.finished;

    const rootBox = root.getBoundingClientRect();
    const finalCardRect = card.getBoundingClientRect();
    const finalMediaRect = media.getBoundingClientRect();
    const finalCard = { x: finalCardRect.x - rootBox.x, y: finalCardRect.y - rootBox.y, width: finalCardRect.width, height: finalCardRect.height };
    const finalMedia = { x: finalMediaRect.x - rootBox.x, y: finalMediaRect.y - rootBox.y, width: finalMediaRect.width, height: finalMediaRect.height };
    const callsBeforeStill = calls;
    const still = captureSmart(root, options).animate();
    await still.finished;
    const noMotionCalls = calls - callsBeforeStill;

    const reducedCapture = captureSmart(root, {
      ...options,
      matchMedia: () => ({ matches: true }),
    });
    card.style.cssText += ';left:80px;top:90px;width:300px;height:220px';
    const callsBeforeReduced = calls;
    const reduced = reducedCapture.animate();
    await reduced.finished;

    return {
      plan1: h1.plan,
      plan2: h2.plan,
      clicks,
      focusedDuringFirst,
      focusedAtRetarget,
      c0Card: Math.hypot(boundaryCard.x - beforeCard.x, boundaryCard.y - beforeCard.y),
      c0Media: Math.hypot(boundaryMedia.x - beforeMedia.x, boundaryMedia.y - beforeMedia.y),
      finalCard,
      finalMedia,
      noMotionCalls,
      stillPlan: still.plan,
      reducedTier: reduced.tier,
      reducedCalls: calls - callsBeforeReduced,
      reducedTransform: card.style.transform,
      focusAfter: document.activeElement === focus,
    };
  });

  expect(result.plan1.matched).toEqual(['card', 'media']);
  expect(result.plan2.matched).toEqual(['card', 'media']);
  expect(result.c0Card).toBeLessThanOrEqual(0.75);
  expect(result.c0Media).toBeLessThanOrEqual(0.75);
  expect(result.clicks).toBe(2);
  expect(result.focusedDuringFirst).toBe(true);
  expect(result.focusedAtRetarget).toBe(true);
  expect(result.focusAfter).toBe(true);
  expect(result.finalCard).toEqual({ x: 20, y: 50, width: 420, height: 360 });
  expect(result.finalMedia).toEqual({ x: 64, y: 130, width: 260, height: 160 });
  expect(result.stillPlan).toEqual({ matched: [], entered: [], exited: [], skipped: [] });
  expect(result.noMotionCalls).toBe(0);
  expect(result.reducedTier).toBe('reduced');
  expect(result.reducedCalls).toBe(0);
  expect(result.reducedTransform).toBe('');
});

test('panel↔source: пересоздание узла, обратный ход, повторное открытие и интерактивность', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    document.body.innerHTML = `
      <button id="focus">Фокус</button>
      <div id="root" style="position:relative;width:720px;height:640px">
        <button id="surface" data-motion-key="surface" style="position:absolute;left:300px;top:20px;width:80px;height:40px">Открыть</button>
      </div>`;
    const focus = document.querySelector<HTMLButtonElement>('#focus')!;
    const root = document.querySelector<HTMLElement>('#root')!;
    let surface = document.querySelector<HTMLElement>('#surface')!;
    focus.focus();

    const queue: Array<(ts?: number) => void> = [];
    let now = 0;
    const requestFrame = (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return queue.length;
    };
    const step = (): void => {
      now += 16;
      const batch = queue.splice(0);
      for (const cb of batch) cb(now);
    };
    const drain = (): void => {
      let guard = 0;
      while (queue.length > 0) {
        if (++guard > 4000) throw new Error('часы панели не остановились');
        step();
      }
    };
    const options = { requestFrame, radius: false };
    let activations = 0;

    const openCapture = captureSmart(root, options);
    const panel = document.createElement('section');
    panel.id = 'surface';
    panel.dataset.motionKey = 'surface';
    panel.style.cssText = 'position:absolute;left:40px;top:60px;width:420px;height:300px';
    panel.innerHTML = '<button id="action">Действие</button>';
    root.replaceChildren(panel);
    surface = panel;
    panel.querySelector('button')!.addEventListener('click', () => { activations++; });
    const opening = openCapture.animate();
    for (let i = 0; i < 4; i++) step();
    panel.querySelector<HTMLButtonElement>('button')!.click();
    const visualBefore = panel.getBoundingClientRect();
    const focusOpening = document.activeElement === focus;

    const closeCapture = captureSmart(root, options);
    const sourceAgain = document.createElement('button');
    sourceAgain.id = 'surface';
    sourceAgain.dataset.motionKey = 'surface';
    sourceAgain.textContent = 'Открыть снова';
    sourceAgain.style.cssText = 'position:absolute;left:300px;top:20px;width:80px;height:40px';
    sourceAgain.addEventListener('click', () => { activations++; });
    root.replaceChildren(sourceAgain);
    surface = sourceAgain;
    const closing = closeCapture.animate();
    const boundary = sourceAgain.getBoundingClientRect();
    sourceAgain.click();
    const focusClosing = document.activeElement === focus;
    await opening.finished;
    drain();
    await closing.finished;

    const reopenCapture = captureSmart(root, options);
    const panelAgain = document.createElement('section');
    panelAgain.id = 'surface';
    panelAgain.dataset.motionKey = 'surface';
    panelAgain.style.cssText = 'position:absolute;left:60px;top:70px;width:400px;height:280px';
    root.replaceChildren(panelAgain);
    surface = panelAgain;
    const reopened = reopenCapture.animate();
    drain();
    await reopened.finished;

    return {
      openingPlan: opening.plan,
      closingPlan: closing.plan,
      reopenedPlan: reopened.plan,
      c0: Math.hypot(boundary.x - visualBefore.x, boundary.y - visualBefore.y),
      activations,
      focusOpening,
      focusClosing,
      focusAfter: document.activeElement === focus,
      finalTransform: surface.style.transform,
      finalBox: (() => {
        const r = surface.getBoundingClientRect();
        const rr = root.getBoundingClientRect();
        return { x: r.x - rr.x, y: r.y - rr.y, width: r.width, height: r.height };
      })(),
    };
  });

  expect(result.openingPlan.matched).toEqual(['surface']);
  expect(result.closingPlan.matched).toEqual(['surface']);
  expect(result.reopenedPlan.matched).toEqual(['surface']);
  expect(result.c0).toBeLessThanOrEqual(0.75);
  expect(result.activations).toBe(2);
  expect(result.focusOpening).toBe(true);
  expect(result.focusClosing).toBe(true);
  expect(result.focusAfter).toBe(true);
  expect(result.finalTransform).toBe('');
  expect(result.finalBox).toEqual({ x: 60, y: 70, width: 400, height: 280 });
});


test('движущийся элемент управления принимает настоящий указатель и клавиатуру, сохраняя фокус', async ({ page }) => {
  await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    document.body.innerHTML = `
      <div id="root" style="position:relative;width:720px;height:640px">
        <article id="card" data-motion-key="card" style="position:absolute;left:20px;top:40px;width:180px;height:120px">
          <button id="action" style="width:96px;height:40px">Действие</button>
        </article>
      </div>`;
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const action = document.querySelector<HTMLButtonElement>('#action')!;
    const queue: Array<(ts?: number) => void> = [];
    let now = 0;
    const state = {
      activations: 0,
      requestFrame(cb: (ts?: number) => void): number { queue.push(cb); return queue.length; },
      step(): void { now += 16; for (const cb of queue.splice(0)) cb(now); },
      drain(): void {
        let guard = 0;
        while (queue.length > 0) {
          if (++guard > 4000) throw new Error('часы взаимодействия не остановились');
          state.step();
        }
      },
      first: Promise.resolve(),
      second: Promise.resolve(),
      pending: (): number => queue.length,
    };
    action.addEventListener('click', () => { state.activations++; });
    const first = captureSmart(root, { requestFrame: state.requestFrame, radius: false });
    card.style.cssText += ';left:80px;top:90px;width:360px;height:260px';
    const handle = first.animate();
    state.first = handle.finished;
    for (let i = 0; i < 4; i++) state.step();
    (window as unknown as { __journeyInteraction: typeof state }).__journeyInteraction = state;
  });

  const action = page.locator('#action');
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.id,
    point,
  )).toBe('action');

  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __journeyInteraction: { activations: number } }).__journeyInteraction.activations,
  )).toBe(1);

  // Правдоподобный дефект: перекрытый указатель обязан сделать тот же ввод красным.
  await action.evaluate((element) => { (element as HTMLElement).style.pointerEvents = 'none'; });
  await page.mouse.click(point.x, point.y);
  expect(await page.evaluate(
    () => (window as unknown as { __journeyInteraction: { activations: number } }).__journeyInteraction.activations,
  )).toBe(1);
  await action.evaluate((element) => { (element as HTMLElement).style.pointerEvents = ''; });

  await action.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __journeyInteraction: { activations: number } }).__journeyInteraction.activations,
  )).toBe(2);

  const focusedAtRetarget = await page.evaluate(async () => {
    const { captureSmart } = await import('/dist/smart/index.js');
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const action = document.querySelector<HTMLButtonElement>('#action')!;
    const state = (window as unknown as {
      __journeyInteraction: {
        requestFrame(cb: (ts?: number) => void): number;
        second: Promise<void>;
      };
    }).__journeyInteraction;
    const second = captureSmart(root, { requestFrame: state.requestFrame, radius: false });
    card.style.cssText += ';left:40px;top:120px;width:420px;height:300px';
    state.second = second.animate().finished;
    return document.activeElement === action;
  });
  expect(focusedAtRetarget).toBe(true);

  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __journeyInteraction: { activations: number } }).__journeyInteraction.activations,
  )).toBe(3);

  const settled = await page.evaluate(async () => {
    const action = document.querySelector<HTMLButtonElement>('#action')!;
    const state = (window as unknown as {
      __journeyInteraction: {
        activations: number;
        first: Promise<void>;
        second: Promise<void>;
        drain(): void;
        pending(): number;
      };
    }).__journeyInteraction;
    await state.first;
    state.drain();
    await state.second;
    return {
      activations: state.activations,
      focused: document.activeElement === action,
      pending: state.pending(),
    };
  });
  expect(settled).toEqual({ activations: 3, focused: true, pending: 0 });
});
