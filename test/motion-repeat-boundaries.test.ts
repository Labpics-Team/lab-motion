import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';

it('обычная подготовка времени и Nano не включают исполнитель повторов', () => {
  for (const entry of ['src/motion/timing.ts', 'src/nano/index.ts']) {
    const result = buildSync({
      stdin: { contents: entry.includes('timing') ? "export { timing } from './src/motion/timing.ts';" : "export * from './src/nano/index.ts';", resolveDir: process.cwd() },
      bundle: true, treeShaking: true, write: false, metafile: true, format: 'esm', platform: 'browser',
    });
    const live = Object.values(result.metafile!.outputs).flatMap(output => Object.entries(output.inputs))
      .filter(([, contribution]) => contribution.bytesInOutput > 0).map(([path]) => path);
    expect(live.some(path => /(?:motion\/repeat|internal\/(?:repeat-cursor|schedule-v1))\.[jt]s$/.test(path)), entry).toBe(false);
  }
});
