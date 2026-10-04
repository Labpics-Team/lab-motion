import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';

/** Каждый outcome привязан к полученным bytes; чужой receipt с тем же именем не проходит. */
export async function verifyJourneyTuple(page: Page, info: TestInfo): Promise<void> {
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const scopeResponse = await page.request.get('/browser/.artifacts/scope-recipes.package.json');
  const followResponse = await page.request.get('/browser/.artifacts/compositor-follow-package.json');
  expect(scopeResponse.ok()).toBe(true); expect(followResponse.ok()).toBe(true);
  const scope = await scopeResponse.json();
  const follow = await followResponse.json();
  expect(scope.schema).toBe('scope-recipes-package-v1');
  expect(scope.package.name).toBe('@labpics/motion');
  expect(follow.package).toBe(`${scope.package.name}@${scope.package.version}`);
  // Эти имена задаёт fixture, не произвольное поле receipt.
  const archive = await page.request.get('/browser/.artifacts/scope-recipes-package.tgz');
  const followArchive = await page.request.get('/browser/.artifacts/compositor-follow-package.tgz');
  const bundle = await page.request.get('/browser/.artifacts/scope-recipes.js');
  const followBundle = await page.request.get('/browser/.artifacts/compositor-follow-recipes.js');
  expect(archive.ok()).toBe(true); expect(followArchive.ok()).toBe(true);
  expect(bundle.ok()).toBe(true); expect(followBundle.ok()).toBe(true);
  const bytes = await archive.body();
  const sha256 = digest(bytes);
  // Local globalSetup владеет expected bytes и при PW_REUSE_SERVER=1:
  // взаимно согласованный foreign server не может удостоверить сам себя.
  const expectedArchiveSha256 = digest(readFileSync(
    new URL('../.artifacts/compositor-follow-package.tgz', import.meta.url)));
  expect(sha256).toBe(expectedArchiveSha256);
  expect(sha256).toBe(scope.tarball.sha256);
  expect(`sha512-${createHash('sha512').update(bytes).digest('base64')}`).toBe(scope.tarball.integrity);
  // Два receipt могут ошибочно сообщить один hash; реальные архивы должны совпасть.
  const followBytes = await followArchive.body();
  expect(followBytes.equals(bytes)).toBe(true);
  expect(digest(followBytes)).toBe(follow.tarball.sha256);
  expect(digest(await bundle.body())).toBe(scope.bundleSha256);
  expect(digest(await followBundle.body())).toBe(follow.outputs.find((output: { file: string }) =>
    output.file === 'compositor-follow-recipes.js')?.sha256);
  expect(follow.documentSha256).toBe(scope.recipesSha256);
  expect(scope.motionInputs.length).toBeGreaterThan(0);
  expect(scope.motionInputs.every((path: string) => path.startsWith('dist/'))).toBe(true);
  expect(Object.keys(scope.motionInputSha256).sort()).toEqual(scope.motionInputs);
  expect(Object.values(scope.motionInputSha256).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))).toBe(true);
  if (process.env.LAB_MOTION_TARBALL) {
    expect(sha256).toBe(digest(readFileSync(process.env.LAB_MOTION_TARBALL)));
  }
  info.annotations.push({ type: 'package-sha256', description: sha256 });
  await info.attach('journey-package-tuple', { contentType: 'application/json', body: JSON.stringify({
    scope, follow, expectedArchiveSha256, browser: page.context().browser()?.version(), project: info.project.name,
  }) });
}
