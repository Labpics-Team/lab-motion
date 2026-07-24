/**
 * test/compiler-facade-lowering.test.ts — #240 facade-erasure: понижение
 * полного `./animate` в compiled-путь.
 *
 * Несущий клейм PR: понижённый вызов подаёт браузеру ТО ЖЕ, что фасадный
 * tier-0 — поле в поле. Он доказывается C4-дифференциалом: один и тот же
 * авторский вызов исполняется (а) настоящим фасадом на фейковом элементе с
 * журналом element.animate и (б) compiled-исполнителем с артефактом
 * компилятора; журналы сравниваются целиком (keyframes, offsets, значения,
 * easing-строка, duration, iterations, fill, composite, условный delay).
 *
 * ── RED PROOF (авторские мутации, каждая роняет свой блок) ────────────────────
 * - Взять кривую из nano/spring-linear вместо compositor/curve → C4 RED
 *   (другая длительность и другой набор стопов).
 * - Убрать identity-инференс from (взять 0 для scale) → C4 RED на scale.
 * - Уронить `composite`/`iterations` из тайминга → C4 RED.
 * - Эмитить delay всегда (а не при >0) → C4 RED на вызове без delay.
 * - Понижать вызовы без прагмы → «без прагмы остаётся фасадом» RED.
 * - Принять props с CSS-каналом → «непонижаемый @lm-oneshot — ошибка» RED.
 * - Снять сортировку слитых правок → «две грамматики в одном модуле» RED.
 */

import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import { animate } from '../src/animate/index.js';
import {
  facadeArtifactLiteral,
  planFacadeLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { animateFacadeCompiled, type CompiledFacadeCall } from '../src/compiler/runtime/index.js';
import { motionCompiler } from '../src/compiler/vite/index.js';
import { fakeEl } from './animate-facade-helpers.js';

async function plan(code: string) {
  const ast = await parseAstAsync(code);
  return planFacadeLowering(ast as unknown as AstNode, code, facadeArtifactLiteral);
}

async function transform(code: string, id = '/app/module.ts') {
  const plugin = motionCompiler();
  const ast = await parseAstAsync(code);
  return plugin.transform.call({ parse: () => ast }, code, id);
}

/** Объектный литерал с Identifier-ключами (JSON даёт строковые — иная грамматика). */
function objectLiteral(value: Record<string, unknown>): string {
  const body = Object.entries(value).map(([key, item]) =>
    `${key}: ${
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? objectLiteral(item as Record<string, unknown>)
        : JSON.stringify(item)
    }`).join(', ');
  return `{ ${body} }`;
}

/** Артефакт из литерала компилятора — ровно то, что уедет в бандл. */
function artifactOf(literal: string): CompiledFacadeCall {
  return (0, eval)(`(${literal})`) as CompiledFacadeCall;
}

// ─── C4: журнал element.animate compiled ≡ фасадный tier-0 ───────────────────

describe('#240 C4: понижённый вызов подаёт браузеру то же, что фасад', () => {
  const CASES: { name: string; props: Record<string, unknown>; options?: Record<string, unknown> }[] = [
    { name: 'x + opacity (канон getting-started)', props: { x: 240, opacity: 1 } },
    { name: 'одиночный transform-канал', props: { x: 100 } },
    { name: 'явная пара opacity', props: { opacity: [0, 1] } },
    { name: 'мульти-канал transform', props: { x: 120, y: -40, scale: 1.5 } },
    { name: 'отрицательные значения', props: { x: -100, rotate: -8 } },
    { name: 'скос и осевой scale', props: { skewX: 12, scaleY: 0.5 } },
    { name: 'кастомная пружина', props: { x: 240 }, options: { spring: { mass: 1, stiffness: 200, damping: 20 } } },
    { name: 'delay', props: { opacity: 1 }, options: { delay: 120 } },
    { name: 'пары в двух группах', props: { x: [16, 0], opacity: [0, 1] } },
  ];

  for (const { name, props, options } of CASES) {
    it(`${name}: keyframes/timing совпадают поле в поле`, async () => {
      // (а) фасадный tier-0 на фейковом элементе с WAAPI.
      const facadeTarget = fakeEl({}, true);
      const facadeControls = animate(
        facadeTarget.el as never,
        props as never,
        { ...(options ?? {}), matchMedia: () => ({ matches: false }) } as never,
      );

      // (б) compiled: артефакт компилятора + исполнитель.
      const source = `import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(el, ${objectLiteral(props)}${options ? `, ${objectLiteral(options)}` : ''});
`;
      const p = await plan(source);
      expect(p, name).toBeDefined();
      expect(p!.edits).toHaveLength(2);
      const literal = p!.edits[1]!.replacement.replace(/^, /, '').replace(/\)$/, '');
      const compiledTarget = fakeEl({}, true);
      animateFacadeCompiled(compiledTarget.el as never, artifactOf(literal));

      expect(compiledTarget.animateCalls.length, name).toBe(facadeTarget.animateCalls.length);
      expect(compiledTarget.animateCalls, name).toEqual(facadeTarget.animateCalls);
      facadeControls.cancel();
    });
  }

  it('stagger по нескольким целям: delay каждой цели совпадает с фасадом', async () => {
    const facadeTargets = [fakeEl({}, true), fakeEl({}, true), fakeEl({}, true)];
    const controls = animate(
      facadeTargets.map((t) => t.el) as never,
      { opacity: 1 } as never,
      { stagger: 50, matchMedia: () => ({ matches: false }) } as never,
    );
    const source = `import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(els, { opacity: 1 }, { stagger: 50 });
`;
    const p = await plan(source);
    const literal = p!.edits[1]!.replacement.replace(/^, /, '').replace(/\)$/, '');
    const compiledTargets = [fakeEl({}, true), fakeEl({}, true), fakeEl({}, true)];
    animateFacadeCompiled(
      compiledTargets.map((t) => t.el) as never,
      artifactOf(literal),
    );
    for (let i = 0; i < 3; i++) {
      expect(compiledTargets[i]!.animateCalls, `цель ${i}`)
        .toEqual(facadeTargets[i]!.animateCalls);
    }
    controls.cancel();
  });
});

// ─── Грамматика: что понижается и что честно отказывается ────────────────────

describe('#240: грамматика понижения фасада', () => {
  it('без прагмы вызов остаётся полным фасадом (план не трогает модуль)', async () => {
    const p = await plan(`import { animate } from '@labpics/motion/animate';
animate(el, { x: 240 });
`);
    expect(p).toBeUndefined();
  });

  it('прагма понижает вызов и hoisted-импорт указывает на фасадный executor', async () => {
    const out = await transform(`import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(el, { x: 240, opacity: 1 });
`);
    expect(out?.code).toContain('animateFacadeCompiled as __labMotionFacadeCompiled');
    expect(out?.code).toContain('__labMotionFacadeCompiled(el, {c:[');
    expect(out?.code).toContain('@labpics/motion/compiler/runtime');
  });

  const REFUSED: [name: string, call: string][] = [
    ['tween duration', `/* @lm-oneshot */ animate(el, { x: 1 }, { duration: 300 });`],
    ['ease', `/* @lm-oneshot */ animate(el, { x: 1 }, { ease: (t) => t });`],
    ['CSS-канал', `/* @lm-oneshot */ animate(el, { '--x': ['0px', '1px'] });`],
    ['цвет строкой', `/* @lm-oneshot */ animate(el, { backgroundColor: 'red' });`],
    ['трек из трёх', `/* @lm-oneshot */ animate(el, { x: [0, 10, 0] });`],
    ['props переменной', `/* @lm-oneshot */ animate(el, props);`],
    ['spread в props', `/* @lm-oneshot */ animate(el, { ...base });`],
    ['дубликат ключа', `/* @lm-oneshot */ animate(el, { x: 1, x: 2 });`],
    ['пустые props', `/* @lm-oneshot */ animate(el, {});`],
    ['неизвестный options-ключ', `/* @lm-oneshot */ animate(el, { x: 1 }, { onComplete: cb });`],
    ['spring переменной', `/* @lm-oneshot */ animate(el, { x: 1 }, { spring: s });`],
    ['optional call', `/* @lm-oneshot */ animate?.(el, { x: 1 });`],
    ['комментарий в тривиа-зоне', `/* @lm-oneshot */ animate(/* h */ el, { x: 1 });`],
  ];

  for (const [name, call] of REFUSED) {
    it(`${name} → отказ с причиной (прагма обещала стирание)`, async () => {
      const p = await plan(`import { animate } from '@labpics/motion/animate';
${call}
`);
      expect(p, name).toBeDefined();
      expect(p!.edits, name).toHaveLength(0);
      expect(p!.refusals, name).toHaveLength(1);
      expect(p!.refusals[0]!.reason.length, name).toBeGreaterThan(10);
    });
  }

  it('использованный результат — отказ: понижённый вызов не отдаёт контролы', async () => {
    const p = await plan(`import { animate } from '@labpics/motion/animate';
const c = /* @lm-oneshot */ animate(el, { x: 1 });
`);
    expect(p!.edits).toHaveLength(0);
    expect(p!.refusals[0]!.reason).toContain('не публикует owner');
  });

  it('отказ помеченного вызова — ошибка сборки, а не тихий откат к фасаду', async () => {
    await expect(transform(`import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(el, { x: 1 }, { duration: 300 });
`)).rejects.toThrow(/непонижаемый @lm-oneshot вызов/);
  });

  it('невалидная доказанная пружина — ошибка сборки с причиной', async () => {
    await expect(transform(`import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(el, { x: 1 }, { spring: { mass: 1, stiffness: 0, damping: 26 } });
`)).rejects.toThrow(/статический фасадный вызов невалиден/);
  });

  it('alias/namespace-импорт фасада: модуль не трогается (фасад — легальный тир)', async () => {
    expect(await plan(`import { animate as go } from '@labpics/motion/animate';
/* @lm-oneshot */ go(el, { x: 1 });
`)).toBeUndefined();
    expect(await plan(`import * as m from '@labpics/motion/animate';
/* @lm-oneshot */ m.animate(el, { x: 1 });
`)).toBeUndefined();
  });

  it('затенение локальным объявлением — консервативный отказ модуля', async () => {
    expect(await plan(`import { animate } from '@labpics/motion/animate';
function f(animate) { /* @lm-oneshot */ animate(el, { x: 1 }); }
`)).toBeUndefined();
  });
});

// ─── Артефакт: форма литерала и инвариант identity-инференса ─────────────────

describe('#240: артефакт понижения', () => {
  it('литерал несёт группы в авторском порядке ключей и from из identity', () => {
    const literal = facadeArtifactLiteral([
      ['transform', [['x', 0, 240], ['scale', 1, 1.5]]],
      ['opacity', [['opacity', 1, 0.5]]],
    ]);
    expect(literal.startsWith('{c:[["transform",[["x",0,240],["scale",1,1.5]]],["opacity",[["opacity",1,0.5]]]],d:'))
      .toBe(true);
    expect(literal).toContain(',e:"linear(');
    expect(literal).not.toContain(',y:');
    expect(literal).not.toContain(',g:');
  });

  it('delay/stagger попадают в литерал только когда заданы', () => {
    const withTiming = facadeArtifactLiteral([['opacity', [['opacity', 1, 0]]]], { delay: 30, stagger: 10 });
    expect(withTiming).toContain(',y:30');
    expect(withTiming).toContain(',g:10');
  });

  it('одинаковые формы дают идентичные литералы (детерминизм сборки)', () => {
    const groups = [['transform', [['x', 0, 240]]]] as never;
    expect(facadeArtifactLiteral(groups)).toBe(facadeArtifactLiteral(groups));
  });

  it('grammar: from transform-каналов — identity, opacity без пары — 1', async () => {
    const p = await plan(`import { animate } from '@labpics/motion/animate';
/* @lm-oneshot */ animate(el, { scale: 1.5, opacity: 0.2, rotate: 45 });
`);
    const literal = p!.edits[1]!.replacement;
    expect(literal).toContain('["scale",1,1.5]');
    expect(literal).toContain('["rotate",0,45]');
    expect(literal).toContain('["opacity",1,0.2]');
  });
});

// ─── Исполнитель: WebKit-ветка и reduced-motion ──────────────────────────────

describe('#240: исполнитель compiled-фасада', () => {
  const ARTIFACT = (): CompiledFacadeCall =>
    artifactOf(facadeArtifactLiteral([['transform', [['x', 0, 240]]]]));

  it('WebKit получает явные стопы и easing linear (linear() там не исполняется)', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { vendor: 'Apple Computer, Inc.', userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15' },
    });
    try {
      const target = fakeEl({}, true);
      const artifact = ARTIFACT();
      animateFacadeCompiled(target.el as never, artifact);
      const [call] = target.animateCalls;
      expect(call!.timing['easing']).toBe('linear');
      const frames = call!.keyframes as Record<string, unknown>[];
      // Стопов ровно столько, сколько в linear()-строке артефакта.
      expect(frames.length).toBe(artifact.e.slice(7, -1).split(', ').length);
      expect(frames[0]).toEqual({ offset: 0, transform: 'none' });
      expect(frames.at(-1)).toEqual({ offset: 1, transform: 'translateX(240px)' });
      // Монотонность offsets — иначе браузер отвергнет keyframes.
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!['offset'] as number).toBeGreaterThanOrEqual(frames[i - 1]!['offset'] as number);
      }
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('reduced-motion: финальная поза пишется сразу, кадров нет', () => {
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    try {
      const target = fakeEl({}, true);
      animateFacadeCompiled(target.el as never, ARTIFACT());
      expect(target.animateCalls).toHaveLength(0);
      expect(target.writes).toEqual([{ prop: 'transform', value: 'translateX(240px)' }]);
    } finally {
      if (matchMediaDescriptor) Object.defineProperty(globalThis, 'matchMedia', matchMediaDescriptor);
      else delete (globalThis as { matchMedia?: unknown }).matchMedia;
    }
  });
});
