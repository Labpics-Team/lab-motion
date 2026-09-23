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
const WARMUPS = 4;
const SAMPLES = 24;
const SERIAL_REPEATS = 32;
const SELECTION_FLOOR_MS = 40;

function invariant(condition, message) {
  if (!condition) throw new Error(`M05 research: ${message}`);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function serve(baseRootPath, candidateRootPath) {
  const roots = Object.create(null);
  for (const [label, rootPath] of [['base', baseRootPath], ['candidate', candidateRootPath]]) {
    const root = await realpath(resolve(rootPath));
    roots[label] = { root, dist: await realpath(resolve(root, 'dist')) };
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8">');
        return;
      }
      const match = pathname.match(/^\/(base|candidate)\/dist\/(.+)$/);
      invariant(match, 'path outside frozen roots');
      const { root, dist } = roots[match[1]];
      const file = await realpath(resolve(root, `dist/${match[2]}`));
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

async function install(page, origin, importFirst) {
  await page.goto(origin, { waitUntil: 'load' });
  await page.evaluate(async ({ importFirst, urls, sheets, frameMs, terminalMs }) => {
    let createBase;
    let createCandidate;
    if (importFirst === 'base') {
      ({ createBottomSheet: createBase } = await import(urls.base));
      ({ createBottomSheet: createCandidate } = await import(urls.candidate));
    } else {
      ({ createBottomSheet: createCandidate } = await import(urls.candidate));
      ({ createBottomSheet: createBase } = await import(urls.base));
    }
    const g = globalThis;
    g.__m05Run = (which, serial = 1) => {
      const createBottomSheet = which === 'base' ? createBase : createCandidate;
      const started = performance.now();
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
      return performance.now() - started;
    };
  }, { importFirst, urls: { base: `${origin}/base/dist/behaviors/index.js`, candidate: `${origin}/candidate/dist/behaviors/index.js` }, sheets: SHEETS, frameMs: FRAME_MS, terminalMs: TERMINAL_MS });
}

function median(values) {
  const x = [...values].sort((a, b) => a - b);
  const m = x.length >> 1;
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}

function quantile(values, q) {
  const x = [...values].sort((a, b) => a - b);
  return x[Math.min(x.length - 1, Math.max(0, Math.ceil(q * x.length) - 1))];
}

async function measure(page, which, serial) {
  return page.evaluate(({ target, repeats }) => globalThis.__m05Run(target, repeats), { target: which, repeats: serial });
}

async function main() {
  const baseRoot = arg('--base-root');
  const candidateRoot = arg('--candidate-root');
  invariant(baseRoot && candidateRoot, '--base-root and --candidate-root are required');
  const server = await serve(baseRoot, candidateRoot);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const baseSamples = [];
    const candidateSamples = [];
    const perOrder = [];
    let one = NaN;
    let two = NaN;

    for (const importFirst of ['base', 'candidate']) {
      const page = await context.newPage();
      try {
        await install(page, server.origin, importFirst);
        for (let i = 0; i < WARMUPS; i++) {
          if ((i + (importFirst === 'candidate' ? 1 : 0)) % 2 === 0) {
            await measure(page, 'base', SERIAL_REPEATS);
            await measure(page, 'candidate', SERIAL_REPEATS);
          } else {
            await measure(page, 'candidate', SERIAL_REPEATS);
            await measure(page, 'base', SERIAL_REPEATS);
          }
        }

        const orderBase = [];
        const orderCandidate = [];
        for (let i = 0; i < SAMPLES / 2; i++) {
          if ((i + (importFirst === 'candidate' ? 1 : 0)) % 2 === 0) {
            orderBase.push(await measure(page, 'base', SERIAL_REPEATS));
            orderCandidate.push(await measure(page, 'candidate', SERIAL_REPEATS));
          } else {
            orderCandidate.push(await measure(page, 'candidate', SERIAL_REPEATS));
            orderBase.push(await measure(page, 'base', SERIAL_REPEATS));
          }
        }
        baseSamples.push(...orderBase);
        candidateSamples.push(...orderCandidate);
        perOrder.push({
          importFirst,
          baseP50: median(orderBase),
          candidateP50: median(orderCandidate),
          ratioP50: median(orderCandidate) / median(orderBase),
        });
        if (importFirst === 'base') {
          one = await measure(page, 'base', SERIAL_REPEATS);
          two = await measure(page, 'base', SERIAL_REPEATS * 2);
        }
      } finally {
        await page.close();
      }
    }

    const result = {
      scene: 'direct-manipulation-sheet',
      sheets: SHEETS,
      warmupsPerImportOrder: WARMUPS,
      samples: SAMPLES,
      selectionFloorMs: SELECTION_FLOOR_MS,
      serialRepeats: SERIAL_REPEATS,
      importOrders: perOrder,
      base: { p50: median(baseSamples), p95: quantile(baseSamples, 0.95), raw: baseSamples },
      candidate: { p50: median(candidateSamples), p95: quantile(candidateSamples, 0.95), raw: candidateSamples },
      ratioP50: median(candidateSamples) / median(baseSamples),
      deliberate2x: two / one,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
