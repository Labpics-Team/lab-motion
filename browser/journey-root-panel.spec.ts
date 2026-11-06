import { expect, packedJourneyTest as test } from './fixtures/harness';
import type { MotionScope, MotionValue, Playback } from '../src/motion/index.js';

type Box = { x: number; y: number; width: number; height: number };
interface PanelState {
  area: MotionScope;
  surfaceArea: MotionScope;
  root: HTMLElement;
  surface: HTMLElement;
  previous: HTMLElement[];
  channels: MotionValue[];
  opening: Playback[];
  closing: Playback[];
  reopened: Playback[];
  active: Playback[];
  box(): Box;
  replace(kind: 'source' | 'panel'): void;
  move(target: readonly number[]): Playback[];
  activations(): number;
  writes(): number;
}
type PanelWindow = Window & { __rootPanel: PanelState };

// Сохраняем отдельный /smart consumer: здесь тот же исход с пересозданием DOM
// исполняется root values, чья скорость и право записи не зависят от узла.
test('root panel↔source: пересоздание, обратный ход, повторное открытие и отзыв владельца', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.evaluate(async () => {
    const { scope } = await import('/browser/.artifacts/motion-root.js');
    document.body.innerHTML = `
      <button id="focus">Фокус</button>
      <div id="root" style="position:relative;width:720px;height:640px">
        <button id="surface" style="position:absolute;left:300px;top:20px;width:80px;height:40px">Открыть</button>
      </div>`;
    const root = document.querySelector<HTMLElement>('#root')!;
    const area = scope(root);
    const channels = [300, 20, 80, 40].map(initial => area.value(initial));
    let activations = 0, writes = 0;
    const state: PanelState = {
      area, root, channels, surface: document.querySelector<HTMLElement>('#surface')!,
      surfaceArea: area.scope(root), previous: [], opening: [], closing: [], reopened: [], active: [],
      box() {
        const box = state.surface.getBoundingClientRect(), origin = root.getBoundingClientRect();
        return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height };
      },
      replace(kind) {
        state.surfaceArea.dispose();
        state.previous.push(state.surface);
        const node = document.createElement(kind === 'panel' ? 'section' : 'button');
        node.id = 'surface';
        node.style.position = 'absolute';
        if (kind === 'panel') node.innerHTML = '<button id="action">Действие</button>';
        else node.textContent = 'Открыть снова';
        root.replaceChildren(node);
        state.surface = node;
        state.surfaceArea = area.scope(node);
        state.surfaceArea.on(kind === 'panel' ? node.querySelector('button')! : node,
          'click', () => { activations++; });
        paint();
      },
      move(target) {
        return channels.map((value, index) => value.animate(target[index]!,
          { spring: { mass: 1, stiffness: 170, damping: 26 } }));
      },
      activations: () => activations,
      writes: () => writes,
    };
    function paint(): void {
      const [x, y, width, height] = channels.map(value => value.get());
      Object.assign(state.surface.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
      writes++;
    }
    for (const value of channels) value.subscribe(paint);
    document.querySelector<HTMLButtonElement>('#focus')!.focus();
    state.replace('panel');
    state.opening = state.move([40, 60, 420, 300]);
    (window as unknown as PanelWindow).__rootPanel = state;
  });
  await page.clock.runFor(64);
  const intermediate = await page.evaluate(() => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    return { box: state.box(), states: state.opening.map(run => run.state),
      focused: document.activeElement?.id };
  });
  expect(intermediate.states).toEqual(['running', 'running', 'running', 'running']);
  expect(intermediate.box.x).toBeGreaterThan(40); expect(intermediate.box.x).toBeLessThan(300);
  expect(intermediate.box.y).toBeGreaterThan(20); expect(intermediate.box.y).toBeLessThan(60);
  expect(intermediate.box.width).toBeGreaterThan(80); expect(intermediate.box.width).toBeLessThan(420);
  expect(intermediate.box.height).toBeGreaterThan(40); expect(intermediate.box.height).toBeLessThan(300);
  expect(intermediate.focused).toBe('focus');

  const action = page.locator('#action');
  const point = await action.boundingBox();
  expect(point).not.toBeNull();
  const center = { x: point!.x + point!.width / 2, y: point!.y + point!.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, center)).toBe('action');
  await page.mouse.click(center.x, center.y);
  await action.focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as PanelWindow).__rootPanel.activations())).toBe(2);
  await page.locator('#focus').focus();
  const boundary = await page.evaluate(() => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    const before = state.box();
    state.replace('source');
    state.closing = state.move([300, 20, 80, 40]);
    const after = state.box();
    state.previous.at(-1)!.querySelector<HTMLButtonElement>('button')!.click();
    return { before, after, activations: state.activations(), focused: document.activeElement?.id };
  });
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(boundary.after[key] - boundary.before[key])).toBeLessThanOrEqual(0.25);
  expect(boundary.activations).toBe(2); expect(boundary.focused).toBe('focus');
  await page.clock.runFor(16);
  const reversal = await page.evaluate(async () => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    return { box: state.box(), states: state.closing.map(run => run.state),
      old: await Promise.all(state.opening.map(run => run.finished)) };
  });
  expect(reversal.states).toEqual(['running', 'running', 'running', 'running']);
  // Скорость расширения должна пережить обратную цель, а не обнулиться при новом DOM.
  expect(reversal.box.width).toBeGreaterThan(boundary.after.width);
  expect(reversal.old).toEqual(Array.from({ length: 4 }, () => ({ status: 'stopped' })));
  await page.locator('#surface').focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as PanelWindow).__rootPanel.activations())).toBe(3);
  const closeBudget = await page.evaluate(() => Math.ceil(Math.max(...
    (window as unknown as PanelWindow).__rootPanel.closing.map(run => run.duration))) + 64);
  await page.clock.runFor(closeBudget);
  const closed = await page.evaluate(async () => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    return { box: state.box(), results: await Promise.all(state.closing.map(run => run.finished)),
      states: state.closing.map(run => run.state), focused: document.activeElement?.id };
  });
  expect(closed.box).toEqual({ x: 300, y: 20, width: 80, height: 40 });
  expect(closed.results).toEqual(Array.from({ length: 4 }, () => ({ status: 'finished' })));
  expect(closed.states).toEqual(['finished', 'finished', 'finished', 'finished']);
  expect(closed.focused).toBe('surface');
  await page.locator('#focus').focus();
  const reopenBudget = await page.evaluate(() => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    state.replace('panel');
    state.reopened = state.move([60, 70, 400, 280]);
    return Math.ceil(Math.max(...state.reopened.map(run => run.duration))) + 64;
  });
  await page.clock.runFor(reopenBudget);
  const reopened = await page.evaluate(async () => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    return { box: state.box(), results: await Promise.all(state.reopened.map(run => run.finished)),
      focused: document.activeElement?.id, detached: state.previous.every(node => !node.isConnected),
      transforms: [state.surface, ...state.previous].map(node => node.style.transform) };
  });
  expect(reopened.box).toEqual({ x: 60, y: 70, width: 400, height: 280 });
  expect(reopened.results).toEqual(Array.from({ length: 4 }, () => ({ status: 'finished' })));
  expect(reopened.focused).toBe('focus'); expect(reopened.detached).toBe(true);
  expect(reopened.transforms).toEqual(['', '', '', '']);

  await page.evaluate(() => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    state.active = state.move([300, 20, 80, 40]);
  });
  await page.clock.runFor(32);
  const disposed = await page.evaluate(() => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    const running = state.active.map(run => run.state), box = state.box();
    state.area.dispose(); state.area.dispose();
    state.surface.querySelector<HTMLButtonElement>('button')!.click();
    for (const node of state.previous) (node.querySelector<HTMLButtonElement>('button') ?? node).click();
    return { running, box, style: state.surface.getAttribute('style'), writes: state.writes(),
      activations: state.activations(), states: state.active.map(run => run.state),
      effects: state.root.getAnimations({ subtree: true }).length };
  });
  expect(disposed.running).toEqual(['running', 'running', 'running', 'running']);
  expect(disposed.box.width).toBeGreaterThan(80); expect(disposed.box.width).toBeLessThan(400);
  expect(disposed.states).toEqual(['stopped', 'stopped', 'stopped', 'stopped']);
  expect(disposed.activations).toBe(3); expect(disposed.effects).toBe(0);
  await page.clock.runFor(64);
  expect(await page.evaluate(async () => {
    const state = (window as unknown as PanelWindow).__rootPanel;
    return { style: state.surface.getAttribute('style'), writes: state.writes(), activations: state.activations(),
      results: await Promise.all(state.active.map(run => run.finished)) };
  })).toEqual({ style: disposed.style, writes: disposed.writes, activations: 3,
    results: Array.from({ length: 4 }, () => ({ status: 'stopped' })) });
});
