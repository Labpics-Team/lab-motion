/**
 * test/compositor-cache.test.ts — ограниченный LRU-кэш linear()-строк.
 * Классы: А (roundtrip/eviction/recency), Д (mutation-хуки LRU и верификации ключа).
 *
 * ── RED PROOF (мутации) ───────────────────────────────────────────────────────
 * - Убрать _moveToHead из lookup → «recency: touched выживает» RED (выжил бы LRU-хвост).
 * - Убрать вытеснение хвоста → «size ≤ capacity» RED (кэш растёт неограниченно).
 * - Убрать сверку полей в lookup (только хеш) → «отличный ключ → промах» RED.
 * - Сломать переиспользование узла при вытеснении → тесты eviction всё равно
 *   зелены (аллокация нового узла корректна), но контракт zero-alloc держится
 *   структурно (см. cache.ts): ветка попадания не аллоцирует и не рекомпилирует.
 *
 * Замечание о zero-alloc-на-попадании: строки в JS — примитивы, сравниваются по
 * значению, поэтому reference-identity их не отличает. Контракт доказывается
 * СТРУКТУРНО (lookup не содержит пути компиляции/аллокации) + стабильностью size
 * (повторная компиляция того же ключа НЕ растит кэш → путь попадания взят).
 */

import { describe, expect, it } from 'vitest';
import { SpringLinearCache, DEFAULT_CACHE_CAPACITY } from '../src/compositor/cache.js';
import { createSpringLinearCache, compileSpringLinear } from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

// ─── SpringLinearCache: прямой юнит LRU ───────────────────────────────────────

describe('compositor cache: SpringLinearCache — roundtrip', () => {
  it('store → lookup возвращает то же значение; промах → undefined', () => {
    const c = new SpringLinearCache(4);
    expect(c.lookup(1, 2, 3, 4, 5)).toBeUndefined();
    c.store(1, 2, 3, 4, 5, 'linear(A)');
    expect(c.lookup(1, 2, 3, 4, 5)).toBe('linear(A)');
    expect(c.size).toBe(1);
  });

  it('отличный хоть на одно поле ключ → промах (верификация ключа, не только хеш)', () => {
    const c = new SpringLinearCache(4);
    c.store(1, 2, 3, 4, 5, 'X');
    expect(c.lookup(1, 2, 3, 4, 6)).toBeUndefined(); // e отличается
    expect(c.lookup(9, 2, 3, 4, 5)).toBeUndefined(); // a отличается
    expect(c.lookup(1, 2, 3, 4, 5)).toBe('X'); // точный ключ — попадание
  });

  it('повторный store того же ключа не растит size (перезапись на месте)', () => {
    const c = new SpringLinearCache(4);
    c.store(1, 1, 1, 1, 1, 'v1');
    c.store(1, 1, 1, 1, 1, 'v2');
    expect(c.size).toBe(1);
    expect(c.lookup(1, 1, 1, 1, 1)).toBe('v2');
  });
});

describe('compositor cache: LRU-вытеснение и recency', () => {
  it('size никогда не превышает capacity; LRU вытесняется', () => {
    const c = new SpringLinearCache(2);
    c.store(1, 0, 0, 0, 0, 'A');
    c.store(2, 0, 0, 0, 0, 'B');
    c.store(3, 0, 0, 0, 0, 'C'); // вытесняет A (самый старый)
    expect(c.size).toBe(2);
    expect(c.lookup(1, 0, 0, 0, 0)).toBeUndefined(); // A вытеснен
    expect(c.lookup(2, 0, 0, 0, 0)).toBe('B');
    expect(c.lookup(3, 0, 0, 0, 0)).toBe('C');
  });

  it('recency: lookup поднимает узел в голову — вытесняется НЕ он', () => {
    const c = new SpringLinearCache(2);
    c.store(1, 0, 0, 0, 0, 'A');
    c.store(2, 0, 0, 0, 0, 'B');
    c.lookup(1, 0, 0, 0, 0); // трогаем A → теперь B самый старый
    c.store(3, 0, 0, 0, 0, 'C'); // должно вытеснить B, не A
    expect(c.lookup(1, 0, 0, 0, 0)).toBe('A'); // выжил (был тронут)
    expect(c.lookup(2, 0, 0, 0, 0)).toBeUndefined(); // B вытеснен
    expect(c.lookup(3, 0, 0, 0, 0)).toBe('C');
  });

  it('clear опустошает кэш', () => {
    const c = new SpringLinearCache(4);
    c.store(1, 2, 3, 4, 5, 'X');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.lookup(1, 2, 3, 4, 5)).toBeUndefined();
  });

  it('невалидная ёмкость → дефолт', () => {
    expect(new SpringLinearCache(0).capacity).toBe(DEFAULT_CACHE_CAPACITY);
    expect(new SpringLinearCache(-5).capacity).toBe(DEFAULT_CACHE_CAPACITY);
    expect(new SpringLinearCache(2.5).capacity).toBe(DEFAULT_CACHE_CAPACITY);
    expect(new SpringLinearCache(8).capacity).toBe(8);
  });

  it('заполнение под завязку + поток промахов держит size = capacity (переиспользование хвоста)', () => {
    const c = new SpringLinearCache(3);
    for (let i = 0; i < 50; i++) c.store(i, 0, 0, 0, 0, `v${i}`);
    expect(c.size).toBe(3);
    // Последние три должны быть на месте.
    expect(c.lookup(49, 0, 0, 0, 0)).toBe('v49');
    expect(c.lookup(48, 0, 0, 0, 0)).toBe('v48');
    expect(c.lookup(47, 0, 0, 0, 0)).toBe('v47');
    expect(c.lookup(46, 0, 0, 0, 0)).toBeUndefined();
  });
});

// ─── createSpringLinearCache / compileSpringLinear: контракт кэша компилятора ─

const A: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const B: SpringParams = { mass: 1, stiffness: 180, damping: 8 };
const C: SpringParams = { mass: 1, stiffness: 120, damping: 30 };

describe('compositor cache: компилятор поверх кэша', () => {
  it('изолированный кэш: одинаковая пружина не растит size (путь попадания)', () => {
    const compiler = createSpringLinearCache(8);
    const s1 = compiler.compile(A);
    expect(compiler.size).toBe(1);
    const s2 = compiler.compile(A);
    expect(compiler.size).toBe(1); // попадание, не новая запись
    expect(s1).toBe(s2); // одинаковый результат
  });

  it('разные пружины → разные строки и рост кэша', () => {
    const compiler = createSpringLinearCache(8);
    const sa = compiler.compile(A);
    const sb = compiler.compile(B);
    expect(sa).not.toBe(sb);
    expect(compiler.size).toBe(2);
  });

  it('ёмкость соблюдается: size ≤ capacity при потоке разных пружин', () => {
    const compiler = createSpringLinearCache(2);
    compiler.compile(A);
    compiler.compile(B);
    compiler.compile(C); // вытесняет A
    expect(compiler.size).toBeLessThanOrEqual(2);
  });

  it('результат изолированного кэша == общего compileSpringLinear (одинаковая математика)', () => {
    const compiler = createSpringLinearCache(4);
    expect(compiler.compile(A)).toBe(compileSpringLinear(A));
    expect(compiler.compile(B, { tolerance: 0.001 })).toBe(
      compileSpringLinear(B, { tolerance: 0.001 }),
    );
  });

  it('clear компилятора сбрасывает кэш', () => {
    const compiler = createSpringLinearCache(4);
    compiler.compile(A);
    expect(compiler.size).toBe(1);
    compiler.clear();
    expect(compiler.size).toBe(0);
  });

  it('квантование: перцептивно-идентичные пружины делят план, но не грубо', () => {
    const compiler = createSpringLinearCache(8);
    compiler.compile({ mass: 1, stiffness: 170, damping: 26 });
    // Отличие ниже шага квантования (stiffness Q=1e4 → шаг 1e-4) → тот же ключ.
    compiler.compile({ mass: 1, stiffness: 170.000001, damping: 26 });
    expect(compiler.size).toBe(1);
    // Заметное отличие → отдельный план.
    compiler.compile({ mass: 1, stiffness: 175, damping: 26 });
    expect(compiler.size).toBe(2);
  });
});
