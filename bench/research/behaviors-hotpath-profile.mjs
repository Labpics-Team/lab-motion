import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium } = compareRequire('playwright');
const MIME = Object.freeze({ '.js': 'text/javascript; charset=utf-8' });
const SHEETS = 128;
const FRAME_MS = 16;
const TERMINAL_MS = 1548;
const PROFILE_REPEATS = 256;

function invariant(condition, message) {
  if (!condition) throw new Error(`M05 baseline profile: ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function serve(rootPath) {
  const root = await realpath(resolve(rootPath));
  const dist = await realpath(resolve(root, 'dist'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8">');
        return;
      }
      invariant(pathname.startsWith('/dist/'), 'path outside dist');
      const file = await realpath(resolve(root, `.${pathname}`));
      invariant(file === dist || file.startsWith(`${dist}${sep}`), 'path escaped dist');
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end(String(error));
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
  const address = server.address();
  invariant(address && typeof address === 'object', 'server address missing');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((ok, bad) => server.close(e => e ? bad(e) : ok())) };
}

async function install(page, origin) {
  await page.goto(origin, { waitUntil: 'load' });
  await page.evaluate(async ({ url, sheets, frameMs, terminalMs }) => {
    const { createBottomSheet } = await import(url);
    globalThis.__m05ProfileRun = (serial) => {
      for (let repeat = 0; repeat < serial; repeat++) {
        let now = 0;
        let queue = [];
        let handle = 0;
        const requestFrame = (callback) => { queue.push(callback); return ++handle; };
        const stepTo = (timestamp) => {
          now = timestamp;
          const batch = queue;
          queue = [];
          for (let i = 0; i < batch.length; i++) batch[i](now);
        };
        const advanceTo = (deadline) => {
          while (queue.length && now < deadline) stepTo(Math.min(deadline, now + frameMs));
        };
        const list = new Array(sheets);
        for (let i = 0; i < sheets; i++) list[i] = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame });
        for (const sheet of list) sheet.pointerDown({ x: 0, y: 0, t: 0 });
        for (const [at, y] of [[160, 80], [320, 180], [480, 260]]) {
          for (const sheet of list) sheet.pointerMove({ x: 0, y, t: at / 1000 });
        }
        for (const sheet of list) sheet.pointerUp({ x: 0, y: 300, t: 0.52 });
        now = 520;
        advanceTo(700);
        for (const sheet of list) {
          if (sheet.state.phase !== 'release') throw new Error(`pre-interrupt phase=${sheet.state.phase}`);
          sheet.snapTo(1);
        }
        advanceTo(terminalMs);
        if (now < terminalMs && queue.length) stepTo(terminalMs);
        for (const sheet of list) {
          const state = sheet.state;
          if (state.phase !== 'settle' || state.value !== 300 || state.snapIndex !== 1 || state.velocity !== 0) {
            throw new Error(`terminal mismatch ${JSON.stringify(state)}`);
          }
          sheet.destroy();
        }
        if (queue.length !== 0) throw new Error(`pending=${queue.length}`);
      }
    };
  }, { url: `${origin}/dist/behaviors/index.js`, sheets: SHEETS, frameMs: FRAME_MS, terminalMs: TERMINAL_MS });
}

function cpuRows(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const hits = new Map();
  for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
  const total = [...hits.values()].reduce((sum, count) => sum + count, 0) || 1;
  return [...hits.entries()]
    .map(([id, samples]) => {
      const frame = nodes.get(id)?.callFrame ?? {};
      return {
        function: frame.functionName || '(anonymous)',
        url: frame.url || '',
        line: (frame.lineNumber ?? -1) + 1,
        column: (frame.columnNumber ?? -1) + 1,
        samples,
        share: samples / total,
      };
    })
    .filter(({ url }) => url.includes('/dist/'))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 40);
}

function allocationRows(profile) {
  const rows = new Map();
  const walk = (node) => {
    const frame = node.callFrame ?? {};
    if ((node.selfSize ?? 0) > 0 && String(frame.url ?? '').includes('/dist/')) {
      const key = `${frame.functionName || '(anonymous)'}\u0000${frame.url}\u0000${(frame.lineNumber ?? -1) + 1}`;
      const prior = rows.get(key) ?? { function: frame.functionName || '(anonymous)', url: frame.url || '', line: (frame.lineNumber ?? -1) + 1, column: (frame.columnNumber ?? -1) + 1, sampledBytes: 0 };
      prior.sampledBytes += node.selfSize;
      rows.set(key, prior);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  const total = [...rows.values()].reduce((sum, row) => sum + row.sampledBytes, 0) || 1;
  return [...rows.values()]
    .map((row) => ({ ...row, share: row.sampledBytes / total }))
    .sort((a, b) => b.sampledBytes - a.sampledBytes)
    .slice(0, 40);
}

async function main() {
  const root = arg('--root');
  invariant(root, '--root is required');
  const server = await serve(root);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await install(page, server.origin);
    await page.evaluate(() => globalThis.__m05ProfileRun(32));

    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
    await cdp.send('Profiler.start');
    const started = Date.now();
    await page.evaluate((repeats) => globalThis.__m05ProfileRun(repeats), PROFILE_REPEATS);
    const elapsedMs = Date.now() - started;
    const { profile: cpu } = await cdp.send('Profiler.stop');
    const { profile: allocations } = await cdp.send('HeapProfiler.stopSampling');

    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      scene: 'direct-manipulation-sheet',
      sheets: SHEETS,
      profileRepeats: PROFILE_REPEATS,
      elapsedMs,
      cpuTop: cpuRows(cpu),
      allocationTop: allocationRows(allocations),
    }, null, 2)}\n`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
