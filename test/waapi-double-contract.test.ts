/**
 * waapi-double-contract.test.ts — контракт разделяемого двойника WAAPI.
 *
 * ЗАЧЕМ. Двойник имеет право существовать только пока он ВЕРЕН движку. Иначе
 * повторяется история #240: тесты зелёные, потому что двойник не умеет того,
 * на чём ломается продукт. Здесь пинится наблюдаемый контракт двойника, а те же
 * самые утверждения проверяются на НАСТОЯЩИХ Chromium/Firefox/WebKit в
 * browser/18-waapi-double-fidelity.spec.ts — расхождение любого из четырёх
 * пунктов роняет либо этот файл, либо браузерную матрицу.
 *
 * Mutation proof: сделать cancel() переводом в 'finished' → «cancel → idle» RED;
 * убрать рассылку 'finish' → «событие finish доходит до слушателя» RED.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createWaapiDouble, installDomShims } from './support/waapi-double.js';

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe('двойник WAAPI: машина состояний', () => {
  it('cancel() переводит в idle и обнуляет currentTime (а НЕ в finished)', () => {
    const dom = createWaapiDouble();
    const animation = dom.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    expect(animation.playState).toBe('running');

    animation.cancel();
    // Ровно это свойство сделало отменённый прогон неотличимым от никогда не
    // стартовавшего и убило реестр прогонов в #240.
    expect(animation.playState).toBe('idle');
    expect(animation.currentTime).toBe(null);
    expect(dom.cancels).toEqual([0]);
  });

  it('естественное завершение переводит в finished и доставляет событие finish', () => {
    const dom = createWaapiDouble();
    const animation = dom.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    let finishes = 0;
    animation.addEventListener('finish', () => { finishes++; });

    dom.advance(299);
    expect(animation.playState).toBe('running');
    expect(finishes).toBe(0);

    dom.advance(1);
    expect(animation.playState).toBe('finished');
    expect(finishes).toBe(1);
    expect(animation.currentTime).toBe(300);
  });

  it('delay учитывается в моменте завершения', () => {
    const dom = createWaapiDouble();
    const animation = dom.el.animate([{ opacity: 1 }], { duration: 100, delay: 50 });
    dom.advance(149);
    expect(animation.playState).toBe('running');
    dom.advance(1);
    expect(animation.playState).toBe('finished');
  });

  it('finished резолвится при завершении и отклоняется AbortError при отмене', async () => {
    const dom = createWaapiDouble();
    const done = dom.el.animate([{ opacity: 1 }], { duration: 10 });
    dom.advance(10);
    await expect(done.finished).resolves.toBe(done);

    const aborted = dom.el.animate([{ opacity: 1 }], { duration: 10 });
    aborted.cancel();
    await expect(aborted.finished).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancel() после завершения не рассылает повторных событий', () => {
    const dom = createWaapiDouble();
    const animation = dom.el.animate([{ opacity: 1 }], { duration: 10 });
    dom.advance(10);
    animation.cancel();
    expect(animation.playState).toBe('idle');
    // Отмена завершённой анимации — законная операция; журнал фиксирует её один раз.
    expect(dom.cancels).toEqual([0]);
    animation.cancel();
    expect(dom.cancels).toEqual([0]);
  });
});

describe('двойник WAAPI: стиль и журнал', () => {
  it('commitStyles() пишет последний кадр в element.style и журналируется', () => {
    const dom = createWaapiDouble({ opacity: '0' });
    const animation = dom.el.animate(
      [{ opacity: 0 }, { opacity: 0.5 }, { opacity: 1 }],
      { duration: 100 },
    );
    animation.commitStyles();
    expect(dom.el.style['opacity']).toBe('1');
    expect(dom.commits).toHaveLength(1);
    expect(dom.commits[0]!['opacity']).toBe('1');
  });

  it('служебные поля кадра не попадают в стиль', () => {
    const dom = createWaapiDouble();
    dom.el.animate([{ opacity: 1, offset: 1, easing: 'linear' }], { duration: 10 })
      .commitStyles();
    expect(dom.el.style['opacity']).toBe('1');
    expect(dom.el.style['offset']).toBeUndefined();
    expect(dom.el.style['easing']).toBeUndefined();
  });

  it('журнал вызовов хранит кадры и тайминг в порядке поступления', () => {
    const dom = createWaapiDouble();
    dom.el.animate([{ opacity: 1 }], { duration: 100 });
    dom.el.animate([{ transform: 'translateX(10px)' }], { duration: 200, delay: 5 });
    expect(dom.calls).toHaveLength(2);
    expect(dom.calls[0]!.timing['duration']).toBe(100);
    expect(dom.calls[1]!.keyframes[0]!['transform']).toBe('translateX(10px)');
    expect(dom.calls[1]!.timing['delay']).toBe(5);
  });

  it('getAnimations() отдаёт только живые прогоны', () => {
    const dom = createWaapiDouble();
    const first = dom.el.animate([{ opacity: 1 }], { duration: 10 });
    dom.el.animate([{ opacity: 0 }], { duration: 1000 });
    expect(dom.el.getAnimations()).toHaveLength(2);
    first.cancel();
    expect(dom.el.getAnimations()).toHaveLength(1);
    dom.advance(1000);
    expect(dom.el.getAnimations()).toHaveLength(0);
  });
});

describe('швы окружения: без них ветка живого стиля не исполняется', () => {
  it('installDomShims даёт getComputedStyle, читающий стиль элемента', () => {
    expect(typeof (globalThis as { getComputedStyle?: unknown }).getComputedStyle)
      .toBe('undefined');
    const dom = createWaapiDouble({ opacity: '0.25' });
    uninstall = installDomShims({ computed: { transform: 'none' } });

    const computed = (globalThis as unknown as {
      getComputedStyle(el: unknown): { getPropertyValue(name: string): string };
    }).getComputedStyle(dom.el);
    expect(computed.getPropertyValue('opacity')).toBe('0.25');
    expect(computed.getPropertyValue('transform')).toBe('none');
  });

  it('matchMedia отвечает по политике reduced-motion и снимается начисто', () => {
    uninstall = installDomShims({ reducedMotion: true });
    const mm = (globalThis as unknown as {
      matchMedia(q: string): { matches: boolean };
    }).matchMedia;
    expect(mm('(prefers-reduced-motion: reduce)').matches).toBe(true);
    expect(mm('(min-width: 100px)').matches).toBe(false);
    uninstall();
    uninstall = undefined;
    expect(typeof (globalThis as { matchMedia?: unknown }).matchMedia).toBe('undefined');
  });
});
