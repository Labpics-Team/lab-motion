import { expect, test } from './fixtures/harness';

test('grid: приложение подтверждает keyboard reorder и отзывает pointer proposal после фильтра', async ({ page }) => {
  await page.evaluate(async () => {
    const { createReorder } = await import('/browser/.artifacts/scope-recipes.js');
    document.body.innerHTML = '<div id="grid" style="position:relative;width:120px;height:120px;direction:rtl"></div>';
    const root = document.querySelector<HTMLElement>('#grid')!;
    let keys = ['a', 'b', 'c', 'd'];
    let accept = true;
    let pending: { keys: string[]; proposal: any } | undefined;
    let session: ReturnType<ReturnType<typeof createReorder<string>>['start']> | undefined;
    const paint = () => {
      for (const node of root.querySelectorAll<HTMLElement>('button')) {
        if (!keys.includes(node.dataset.key!)) node.remove();
      }
      keys.forEach((key, i) => {
        let button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.dataset.key === key);
        if (!button) {
          button = document.createElement('button');
          button.textContent = key;
          button.dataset.key = key;
          root.append(button);
        }
        button.style.cssText = `position:absolute;left:${i % 2 * 60}px;top:${Math.floor(i / 2) * 60}px;width:40px;height:40px`;
      });
    };
    const measure = () => keys.map(key => {
      const node = [...root.querySelectorAll<HTMLElement>('button')].find(item => item.dataset.key === key)!;
      const rect = node.getBoundingClientRect();
      return { key, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    });
    paint();
    const resolver = createReorder<string>({ items: measure(), axis: 'both', direction: 'rtl', onReorder(next, proposal) {
      pending = { keys: [...next], proposal };
      if (accept && resolver.isCurrent(proposal)) {
        keys = [...next]; paint(); resolver.update(measure());
      }
    } });
    root.addEventListener('keydown', event => {
      if (!(event.target instanceof HTMLElement) || event.key !== 'ArrowDown') return;
      event.preventDefault();
      session = resolver.start(event.target.dataset.key!)!;
      session?.step('down');
      session?.end();
    });
    root.addEventListener('pointerdown', event => {
      if (!(event.target instanceof HTMLElement)) return;
      session = resolver.start(event.target.dataset.key!)!;
    });
    root.addEventListener('pointermove', event => session?.move({ x: event.clientX, y: event.clientY }));
    root.addEventListener('pointerup', () => { session?.end(); session = undefined; });
    (window as any).grid = {
      read: () => ({ keys: [...keys], pending: pending?.keys, current: pending && resolver.isCurrent(pending.proposal),
        activeKey: resolver.activeKey, active: session?.active ?? false }),
      hold: () => { accept = false; pending = undefined; },
      filter: () => { keys = ['b', 'c', 'd', 'e']; paint(); resolver.update(measure()); },
      commitPending: () => {
        if (pending && resolver.isCurrent(pending.proposal)) { keys = pending.keys; paint(); resolver.update(measure()); }
      },
      destroy: () => resolver.destroy(),
    };
  });

  await page.getByRole('button', { name: 'a' }).focus();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => (window as any).grid.read().keys)).toEqual(['b', 'c', 'a', 'd']);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe('a');
  await page.evaluate(() => (window as any).grid.hold());
  const from = await page.getByRole('button', { name: 'a' }).boundingBox();
  const to = await page.getByRole('button', { name: 'd' }).boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  await page.mouse.move(from!.x + 20, from!.y + 20);
  await page.mouse.down();
  await page.mouse.move(to!.x + 20, to!.y + 20);
  expect(await page.evaluate(() => (window as any).grid.read())).toMatchObject({
    keys: ['b', 'c', 'a', 'd'], pending: ['b', 'c', 'd', 'a'], current: true, active: true,
  });
  await page.evaluate(() => (window as any).grid.filter());
  await page.mouse.up();
  await page.evaluate(() => (window as any).grid.commitPending());
  expect(await page.evaluate(() => (window as any).grid.read())).toMatchObject({
    keys: ['b', 'c', 'd', 'e'], current: false, active: false,
  });
  const remaining = await page.getByRole('button', { name: 'b' }).boundingBox();
  expect(remaining).not.toBeNull();
  await page.mouse.move(remaining!.x + 20, remaining!.y + 20);
  await page.mouse.down();
  expect(await page.evaluate(() => (window as any).grid.read().activeKey)).toBe('b');
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).grid.read().activeKey)).toBeUndefined();
  await page.evaluate(() => (window as any).grid.destroy());
});
