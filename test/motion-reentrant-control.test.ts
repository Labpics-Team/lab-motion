import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

it.each([false, true])('вложенное управление завершается без цикла: общий Runtime=%s', shared => {
  const work = mkdtempSync(join(tmpdir(), 'motion-reentry-'));
  try {
    const entry = join(work, 'probe.mjs'), output = join(work, 'probe-built.mjs');
    writeFileSync(entry, `
      import assert from 'node:assert/strict';
      import { Runtime } from RUNTIME_SOURCE;
      const updates = new Set(), renders = new Set();
      const frame = {
        read: () => () => {},
        update: callback => { updates.add(callback); return () => updates.delete(callback); },
        render: callback => { renders.add(callback); return () => renders.delete(callback); },
        cancelAll() { updates.clear(); renders.clear(); },
      };
      const host = { frame, now: () => 0, reduced: () => false,
        styles: element => element.style, supports: () => false };
      const first = new Runtime(host), second = SECOND_RUNTIME;
      const element = () => { const values = new Map(); return { style: {
        getPropertyValue: key => values.get(key) ?? '',
        setProperty: (key, value) => values.set(key, value),
      } }; };
      const left = element(), right = element();
      const options = { duration: 1000, ease: 'linear' };
      const a = first.animate(left, { x: 100 }, options);
      const b = second.animate(right, { x: 100 }, options);
      const write = left.style.setProperty;
      let nested = false;
      left.style.setProperty = (key, value) => {
        write(key, value);
        if (!nested) { nested = true; a.pause(); b.pause(); }
      };
      a.seek(100);
      assert.equal(nested, true);
      assert.equal(a.state, 'paused'); assert.equal(b.state, 'paused');
      assert.equal(updates.size + renders.size, 0);
      a.stop(); b.stop();
      assert.deepEqual(await a.finished, { status: 'stopped' });
      assert.deepEqual(await b.finished, { status: 'stopped' });
      console.log('reentry PASS');
    `.replace('RUNTIME_SOURCE', JSON.stringify(resolve('src/motion/runtime.ts')))
      .replace('SECOND_RUNTIME', shared ? 'first' : 'new Runtime(host)'));
    buildSync({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node' });
    expect(execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 10_000 })).toContain('reentry PASS');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 20_000);
