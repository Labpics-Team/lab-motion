/**
 * JOURNEY-01: два реальных браузерных потребителя ./smart.
 * Пакетный импорт отдельно запинен test/journey-package-consumers.test.ts;
 * здесь установленный production tarball проходит настоящий DOM, фокус, ввод и визуальную C0-границу.
 */
import { expect, packedJourneyTest as test } from './fixtures/harness';
import type { MotionScope, Playback } from '../src/motion/index.js';

type CardBox = { x: number; y: number; width: number; height: number };
interface RootCardState {
  area: MotionScope;
  root: HTMLElement;
  card: HTMLElement;
  media: HTMLElement;
  input: HTMLInputElement;
  opening: Playback;
  openingMedia: Playback;
  retarget: Playback;
  retargetMedia: Playback;
  closing?: Playback;
  reopened?: Playback;
  active?: Playback;
  before: CardBox[];
  boundary: CardBox[];
  moving: CardBox[];
  boxes(): CardBox[];
  activations(): number;
}
type RootCardWindow = Window & { __rootCard: RootCardState };

test('card↔details: вложенная геометрия, перенацеливание в полёте, фокус и режимы без движения', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
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
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
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
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
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
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
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

test('card↔details: выделение и ввод в том же input переживают retarget', async ({ page }) => {
  await page.evaluate(async () => {
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
    document.body.innerHTML = `
      <div id="root" style="position:relative;width:720px;height:640px">
        <article id="card" data-motion-key="card" style="position:absolute;left:20px;top:40px;width:180px;height:120px">
          <label>Название <input id="title" value="alpha beta"></label>
        </article>
      </div>`;
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const input = document.querySelector<HTMLInputElement>('#title')!;
    const queue: Array<(time?: number) => void> = [];
    let now = 0;
    const state = {
      input,
      requestFrame(callback: (time?: number) => void): number { queue.push(callback); return queue.length; },
      step(): void { now += 16; for (const callback of queue.splice(0)) callback(now); },
      drain(): void {
        let steps = 0;
        while (queue.length) {
          if (++steps > 4000) throw new Error('переход не завершился');
          state.step();
        }
      },
      first: Promise.resolve(), second: Promise.resolve(),
    };
    input.focus(); input.setSelectionRange(6, 10);
    const first = captureSmart(root, { requestFrame: state.requestFrame, radius: false });
    card.style.cssText += ';left:80px;top:90px;width:360px;height:260px';
    state.first = first.animate().finished;
    for (let i = 0; i < 4; i++) state.step();
    (window as any).__journeyInput = state;
  });

  const before = await page.evaluate(() => {
    const state = (window as any).__journeyInput;
    const input = document.querySelector<HTMLInputElement>('#title')!;
    return { same: input === state.input, focused: document.activeElement === input,
      start: input.selectionStart, end: input.selectionEnd, value: input.value };
  });
  expect(before).toEqual({ same: true, focused: true, start: 6, end: 10, value: 'alpha beta' });

  const atRetarget = await page.evaluate(async () => {
    const { captureSmart } = await import('/browser/.artifacts/scope-recipes.js');
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const state = (window as any).__journeyInput;
    const second = captureSmart(root, { requestFrame: state.requestFrame, radius: false });
    card.style.cssText += ';left:40px;top:120px;width:420px;height:300px';
    state.second = second.animate().finished;
    const input = document.querySelector<HTMLInputElement>('#title')!;
    return { same: input === state.input, focused: document.activeElement === input,
      start: input.selectionStart, end: input.selectionEnd };
  });
  expect(atRetarget).toEqual({ same: true, focused: true, start: 6, end: 10 });

  await page.keyboard.insertText('世界');
  const result = await page.evaluate(async () => {
    const state = (window as any).__journeyInput;
    await state.first;
    state.drain();
    await state.second;
    const input = document.querySelector<HTMLInputElement>('#title')!;
    return { same: input === state.input, focused: document.activeElement === input,
      value: input.value, start: input.selectionStart, end: input.selectionEnd,
      transform: document.querySelector<HTMLElement>('#card')!.style.transform };
  });
  expect(result).toEqual({ same: true, focused: true, value: 'alpha 世界', start: 8, end: 8, transform: '' });
});

test('root card↔details: живая геометрия, перехват, ввод и освобождение одной области', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.evaluate(async () => {
    const { scope } = await import('/browser/.artifacts/motion-root.js');
    document.body.innerHTML = `
      <div id="root" style="position:relative;width:720px;height:640px">
        <article id="card" style="position:absolute;left:0;top:50px;width:120px;height:80px">
          <div id="media" style="position:absolute;left:12px;top:12px;width:48px;height:48px"></div>
          <button id="action">Действие</button><input id="title" value="alpha beta">
        </article>
      </div>`;
    const root = document.querySelector<HTMLElement>('#root')!;
    const card = document.querySelector<HTMLElement>('#card')!;
    const media = document.querySelector<HTMLElement>('#media')!;
    const action = document.querySelector<HTMLButtonElement>('#action')!;
    const input = document.querySelector<HTMLInputElement>('#title')!;
    const area = scope(root, { spring: { mass: 1, stiffness: 170, damping: 26 } });
    let activations = 0;
    area.on(action, 'click', () => { activations++; });
    // Размеры принадлежат приложению; root исполняет CSS-каналы живых узлов,
    // без snapshot, скопированного solver и ручной передачи скорости.
    const opening = area.animate(card, { left: 40, top: 30, width: 360, height: 300 });
    const openingMedia = area.animate(media, { left: 40, top: 60, width: 200, height: 120 });
    const boxes = () => [card, media].map(node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    (window as unknown as RootCardWindow).__rootCard = { area, root, card, media, input, opening, openingMedia,
      retarget: opening, retargetMedia: openingMedia, before: [], boundary: [], moving: [], boxes,
      activations: () => activations };
  });
  await page.clock.runFor(64);
  const intermediate = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    return { boxes: state.boxes(), card: state.opening.state, media: state.openingMedia.state };
  });
  expect(intermediate.card).toBe('running'); expect(intermediate.media).toBe('running');
  expect(intermediate.boxes[0]!.width).toBeGreaterThan(120);
  expect(intermediate.boxes[0]!.width).toBeLessThan(360);
  expect(intermediate.boxes[1]!.width).toBeGreaterThan(48);
  expect(intermediate.boxes[1]!.width).toBeLessThan(200);
  await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    state.before = state.boxes();
    state.retarget = state.area.animate(state.card, { left: 20, top: 50, width: 420, height: 360 });
    state.retargetMedia = state.area.animate(state.media, { left: 44, top: 80, width: 260, height: 160 });
    state.boundary = state.boxes();
  });
  await page.clock.runFor(32);
  const geometry = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    return { before: state.before, boundary: state.boundary, moving: state.boxes() };
  });
  for (let i = 0; i < 2; i++) {
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(geometry.boundary[i]![key] - geometry.before[i]![key])).toBeLessThanOrEqual(0.25);
    expect(geometry.moving[i]).not.toEqual(geometry.boundary[i]);
  }
  const action = page.locator('#action');
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point)).toBe('action');
  await page.mouse.click(point.x, point.y);
  await action.focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as RootCardWindow).__rootCard.activations())).toBe(2);
  await page.locator('#title').focus();
  await page.locator('#title').evaluate(node => (node as HTMLInputElement).setSelectionRange(6, 10));
  const preserved = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    state.closing = state.area.animate(state.card, { left: 0, top: 50, width: 120, height: 80 });
    const input = document.querySelector<HTMLInputElement>('#title')!;
    return { same: input === state.input, focused: document.activeElement === input,
      start: input.selectionStart, end: input.selectionEnd };
  });
  expect(preserved).toEqual({ same: true, focused: true, start: 6, end: 10 });
  // Исходный finished доставляет clock, а не ручная terminal-команда playback.
  const completionBudget = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    return Math.ceil(Math.max(state.closing!.duration, state.retargetMedia.duration)) + 64;
  });
  await page.clock.runFor(completionBudget);
  expect(await page.evaluate(() => (window as unknown as RootCardWindow).__rootCard.closing!.state)).toBe('finished');
  expect(await page.evaluate(() => (window as unknown as RootCardWindow).__rootCard.retargetMedia.state)).toBe('finished');
  const reopenBudget = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    state.reopened = state.area.animate(state.card, { left: 20, top: 50, width: 420, height: 360 });
    return Math.ceil(state.reopened.duration) + 64;
  });
  await page.clock.runFor(reopenBudget);
  expect(await page.evaluate(() => (window as unknown as RootCardWindow).__rootCard.reopened!.state)).toBe('finished');
  const settled = await page.evaluate(async () => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    const rootBox = state.root.getBoundingClientRect();
    const final = state.boxes().map((rect: { x: number; y: number; width: number; height: number }) =>
      ({ ...rect, x: rect.x - rootBox.x, y: rect.y - rootBox.y }));
    return { stopped: await state.retarget.finished, final, opening: await state.opening.finished,
      openingMedia: await state.openingMedia.finished, closing: await state.closing!.finished,
      reopened: await state.reopened!.finished, media: await state.retargetMedia.finished };
  });
  expect(settled.opening).toEqual({ status: 'stopped' });
  expect(settled.openingMedia).toEqual({ status: 'stopped' });
  expect(settled.stopped).toEqual({ status: 'stopped' });
  expect(settled.closing).toEqual({ status: 'finished' });
  expect(settled.reopened).toEqual({ status: 'finished' });
  expect(settled.media).toEqual({ status: 'finished' });
  expect(settled.final).toEqual([
    { x: 20, y: 50, width: 420, height: 360 },
    { x: 64, y: 130, width: 260, height: 160 },
  ]);
  await page.keyboard.insertText('世界');
  expect(await page.locator('#title').inputValue()).toBe('alpha 世界');
  const cleanup = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    const quiet = state.area.animate(state.card, { left: 80, top: 90, width: 300, height: 220 },
      { reducedMotion: 'always' });
    const quietState = quiet.state;
    const quietBox = state.card.getBoundingClientRect();
    const still = state.area.animate(state.card, { left: 80, top: 90, width: 300, height: 220 }, { duration: 0 });
    const stillState = still.state;
    state.active = state.area.animate(state.card, { left: 0, width: 120 });
    return { quietState, stillState, quietWidth: quietBox.width, quietHeight: quietBox.height };
  });
  await page.clock.runFor(32);
  const disposed = await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    const running = state.active!.state;
    const width = state.card.getBoundingClientRect().width;
    state.area.dispose(); state.area.dispose();
    document.querySelector<HTMLButtonElement>('#action')!.click();
    return { running, width, state: state.active!.state,
      style: state.card.getAttribute('style'), activations: state.activations(),
      effects: state.root.getAnimations({ subtree: true }).length };
  });
  expect(cleanup).toEqual({ quietState: 'finished', stillState: 'finished', quietWidth: 300, quietHeight: 220 });
  expect(disposed).toMatchObject({ running: 'running', state: 'stopped', activations: 2, effects: 0 });
  expect(disposed.width).toBeGreaterThan(120); expect(disposed.width).toBeLessThan(300);
  // Управляемый tick проверяет именно позднюю доставку после terminal boundary.
  await page.clock.runFor(64);
  expect(await page.evaluate(() => {
    const state = (window as unknown as RootCardWindow).__rootCard;
    return { style: state.card.getAttribute('style'), activations: state.activations(),
      transform: state.card.style.transform, sameInput: document.querySelector('#title') === state.input };
  })).toEqual({ style: disposed.style, activations: 2, transform: '', sameInput: true });
});
