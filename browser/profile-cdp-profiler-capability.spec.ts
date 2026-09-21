import { expect, test } from '@playwright/test';

test('PROFILE-01: sampling profiler attribution is an explicit Chromium capability', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');
  await page.addScriptTag({
    content: `
      globalThis.__labMotionProfileProbe = (iterations) => {
        let value = 0x12345678;
        for (let i = 0; i < iterations; i += 1) {
          value = Math.imul(value ^ i, 1664525) + 1013904223;
        }
        return value >>> 0;
      };
      //# sourceURL=lab-motion-profile-cdp-probe.js
    `,
  });

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

  expect(profile.samples?.length ?? 0).toBeGreaterThan(0);
  expect(profile.timeDeltas?.length ?? 0).toBe(profile.samples?.length ?? 0);

  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const attributable = (profile.samples ?? []).filter((id) =>
    nodes.get(id)?.callFrame.url.endsWith('lab-motion-profile-cdp-probe.js'),
  );
  expect(attributable.length).toBeGreaterThan(0);

  const attributableUs = attributable.reduce((total, id, index) => {
    const sampleIndex = profile.samples?.indexOf(id, index) ?? -1;
    return total + (sampleIndex >= 0 ? (profile.timeDeltas?.[sampleIndex] ?? 0) : 0);
  }, 0);
  expect(attributableUs).toBeGreaterThan(0);
});
