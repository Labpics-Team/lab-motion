import { expect, test } from './fixtures/harness';
import { tryCompileSurfaceArtifact } from '../src/future-layout/artifact.js';

/**
 * Независимая граница: реальные браузеры исполняют Q/A одинаково до и после
 * удаления тождественных узлов. Численный oracle отдельно защищает subdivision.
 */
for (const [name, damping] of [['обычная', 26], ['колебательная', 9]] as const) {
  for (const [from, to] of [[240, 360], [360, 240]] as const) {
    test(`${name} ${from}→${to}: материализация сохраняет native Q/A`, async ({ page }) => {
      const artifact = tryCompileSurfaceArtifact({ mass: 1, stiffness: 170, damping }, from, to)!;
      expect(artifact).toBeDefined();
      const curves = [artifact.reciprocalEasing, artifact.blendEasing].map((css) => {
        const stops = css.slice(7, -1).split(',').map((part) => part.trim());
        const duplicate = stops.flatMap((stop, i) =>
          i > 0 && i < stops.length - 1 ? [stop, stop] : [stop]);
        const positions = stops.map((stop) => Number(stop.split(' ')[1]!.slice(0, -1)));
        const middle = Math.floor(stops.length / 2);
        const changed = [...stops];
        const [value, position] = changed[middle]!.split(' ');
        changed[middle] = `${Number(value) + 0.25} ${position}`;
        return { css, duplicate: `linear(${duplicate.join(', ')})`,
          changed: `linear(${changed.join(', ')})`, positions, witness: positions[middle]! };
      });
      const results = await page.evaluate((curves) => curves.map((curve) => {
        const elements: HTMLElement[] = [];
        const animations: Animation[] = [];
        try {
          for (const easing of [curve.css, curve.duplicate, curve.changed]) {
            const element = document.createElement('div');
            element.style.cssText = 'width:10px;height:10px';
            document.body.appendChild(element);
            elements.push(element);
            const animation = element.animate(
              [{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }],
              { duration: 1000, easing, fill: 'both' },
            );
            animation.pause();
            animations.push(animation);
          }
          const times = [...curve.positions];
          for (let i = 1; i < curve.positions.length; i++) {
            times.push((curve.positions[i - 1]! + curve.positions[i]!) / 2);
          }
          let mismatches = 0;
          for (const percent of times) {
            for (const animation of animations) animation.currentTime = percent * 10;
            if (getComputedStyle(elements[0]!).transform !== getComputedStyle(elements[1]!).transform) mismatches++;
          }
          for (const animation of animations) animation.currentTime = curve.witness * 10;
          const controlDetected = getComputedStyle(elements[0]!).transform !== getComputedStyle(elements[2]!).transform;
          return { comparisons: times.length, mismatches, controlDetected };
        } finally {
          for (const animation of animations) animation.cancel();
          for (const element of elements) element.remove();
        }
      }), curves);
      for (const result of results) {
        expect(result.comparisons).toBeGreaterThan(20);
        expect(result.mismatches).toBe(0);
        expect(result.controlDetected).toBe(true);
      }
    });
  }
}
