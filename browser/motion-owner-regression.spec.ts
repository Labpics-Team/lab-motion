import { expect, test } from './fixtures/harness';

test('три переназначения opacity сохраняют одного владельца и непрерывную позу', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const element = document.createElement('div'); element.style.cssText = 'width:30px;height:30px;opacity:0'; document.body.append(element);
    const options = { duration: 1000, ease: 'linear' as const }, runs: ReturnType<typeof animate>[] = [];
    const effect = (): Animation => {
      const current = element.getAnimations();
      if (current.length !== 1) throw new Error(`Ожидается один native-эффект, получено ${current.length}`);
      return current[0]!;
    };
    try {
      const first = animate(element, { opacity: [0, 1] }, options); runs.push(first);
      const a = effect(); a.pause(); a.currentTime = 200;
      const second = animate(element, { opacity: .8 }, options); runs.push(second);
      const b = effect(); b.pause(); b.currentTime = 250;
      const before = Number(getComputedStyle(element).opacity);
      const third = animate(element, { opacity: .1 }, options); runs.push(third);
      const c = effect(); c.pause(); c.currentTime = 0;
      const after = Number(getComputedStyle(element).opacity);
      if (second.state !== 'stopped') throw new Error('Предыдущий владелец не отозван');
      first.finish(); second.stop();
      const runningEffects = element.getAnimations().length, active = third.state;
      c.play(); await third.finished;
      return { before, after, runningEffects, active, outcomes: await Promise.all(runs.map(run => run.finished)),
        final: Number(getComputedStyle(element).opacity), remaining: element.getAnimations().length };
    } finally { for (const run of runs) run.stop(); element.remove(); }
  });
  expect(result.before).toBeCloseTo(.35, 4); expect(result.after).toBeCloseTo(result.before, 4);
  expect(result.runningEffects).toBe(1); expect(result.active).toBe('running');
  expect(result.outcomes).toEqual([{ status: 'stopped' }, { status: 'stopped' }, { status: 'finished' }]);
  expect(result.final).toBeCloseTo(.1, 5); expect(result.remaining).toBe(0);
});
test('область снимает DOM-listener с однажды прочитанным capture', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scope } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('section'), button = document.createElement('button'); root.append(button); document.body.append(root);
    const area = scope(root); let reads = 0, calls = 0;
    try {
      const off = area.on(button, 'click', () => { calls++; }, { get capture() { return ++reads === 1; } });
      button.click(); const before = calls; off(); button.click(); area.dispose(); button.click();
      return { reads, before, after: calls, disposed: area.disposed };
    } finally { area.dispose(); root.remove(); }
  });
  expect(result).toEqual({ reads: 1, before: 1, after: 1, disposed: true });
});


test('пример подключения из документации запускается и освобождает компонент', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { mountMotion } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('section');
    root.innerHTML = '<button data-replay>Повтор</button><div class="item"></div><div class="item"></div>';
    document.body.append(root);
    const dispose = mountMotion(root);
    const initial = root.getAnimations({ subtree: true }).length;
    const button = root.querySelector('button')!;
    button.click(); dispose(); await Promise.resolve(); button.click();
    const remaining = root.getAnimations({ subtree: true }).length;
    root.remove(); return { initial, remaining };
  });
  expect(result.initial).toBeGreaterThan(0); expect(result.remaining).toBe(0);
});
