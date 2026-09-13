import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('настоящий tarball: ESM/CJS/types/SSR и буквальный DOM-рецепт доступны потребителю', () => {
  expect(existsSync('dist/presence/index.js')).toBe(true);
  const work = mkdtempSync(join(tmpdir(), 'presence-consumer-'));
  try {
    const pack = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { encoding: 'utf8', timeout: 30_000 })) as Array<{ filename: string }>;
    const modulePath = join(work, 'node_modules/@labpics/motion'); mkdirSync(modulePath, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, pack[0]!.filename), '-C', modulePath, '--strip-components=1']);
    writeFileSync(join(work, 'package.json'), '{"type":"module"}');
    writeFileSync(join(work, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createPresenceTransition } from '@labpics/motion/presence';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('@labpics/motion/presence');
assert.equal(typeof document, 'undefined');
for (const create of [createPresenceTransition, cjs.createPresenceTransition]) {
  const p = create();
  assert.deepEqual(await p.setPresent(true), { status: 'finished', present: true });
  p.destroy(); assert.equal(p.state, 'destroyed');
}
console.log('presence-consumer: PASS');
`);
    expect(execFileSync(process.execPath, [join(work, 'consumer.mjs')], { encoding: 'utf8', timeout: 30_000 })).toContain('presence-consumer: PASS');
    const docs = readFileSync(resolve('docs/recipes.md'), 'utf8');
    const recipe = docs.match(/```typescript\n([^`]*?export function bindAnimatedDialog[^]*?)\n```/)?.[1];
    expect(recipe).toBeTruthy();
    writeFileSync(join(work, 'recipe.ts'), recipe!);
    writeFileSync(join(work, 'consumer.ts'), `
import { createPresenceTransition } from '@labpics/motion/presence';
import type { PresenceAnimation, PresenceTransitionResult } from '@labpics/motion/presence';
import { animate } from '@labpics/motion/animate';
const p = createPresenceTransition({ enter: () => animate(document.body, { opacity: 1 }) });
const promise: Promise<PresenceTransitionResult> = p.setPresent(true);
const native: PresenceAnimation = document.body.animate({ opacity: [0, 1] });
createPresenceTransition({ exit: () => [native] });
// @ts-expect-error an async factory loses ownership of effects created after interruption
createPresenceTransition({ enter: async () => native });
// @ts-expect-error a promise without cancel is not an owned animation
createPresenceTransition({ enter: () => ({ finished: Promise.resolve() }) });
// @ts-expect-error boolean is intentional, not coercion of app state
p.setPresent('false');
void promise;
`);
    const tsc = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
    execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'false', join(work, 'recipe.ts'), join(work, 'consumer.ts')], { cwd: work, encoding: 'utf8', timeout: 30_000 });
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 60_000);
