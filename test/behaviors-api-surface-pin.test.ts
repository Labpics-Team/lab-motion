import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as behaviors from '../src/behaviors/index.js';

const factories = ['createBottomSheet', 'createCarousel', 'createDragDismiss', 'createPullToRefresh'];
const types = ['SheetState', 'SheetOptions', 'SheetController', 'CarouselState', 'CarouselOptions',
  'CarouselController', 'DismissState', 'DismissOptions', 'DismissController', 'PullState',
  'PullOptions', 'PullController', 'BehaviorState', 'BehaviorPhase', 'BehaviorPoint', 'BehaviorAxis'];
const retired = new RegExp(`\\b(?:${[...factories, ...types].join('|')})\\b`);
const root = resolve('.');

describe('граница motion-пакета и UI-компонентов', () => {
  it('behaviors экспортирует только каскад произвольных целей', () => {
    expect(Object.keys(behaviors)).toEqual(['createStateCascade']);
    const state = behaviors.createStateCascade<{ position: number }>();
    const base = state.createLayer({ position: 1 });
    const transient = state.createLayer({ position: 2 });
    expect(state.get('position')).toBe(2);
    base.set({ position: 3 });
    transient.clear();
    expect(state.get('position')).toBe(3);
    state.destroy();
  });

  it('установленный tarball сохраняет общие ESM/CJS/types и исключает компонентные API', () => {
    const work = mkdtempSync(join(tmpdir(), 'motion boundary-'));
    try {
      const windows = process.platform === 'win32';
      const [archive] = JSON.parse(execFileSync(windows ? 'npm.cmd' : 'npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', windows ? `"${work}"` : work,
      ], { cwd: root, encoding: 'utf8', shell: windows, timeout: 30_000 }));
      const installed = join(work, 'node_modules', '@labpics', 'motion');
      mkdirSync(installed, { recursive: true });
      execFileSync('tar', ['-xzf', join(work, archive.filename), '-C', installed, '--strip-components=1']);
      writeFileSync(join(work, 'package.json'), '{"type":"module"}');
      expect(readFileSync(join(installed, 'package.json'))).toEqual(readFileSync(join(root, 'package.json')));

      // Проверяется содержимое поставки, включая декларации внутренних файлов:
      // удаление только barrel-экспорта не скроет оставшийся компонентный runtime.
      const dist = join(installed, 'dist');
      const files = readdirSync(dist, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
      expect(files.some(entry => entry.name === 'index.d.ts')).toBe(true);
      for (const entry of files) {
        const file = join(entry.parentPath, entry.name);
        expect(readFileSync(file, 'utf8').match(retired), file).toBeNull();
      }
      for (const esm of [true, false]) {
        const load = (name: string): string => esm ? `await import('${name}')` : `require('${name}')`;
        const script = `const assert = ${load('node:assert/strict')};
          const behaviors = ${load('@labpics/motion/behaviors')};
          assert.deepEqual(Object.keys(behaviors), ['createStateCascade']);
          const state = behaviors.createStateCascade();
          const layer = state.createLayer({ x: 0 }); layer.set({ x: 12 });
          assert.equal(state.get('x'), 12); state.destroy();
          const { createCompositorFollow } = ${load('@labpics/motion/compositor/follow')};
          const motion = createCompositorFollow({ spring: { mass: 1, stiffness: 170, damping: 26 },
            property: 'opacity', from: 0, to: 1, apply() {}, matchMedia: () => ({ matches: true }) });
          motion.beginFollow(0); motion.follow(0.25, 0.1); motion.settle(1, 0.1);
          assert.equal(motion.value, 1); motion.destroy();
          const { createReorder } = ${load('@labpics/motion/behaviors/reorder')};
          const order = createReorder({ items: [], onReorder() {} }); order.destroy();`;
        execFileSync(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', script],
          { cwd: work, encoding: 'utf8', timeout: 30_000 });
      }
      const missing = [
        ...factories.map((name, i) => `// @ts-expect-error компонентная фабрика удалена\ntype Factory${i} = typeof import('@labpics/motion/behaviors').${name};`),
        ...types.map((name, i) => `// @ts-expect-error компонентный тип удалён\ntype Retired${i} = import('@labpics/motion/behaviors').${name};`),
      ].join('\n');
      for (const extension of ['mts', 'cts']) {
        const file = join(work, `consumer.${extension}`);
        writeFileSync(file, `import { createStateCascade, type StateCascade } from '@labpics/motion/behaviors';
          import { createCompositorFollow, type CompositorFollow } from '@labpics/motion/compositor/follow';
          import { createReorder, type ReorderController } from '@labpics/motion/behaviors/reorder';
          const state: StateCascade<{ x: number }> = createStateCascade();
          state.createLayer({ x: 1 }); state.destroy();
          const motion: CompositorFollow = createCompositorFollow({
            spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'opacity', from: 0, to: 1 });
          motion.destroy();
          const order: ReorderController<'a'> = createReorder({ items: [{ key: 'a' }], onReorder() {} });
          order.destroy();\n${missing}`);
        const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true,
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] });
        expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
