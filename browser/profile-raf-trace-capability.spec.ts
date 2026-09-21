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
const TRACE_COMPLETION_TIMEOUT_MS = 5_000;

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

async function finishTrace(
  end: () => Promise<unknown>,
  subscribeComplete: (resolve: () => void) => () => void,
  detach: () => Promise<void>,
  timeoutMs = TRACE_COMPLETION_TIMEOUT_MS,
): Promise<void> {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = new Promise<void>((resolve) => {
      unsubscribe = subscribeComplete(resolve);
    });
    await end();
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`PROFILE-01 trace completion timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    await detach();
  }
}

async function collectTrace(page: Page, run: () => Promise<void>): Promise<TraceEvent[]> {
  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) => {
    events.push(...(value as TraceEvent[]));
  });

  let tracingStarted = false;
  try {
    await session.send('Tracing.start', {
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline.stack',
        ],
      },
    });
    tracingStarted = true;

    await run();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  } finally {
    if (tracingStarted) {
      await finishTrace(
        () => session.send('Tracing.end'),
        (resolve) => {
          session.once('Tracing.tracingComplete', resolve);
          return () => session.off('Tracing.tracingComplete', resolve);
        },
        () => session.detach(),
      );
    } else {
      await session.detach();
    }
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

test('PROFILE-01: таймаут tracingComplete завершает CDP-сессию перед отказом', async () => {
  let ended = false;
  let unsubscribed = false;
  let detached = false;

  const result = finishTrace(
    async () => { ended = true; },
    () => () => { unsubscribed = true; },
    async () => { detached = true; },
    1,
  );

  await expect(result).rejects.toThrow('PROFILE-01 trace completion timed out after 1ms');
  expect(ended).toBe(true);
  expect(unsubscribed).toBe(true);
  expect(detached).toBe(true);
});

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
      const controls = createProjection({
        requestFrame: (callback) => requestAnimationFrame((timestamp) => callback(timestamp)),
        // Пустой consumer сохраняет вычисление ProjectionFrame, но не добавляет
        // прикладную мутацию внутрь измеряемого production-owned rAF.
        onFrame: () => {},
      });
      controls.play([{
        id: 'probe',
        first: { x: 0, y: 0, width: 32, height: 32 },
        last: { x: 96, y: 64, width: 48, height: 48 },
      }]);
      while (controls.playing) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const box = controls.boxAt('probe');
      if (box?.x !== 96 || box.y !== 64 || box.width !== 48 || box.height !== 48) {
        throw new Error('PROFILE-01 projection probe did not reach authored terminal geometry');
      }
    });
  });
  expectOwnedFrame(projectionEvents, PROJECTION_SUFFIX);

  const behaviorEvents = await collectTrace(page, async () => {
    await page.evaluate(async () => {
      const { createBottomSheet } = await import('/dist/behaviors/index.js');
      const sheet = createBottomSheet({
        snapPoints: [0, 300, 600],
        requestFrame: (callback) => requestAnimationFrame((timestamp) => callback(timestamp)),
      });
      sheet.snapTo(1);
      while (sheet.state.phase !== 'settle') {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (sheet.state.value !== 300 || sheet.state.snapIndex !== 1 || sheet.state.velocity !== 0) {
        throw new Error('PROFILE-01 bottom-sheet probe did not reach authored terminal state');
      }
      sheet.destroy();
    });
  });
  expectOwnedFrame(behaviorEvents, BEHAVIORS_SUFFIX);
});
