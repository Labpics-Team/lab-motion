/**
 * Тест: закрытие класса catastrophic-backtracking ReDoS в parseUnit's var()-регексе.
 * Класс В (pathological-input regression): раньше `VAR_RE` содержал ТРИ
 * квантификатора над пересекающимися символьными классами вокруг
 * fallback-хвоста (`\s*(?:,\s*([\s\S]*?)\s*)?\)`) — ведущий `\s*`, ленивый
 * `[\s\S]*?` и завершающий `\s*` могут делить один и тот же whitespace-ран
 * между собой множеством способов → полиномиальный (эмпирически ~O(n^3))
 * backtracking на входах, где после запятой идёт длинный whitespace-ран
 * и строка не заканчивается на `)`.
 *
 * ВАЖНО про trim(): payload не может быть "запятая + N пробелов" —
 * `value.trim()` в parseUnit съедает whitespace-suffix ДО регекса, что
 * тривиально "чинит" такой payload безотносительно регекса (замер это
 * подтвердил: len после trim схлопывается до 8 символов, 0ms). Реальный
 * pathological-вход обязан иметь не-whitespace якорь ПОСЛЕ whitespace-рана
 * (например хвостовой символ, который не `)`), чтобы trim() не удалил ран
 * и регекс был вынужден перебирать все разбиения перед провалом.
 *
 * Замер до фикса (node -e, эта же регулярка, `'var(--a, ' + ' '.repeat(n) + 'x'`,
 * т.е. РОВНО то, что проходит через реальный parseUnit после .trim()):
 *   1000 пробелов → ~114ms
 *   2000 пробелов → ~833ms
 *   4000 пробелов → ~6648ms      (рост ~8× на удвоение входа)
 *
 * RED-доказательство:
 *   Ревёрт VAR_RE на `/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*?)\s*)?\)$/i`
 *   (убрать линеаризацию) → тест "pathological var(): длинный whitespace-ран
 *   после запятой без закрывающей скобки" падает по правильной причине —
 *   либо превышает BUDGET_MS (секунды вместо миллисекунд), либо тайм-аутит
 *   весь vitest-воркер на 3000-символьном входе (< MAX_PARSE_LENGTH, так что
 *   length-guard тут ни при чём — падение изолированно доказывает баг именно
 *   в регексе). Восстановление линеаризации → GREEN, тест укладывается в
 *   миллисекунды.
 *   Отдельно: убрать MAX_PARSE_LENGTH-guard (сохранив линеаризацию regex) →
 *   тест "вход длиннее MAX_PARSE_LENGTH" падает (валидный длинный var()
 *   больше не отклоняется на входе, хотя сам regex уже безопасен —
 *   guard это отдельный, defense-in-depth слой).
 */

import { describe, expect, it } from 'vitest';
import { parseUnit } from '../src/value/index.js';

const BUDGET_MS = 300;

describe('parseUnit: var() ReDoS-класс закрыт', () => {
  it('pathological var(): длинный whitespace-ран после запятой без закрывающей скобки', () => {
    // Хвостовой 'x' (не whitespace, не ')') не даёт value.trim() схлопнуть
    // ран пробелов — именно так выглядит реальный pathological-вход,
    // дошедший до регекса. Длина ~3010 < MAX_PARSE_LENGTH (4096), поэтому
    // падение теста при ревёрте регекса нельзя списать на length-guard.
    const payload = 'var(--a, ' + ' '.repeat(3_000) + 'x';
    const start = Date.now();
    expect(() => parseUnit(payload)).toThrow(RangeError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('pathological var(): смешанный \\t/\\n whitespace-ран после запятой', () => {
    const payload = 'var(--a, ' + '\t\n '.repeat(1_000) + 'x';
    const start = Date.now();
    expect(() => parseUnit(payload)).toThrow(RangeError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('очень большой (>MAX_PARSE_LENGTH) pathological-вход отклоняется мгновенно guard-ом', () => {
    // 120k символов — размер, которым реально атакуют; здесь целиком
    // полагаемся на defense-in-depth length-guard (сам regex тоже линеен,
    // но проверять его на 120k нет смысла — guard обязан сработать раньше).
    const payload = 'var(--a, ' + ' '.repeat(120_000) + 'x';
    const start = Date.now();
    expect(() => parseUnit(payload)).toThrow(RangeError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('вход длиннее MAX_PARSE_LENGTH → RangeError сразу, без .exec (defense-in-depth)', () => {
    // Полностью валидный (при отсутствии guard успешно распарсился бы)
    // var() с длинным fallback — guard обязан отклонить его по одной лишь
    // длине, до попытки regex.exec.
    const payload = 'var(--a, ' + '1'.repeat(5000) + ')';
    expect(() => parseUnit(payload)).toThrow(RangeError);
  });

  it('вложенная скобка в fallback (короткий вход) парсится быстро и корректно', () => {
    const start = Date.now();
    const r = parseUnit('var(--a, ' + ' '.repeat(50) + 'rgb(0,0,0))');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(r).toEqual({ kind: 'var', name: '--a', fallback: 'rgb(0,0,0)' });
  });
});

describe('parseUnit: var() семантика сохранена (regression)', () => {
  it('nested var(--a, rgb(0,0,0)) → ParsedVar с fallback "rgb(0,0,0)"', () => {
    expect(parseUnit('var(--a, rgb(0,0,0))')).toEqual({
      kind: 'var', name: '--a', fallback: 'rgb(0,0,0)',
    });
  });

  it('var(--x) без fallback — не изменилось', () => {
    expect(parseUnit('var(--x)')).toEqual({ kind: 'var', name: '--x', fallback: undefined });
  });

  it('var(--x, 10px) — не изменилось', () => {
    expect(parseUnit('var(--x, 10px)')).toEqual({
      kind: 'var', name: '--x', fallback: '10px',
    });
  });

  it('var( --x ) с пробелами вокруг имени — не изменилось', () => {
    expect(parseUnit('var( --x )')).toMatchObject({ kind: 'var', name: '--x' });
  });

  it('var(--color, red) — fallback без юнита не изменился', () => {
    expect(parseUnit('var(--color, red)')).toEqual({
      kind: 'var', name: '--color', fallback: 'red',
    });
  });
});
