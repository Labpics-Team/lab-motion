import { describe, expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { MotionProperties, Playback } from '../src/motion/types.js';

const linear = { duration: 1000, ease: 'linear' } as const;

describe('владелец CSS-свойства при повторном прерывании', () => {
  for (const key of ['opacity', 'width', '--offset']) for (const native of [false, true]) {
    it(`${key}, native=${native}: три цели имеют одного исполнителя`, async () => {
      const h = harness(native), scale = key === 'opacity' ? 1 : 100;
      const nativeEffect = native && key === 'opacity', runs: Playback[] = [];
      try {
        const first = h.runtime.animate(h.element, { [key]: [0, scale] }, linear); runs.push(first);
        if (nativeEffect) h.effects[0]!.currentTime = 200; else h.step(200);
        const second = h.runtime.animate(h.element, { [key]: .8 * scale }, linear); runs.push(second);
        expect(first.state).toBe('stopped');
        if (nativeEffect) h.effects[1]!.currentTime = 250; else h.step(450);
        const third = h.runtime.animate(h.element, { [key]: .1 * scale }, linear); runs.push(third);
        expect(second.state).toBe('stopped');
        expect(Number.parseFloat(h.values.get(key)!)).toBeCloseTo(.35 * scale, 10);
        expect(h.effects.filter(effect => !effect.cancelled)).toHaveLength(nativeEffect ? 1 : 0);
        expect(third.state).toBe('running');
        if (nativeEffect) {
          const writes = h.writes.length; h.effects[1]!.complete();
          await Promise.resolve(); await Promise.resolve();
          expect(h.writes).toHaveLength(writes); expect(third.state).toBe('running');
        }
        third.finish();
        expect(await first.finished).toEqual({ status: 'stopped' });
        expect(await second.finished).toEqual({ status: 'stopped' });
        expect(await third.finished).toEqual({ status: 'finished' });
        expect(Number.parseFloat(h.values.get(key)!)).toBeCloseTo(.1 * scale, 10);
        expect(h.effects.every(effect => effect.cancelled)).toBe(true);
        expect(h.updates.size + h.renders.size).toBe(0);
      } finally { for (const run of runs) run.stop(); }
    });
  }
});

describe('отложенная команда проверяет текущего владельца', () => {
  for (const partial of [false, true]) it(`старый stop сохраняет преемника, partial=${partial}`, async () => {
    const h = harness();
    const previous = h.runtime.animate(h.element, partial ? { x: 100, y: 200 } : { x: 100 }, linear);
    let next: Playback | undefined, armed = true;
    const write = h.element.style.setProperty.bind(h.element.style);
    h.element.style.setProperty = (name, text) => {
      write(name, text); if (!armed || name !== 'transform') return; armed = false;
      h.runtime.after(() => { next = h.runtime.animate(h.element, { x: 100 }, linear); });
      previous.stop();
    };
    try {
      h.step(250);
      expect(previous.state).toBe('stopped'); expect(next).toBeDefined(); expect(next!.state).toBe('running');
      expect(h.x()).toBe(25); if (partial) expect(h.y()).toBe(50);
      h.step(500); expect(h.x()).toBe(50); if (partial) expect(h.y()).toBe(50);
      next!.finish();
      expect(await next!.finished).toEqual({ status: 'finished' });
      expect(await previous.finished).toEqual({ status: 'stopped' });
      expect(h.updates.size + h.renders.size).toBe(0);
    } finally { h.element.style.setProperty = write; previous.stop(); next?.stop(); }
  });
});

describe('однозначность нормализованных имён свойств', () => {
  const collisions: MotionProperties[] = [
    { scale: 1, 'scale-x': 2 }, { scaleX: 1, 'scale-x': 2 },
    { marginLeft: '0px', 'margin-left': '10px' }, { marginLeft: '10px', 'margin-left': '10px' },
    { backgroundColor: '#000', 'background-color': '#fff' },
  ];
  for (const props of collisions) it(`${Object.keys(props).join(' + ')} отвергается до прерывания`, () => {
    const h = harness(); h.values.set('background-color', '#000'); h.values.set('margin-left', '0px');
    const running = h.runtime.animate(h.element, { x: 100 }, linear); let rejected: Playback | undefined;
    try {
      h.step(200); const writes = h.writes.length;
      expect(() => { rejected = h.runtime.animate(h.element, props, linear); }).toThrow('задано несколько раз');
      expect(h.writes).toHaveLength(writes); expect(running.state).toBe('running'); h.step(500); expect(h.x()).toBe(50);
    } finally { rejected?.stop(); running.stop(); }
  });
  it('регистр custom properties и разные transform-оси остаются независимыми', () => {
    const h = harness();
    const running = h.runtime.animate(h.element, { '--tone': [0, 100], '--Tone': [0, 200], scaleX: [1, 2], scaleY: [1, 3] }, linear);
    try {
      running.seek(500); expect(h.values.get('--tone')).toBe('50'); expect(h.values.get('--Tone')).toBe('100');
      expect(h.values.get('transform')).toContain('scale(1.5,2)');
    } finally { running.stop(); }
  });
});
