import { expect, it } from 'vitest';
import { CORE_GATE_BYTES, deriveKernelEntry } from '../scripts/size-gate.mjs';

it('размер ядра следует ESM-цели владельца независимо от внутреннего пути', () => {
  for (const path of ['./dist/index.js', './dist/private/kernel.js']) {
    for (const target of [path, { import: path }, { import: { default: path }, require: './dist/cjs-kernel.cjs' }]) {
      expect(deriveKernelEntry({ imports: { '#kernel': target } })).toEqual({
        key: '#kernel', label: 'core (#kernel)', importPath: path.slice(2), gate: CORE_GATE_BYTES,
      });
    }
  }
});

it('отсутствующее ядро не добавляется, а неразрешимый объявленный путь отклоняется', () => {
  expect(deriveKernelEntry({})).toBeUndefined();
  expect(deriveKernelEntry({ imports: { '#frame': './dist/frame/index.js' } })).toBeUndefined();
  for (const target of [null, {}, { require: './dist/kernel.cjs' }]) {
    expect(() => deriveKernelEntry({ imports: { '#kernel': target } })).toThrow('#kernel');
  }
});
