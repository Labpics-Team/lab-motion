/** Смысловые коды ошибок одинаковы во всех публичных animate-срезах. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate as fullAnimate } from '../src/animate/index.js';
import { colorCodec, svgAttrAdapter } from '../src/animate/full-codecs.js';
import { animate as miniAnimate } from '../src/animate/mini/index.js';
import { springTo } from '../src/animate/native/index.js';
import { createRegistry } from '../src/animate/registry.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { __resetSpringExecutionCache } from '../src/compositor/execution.js';
import { MotionParamError, type MotionParamErrorCode } from '../src/errors.js';
import { fakeEl } from './animate-facade-helpers.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function codeOf(run: () => unknown): MotionParamErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MotionParamError);
    return (error as MotionParamError).code;
  }
  throw new Error('ожидался MotionParamError');
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function nativeElement(animation: unknown = {
  cancel() {},
  finished: Promise.resolve(),
}): {
  style: { setProperty(): void };
  animate(): unknown;
} {
  return {
    style: { setProperty() {} },
    animate: () => animation,
  };
}

beforeEach(() => {
  __resetDetectionCache();
  __resetSpringExecutionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
  vi.stubGlobal('navigator', { vendor: 'Google Inc.', userAgent: 'Chrome' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
  __resetSpringExecutionCache();
});

describe('animate: общие коды режимов и значений', () => {
  it('LM136 — конфликт spring и tween в full/mini', () => {
    const options = { spring: SPRING, duration: 100 };
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: 1 }, options))).toBe('LM136');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: 1 }, options))).toBe('LM136');
  });

  it('LM137/LM138 — duration и ease в full/mini', () => {
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: 1 }, { duration: 0 }))).toBe('LM137');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: 1 }, { duration: 0 }))).toBe('LM137');
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: 1 }, { ease: 1 as never }))).toBe('LM138');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: 1 }, { ease: 1 as never }))).toBe('LM138');
  });

  it('диагностика не вызывает hostile toString после fail-fast guard', () => {
    const toString = vi.fn(() => 'poison');
    const hostile = { toString } as never;
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: 1 }, { duration: hostile }))).toBe('LM137');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: 1 }, { duration: hostile }))).toBe('LM137');
    expect(toString).not.toHaveBeenCalled();
  });

  it('LM139 — отрицательные delay/stagger в full/mini', () => {
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: 1 }, { delay: -1 }))).toBe('LM139');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: 1 }, { stagger: -1 }))).toBe('LM139');
  });

  it('LM140 — whole transform в full/mini', () => {
    expect(codeOf(() => fullAnimate(fakeEl().el, { transform: 'none' }))).toBe('LM140');
    expect(codeOf(() => miniAnimate(fakeEl().el, { transform: 'none' }))).toBe('LM140');
  });

  it('LM141/LM142 — пара и конечные числа в full/mini/native', () => {
    expect(codeOf(() => fullAnimate(fakeEl().el, { x: [0] as never }))).toBe('LM141');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: [0] as never }))).toBe('LM141');
    expect(codeOf(() => springTo(nativeElement() as never, { x: [0] } as never))).toBe('LM141');

    expect(codeOf(() => fullAnimate(fakeEl().el, { x: NaN }))).toBe('LM142');
    expect(codeOf(() => miniAnimate(fakeEl().el, { x: NaN }))).toBe('LM142');
    expect(codeOf(() => springTo(nativeElement() as never, { x: [0, NaN] }))).toBe('LM142');
  });

  it('LM150 не подменяет представимый MAX ↔ -MAX переполнением разности', () => {
    const controls = fullAnimate(fakeEl().el, {
      x: [Number.MAX_VALUE, -Number.MAX_VALUE],
    }, { requestFrame: () => 1 });
    expect(typeof controls.cancel).toBe('function');
    controls.cancel();
  });

  it('LM143/LM144 — тип и синтаксис CSS-значения', () => {
    expect(codeOf(() => fullAnimate(fakeEl().el, { backgroundColor: {} as never }))).toBe('LM143');
    expect(codeOf(() => miniAnimate(fakeEl().el, { '--gap': {} as never }))).toBe('LM143');
    expect(codeOf(() => colorCodec.parse(42, 'color'))).toBe('LM143');

    expect(codeOf(() => fullAnimate(fakeEl().el, { backgroundColor: 'not-a-value' }))).toBe('LM144');
    expect(codeOf(() => miniAnimate(fakeEl().el, { '--gap': 'not-a-value' }))).toBe('LM144');
    expect(codeOf(() => colorCodec.parse('not-a-color', 'color'))).toBe('LM144');
  });

  it('LM145 — неподдерживаемое свойство во внутренних и публичных resolver', () => {
    expect(codeOf(() => miniAnimate(fakeEl().el, { z: 1 }))).toBe('LM145');
    expect(codeOf(() => createRegistry().resolveCodec('x'))).toBe('LM145');
    expect(codeOf(() => svgAttrAdapter.surfaceOf('scale'))).toBe('LM145');
    expect(codeOf(() => springTo(nativeElement() as never, { z: [0, 1] } as never))).toBe('LM145');
  });

  it.each([null, 42, true, '', () => {}, []])(
    'LM151 — props обязан быть объектом-записью: %p',
    (invalid) => {
      const target = fakeEl().el;
      expect(codeOf(() => fullAnimate(target, invalid as never))).toBe('LM151');
      expect(codeOf(() => miniAnimate(target, invalid as never))).toBe('LM151');
      expect(codeOf(() => springTo(nativeElement() as never, invalid as never))).toBe('LM151');
    },
  );

  it('LM151 отсекает props до чтения hostile target во всех animate-срезах', () => {
    const readLength = vi.fn(() => { throw new Error('target getter reached'); });
    const target = Object.defineProperty({}, 'length', { get: readLength });
    expect(codeOf(() => fullAnimate(target as never, null as never))).toBe('LM151');
    expect(codeOf(() => miniAnimate(target, null as never))).toBe('LM151');
    expect(codeOf(() => springTo(target as never, null as never))).toBe('LM151');
    expect(readLength).not.toHaveBeenCalled();
  });
});

describe('animate: общие коды целей', () => {
  it('LM146 — неверный контейнер целей в full/mini/native', () => {
    const invalid = { length: -1 };
    expect(codeOf(() => fullAnimate(invalid as never, { x: [0, 1] }))).toBe('LM146');
    expect(codeOf(() => miniAnimate(invalid, { x: [0, 1] }))).toBe('LM146');
    expect(codeOf(() => springTo(invalid as never, { x: [0, 1] }))).toBe('LM146');
  });

  it('LM147 — неверный элемент списка в full/mini/native', () => {
    const invalid = [1] as never;
    expect(codeOf(() => fullAnimate(invalid, { x: [0, 1] }))).toBe('LM147');
    expect(codeOf(() => miniAnimate(invalid, { x: [0, 1] }))).toBe('LM147');
    expect(codeOf(() => springTo(invalid, { x: [0, 1] }))).toBe('LM147');
  });

  it('LM148 — адаптер цели отсутствует в mini/registry', () => {
    expect(codeOf(() => miniAnimate([{}], { x: [0, 1] }))).toBe('LM148');
    expect(codeOf(() => createRegistry().resolveAdapter({}))).toBe('LM148');
  });

  it('LM149 — selector без document в full/mini/native и selector не входит в message', () => {
    vi.stubGlobal('document', undefined);
    for (const run of [
      () => fullAnimate('.secret-selector', { x: [0, 1] }),
      () => miniAnimate('.secret-selector', { x: [0, 1] }),
      () => springTo('.secret-selector', { x: [0, 1] }),
    ]) {
      try {
        run();
        expect.fail('ожидался MotionParamError');
      } catch (error) {
        expect(error).toBeInstanceOf(MotionParamError);
        expect((error as MotionParamError).code).toBe('LM149');
        expect((error as Error).message).not.toContain('secret-selector');
      }
    }
  });
});

describe('animate/native: специальные коды', () => {
  it('LM152 — props пуст', () => {
    const target = nativeElement() as never;
    expect(codeOf(() => springTo(target, {}))).toBe('LM152');
  });

  it('LM153 — WAAPI отсутствует', () => {
    const target = { style: { setProperty() {} } };
    expect(codeOf(() => springTo(target as never, { x: [0, 1] }))).toBe('LM153');
  });

  it('LM154 — CSS linear отсутствует вне WebKit', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    expect(codeOf(() => springTo(nativeElement() as never, { x: [0, 1] }))).toBe('LM154');
  });

  it('LM155 — host вернул некорректную Animation', () => {
    expect(codeOf(() => springTo(nativeElement({}) as never, { x: [0, 1] }))).toBe('LM155');
  });
});

describe('animate: options boundary', () => {
  it('full читает spring и каждое физическое поле ровно один раз до валидации', () => {
    const reads = { option: 0, mass: 0, stiffness: 0, damping: 0 };
    const spring = {
      get mass() { return reads.mass++ === 0 ? 1 : Number.NaN; },
      get stiffness() { return reads.stiffness++ === 0 ? 170 : Number.NaN; },
      get damping() { return reads.damping++ === 0 ? 26 : Number.NaN; },
    };
    const options = {
      get spring() {
        reads.option++;
        return spring;
      },
      matchMedia: () => ({ matches: true }),
    };

    const controls = fullAnimate(fakeEl().el, { x: [0, 1] }, options);

    expect(reads).toEqual({ option: 1, mass: 1, stiffness: 1, damping: 1 });
    controls.cancel();
  });

  it('full читает getter options.stagger ровно один раз', () => {
    let reads = 0;
    const options = {
      duration: 10,
      matchMedia: () => ({ matches: true }),
      get stagger() {
        reads++;
        return { gap: 1 };
      },
    };
    const controls = fullAnimate(
      [fakeEl().el, fakeEl().el],
      { x: [0, 1] },
      options,
    );

    expect(reads).toBe(1);
    controls.cancel();
  });

  it.each([
    ['full', fullAnimate],
    ['mini', miniAnimate],
  ] as const)('%s проверяет numeric stagger до props и target', (_name, run) => {
    let touches = 0;
    const props = new Proxy({ x: [0, 1] as const }, {
      ownKeys(value) {
        touches++;
        return Reflect.ownKeys(value);
      },
    });
    const target = {
      get style() {
        touches++;
        return { getPropertyValue: () => '0', setProperty() {} };
      },
    };

    expect(codeOf(() => run(target as never, props as never, { stagger: -1 }))).toBe('LM139');
    expect(touches).toBe(0);
  });

  it.each([
    ['full', fullAnimate, null],
    ['full', fullAnimate, 1],
    ['mini', miniAnimate, null],
    ['mini', miniAnimate, 1],
    ['native', springTo, null],
    ['native', springTo, 1],
  ] as const)('%s отвергает не-объект options до чтения остальных входов', (_name, run, options) => {
    let touches = 0;
    const style = {
      getPropertyValue: () => '0',
      setProperty: () => { touches++; },
    };
    const target = {
      get style() {
        touches++;
        return style;
      },
      animate() {
        touches++;
        return { cancel() {}, finished: Promise.resolve() };
      },
    };
    const props = new Proxy({ x: [0, 1] as const }, {
      ownKeys(value) {
        touches++;
        return Reflect.ownKeys(value);
      },
    });

    const error = thrownBy(() => run(target as never, props as never, options as never));

    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM156');
    expect(touches).toBe(0);
  });
});
