import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import { motionCompiler } from '../src/compiler/vite/index.js';

async function transform(code: string) {
  const ast = await parseAstAsync(code);
  return motionCompiler().transform.call({ parse: () => ast, warn(message) { throw new Error(message); } }, code, '/app/motion.ts');
}
const surface = (name: string) => `${name}(el, { width: [240, 360] }, { layout: 'project' });`;
const nano = (name: string) => `${name}(el, { opacity: 0.5 });`;
const families = [
  { path: 'animate', call: surface, marker: '__labMotionSurface', executor: 'surface' },
  { path: 'nano', call: nano, marker: '__labMotionNanoCompiled', executor: 'runtime' },
];

for (const family of families) describe(`локальные имена ${family.path}`, () => {
  for (const name of ['move', '$motion', 'движение']) it(`статический импорт ${name} получает тот же исполнитель`, async () => {
    const code = `import { animate as ${name} } from '@labpics/motion/${family.path}';\nexport function play(el) { ${family.call(name)} }`;
    const output = await transform(code);
    expect(output).toBeDefined();
    expect(output!.code).toContain(`${family.marker}(el,`);
    expect(output!.code).toContain(`from "@labpics/motion/compiler/${family.executor}"`);
    expect(output!.map.sourcesContent).toEqual([code]);
    await expect(parseAstAsync(output!.code)).resolves.toBeDefined();
  });

  it('два имени одного экспорта не путает с одноимённой чужой функцией', async () => {
    const code = `import { animate as first, animate as second } from '@labpics/motion/${family.path}';
import { animate } from 'other-animation';
export function play(el) { ${family.call('first')} ${family.call('second')} ${family.call('animate')} }`;
    const result = await transform(code);
    expect(result!.code.match(new RegExp(`${family.marker}\\(el,`, 'g'))).toHaveLength(2);
    expect(result!.code).toContain(family.call('animate'));
  });

  it('независимый локальный animate не затеняет переименованный импорт', async () => {
    const code = `import { animate as move } from '@labpics/motion/${family.path}';
function other(animate) { return animate; }
export function play(el) { ${family.call('move')} }`;
    expect((await transform(code))!.code).toContain(`${family.marker}(el,`);
  });

  for (const declaration of ['function other(move) {}', 'function other({ move }) {}', 'function other() { const move = () => {}; }']) {
    it(`сохраняет консервативный отказ при затенении: ${declaration}`, async () => {
      const code = `import { animate as move } from '@labpics/motion/${family.path}';\n${declaration}\nexport function play(el) { ${family.call('move')} }`;
      expect(await transform(code)).toBeUndefined();
    });
  }

  it('не следует через присваивание и не меняет optional-call', async () => {
    for (const call of [family.call('indirect'), family.call('move').replace('move(', 'move?.(')]) {
      const code = `import { animate as move } from '@labpics/motion/${family.path}'; const indirect = move;\n${call}`;
      expect(await transform(code)).toBeUndefined();
    }
  });

  it('новый helper не захватывает существующее имя потребителя', async () => {
    const code = `import { animate as move } from '@labpics/motion/${family.path}';\nconst ${family.marker} = 7;\n${family.call('move')}`;
    expect(await transform(code)).toBeUndefined();
  });
});

it('оба исполнителя работают в одном модуле независимо от порядка импортов', async () => {
  const imports = ["import { animate as fade } from '@labpics/motion/nano';", "import { animate as resize } from '@labpics/motion/animate';"];
  for (const lines of [imports, [...imports].reverse()]) {
    const code = lines.join('\n') + `\nexport function play(el) {\n ${nano('fade')}\n ${surface('resize')}\n}\n`;
    const output = await transform(code);
    expect(output!.code).toContain('__labMotionNanoCompiled(el,');
    expect(output!.code).toContain('__labMotionSurface(el,');
    expect(output!.map.mappings.split(';')).toHaveLength(output!.code.split('\n').length);
    expect(output!.map.mappings.split(';').slice(-2)).toEqual(['', '']);
    await expect(parseAstAsync(output!.code)).resolves.toBeDefined();
  }
});

it('смешанный файл сохраняет runtime для используемого результата и динамических значений', async () => {
  const code = `import { animate as fade } from '@labpics/motion/nano';
import { animate as resize } from '@labpics/motion/animate';
export function play(el, width) {
  ${nano('fade')}
  resize(el, { width: [240, width] }, { layout: 'project' });
  return resize(el, { width: [240, 360] }, { layout: 'project' });
}`;
  const output = await transform(code);
  expect(output!.code).toContain('__labMotionNanoCompiled(el,');
  expect(output!.code).not.toContain('__labMotionSurface');
  expect(output!.code).toContain('width: [240, width]');
  expect(output!.code).toContain('return resize(el,');
});
