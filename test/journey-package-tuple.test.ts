import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve('.');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('scope journeys устанавливают заданные байты tgz, включая отличие от checkout той же версии', async () => {
  mkdirSync(join(root, 'work'), { recursive: true });
  const work = mkdtempSync(join(root, 'work', 'journey tuple '));
  try {
    const { packScopeRecipePackage } = await import('../browser/fixtures/scope-recipes.mjs');
    const initial = packScopeRecipePackage(root, join(work, 'initial consumer'));
    const entry = join(initial.packageRoot, 'dist/smart/index.js');
    const marker = '\nexport const suppliedJourneyMarker = "actual-supplied-tarball";\n';
    writeFileSync(entry, readFileSync(entry, 'utf8') + marker);
    const destination = join(work, 'supplied archive');
    mkdirSync(destination);
    const packed = packScopeRecipePackage(initial.packageRoot, destination);
    const supplied = packed.tarball;
    const expected = digest(readFileSync(supplied));
    expect(expected).not.toBe(initial.receipt.tarball.sha256);
    const consumer = packScopeRecipePackage(root, join(work, 'supplied consumer'), supplied);
    expect(consumer.receipt.tarball.sha256).toBe(expected);
    expect(readFileSync(join(consumer.packageRoot, 'dist/smart/index.js'), 'utf8')).toContain(marker);
    expect(digest(readFileSync(join(consumer.packageRoot, 'package.json'))))
      .toBe(consumer.receipt.manifest.sha256);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 120_000);
