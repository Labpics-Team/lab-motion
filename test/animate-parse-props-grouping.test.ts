import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProps, type ChannelSpec } from '../src/animate/channels.js';

function channelKeys(specs: readonly ChannelSpec[] | undefined): string[] {
  return specs?.map((spec) => spec._key) ?? [];
}

function hasSingleGroupingOwner(source: string): boolean {
  return (
    source.includes('const groups = parseProps(requireAnimateProps(props));') &&
    !/\bgroupSpecs\s*\(/.test(source)
  );
}

describe('animate: владение группировкой parseProps', () => {
  it('сохраняет порядок групп и каналов при смешанных свойствах', () => {
    const groups = parseProps({
      x: [0, 10],
      rotate: [0, 90],
      scale: [1, 2],
      opacity: [0, 1],
      marginLeft: ['0px', '12px'],
    });

    expect([...groups.keys()]).toEqual(['transform', 'opacity', 'margin-left']);
    expect(channelKeys(groups.get('transform'))).toEqual([
      'x',
      'rotate',
      'scaleX',
      'scaleY',
    ]);
    expect(channelKeys(groups.get('opacity'))).toEqual(['opacity']);
    expect(channelKeys(groups.get('margin-left'))).toEqual(['marginLeft']);
    expect(groups.get('margin-left')?.[0]?._kind).toBe('css');
  });

  it('не дублирует явно заданную ось scale', () => {
    const groups = parseProps({ scale: 2, scaleX: 3 });

    expect(channelKeys(groups.get('transform'))).toEqual(['scaleY', 'scaleX']);
  });

  it('оставляет parseProps единственным владельцем группировки в animate', () => {
    const source = readFileSync(
      new URL('../src/animate/index.ts', import.meta.url),
      'utf8',
    );

    expect(hasSingleGroupingOwner(source)).toBe(true);
  });

  it('структурный gate ловит возвращение второго группирующего прохода', () => {
    const mutant = `
const specs = parseProps(requireAnimateProps(props));
function groupSpecs(specs) { return new Map(); }
const groups = groupSpecs(specs);
`;

    expect(hasSingleGroupingOwner(mutant)).toBe(false);
  });
});
