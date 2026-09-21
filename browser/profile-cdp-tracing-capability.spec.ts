import { expect, test } from '@playwright/test';

type TraceEvent = {
  args?: { data?: { scriptName?: string } };
  cat?: string;
  dur?: number;
  name?: string;
  ph?: string;
  tdur?: number;
};

test('PROFILE-01: timeline tracing can attribute renderer-thread CPU to an exact production-like script URL', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');
  const probePath = '/browser/fixtures/profile-cdp-tracing-probe.js';
  const probeUrl = new URL(probePath, page.url()).href;
  await page.addScriptTag({ url: probePath });

  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) => {
    events.push(...(value as TraceEvent[]));
  });

  await session.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });

  await page.evaluate(async () => {
    const probe = (globalThis as typeof globalThis & {
      __labMotionProfileTraceProbe: (iterations: number) => Promise<number>;
    }).__labMotionProfileTraceProbe;
    await probe(20_000_000);
  });

  const tracingComplete = new Promise<void>((resolve) => {
    session.once('Tracing.tracingComplete', () => resolve());
  });
  await session.send('Tracing.end');
  await tracingComplete;
  await session.detach();

  const attributed = events.filter((event) =>
    event.name === 'FunctionCall' &&
    event.ph === 'X' &&
    event.args?.data?.scriptName === probeUrl,
  );
  const rendererThreadCpuUs = attributed.reduce((sum, event) => sum + (event.tdur ?? 0), 0);
  const wallUs = attributed.reduce((sum, event) => sum + (event.dur ?? 0), 0);

  expect(attributed.length).toBeGreaterThan(0);
  expect(rendererThreadCpuUs).toBeGreaterThan(0);
  expect(wallUs).toBeGreaterThan(0);
  expect(rendererThreadCpuUs).toBeLessThanOrEqual(wallUs);
});
