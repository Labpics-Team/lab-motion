import { describe, expect, it, onTestFinished } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompositorFollowRecipes, compositorFollowRecipes } from '../browser/fixtures/compositor-follow-recipes.mjs';

function fixture() {
  const consumer = mkdtempSync(join(tmpdir(), 'motion-recipe-test-'));
  onTestFinished(() => rmSync(consumer, { recursive: true, force: true }));
  const installed = join(consumer, 'node_modules/@labpics/motion');
  const out = join(consumer, 'out');
  mkdirSync(join(installed, 'docs'), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(installed, 'package.json'), JSON.stringify({
    name: '@labpics/motion', type: 'module', exports: { './compositor/follow': './follow.js' },
  }));
  const recipe = "export { marker, load } from '@labpics/motion/compositor/follow';";
  const docs = '<!-- compositor-follow-recipes:start -->\n' +
    '```typescript\n' + recipe + '\n```\n<!-- compositor-follow-recipes:end -->\n';
  writeFileSync(join(installed, 'docs/recipes.md'), docs.replaceAll('\n', '\r\n'));
  writeFileSync(join(installed, 'follow.js'),
    "export const marker = 'shipped-marker'; export const load = () => import('./lazy.js');");
  writeFileSync(join(installed, 'lazy.js'), "export const value = 'shipped-lazy';");
  mkdirSync(join(consumer, 'docs'));
  writeFileSync(join(consumer, 'docs/recipes.md'), docs.replace(recipe, "export const marker = 'checkout-marker';"));
  return { consumer, installed, out, recipe };
}

describe('shipped compositor recipes', () => {
  it('reads installed CRLF docs and measures the emitted initial and lazy bytes', async () => {
    const { consumer, installed, out, recipe } = fixture();
    expect(compositorFollowRecipes(installed)).toBe(recipe);
    const receipt = await buildCompositorFollowRecipes(installed, out, consumer);
    const initial = readFileSync(join(out, 'compositor-follow-recipes.js'), 'utf8');
    expect(initial).toContain('shipped-marker');
    expect(initial).not.toContain('checkout-marker');
    expect(receipt.packageInputs).toEqual(['follow.js', 'lazy.js']);
    expect(receipt.measurement.initialFiles).toBe(1);
    expect(receipt.measurement.lazyFiles).toBe(1);
    expect(receipt.measurement.totalGzBytes).toBeGreaterThan(receipt.measurement.gzBytes);
    for (const output of receipt.outputs) {
      const bytes = readFileSync(join(out, output.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.sha256);
    }
  });

  it('rejects a resolver that includes source outside the installed package', async () => {
    const { consumer, installed, out } = fixture();
    writeFileSync(join(consumer, 'escaped.js'), "export const marker = 'checkout-marker';");
    writeFileSync(join(installed, 'follow.js'),
      "export { marker } from '../../../escaped.js'; export const load = () => 0;");
    await expect(buildCompositorFollowRecipes(installed, out, consumer))
      .rejects.toThrow('recipe dependency escaped installed package');
  });
});
