import { expect, test } from '@playwright/test';

test('PROFILE-01: sampling profiler attribution is an explicit Chromium capability', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');
  await page.addScriptTag({ url: '/browser/fixtures/profile-cdp-profiler-probe.js' });

  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 100 });
  await session.send('Profiler.start');
  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __labMotionProfileProbe: (iterations: number) => number;
    }).__labMotionProfileProbe;
    probe(20_000_000);
  });
  const { profile } = await session.send('Profiler.stop');
  await session.send('Profiler.disable');
  await session.detach();

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  expect(samples.length).toBeGreaterThan(0);
  expect(deltas.length).toBe(samples.length);

  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  let attributableSamples = 0;
  let attributableUs = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (!nodes.get(samples[index])?.callFrame.url.endsWith('/browser/fixtures/profile-cdp-profiler-probe.js')) continue;
    attributableSamples += 1;
    attributableUs += deltas[index] ?? 0;
  }

  expect(attributableSamples).toBeGreaterThan(0);
  expect(attributableUs).toBeGreaterThan(0);
});
