/**
 * test/future-layout-coordinator.test.ts — RED: document-scoped coordinator.
 *
 * Спека: «DOCUMENT-SCOPED COORDINATOR», «VIEW TRANSITION HOST»; RED-Фаза
 * п.14 (stale finish старой generation очищает новую), п.15 (stale commit
 * старой generation публикует состояние), п.16 (View Transition skip
 * оставляет owner занятым), п.17 (duplicate transition names оставляют
 * partial styles), п.18 (UA default group width animation остаётся активной).
 *
 * RED PROOF: src/future-layout/index.ts — заглушка `export {}`; каждый тест
 * падает СВОИМ ассертом через pick-хелпер (канон animate-facade-helpers).
 */

import { describe, expect, it } from 'vitest';
import * as surface from '../src/future-layout/index.js';
import { pickCreateSurfaceCoordinator } from './future-layout-helpers.js';

const mod = surface as unknown as Record<string, unknown>;
const createSurfaceCoordinator = pickCreateSurfaceCoordinator(mod);

describe('DocumentSurfaceCoordinator: одна active generation на document', () => {
  it('RED п.15: stale commit старой generation НЕ публикует состояние после supersede', () => {
    const coord = createSurfaceCoordinator();
    const gen1 = coord.begin({ target: 'viewport', fromWidth: 240, toWidth: 360 });
    const gen2 = coord.begin({ target: 'viewport', fromWidth: 360, toWidth: 480 });

    gen1.commit(); // stale: generation уже supersede-нута
    expect(gen1.published).toBe(false);
    expect(coord.activeGeneration).toBe(gen2.generation);
  });

  it('RED п.14: stale finish старой generation НЕ очищает новую', () => {
    const coord = createSurfaceCoordinator();
    const gen1 = coord.begin({ target: 'viewport', fromWidth: 240, toWidth: 360 });
    const gen2 = coord.begin({ target: 'viewport', fromWidth: 360, toWidth: 480 });

    gen1.finish(); // stale finish
    expect(coord.activeGeneration).toBe(gen2.generation);
    // Новая generation жива: её commit публикует состояние.
    gen2.commit();
    expect(gen2.published).toBe(true);
  });

  it('RED п.16: View Transition skip освобождает coordinator (owner не занят)', () => {
    const coord = createSurfaceCoordinator();
    const gen = coord.begin({ target: 'viewport', fromWidth: 240, toWidth: 360 });
    // host.skip() — UA отказал/unsupported: terminal authority снимает owner.
    gen.finish();
    const next = coord.begin({ target: 'viewport', fromWidth: 360, toWidth: 480 });
    expect(next.generation).toBeGreaterThan(gen.generation);
    expect(coord.activeGeneration).toBe(next.generation);
  });
});

describe('View Transition host: unique names + отключённые UA-анимации', () => {
  it('RED п.17: параллельные generations получают уникальные view-transition-name', () => {
    const coord = createSurfaceCoordinator();
    const gen1 = coord.begin({ target: 'viewport', fromWidth: 240, toWidth: 360 });
    const gen2 = coord.begin({ target: 'a', fromWidth: 1, toWidth: 2 });
    const nameOf = (g: unknown) => (g as { viewTransitionName?: string }).viewTransitionName;
    expect(typeof nameOf(gen1)).toBe('string');
    expect(nameOf(gen1)).not.toBe(nameOf(gen2));
  });

  it('RED п.18: UA-анимации group/image-pair/old/new полностью отключены', () => {
    const coord = createSurfaceCoordinator();
    const gen = coord.begin({ target: 'viewport', fromWidth: 240, toWidth: 360 });
    const css = (gen as { generatedCss?: string }).generatedCss ?? '';
    for (const pseudo of ['::view-transition-group', '::view-transition-image-pair', '::view-transition-old', '::view-transition-new']) {
      expect(css).toContain(pseudo);
    }
    expect(css).toMatch(/animation:\s*none/);
  });
});
