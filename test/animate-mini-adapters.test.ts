/**
 * test/animate-mini-adapters.test.ts — contract-тесты шва кодеков/адаптеров.
 *
 * Пинует ЗАКОН расширения (registry.ts): новый вид свойства/цели входит НОВОЙ
 * реализацией кодека/адаптера за швом CodecResolver, движок (engine.ts) не
 * меняется и не ветвится по имени свойства. Ручные реализации шва в тестах —
 * норма контракта: живой код здесь — движок, шов — инъекционная точка.
 *
 * MUTATION PROOF-якоря:
 *   - слом resolver→fallback-switch → 'resolver: неизвестное свойство fail-fast';
 *   - кадровые аллокации карты композиции → 'горячий render переиспользует
 *     одну карту композиции без кадровых аллокаций';
 *   - расширение за швом → 'кастомный кодек ведёт новое свойство без правки движка'.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { runAnimate } from '../src/animate/mini/engine.js';
import type { CodecResolver, PropertyCodec, TargetAdapter } from '../src/animate/registry.js';
import { numberCodec } from '../src/animate/mini-codecs.js';
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

// ─── resolver-шов: fail-fast и расширение ─────────────────────────────────────

describe('resolver-шов — fail-fast и расширение', () => {
  it('горячий render переиспользует одну карту композиции без кадровых аллокаций', () => {
    const maps: ReadonlyMap<string, string | number>[] = [];
    const target = { level: 0 };
    const adapter: TargetAdapter = {
      _read: (t, property) => (t as Record<string, unknown>)[property],
      _surfaceOf: (property) => property,
      _compose: (_surface, channels) => {
        maps.push(channels);
        return channels.get('level') ?? 0;
      },
      _apply: (t, property, value) => {
        (t as Record<string, unknown>)[property] = value;
      },
    };
    // Пинуется движок (одна карта на поверхность), не выбор кодека — шов
    // подставлен минимальной ручной реализацией CodecResolver.
    const registry: CodecResolver = {
      _resolveCodec: () => numberCodec,
      _resolveAdapter: () => adapter,
    };
    const clock = makeClock();
    const controls = runAnimate(
      registry,
      target,
      { level: 1 },
      { ...RF(clock), duration: 1000 },
    );
    clock.step(16);
    clock.step(16);
    clock.step(16);

    expect(maps.length).toBeGreaterThan(1);
    expect(new Set(maps).size).toBe(1);
    controls.cancel();
  });

  it('resolver: неизвестное свойство fail-fast', () => {
    // mini не знает 'width' — _resolveCodec бросает ДО записи (не молчаливый
    // fallback на первый попавшийся кодек). Явная пара [10,100] исключает
    // побочный бросок при чтении from — тест пинует ИМЕННО резолв кодека.
    const f = fakeEl();
    expect(() => animate(f.el, { width: [10, 100] } as never)).toThrow(MotionParamError);
    expect(f.writes.length).toBe(0);
  });

  it('resolver: неизвестная цель fail-fast', () => {
    // number — не объект-цель ни одного адаптера.
    expect(() => animate(42 as never, { x: 1 })).toThrow(MotionParamError);
  });

  it('кастомный кодек ведёт новое свойство без правки движка', async () => {
    // ЗАКОН расширения: кодек 'децибелы' (лог-шкала) за швом — движок
    // прогоняет его теми же parse/interpolate/serialize, ни строки в engine.ts.
    const dbCodec: PropertyCodec<number> = {
      _parse: (v) => Number(v),
      _interpolate: (from, to) => (p) => from + (to - from) * p,
      _serialize: (v) => `${v.toFixed(1)}dB`,
    };
    const target: Record<string, unknown> = { db: '0' };
    const objAdapter: TargetAdapter = {
      _read: (t, prop) => (t as Record<string, unknown>)[prop],
      _surfaceOf: (p) => p,
      _compose: (_s, ch) => {
        for (const v of ch.values()) return v;
        return '';
      },
      _apply: (t, s, v) => {
        (t as Record<string, unknown>)[s] = v;
      },
    };
    const reg: CodecResolver = {
      _resolveCodec: (p) => {
        if (p === 'db') return dbCodec;
        throw new MotionParamError('LM145');
      },
      _resolveAdapter: () => objAdapter,
    };
    const clock = makeClock();
    const c = runAnimate(reg, target, { db: [0, 6] }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(target.db).toBe('6.0dB');
  });
});
