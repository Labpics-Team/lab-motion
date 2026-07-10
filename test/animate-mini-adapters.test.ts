/**
 * test/animate-mini-adapters.test.ts — contract-тесты адаптерной архитектуры.
 *
 * Пинует ЗАКОН расширения (registry.ts): новый вид свойства/цели входит
 * РЕГИСТРАЦИЕЙ кодека/адаптера, движок (engine.ts) не меняется. Контракт-покрытие
 * acceptance #103: CSS-переменные, SVG-атрибуты, plain-object (ноль-DOM), цвет.
 *
 * MUTATION PROOF-якоря:
 *   - слом реестра→fallback-switch → 'реестр: неизвестное свойство fail-fast';
 *   - слом plain-object ноль-DOM → 'plain-object: ноль касаний DOM';
 *   - слом SVG-адаптера → 'SVG: атрибуты через setAttribute, не style';
 *   - расширение регистрацией → 'кастомный кодек ведёт новое свойство без правки движка'.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { runAnimate } from '../src/animate/mini/engine.js';
import { createRegistry, type PropertyCodec, type TargetAdapter } from '../src/animate/registry.js';
import { numberCodec } from '../src/animate/mini-codecs.js';
import { createFullRegistry, plainObjectAdapter } from '../src/animate/full-codecs.js';
import { animate } from '../src/animate/mini/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const RF = (clock: ReturnType<typeof makeClock>) => ({ requestFrame: clock.requestFrame });

// ─── CSS-переменные (mini) ────────────────────────────────────────────────────

describe('contract — CSS-переменные', () => {
  it('переменная анимируется, имя и юнит сохраняются', async () => {
    const f = fakeEl({});
    const clock = makeClock();
    const c = animate(f.el, { '--x': ['0%', '100%'] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    const w = f.writes.filter((x) => x.prop === '--x');
    expect(w.at(-1)?.value).toBe('100%');
    // Каждая запись — по имени переменной (не через surfaceOf в transform).
    expect(w.every((x) => x.prop === '--x')).toBe(true);
  });

  it('unitless переменная сериализуется числом', async () => {
    const f = fakeEl({});
    const clock = makeClock();
    const c = animate(f.el, { '--opacity': [0, 1] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(f.writes.filter((x) => x.prop === '--opacity').at(-1)?.value).toBe('1');
  });
});

// ─── SVG-атрибуты (full) ──────────────────────────────────────────────────────

interface FakeSvg {
  el: {
    namespaceURI: string;
    setAttribute(n: string, v: string): void;
    getAttribute(n: string): string | null;
  };
  attrs: Map<string, string>;
  attrWrites: { name: string; value: string }[];
}

function fakeSvg(initial: Record<string, string> = {}): FakeSvg {
  const attrs = new Map(Object.entries(initial));
  const attrWrites: FakeSvg['attrWrites'] = [];
  return {
    attrs,
    attrWrites,
    el: {
      namespaceURI: 'http://www.w3.org/2000/svg',
      setAttribute(n, v) {
        attrs.set(n, v);
        attrWrites.push({ name: n, value: v });
      },
      getAttribute: (n) => attrs.get(n) ?? null,
    },
  };
}

describe('contract — SVG-атрибуты', () => {
  it('SVG: атрибуты через setAttribute, не style', async () => {
    const s = fakeSvg({ cx: '0' });
    const clock = makeClock();
    const reg = createFullRegistry();
    const c = runAnimate(reg, s.el, { cx: 100 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(s.attrs.get('cx')).toBe('100');
    expect(s.attrWrites.length).toBeGreaterThan(1);
    // Все записи ушли в атрибут cx (SVG-адаптер, не DOM-style).
    expect(s.attrWrites.every((w) => w.name === 'cx')).toBe(true);
  });

  it('SVG radius r с явной парой', async () => {
    const s = fakeSvg({ r: '10' });
    const clock = makeClock();
    const c = runAnimate(createFullRegistry(), s.el, { r: [10, 40] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(s.attrs.get('r')).toBe('40');
  });
});

// ─── plain-object (ноль-DOM) ──────────────────────────────────────────────────

describe('contract — plain-object (ноль-DOM)', () => {
  it('plain-object: ноль касаний DOM', async () => {
    // Цель — чистый JS-объект без style/setAttribute. Любой DOM-путь бросил бы
    // (нет style.setProperty). Успех = адаптер работает исключительно по полям.
    const target: { x: number; opacity: number } = { x: 0, opacity: 0 };
    const clock = makeClock();
    const reg = createFullRegistry();
    const c = runAnimate(reg, target, { x: 100, opacity: 1 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(target.x).toBe(100);
    expect(target.opacity).toBe(1);
  });

  it('plain-object подхватывает текущее поле как from', async () => {
    const target = { level: 5 };
    const clock = makeClock();
    const reg = createRegistry();
    reg.registerCodec(() => true, numberCodec);
    reg.registerAdapter((t) => typeof t === 'object' && t !== null, plainObjectAdapter);
    const c = runAnimate(reg, target, { level: 10 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(target.level).toBe(10);
  });

  it('plain-object spring оседает точно в цели', async () => {
    const target = { opacity: 0 };
    const clock = makeClock();
    const c = runAnimate(createFullRegistry(), target, { opacity: 1 }, RF(clock));
    clock.drain(16);
    await c.finished;
    expect(target.opacity).toBe(1);
  });
});

// ─── Цвет (full) ──────────────────────────────────────────────────────────────

describe('contract — цвет', () => {
  it('цвет интерполируется от чёрного к белому', async () => {
    const f = fakeEl({});
    const clock = makeClock();
    const c = runAnimate(createFullRegistry(), f.el, { color: ['#000000', '#ffffff'] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    const last = f.writes.filter((w) => w.prop === 'color').at(-1)!.value;
    expect(last).toMatch(/rgb\(255,\s*255,\s*255\)/);
  });
});

// ─── Реестр: fail-fast и расширение ──────────────────────────────────────────

describe('реестр — fail-fast и расширение', () => {
  it('реестр: неизвестное свойство fail-fast', () => {
    // mini не знает 'width' — resolveCodec бросает ДО записи (не молчаливый
    // fallback на первый попавшийся кодек). Явная пара [10,100] исключает
    // побочный бросок при чтении from — тест пинует ИМЕННО резолв кодека.
    const f = fakeEl();
    expect(() => animate(f.el, { width: [10, 100] } as never)).toThrow(MotionParamError);
    expect(f.writes.length).toBe(0);
  });

  it('реестр: неизвестная цель fail-fast', () => {
    // number — не объект-цель ни одного адаптера.
    expect(() => animate(42 as never, { x: 1 })).toThrow(MotionParamError);
  });

  it('кастомный кодек ведёт новое свойство без правки движка', async () => {
    // ЗАКОН расширения: регистрируем кодек 'децибелы' (лог-шкала) — движок
    // прогоняет его теми же parse/interpolate/serialize, ни строки в engine.ts.
    const dbCodec: PropertyCodec<number> = {
      parse: (v) => Number(v),
      interpolate: (from, to) => (p) => from + (to - from) * p,
      serialize: (v) => `${v.toFixed(1)}dB`,
      canComposite: () => false,
    };
    const target: Record<string, unknown> = { db: '0' };
    const objAdapter: TargetAdapter = {
      read: (t, prop) => (t as Record<string, unknown>)[prop],
      surfaceOf: (p) => p,
      compose: (_s, ch) => {
        for (const v of ch.values()) return v;
        return '';
      },
      apply: (t, s, v) => {
        (t as Record<string, unknown>)[s] = v;
      },
    };
    const reg = createRegistry();
    reg.registerCodec((p) => p === 'db', dbCodec);
    reg.registerAdapter(() => true, objAdapter);
    const clock = makeClock();
    const c = runAnimate(reg, target, { db: [0, 6] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(target.db).toBe('6.0dB');
  });

  it('позже зарегистрированный кодек перекрывает ранний (last-first)', () => {
    const reg = createRegistry();
    const a: PropertyCodec<number> = { parse: () => 1, interpolate: () => () => 1, serialize: () => 'A', canComposite: () => false };
    const b: PropertyCodec<number> = { parse: () => 1, interpolate: () => () => 1, serialize: () => 'B', canComposite: () => false };
    reg.registerCodec(() => true, a);
    reg.registerCodec(() => true, b);
    expect(reg.resolveCodec('anything').serialize(1)).toBe('B');
  });
});
