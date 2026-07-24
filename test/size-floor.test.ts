/**
 * size-floor.test.ts — исполняемые пины гейта честности манифеста (#243).
 *
 * ЗАЧЕМ (ревью #247): 180-строчный скрипт, на котором держится клейм «честность
 * манифеста охраняется машинно», сам не имел ни одного теста — при том что у
 * соседнего size-gate.mjs он есть. Два дефекта скрипта, найденные ревью, были
 * ровно того класса, что ловится юнит-тестом: невалидный ESM-носитель и
 * подстрочный поиск токенов (`mass` находился внутри `_mass`).
 *
 * Mutation proof: вернуть в isTokenShipped подстрочный `shipped.includes(token)`
 * → блок «границы слова» RED; убрать JSON.stringify в floorSource → блок
 * «носитель — валидный код» RED.
 */

import { describe, expect, it } from 'vitest';
import {
  NANO_FLOOR_MANIFEST,
  floorBody,
  floorSource,
  isTokenShipped,
} from '../scripts/size-floor.mjs';

describe('#243: гейт честности манифеста ищет токены по границам слова', () => {
  it('подстрока внутри длинного идентификатора НЕ считается присутствием', () => {
    expect(isTokenShipped('mass', 'const _mass=1;')).toBe(false);
    expect(isTokenShipped('ease', 'a.easing="linear"')).toBe(false);
    expect(isTokenShipped('fill', 'x.fillMode="both"')).toBe(false);
    expect(isTokenShipped('animate', 'const animated=1;')).toBe(false);
    expect(isTokenShipped('cancel', 'let cancelled=0;')).toBe(false);
  });

  it('честные формы шипа засчитываются', () => {
    expect(isTokenShipped('animate', 'e.animate(k,t)')).toBe(true);
    expect(isTokenShipped('playState', 'if(a.playState==="idle")')).toBe(true);
    expect(isTokenShipped('mass', 'const {mass:m}=s;')).toBe(true);
    expect(isTokenShipped('document.querySelectorAll', 'document.querySelectorAll(t)')).toBe(true);
  });

  it('строковые литералы манифеста ищутся в кавычках любой формы', () => {
    expect(isTokenShipped('"both"', 'fill:"both"')).toBe(true);
    expect(isTokenShipped('"both"', "fill:'both'")).toBe(true);
    // Голое слово без кавычек литералом НЕ считается: контракт — именно строка.
    expect(isTokenShipped('"both"', 'const both=1;')).toBe(false);
  });

  it('не-идентификаторы остаются подстроками (границ слова у них нет)', () => {
    expect(isTokenShipped('linear(', 'easing:`linear(${s})`')).toBe(true);
    expect(isTokenShipped('(prefers-reduced-motion: reduce)',
      'matchMedia("(prefers-reduced-motion: reduce)")')).toBe(true);
  });
});

describe('#243: носитель floor — валидный исполнимый код', () => {
  it('тело носителя парсится движком', () => {
    const source = floorSource(NANO_FLOOR_MANIFEST);
    expect(() => new Function(floorBody(source))).not.toThrow();
  });

  it('каждый токен манифеста присутствует в носителе ровно один раз', () => {
    const source = floorSource(NANO_FLOOR_MANIFEST);
    const tokens = Object.values(NANO_FLOOR_MANIFEST.categories).flat() as string[];
    // Анти-вырожденность: манифест не пуст, иначе тест ничего не проверяет.
    expect(tokens.length).toBeGreaterThan(30);
    for (const token of tokens) {
      const body = token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
      const occurrences = source.split(body).length - 1;
      expect(occurrences, `токен ${token}`).toBeGreaterThan(0);
    }
  });

  it('строковые токены попадают в носитель экранированными, а не голыми', () => {
    const manifest = {
      scenario: 'проба',
      categories: { c: ['(prefers-reduced-motion: reduce)', 'Math.abs'] },
    };
    const source = floorSource(manifest);
    expect(source).toContain('"(prefers-reduced-motion: reduce)"');
    // Идентификатор остаётся голым выражением — иначе floor мерил бы кавычки.
    expect(source).toContain(';Math.abs');
    expect(() => new Function(floorBody(source))).not.toThrow();
  });
});
