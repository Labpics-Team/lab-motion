import { describe, expect, it } from 'vitest';
import { animate, type AnimateProps } from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

type Mode = 'main' | 'reduced';

async function transform(props: AnimateProps, mode: Mode): Promise<string> {
  const target = fakeEl();
  const clock = makeClock();
  const run = animate(target.el, props, {
    duration: 1,
    ease: (t) => t,
    requestFrame: clock.requestFrame,
    matchMedia: () => ({ matches: mode === 'reduced' }),
  });
  clock.drain();
  await run.finished;
  return target.el.style.getPropertyValue('transform');
}

for (const mode of ['main', 'reduced'] as const) {
  describe(`animate ${mode}: снимок собственных перечисляемых свойств`, () => {
    for (const axis of ['scaleX', 'scaleY'] as const) {
      it(`${axis} из прототипа не подавляет scale и не читается`, async () => {
        const prototype = Object.defineProperty({}, axis, {
          enumerable: true,
          get() { throw new Error('Унаследованное значение не должно читаться'); },
        });
        const props: AnimateProps = Object.create(prototype);
        props.scale = 2;
        expect(await transform(props, mode)).toBe('scale(2)');
      });

      it(`неперечисляемое ${axis} не подавляет scale и не читается`, async () => {
        const props: AnimateProps = { scale: 2 };
        Object.defineProperty(props, axis, {
          get() { throw new Error('Скрытое значение не должно читаться'); },
        });
        expect(await transform(props, mode)).toBe('scale(2)');
      });
    }

    it.each([false, true])('собственная явная ось имеет приоритет; axisFirst=%s', async (axisFirst) => {
      const props = axisFirst ? { scaleX: 3, scale: 2 } : { scale: 2, scaleX: 3 };
      expect(await transform(props, mode)).toBe('scaleX(3) scaleY(2)');
    });

    it('принимает объект без прототипа', async () => {
      const props: AnimateProps = Object.create(null);
      props.scale = 2;
      expect(await transform(props, mode)).toBe('scale(2)');
    });

    it('getter не добавляет ось в уже выбранный набор', async () => {
      let reads = 0;
      const props: AnimateProps = {
        get scale() {
          reads++;
          props.scaleX = 9;
          return 2;
        },
      };
      expect(await transform(props, mode)).toBe('scale(2)');
      expect(reads).toBe(1);
    });

    it('смена перечисляемости не удаляет ранее выбранную ось', async () => {
      const props: AnimateProps = {
        get scale() {
          Object.defineProperty(props, 'scaleX', { enumerable: false });
          return 2;
        },
        scaleX: 3,
      };
      expect(await transform(props, mode)).toBe('scaleX(3) scaleY(2)');
    });

    it('удалённая getter-ом выбранная ось отклоняется до внешних эффектов', () => {
      const target = fakeEl({}, true);
      let frames = 0;
      const props: AnimateProps = {
        get scale() {
          delete props.scaleX;
          return 2;
        },
        scaleX: 3,
      };
      expect(() => animate(target.el, props, {
        duration: 1,
        requestFrame: () => ++frames,
        matchMedia: () => ({ matches: mode === 'reduced' }),
      })).toThrow(MotionParamError);
      expect(target.writes).toEqual([]);
      expect(target.animateCalls).toEqual([]);
      expect(frames).toBe(0);
    });
  });
}
