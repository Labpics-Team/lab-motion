import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

for (const extension of ['js', 'cjs']) it(`destroy освобождает callbacks даже при вечном finished (${extension})`, () => {
  const entry = resolve(`dist/presence/index.${extension}`);
  expect(existsSync(entry)).toBe(true);
  const temp = mkdtempSync(join(tmpdir(), 'presence-gc-'));
  try {
    const script = join(temp, 'probe.mjs');
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { createPresenceTransition } = await import(pathToFileURL(process.argv[2]).href);
function setup(dispose) {
  const marker = { unique: new Uint8Array(100) };
  const weak = new WeakRef(marker);
  const never = new Promise(() => {});
  const controls = createPresenceTransition({ enter: () => ({ finished: never, cancel() { void marker.unique; } }) });
  const pending = controls.setPresent(true);
  if (dispose) controls.destroy();
  return { weak, controls, pending, never };
}
const dead = setup(true), alive = setup(false);
globalThis.retained = [dead.controls, dead.pending, dead.never, alive.controls, alive.pending, alive.never];
for (let i = 0; i < 32; i++) {
  await new Promise(resolve => setImmediate(resolve)); global.gc();
}
assert.equal(dead.weak.deref(), undefined, 'destroyed configuration retained by pending callbacks');
assert.notEqual(alive.weak.deref(), undefined, 'positive live-owner control');
alive.controls.destroy();
for (let i = 0; i < 32; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
assert.equal(alive.weak.deref(), undefined, 'live control must release after destroy');
console.log('presence-retention: PASS');
`);
    const output = execFileSync(process.execPath, ['--expose-gc', script, entry], { encoding: 'utf8', timeout: 30_000 });
    expect(output).toContain('presence-retention: PASS');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
