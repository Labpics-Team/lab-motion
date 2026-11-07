import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback, SequenceStep } from '../src/motion/types.js';

it('сборка длинной sequence ограничивает чтения сегментов и не мутирует входные массивы', async () => {
  const source = readFileSync(resolve('src/motion/sequence.ts'), 'utf8');
  const boundary = 'const segments = before?._program._segments ?? [];';
  const signature = 'options?: SequenceOptions): Playback {';
  expect(source.split(boundary)).toHaveLength(2);
  expect(source.split(signature)).toHaveLength(3);
  const count = 128;
  const records: Array<{ copy: string; reads: number }> = [];
  // Накопитель — частный [], недоступный через _draft. Инструментируем только
  // эту границу в изолированной копии исходника; checkout и globals не меняются.
  for (const copy of ['identity', 'slice', 'spread', 'concat']) {
    const expression = copy === 'identity' ? 'observe(before?._program._segments ?? [])'
      : copy === 'slice' ? 'observe(before?._program._segments ?? []).slice()'
      : copy === 'spread' ? '[...observe(before?._program._segments ?? [])]'
      : 'observe(before?._program._segments ?? []).concat()';
    const instrumented = source.replace(signature,
      'options: SequenceOptions | undefined, observe: (segments: Segment[]) => Segment[]): Playback {')
      .replace(boundary, `const segments = ${expression};`);
    const output = buildSync({ stdin: { contents: instrumented, resolveDir: resolve('src/motion'), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', write: false });
    const module = { exports: {} as { runSequence: (
      engine: ReturnType<typeof harness>['runtime'], steps: SequenceStep[], options: undefined,
      observe: <T extends object>(segments: T) => T,
    ) => Playback } };
    new Function('module', 'exports', output.outputFiles[0]!.text)(module, module.exports);
    const h = harness();
    let reads = 0, assembling = true;
    const proxies = new WeakMap<object, object>();
    const measure = <T extends object>(segments: T): T => {
      const existing = proxies.get(segments);
      if (existing) return existing as T;
      const proxy = new Proxy(segments, { get(target, key, receiver) {
        if (assembling && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      } });
      proxies.set(segments, proxy); proxies.set(proxy, proxy);
      return proxy;
    };
    const inputs: ReadonlyArray<unknown>[] = [];
    const steps: SequenceStep[] = Array.from({ length: count }, (_, index) => [
      h.element, { x: index + 1 }, { duration: 10, ease: 'linear' },
    ]);
    let run: Playback | undefined;
    const draft = h.runtime._draft.bind(h.runtime);
    const observe = vi.spyOn(h.runtime, '_draft').mockImplementation((...args) => {
      const result = draft(...args);
      for (const entry of result) {
        const segments = entry._program._segments;
        Object.freeze(segments);
        inputs.push(segments);
        entry._program = { ...entry._program, _segments: measure(segments) };
      }
      return result;
    });
    try {
      const execute = h.runtime._execute.bind(h.runtime);
      const execution = vi.spyOn(h.runtime, '_execute').mockImplementation((...args) => {
        assembling = false;
        return execute(...args);
      });
      try {
        run = module.exports.runSequence(h.runtime, steps, undefined, measure);
        records.push({ copy, reads });
        // Индексные чтения наблюдают iterator, slice и concat без глобальных перехватов.
        if (copy === 'identity') expect(reads).toBeLessThanOrEqual(count * 3);
        else expect(reads).toBeGreaterThan(count * (count - 1) / 2);
        expect(inputs).toHaveLength(count);
        for (const segments of inputs) expect(segments).toHaveLength(1);
        expect(run!.duration).toBe(count * 10);
        run!.seek(1235); expect(h.x()).toBe(123.5);
        run!.seek(5); expect(h.x()).toBe(0.5);
        run!.finish(); expect(await run!.finished).toEqual({ status: 'finished' });
        expect(h.x()).toBe(count);
        expect(h.updates.size + h.renders.size).toBe(0);
      } finally {
        try { run?.stop(); } finally { execution.mockRestore(); }
      }
    } finally { observe.mockRestore(); }
  }
  console.log('sequence copy-work mutation receipt', JSON.stringify(records));
});
