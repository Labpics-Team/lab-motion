import { realpathSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseSequencePairArgs } from '../scripts/bench-sequence-pair.mjs';

it('сравнение принимает два dist и допускает одинаковый путь для A/A', () => {
  const root = realpathSync('.');
  expect(parseSequencePairArgs(['--baseline', '.', '--current', '.'])).toEqual({
    roots: { baseline: root, current: root }, browser: 'chromium',
  });
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    expect(parseSequencePairArgs(['--baseline', '.', '--current', '.', '--browser', browser]).browser).toBe(browser);
  }
});

it('не принимает неизвестные флаги, неполные аргументы и несуществующий dist', () => {
  for (const args of [[], ['--baseline', '.'], ['--current', '.', '--baseline', '.'],
    ['--baseline', '.', '--current', '.', '--browser', 'unknown'],
    ['--baseline', '.', '--current', '.', '--ignore-errors', 'true']]) {
    expect(() => parseSequencePairArgs(args)).toThrow('Usage:');
  }
  expect(() => parseSequencePairArgs(['--baseline', '__missing_sequence_artifact__', '--current', '.'])).toThrow();
});
