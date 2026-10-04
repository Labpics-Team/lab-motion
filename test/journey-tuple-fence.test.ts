import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { verifyJourneyTuple } from '../browser/fixtures/journey-tuple';

const globalSetup = vi.hoisted(() => ({ archive: Buffer.alloc(0), reads: 0 }));
// Только readback Node-owner: ни один общий browser artifact тест не перезаписывает.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: any[]) {
    if (path instanceof URL && path.pathname.endsWith('/browser/.artifacts/compositor-follow-package.tgz')) {
      globalSetup.reads++; return globalSetup.archive;
    }
    return (actual.readFileSync as any)(path, ...args);
  } };
});

afterEach(() => vi.unstubAllEnvs());
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('default fence отклоняет coherent foreign HTTP tuple той же версии, сохраняя local healthy control', async () => {
  vi.stubEnv('LAB_MOTION_TARBALL', '');
  const root = resolve('.');
  mkdirSync(join(root, 'work'), { recursive: true });
  const work = mkdtempSync(join(root, 'work', 'journey fence '));
  try {
    const { packScopeRecipePackage } = await import('../browser/fixtures/scope-recipes.mjs');
    const local = packScopeRecipePackage(root, join(work, 'local'));
    globalSetup.archive = readFileSync(local.tarball); globalSetup.reads = 0;
    const entry = join(local.packageRoot, 'dist/smart/index.js');
    writeFileSync(entry, readFileSync(entry, 'utf8') + '\nexport const foreignTuple = true;\n');
    const foreign = packScopeRecipePackage(local.packageRoot, join(work, 'foreign'));
    const foreignBytes = readFileSync(foreign.tarball);
    expect(digest(foreignBytes)).not.toBe(digest(globalSetup.archive));
    let bytes = globalSetup.archive;
    const bundle = Buffer.from('export const checkerFixture = true;');
    const hash = digest(bundle);
    const server = createServer((req, res) => {
      if (req.url?.endsWith('.tgz')) { res.end(bytes); return; }
      if (req.url?.endsWith('.js')) { res.end(bundle); return; }
      const archive = { sha256: digest(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
      const scope = { schema: 'scope-recipes-package-v1', package: local.receipt.package, tarball: archive,
        bundleSha256: hash, recipesSha256: hash, motionInputs: ['dist/smart/index.js'], motionInputSha256: { 'dist/smart/index.js': hash } };
      const follow = { package: `${scope.package.name}@${scope.package.version}`, tarball: archive,
        documentSha256: hash, outputs: [{ file: 'compositor-follow-recipes.js', sha256: hash }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('scope-recipes.package.json') ? scope : follow));
    });
    onTestFinished(async () => {
      if (server.listening) { server.close(); await once(server, 'close'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a port');
    const client = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
    try {
      // Проверяется Node checker seam; этот тест не объявляет browser journey выполненным.
      const page = { request: client, context: () => ({ browser: () => undefined }) } as unknown as Page;
      const info = { annotations: [], project: { name: 'checker-seam' }, attach: async () => {} } as unknown as TestInfo;
      await verifyJourneyTuple(page, info);
      bytes = foreignBytes;
      await expect(verifyJourneyTuple(page, info)).rejects.toThrow();
      expect(globalSetup.reads).toBe(2);
    } finally { await client.dispose(); server.close(); await once(server, 'close'); }
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 120_000);
