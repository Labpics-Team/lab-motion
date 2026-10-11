import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('установленные root и animate делят один кадровый проход', () => {
  const work = mkdtempSync(join(tmpdir(), 'motion-shared-frame-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', work], { stdio: 'pipe' });
    const archive = readdirSync(work).find(name => name.endsWith('.tgz'))!;
    const installed = join(work, 'node_modules/@labpics/motion');
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, archive), '--strip-components=1', '-C', installed]);
    writeFileSync(join(work, 'package.json'), '{"type":"module"}');
    writeFileSync(join(work, 'probe.mjs'), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      let id = 0; const pending = new Map();
      globalThis.requestAnimationFrame = cb => { pending.set(++id, cb); return id; };
      globalThis.cancelAnimationFrame = id => pending.delete(id);
      const element = () => { const values = new Map(); return { style: {
        getPropertyValue: key => values.get(key) ?? '',
        setProperty: (key, value) => values.set(key, value),
      } }; };
      for (const load of [specifier => import(specifier), specifier => require(specifier)]) {
        const root = await load('@labpics/motion');
        const legacy = await load('@labpics/motion/animate');
        const { frame } = await load('@labpics/motion/frame');
        const update = frame.update, render = frame.render;
        let updates = 0, renders = 0;
        frame.update = (...args) => { updates++; return update(...args); };
        frame.render = (...args) => { renders++; return render(...args); };
        const a = root.animate(element(), { x: 100 }, { duration: 1000, ease: t => t });
        const b = legacy.animate(element(), { x: [0, 100] }, { duration: 1000, ease: t => t });
        assert.equal(updates, 1); assert.equal(renders, 1); assert.equal(pending.size, 1);
        a.stop(); b.cancel();
        assert.deepEqual(await a.finished, { status: 'stopped' });
        await b.finished; assert.equal(pending.size, 0);
        const c = root.animate(element(), { x: 100 }, { duration: 1000, ease: t => t });
        const d = legacy.animate(element(), { x: [0, 100] }, { duration: 1000, ease: t => t });
        frame.cancelAll();
        assert.deepEqual(await c.finished, { status: 'stopped' });
        await d.finished; assert.equal(pending.size, 0);
        frame.update = update; frame.render = render;
      }
      console.log('shared frame PASS');
    `);
    expect(execFileSync(process.execPath, ['probe.mjs'], { cwd: work, encoding: 'utf8', timeout: 15_000 })).toContain('shared frame PASS');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 45_000);
