import { expect, test } from './fixtures/harness';

for (const reduced of [false, true]) test(`совместные импорты: тот же проект и очистка (reduce=${reduced})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.evaluate(async () => {
    const sources = ['/browser/.artifacts/compiler-project-runtime.js', '/browser/.artifacts/compiler-project-compiled.js'];
    const initialStyles = document.querySelectorAll('style').length;
    for (let i = 0; i < sources.length; i++) {
      const panel = document.createElement('div'), label = document.createElement('span');
      panel.id = `compiler-project-panel-${i}`; label.id = `compiler-project-label-${i}`;
      panel.style.cssText = 'width:240px;height:30px;background:#3366ee'; label.style.opacity = '0';
      label.textContent = 'Готово'; document.body.append(panel, label);
      const { reveal } = await import(sources[i]!);
      reveal(panel, label);
      // Последовательные VT одного документа могут отменять друг друга.
      // Ждём завершение каждой поверхности по её наблюдаемому DOM.
      const end = performance.now() + 5000;
      while (getComputedStyle(panel).width !== '360px' || Number(getComputedStyle(label).opacity) !== 1 ||
        document.querySelectorAll('style').length !== initialStyles) {
        if (performance.now() > end) throw new Error('Переход не завершился');
        await new Promise(requestAnimationFrame);
      }
    }
  });
  const result = await page.evaluate(() => [0, 1].map(i => {
    const panel = document.getElementById(`compiler-project-panel-${i}`)!;
    const label = document.getElementById(`compiler-project-label-${i}`)!;
    const state = { width: getComputedStyle(panel).width, opacity: getComputedStyle(label).opacity,
      text: label.textContent, viewName: (panel as HTMLElement).style.viewTransitionName };
    for (const effect of [...panel.getAnimations(), ...label.getAnimations()]) effect.cancel();
    panel.remove(); label.remove(); return state;
  }));
  expect(result[0]).toEqual({ width: '360px', opacity: '1', text: 'Готово', viewName: '' });
  expect(result[1]).toEqual(result[0]);
});

test('промежуточные позиции списка и opacity совпадают после реальной сборки', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const urls = ['/browser/.artifacts/compiler-project-runtime.js', '/browser/.artifacts/compiler-project-compiled.js'];
    const rows: Array<Array<{ width: number[]; opacity: number }>> = [];
    const original = window.requestAnimationFrame;
    let queue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = callback => { queue.push(callback); return queue.length; };
    const tick = (time: number) => { const jobs = queue; queue = []; for (const job of jobs) job(time); };
    try {
      for (const url of urls) {
        const panels = Array.from({ length: 4 }, () => {
          const panel = document.createElement('div'); panel.style.cssText = 'width:240px;height:20px';
          document.body.append(panel); return panel;
        });
        const label = document.createElement('span'); label.style.opacity = '0'; document.body.append(label);
        const elements = [...panels, label];
        const { reveal } = await import(url); reveal(panels, label);
        const effects = elements.flatMap(element => element.getAnimations());
        if (effects.length === 0) throw new Error('Прозрачность должна иметь native-исполнитель');
        for (const effect of effects) { effect.pause(); effect.currentTime = 0; }
        // Runtime width использует JS-кадры; compiled width — native currentTime.
        // Оба получают одни и те же миллисекунды, независимо от способа исполнения.
        tick(0);
        const samples = [];
        for (const time of [0, 50, 200, 500, 800, 1500]) {
          tick(time);
          for (const effect of effects) effect.currentTime = time;
          samples.push({ width: panels.map(panel => Number.parseFloat(getComputedStyle(panel).width)),
            opacity: Number(getComputedStyle(label).opacity) });
        }
        rows.push(samples);
        for (let i = 0; queue.length > 0 && i < 10; i++) tick(3000 + i * 2000);
        if (queue.length) throw new Error('Runtime не освободил кадры после достижения цели');
        for (const effect of effects) effect.cancel();
        for (const element of elements) element.remove();
      }
    } finally { window.requestAnimationFrame = original; }
    return rows;
  });
  expect(result[0]).toHaveLength(6); expect(result[1]).toHaveLength(6);
  expect(result[0]![2]!.width[0]).toBeGreaterThan(240);
  expect(result[0]![2]!.width[0]).toBeLessThan(360);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) expect(Math.abs(result[0]![i]!.width[j]! - result[1]![i]!.width[j]!)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(result[0]![i]!.opacity - result[1]![i]!.opacity)).toBeLessThanOrEqual(0.001);
  }
});
