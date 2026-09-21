import { expect, test } from '@playwright/test';

type TraceCallFrame = { url?: string };
type TraceEvent = {
  name?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  dur?: number;
  args?: {
    data?: {
      id?: number;
      frame?: string;
      stackTrace?: unknown;
    };
  };
};

const FIXTURE_SUFFIX = '/browser/fixtures/profile-raf-trace-probe.js';

function stackUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(stackUrls);
  if (value === null || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const urls = typeof record.url === 'string' ? [record.url] : [];
  if (Array.isArray(record.callFrames)) urls.push(...record.callFrames.flatMap(stackUrls));
  if (record.parent !== undefined) urls.push(...stackUrls(record.parent));
  return urls;
}

function sameIdentity(left: TraceEvent, right: TraceEvent): boolean {
  const a = left.args?.data;
  const b = right.args?.data;
  return typeof a?.id === 'number' &&
    a.id === b?.id &&
    typeof a.frame === 'string' &&
    a.frame.length > 0 &&
    a.frame === b?.frame;
}

test('PROFILE-01: exact rAF trace duration is an explicit Chromium capability', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');
  await page.addScriptTag({ url: FIXTURE_SUFFIX });

  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) => {
    events.push(...(value as TraceEvent[]));
  });

  await session.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline.stack',
      ],
    },
  });

  await page.evaluate(async () => {
    const probe = (globalThis as typeof globalThis & {
      __labMotionProfileRafTraceProbe: (iterations?: number) => Promise<number>;
    }).__labMotionProfileRafTraceProbe;
    await probe();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

  const completed = new Promise<void>((resolve) => {
    session.once('Tracing.tracingComplete', () => resolve());
  });
  await session.send('Tracing.end');
  await completed;
  await session.detach();

  const request = events.find((event) =>
    event.name === 'RequestAnimationFrame' &&
    stackUrls(event.args?.data?.stackTrace).some((url) => url.endsWith(FIXTURE_SUFFIX))
  );
  expect(request, 'fixture-owned RequestAnimationFrame with exact source stack').toBeDefined();

  const fire = events.find((event) =>
    event.name === 'FireAnimationFrame' &&
    event.ph === 'X' &&
    request !== undefined &&
    sameIdentity(request, event)
  );
  expect(fire, 'matching FireAnimationFrame complete event').toBeDefined();
  expect(fire?.pid).toBe(request?.pid);
  expect(fire?.tid).toBe(request?.tid);
  expect(fire?.dur).toBeGreaterThan(0);
});
