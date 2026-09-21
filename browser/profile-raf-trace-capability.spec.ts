import { expect, test, type Page } from '@playwright/test';

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
const PROJECTION_SUFFIX = '/dist/projection/index.js';
const BEHAVIORS_SUFFIX = '/dist/behaviors/index.js';

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

async function collectTrace(page: Page, run: () => Promise<void>): Promise<TraceEvent[]> {
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

  try {
    await run();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  } finally {
    const completed = new Promise<void>((resolve) => {
      session.once('Tracing.tracingComplete', () => resolve());
    });
    await session.send('Tracing.end');
    await completed;
    await session.detach();
  }

  return events;
}

function matchedOwnedFrame(events: TraceEvent[], sourceSuffix: string): { request: TraceEvent; fire: TraceEvent } | undefined {
  for (const request of events) {
    if (request.name !== 'RequestAnimationFrame') continue;
    if (!stackUrls(request.args?.data?.stackTrace).some((url) => url.endsWith(sourceSuffix))) continue;
    const fire = events.find((event) =>
      event.name === 'FireAnimationFrame' &&
      event.ph === 'X' &&
      sameIdentity(request, event)
    );
    if (fire !== undefined) return { request, fire };
  }
  return undefined;
}

function expectOwnedFrame(events: TraceEvent[], sourceSuffix: string): void {
  const pair = matchedOwnedFrame(events, sourceSuffix);
  expect(pair, `source-owned rAF trace pair for ${sourceSuffix}`).toBeDefined();
  expect(pair?.fire.pid).toBe(pair?.request.pid);
  expect(pair?.fire.tid).toBe(pair?.request.tid);
  expect(pair?.fire.dur).toBeGreaterThan(0);
}

test('PROFILE-01: exact rAF trace duration is an explicit Chromium capability', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');
  await page.addScriptTag({ url: FIXTURE_SUFFIX });
  const events = await collectTrace(page, async () => {
    await page.evaluate(async () => {
      const probe = (globalThis as typeof globalThis & {
        __labMotionProfileRafTraceProbe: (iterations?: number) => Promise<number>;
      }).__labMotionProfileRafTraceProbe;
      await probe();
    });
  });

  expectOwnedFrame(events, FIXTURE_SUFFIX);
});

test('PROFILE-01: both frozen M-05 families retain exact production-owner attribution', async ({ page, browserName }) => {
  if (browserName !== 'chromium') {
    await expect(page.context().newCDPSession(page)).rejects.toThrow(/Chromium|CDP session/i);
    return;
  }

  await page.goto('/site/dist/index.html');

  const projectionEvents = await collectTrace(page, async () => {
    await page.evaluate(async () => {
      const { createProjection } = await import('/dist/projection/index.js');
      await new Promise<void>((resolve) => {
        const controls = createProjection({
          requestFrame: (callback) => requestAnimationFrame((timestamp) => callback(timestamp)),
          onFrame: (frames) => {
            const first = frames[0];
            (globalThis as typeof globalThis & { __labMotionProfileOwnerSink?: number }).__labMotionProfileOwnerSink =
              first === undefined ? 0 : first.tx + first.ty + first.sx + first.sy;
          },
          onRest: resolve,
        });
        controls.play([{
          id: 'probe',
          first: { x: 0, y: 0, width: 32, height: 32 },
          last: { x: 96, y: 64, width: 48, height: 48 },
        }]);
      });
    });
  });
  expectOwnedFrame(projectionEvents, PROJECTION_SUFFIX);

  const behaviorEvents = await collectTrace(page, async () => {
    await page.evaluate(async () => {
      const { createBottomSheet } = await import('/dist/behaviors/index.js');
      await new Promise<void>((resolve) => {
        const sheet = createBottomSheet({
          snapPoints: [0, 300, 600],
          requestFrame: (callback) => requestAnimationFrame((timestamp) => callback(timestamp)),
        });
        const unsubscribe = sheet.subscribe((state) => {
          (globalThis as typeof globalThis & { __labMotionProfileOwnerSink?: number }).__labMotionProfileOwnerSink =
            state.value + state.velocity;
          if (state.phase === 'settle' && state.snapIndex === 1) {
            unsubscribe();
            sheet.destroy();
            resolve();
          }
        });
        sheet.snapTo(1);
      });
    });
  });
  expectOwnedFrame(behaviorEvents, BEHAVIORS_SUFFIX);
});
