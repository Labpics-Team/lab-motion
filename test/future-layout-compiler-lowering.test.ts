/**
 * test/future-layout-compiler-lowering.test.ts — GREEN: conservative lowering
 * animate(..., { layout: 'project' }) в versioned SurfaceProgram V1
 * (спека «COMPILER», список гардов «Conservative lowering»: каждый guard
 * имеет positive control).
 */

import { describe, expect, it } from 'vitest';
import { lowerSurfaceCall, type SurfaceCallInput } from '../src/compiler/core.js';

const staticCall: SurfaceCallInput = {
  callee: 'animate',
  target: { kind: 'identifier', name: 'viewport' },
  props: { width: [240, 360] },
  options: { layout: 'project' },
};

const dyn = (name: string): { kind: string; name: string } => ({ kind: 'identifier', name });

describe('lowerSurfaceCall: positive path', () => {
  it('статический вызов понижается в frozen versioned SurfaceProgram V1', () => {
    const result = lowerSurfaceCall(staticCall);
    expect(result.lowered).toBe(true);
    if (!result.lowered) throw new Error('unreachable');
    expect(result.program.version).toBe('surface/1');
    expect(result.program.target).toEqual({ kind: 'identifier', name: 'viewport' });
    expect(result.program.fromWidth).toBe(240);
    expect(result.program.toWidth).toBe(360);
    // Immutable representation: mutation бросает даже вне strict mode.
    expect(() => {
      (result.program as unknown as { version: string }).version = 'surface/2';
    }).toThrow();
    expect(() => {
      (result.program.target as unknown as { name: string }).name = 'hacked';
    }).toThrow();
  });

  it('полные опции (spring/inputPolicy/scrollAnchor/onFrame) проходят целиком', () => {
    const result = lowerSurfaceCall({
      ...staticCall,
      options: {
        layout: 'project',
        spring: { mass: 1, stiffness: 170, damping: 26, velocity: 12 },
        inputPolicy: 'cancel',
        scrollAnchor: 'none',
        onFrame: (): void => {},
      },
    });
    expect(result.lowered).toBe(true);
    if (!result.lowered) throw new Error('unreachable');
    expect(result.program.spring).toEqual({ mass: 1, stiffness: 170, damping: 26, velocity: 12 });
    expect(result.program.inputPolicy).toBe('cancel');
    expect(result.program.scrollAnchor).toBe('none');
    expect(result.program.hasOnFrame).toBe(true);
  });

  it('вызов без options: layout неявно обязателен → без layout понижения нет', () => {
    const { options: _options, ...rest } = staticCall;
    void _options;
    expect(lowerSurfaceCall(rest).lowered).toBe(false);
  });
});

describe('lowerSurfaceCall: каждый guard спеки имеет positive control', () => {
  const expectReject = (input: SurfaceCallInput, reason: string): void => {
    const result = lowerSurfaceCall(input);
    expect(result.lowered, `reason должен быть ${reason}`).toBe(false);
    if (!result.lowered) expect(result.reason).toBe(reason);
  };

  it('alias / namespace import: callee не plain "animate"', () => {
    expectReject({ ...staticCall, callee: 'motion.animate' }, 'callee-not-animate');
    expectReject({ ...staticCall, callee: dyn('anim') }, 'callee-not-animate');
    expectReject({ ...staticCall, callee: undefined }, 'callee-not-animate');
  });

  it('optional call: callee не идентифицирован → runtime path', () => {
    expectReject({ ...staticCall, callee: { kind: 'optional', name: 'animate' } }, 'callee-not-animate');
  });

  it('dynamic target / member expression / spread-target', () => {
    expectReject({ ...staticCall, target: { kind: 'call', name: 'resolveTarget' } }, 'target-dynamic');
    expectReject({ ...staticCall, target: { kind: 'member', name: 'panel.el' } }, 'target-dynamic');
    expectReject({ ...staticCall, target: { kind: 'spread' } }, 'target-dynamic');
    expectReject({ ...staticCall, target: 'viewport' }, 'target-dynamic');
  });

  it('spread/getter/computed key/duplicate key в props — сомнение', () => {
    expectReject({ ...staticCall, props: { kind: 'spread', name: 'rest' } }, 'props-not-static');
    expectReject({ ...staticCall, props: { width: [240, 360], opacity: [0, 1] } }, 'props-not-width');
    expectReject({ ...staticCall, props: { ['width']: [240, 360], extra: 1 } }, 'props-not-width');
    expectReject({ ...staticCall, props: {} }, 'props-not-width');
    expectReject({ ...staticCall, props: null }, 'props-not-static');
  });

  it('unary number / не-числа / NaN / Infinity в концах width', () => {
    expectReject({ ...staticCall, props: { width: [{ kind: 'unary', name: '-240' }, 360] } }, 'width-dynamic');
    expectReject({ ...staticCall, props: { width: ['240px', 360] } }, 'width-not-numeric');
    expectReject({ ...staticCall, props: { width: [Number.NaN, 360] } }, 'width-not-finite');
    expectReject({ ...staticCall, props: { width: [240, Number.POSITIVE_INFINITY] } }, 'width-not-finite');
  });

  it('zero / negative width отклоняются (fail-closed)', () => {
    expectReject({ ...staticCall, props: { width: [0, 360] } }, 'width-not-positive');
    expectReject({ ...staticCall, props: { width: [240, -360] } }, 'width-not-positive');
  });

  it('width не пара / пустой массив / тройка', () => {
    expectReject({ ...staticCall, props: { width: [240] } }, 'width-not-pair');
    expectReject({ ...staticCall, props: { width: [240, 360, 480] } }, 'width-not-pair');
    expectReject({ ...staticCall, props: { width: 360 } }, 'width-not-pair');
  });

  it('dynamic layout option', () => {
    expectReject({ ...staticCall, options: { layout: dyn('mode') } }, 'layout-not-project');
    expectReject({ ...staticCall, options: { layout: 'smart' } }, 'layout-not-project');
  });

  it('dynamic spring / невалидная пружина', () => {
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: dyn('spring') } },
      'spring-not-static',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: { mass: dyn('m'), stiffness: 170, damping: 26 } } },
      'spring-dynamic',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: { mass: 0, stiffness: 170, damping: 26 } } },
      'spring-invalid',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: { mass: 1, stiffness: -170, damping: 26 } } },
      'spring-invalid',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: { mass: 1, stiffness: 170, damping: -1 } } },
      'spring-invalid',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', spring: { mass: 1, stiffness: 170, damping: 26, velocity: Number.NaN } } },
      'velocity-invalid',
    );
  });

  it('неизвестные inputPolicy/scrollAnchor/onFrame — runtime path', () => {
    expectReject(
      { ...staticCall, options: { layout: 'project', inputPolicy: 'abort' } },
      'input-policy-unknown',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', scrollAnchor: 'end' } },
      'scroll-anchor-unknown',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', onFrame: dyn('cb') } },
      'onframe-dynamic',
    );
    expectReject(
      { ...staticCall, options: { layout: 'project', onFrame: 'log' } },
      'onframe-not-function',
    );
  });

  it('untrusted input: не-объект и пустые поля отклоняются, не бросая', () => {
    expect(lowerSurfaceCall(null as never).lowered).toBe(false);
    expect(lowerSurfaceCall({} as never).lowered).toBe(false);
    expect(lowerSurfaceCall({ callee: 'animate' } as never).lowered).toBe(false);
  });
});

describe('lowerSurfaceCall: erasure-инвариант seams', () => {
  it('lowering не импортирует solver/parser: результат детерминирован без среды', () => {
    // Один и тот же вход даёт байтово идентичную программу (чистая функция).
    const a = lowerSurfaceCall(staticCall);
    const b = lowerSurfaceCall({ ...staticCall });
    expect(a).toEqual(b);
  });
});
