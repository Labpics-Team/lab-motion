/**
 * test/smart-finiteness-fuzz.test.ts — CSS-safety fuzz для ./smart.
 * Классы: В (property/fuzz, seeded) + Д (враждебное состояние DOM).
 * Спека: §7.10 — злые снапшоты (NaN/±Inf-ректы, битые строки радиусов,
 * пересоздания, скролл, перехваты) сквозь capture→animate→кадры: ни одного
 * броска, ни одного нефинитного числа и ни одного «-0» в журнале setProperty.
 *
 * Попадает в fuzz-шаг CI автоматически (глоб test/*finiteness-fuzz.test.ts).
 *
 * ── RED PROOF (факт от 2026-07-10, заглушка src/smart/index.ts `export {}`) ──
 * Оба it падали «captureSmart is not a function» (pick-хелпер + namespace-
 * import) — RED for the right reason, не link-ошибка.
 *
 * Mutation proof:
 *   - Убрать finite()-страж координат ghost'а (left/top/width/height) →
 *     'NaNpx' в журнале при злом ректе → красный.
 *   - Пропустить degenerate-классификацию (NaN-last в projection-узлы без
 *     стражей) → нефинитный transform → красный.
 *   - Убрать try/catch вокруг враждебного getBoundingClientRect → бросок →
 *     красный («цикл никогда не бросает»).
 *   - Сломать валидацию дубликата ключа → и здесь красный (негативная ветка
 *     пинит бросок MotionParamError, не тихое поглощение).
 */

import { describe, expect, it } from 'vitest';
import * as smart from '../src/smart/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  lcg,
  makeClock,
  makeSmartWorld,
  pickCaptureSmart,
  type SmartFakeElement,
  type SmartWorld,
} from './smart-helpers.js';
import type { RectLike } from './projection-helpers.js';

const mod = smart as unknown as Record<string, unknown>;
const captureSmart = pickCaptureSmart(mod);

const EVIL = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 0, -0, 1e-320, 1e308, -1e308];
const EVIL_RADII = ['8px', '50%', '150%', 'abcpx', 'calc(1px + 1%)', '1e4px', '', '0px', '4px 8px', '-3px'];

const NUMERIC_PROPS = new Set([
  'transform',
  'opacity',
  'border-radius',
  'left',
  'top',
  'width',
  'height',
]);

/** Каждое число каждой записи конечно; токен «-0» не эмитится. */
function assertWritesFinite(world: SmartWorld, seed: number): void {
  for (const op of world.ops) {
    if (op.kind !== 'set' || op.prop === undefined || !NUMERIC_PROPS.has(op.prop)) continue;
    const v = op.value ?? '';
    expect(v.includes('NaN'), `seed ${seed}: NaN в ${op.prop}: "${v}"`).toBe(false);
    expect(v.includes('Infinity'), `seed ${seed}: Infinity в ${op.prop}: "${v}"`).toBe(false);
    for (const token of v.split(/[\s(),/]+/)) {
      if (token === '' || !/^-?[\d.]/.test(token)) continue;
      const n = Number(token.replace(/px$/, ''));
      expect(Number.isFinite(n), `seed ${seed}: нефинитный токен "${token}" в ${op.prop}: "${v}"`).toBe(true);
      expect(token === '-0' || token === '-0px', `seed ${seed}: «-0» в ${op.prop}: "${v}"`).toBe(false);
    }
  }
}

describe('./smart: финитность ≥10k злых дифов (seeded LCG)', () => {
  it('capture→мутация→animate→кадры→перехват: ни броска, ни NaN/Inf/-0 в записях', () => {
    const ITERATIONS = 10_000;
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rnd = lcg(seed * 7919);
      const evil = (): number => EVIL[Math.floor(rnd() * EVIL.length)];
      const num = (): number => (rnd() < 0.3 ? evil() : (rnd() - 0.5) * 1000);
      const rect = (): RectLike => ({ x: num(), y: num(), width: num(), height: num() });
      const radius = (): string => EVIL_RADII[Math.floor(rnd() * EVIL_RADII.length)];

      const world = makeSmartWorld();
      const clock = makeClock();
      const keyed: SmartFakeElement[] = [];
      const kids: SmartFakeElement[] = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const r = radius();
        const el = world.el(`e${i}`, rect(), {
          key: `k${i}`,
          computed: {
            'border-radius': r,
            'border-top-left-radius': r,
            'border-top-right-radius': radius(),
            'border-bottom-right-radius': radius(),
            'border-bottom-left-radius': radius(),
          },
        });
        keyed.push(el);
        // Половина — вложенные под предыдущий keyed (каскад регистрации).
        if (i > 0 && rnd() < 0.5) keyed[i - 1].children.push(el);
        else kids.push(el);
      }
      const root = world.root('root', rect(), {
        children: kids,
        clientLeft: Math.floor(rnd() * 5),
        clientTop: Math.floor(rnd() * 5),
        computed: { position: rnd() < 0.5 ? 'static' : 'relative' },
      });

      const opts = {
        requestFrame: clock.requestFrame,
        getScroll: world.getScroll,
        getComputedStyle: world.getComputedStyle,
        epsilon: rnd() < 0.1 ? 0 : 0.5,
      };

      let freshCounter = 0;
      const run = (): void => {
        const cap = captureSmart(root, opts);
        // Злая мутация: движение/удаление/пересоздание/добавление + скролл.
        world.scroll = { x: rnd() < 0.2 ? evil() : rnd() * 500, y: rnd() * 500 };
        for (const el of [...keyed]) {
          const dice = rnd();
          if (dice < 0.35) {
            el.rect = rect(); // move (возможно в злой rect)
          } else if (dice < 0.55) {
            // remove: connected-флаг случайный (ghost либо skipped)
            const p = kids.includes(el) ? root : keyed.find((k) => k.children.includes(el));
            if (p) {
              const idx = p.children.indexOf(el);
              if (idx >= 0) p.children.splice(idx, 1);
            }
            el.isConnected = rnd() < 0.5;
          } else if (dice < 0.7) {
            // recreate: новый объект, тот же ключ
            const key = el.getAttribute('data-motion-key')!;
            const p = kids.includes(el) ? root : keyed.find((k) => k.children.includes(el)) ?? root;
            const idx = p.children.indexOf(el);
            if (idx >= 0) {
              const fresh = world.el(`${el.name}'`, rect(), { key });
              p.children[idx] = fresh;
              el.isConnected = false;
            }
          }
        }
        if (rnd() < 0.4) {
          root.children.push(world.el('fresh', rect(), { key: `fresh-${freshCounter++}` }));
        }

        const handle = cap.animate();
        clock.step(16);
        clock.step(16);
        if (rnd() < 0.5) handle.cancel();
        else clock.drain(16, 50);
      };

      expect(run, `seed ${seed} бросил`).not.toThrow();
      // Второй цикл с вероятностью — перехват живого полёта.
      if (rnd() < 0.3) expect(run, `seed ${seed} (перехват) бросил`).not.toThrow();

      assertWritesFinite(world, seed);
    }
  }, 120_000);

  it('негативный контроль: дубликат ключа ОБЯЗАН бросать (fuzz не глотает валидацию)', () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 1, height: 1 }, { key: 'dup' });
    const b = world.el('b', { x: 5, y: 0, width: 1, height: 1 }, { key: 'dup' });
    const root = world.root('root', { x: 0, y: 0, width: 10, height: 10 }, { children: [a, b] });
    expect(() => captureSmart(root, { getScroll: world.getScroll })).toThrowError(MotionParamError);
  });
});
