import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('установленные root, animate и bindings используют один owner и две общие подписки', () => {
  const work = mkdtempSync(join(tmpdir(), 'motion-shared-package-'));
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
      globalThis.performance = { now: () => 0 };
      let id = 0; const scheduled = new Map();
      globalThis.requestAnimationFrame = cb => { scheduled.set(++id, cb); return id; };
      globalThis.cancelAnimationFrame = id => scheduled.delete(id);
      globalThis.getComputedStyle = element => element.style;
      const element = () => {
        const values = new Map();
        return { style: {
          getPropertyValue: key => values.get(key) ?? '',
          setProperty: (key, value) => values.set(key, String(value)),
          removeProperty: key => values.delete(key),
        } };
      };
      const x = el => Number(/translate(?:X)?\\(([^p]+)px/.exec(el.style.getPropertyValue('transform'))?.[1] ?? 0);
      for (const load of [specifier => import(specifier), specifier => require(specifier)]) {
        const root = await load('@labpics/motion');
        const legacy = await load('@labpics/motion/animate');
        const { frame } = await load('@labpics/motion/frame');
        const { createMotionBinding } = await load('@labpics/motion/bindings');
        let updates = 0, renders = 0;
        const update = frame.update, render = frame.render;
        frame.update = (...args) => { updates++; return update(...args); };
        frame.render = (...args) => { renders++; return render(...args); };
        const left = element(), right = element();
        const first = root.animate(left, { x: 100 }, { duration: 1000, ease: t => t });
        const second = legacy.animate(right, { x: [0, 100] }, { duration: 1000, ease: t => t });
        assert.equal(updates, 1); assert.equal(renders, 1); assert.equal(scheduled.size, 1);
        first.seek(250);
        const next = legacy.animate(left, { x: 200 }, { duration: 1000, ease: t => t });
        assert.deepEqual(await first.finished, { status: 'stopped' });
        next.seek(0); assert.equal(x(left), 25);
        first.finish(); first.stop(); assert.equal(x(left), 25);
        next.seek(500); assert.equal(x(left), 112.5);
        next.cancel(); second.cancel();
        const value = element();
        let playback;
        const binding = createMotionBinding(model => ({ panel: { x: model } }), {
          panel: goal => playback = root.animate(value, goal, { duration: 1000, ease: t => t }),
        });
        binding.update(100); binding.destroy();
        assert.deepEqual(await playback.finished, { status: 'stopped' });
        assert.equal(scheduled.size, 0);
        frame.update = update; frame.render = render;
      }
      console.log('shared package owner and scheduling PASS');
    `);
    const output = execFileSync(process.execPath, ['probe.mjs'], { cwd: work, encoding: 'utf8', timeout: 20_000 });
    expect(output).toContain('shared package owner and scheduling PASS');
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 60_000);
