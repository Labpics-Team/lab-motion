/**
 * test/smart-diff.test.ts — walker, диф и классификация субпутя ./smart.
 * Классы: А (пример-пин) + Б (контракт) + Д (враждебные входы).
 * Спека: §3.2 (walker/диф/классификация), правило регистрации статичных детей
 * движущегося keyed-предка, §2.1.4.3 (вырожденные ректы).
 *
 * ── RED PROOF (факт от 2026-07-10, заглушка src/smart/index.ts `export {}`) ──
 * Каждый it падал «captureSmart is not a function» (pick-хелпер + namespace-
 * import) — RED for the right reason, не link-ошибка.
 *
 * Mutation proof:
 *   - Сломать матчинг по ключу (matched → enter+exit при пересоздании) →
 *     «пересозданный узел = matched» красный.
 *   - Убрать каскад регистрации (статичный ребёнок движущегося предка) →
 *     «counter-scale ребёнка» красный (нет записей transform / identity).
 *   - Потерять removed-ветку (exited) → «ключ ушёл → exited» красный.
 *   - Обойти shadowRoot → «ключ в открытом shadow» красный.
 *   - Убрать MotionParamError дубликата → «duplicate» красный.
 *   - Убрать degenerate-классификацию → «NaN-rect → skipped» красный.
 */

import { describe, expect, it } from 'vitest';
import * as smart from '../src/smart/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  makeClock,
  makeSmartWorld,
  pickCaptureSmart,
  type SmartWorld,
} from './smart-helpers.js';
import { parseTranslateScale } from './projection-helpers.js';

const mod = smart as unknown as Record<string, unknown>;
const captureSmart = pickCaptureSmart(mod);

function opts(world: SmartWorld, clock: ReturnType<typeof makeClock>): Record<string, unknown> {
  return {
    requestFrame: clock.requestFrame,
    getScroll: world.getScroll,
    getComputedStyle: world.getComputedStyle,
  };
}

describe('./smart: walker по keyAttr (light DOM + открытые shadow roots)', () => {
  it('находит ключи сквозь keyless-обёртки и открытый shadowRoot', () => {
    const world = makeSmartWorld();
    const inner = world.el('inner', { x: 5, y: 5, width: 10, height: 10 }, { key: 'inner' });
    const host = world.el('host', { x: 0, y: 0, width: 50, height: 50 }, { shadowChildren: [inner] });
    const deep = world.el('deep', { x: 60, y: 0, width: 10, height: 10 }, { key: 'deep' });
    const wrap = world.el('wrap', { x: 60, y: 0, width: 30, height: 30 }, { children: [deep] });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [host, wrap] });
    const cap = captureSmart(root, opts(world, makeClock()));
    expect(cap.size).toBe(2); // inner (shadow) + deep (за keyless-обёрткой)
  });

  it('дубликат ключа → MotionParamError с кодом LM084', () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'card-3' });
    const b = world.el('b', { x: 20, y: 0, width: 10, height: 10 }, { key: 'card-3' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    expect(() => captureSmart(root, opts(world, makeClock()))).toThrowError(MotionParamError);
    expect(() => captureSmart(root, opts(world, makeClock()))).toThrowError('LM084');
  });

  it('кастомный keyAttr уважается и сохраняет код дубликата', () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 });
    a.attrs.set('data-id', 'x');
    const b = world.el('b', { x: 20, y: 0, width: 10, height: 10 });
    b.attrs.set('data-id', 'x');
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    const clock = makeClock();
    expect(() => captureSmart(root, { ...opts(world, clock), keyAttr: 'data-id' }))
      .toThrowError('LM084');
  });
});

describe('./smart: классификация дифа (matched / entered / exited / skipped)', () => {
  it('перемещение = matched; новый ключ = entered; ушедший = exited', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const b = world.el('b', { x: 20, y: 0, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    // Мутация: a двигается, b уходит, c приходит.
    a.rect = { x: 50, y: 0, width: 10, height: 10 };
    const i = root.children.indexOf(b);
    root.children.splice(i, 1);
    b.isConnected = false;
    const c = world.el('c', { x: 80, y: 0, width: 10, height: 10 }, { key: 'c' });
    root.children.push(c);

    const handle = cap.animate();
    expect(handle.plan.matched).toEqual(['a']);
    expect(handle.plan.entered).toEqual(['c']);
    expect(handle.plan.exited).toEqual(['b']);
    expect(handle.plan.skipped).toEqual([]);
    handle.cancel();
    await handle.finished;
  });

  it('пересозданный узел (тот же ключ, новый объект) = matched, НЕ exit+enter', async () => {
    const world = makeSmartWorld();
    const oldEl = world.el('old', { x: 0, y: 0, width: 20, height: 20 }, { key: 'card' });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [oldEl] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    // «Ре-рендер»: старый узел заменён новым с тем же ключом на новом месте.
    root.children.length = 0;
    oldEl.isConnected = false;
    const newEl = world.el('new', { x: 100, y: 50, width: 40, height: 40 }, { key: 'card' });
    root.children.push(newEl);

    const handle = cap.animate();
    expect(handle.plan.matched).toEqual(['card']);
    expect(handle.plan.entered).toEqual([]);
    expect(handle.plan.exited).toEqual([]);

    // Shared-element: НОВЫЙ узел стартует от снапшот-ректа СТАРОГО (p=0 — синхронный кадр).
    const first = parseTranslateScale(newEl.inline.get('transform') ?? '');
    expect(first).not.toBeNull();
    expect(first!.tx).toBeCloseTo(0 - 100, 9);
    expect(first!.ty).toBeCloseTo(0 - 50, 9);
    expect(first!.sx).toBeCloseTo(20 / 40, 9);
    expect(first!.sy).toBeCloseTo(20 / 40, 9);
    handle.cancel();
    await handle.finished;
  });

  it('статичный ребёнок движущегося keyed-предка зарегистрирован (counter-scale в полёте)', async () => {
    const world = makeSmartWorld();
    const child = world.el('avatar', { x: 10, y: 10, width: 20, height: 20 }, { key: 'avatar' });
    const card = world.el('card', { x: 0, y: 0, width: 100, height: 100 }, { key: 'card', children: [child] });
    const root = world.root('root', { x: 0, y: 0, width: 400, height: 400 }, { children: [card] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    // Родитель растёт 100→200 и уезжает; ребёнок «статичен» (Δ = 0 ≤ ε).
    card.rect = { x: 50, y: 0, width: 200, height: 200 };

    const handle = cap.animate();
    expect(handle.plan.matched).toEqual(expect.arrayContaining(['card', 'avatar']));

    // Несколько кадров в полёте: transform ребёнка НЕ identity (counter-scale работает).
    clock.step(16);
    clock.step(16);
    const midChild = parseTranslateScale(child.inline.get('transform') ?? '');
    expect(midChild, 'у статичного ребёнка должен быть counter-transform в полёте').not.toBeNull();
    // k родителя в полёте < 1 ⇒ собственный scale ребёнка = 1/k > 1.
    expect(midChild!.sx).toBeGreaterThan(1);
    expect(Math.abs(midChild!.tx)).toBeGreaterThan(1e-6);

    handle.cancel();
    await handle.finished;
  });

  it('статичный matched БЕЗ движущегося предка не анимируется (ноль записей)', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const b = world.el('b', { x: 30, y: 0, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    b.rect = { x: 60, y: 0, width: 10, height: 10 }; // движется только b

    const handle = cap.animate();
    expect(world.writes(a)).toHaveLength(0); // сосед (не предок) не тащит a в полёт
    expect(world.writes(b, 'transform').length).toBeGreaterThan(0);
    clock.drain();
    await handle.finished;
  });

  it('NaN-ректы: классификация тотальна (не бросает), вырожденный last → skipped', async () => {
    const world = makeSmartWorld();
    const bad = world.el('bad', { x: NaN, y: 0, width: NaN, height: 10 }, { key: 'bad' });
    const ok = world.el('ok', { x: 0, y: 20, width: 10, height: 10 }, { key: 'ok' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [bad, ok] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    ok.rect = { x: 40, y: 20, width: 10, height: 10 };

    const handle = cap.animate();
    expect(handle.plan.skipped).toEqual(['bad']);
    expect(handle.plan.matched).toEqual(['ok']);
    expect(world.writes(bad)).toHaveLength(0); // честно не анимирован
    clock.drain();
    await handle.finished;
  });

  it('вырожденный first (0×0 на capture) → entered (fade-in на новом месте, без transform)', async () => {
    const world = makeSmartWorld();
    const el = world.el('el', { x: 0, y: 0, width: 0, height: 0 }, { key: 'pop' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [el] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    el.rect = { x: 10, y: 10, width: 30, height: 30 };

    const handle = cap.animate();
    expect(handle.plan.entered).toEqual(['pop']);
    expect(handle.plan.matched).toEqual([]);
    expect(world.writes(el, 'transform')).toHaveLength(0);
    expect(world.values(el, 'opacity')[0]).toBe('0'); // fade-in с нуля
    clock.drain();
    await handle.finished;
  });

  it('ключ в открытом shadowRoot анимируется (host — keyless)', async () => {
    const world = makeSmartWorld();
    const inner = world.el('inner', { x: 5, y: 5, width: 10, height: 10 }, { key: 'inner' });
    const host = world.el('host', { x: 0, y: 0, width: 50, height: 50 }, { shadowChildren: [inner] });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [host] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    inner.rect = { x: 25, y: 5, width: 10, height: 10 };

    const handle = cap.animate();
    expect(handle.plan.matched).toEqual(['inner']);
    expect(world.writes(inner, 'transform').length).toBeGreaterThan(0);
    clock.drain();
    await handle.finished;
  });

  it('shadow: false выключает обход shadowRoot', () => {
    const world = makeSmartWorld();
    const inner = world.el('inner', { x: 5, y: 5, width: 10, height: 10 }, { key: 'inner' });
    const host = world.el('host', { x: 0, y: 0, width: 50, height: 50 }, { shadowChildren: [inner] });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [host] });
    const cap = captureSmart(root, { ...opts(world, makeClock()), shadow: false });
    expect(cap.size).toBe(0);
  });

  it('пустой диф → мгновенно resolved handle, ноль кадров и ноль записей', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    const handle = cap.animate(); // ничего не менялось
    expect(handle.playing).toBe(false);
    expect(handle.progress).toBe(1);
    expect(clock.rafCalls()).toBe(0);
    expect(world.writes(a)).toHaveLength(0);
    await handle.finished;
  });
});
