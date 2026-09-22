import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHEET_RELEASE_V2 } from './sheet-release-v2-preregistration.mjs';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium, firefox, webkit } = compareRequire('playwright');
const ENGINES = Object.freeze({ chromium, firefox, webkit });
const MIME = Object.freeze({ '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' });

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 sheet-release-v2: ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function validateFrozenContract(contract) {
  const moves = contract.timeline.filter(({ kind }) => kind === 'move');
  const up = contract.timeline.find(({ kind }) => kind === 'up');
  const interrupt = contract.timeline.find(({ kind }) => kind === 'interrupt');
  const terminal = contract.timeline.find(({ kind }) => kind === 'terminal-observation');
  invariant(moves.length === 3 && up && interrupt && terminal, 'timeline shape drifted');
  const lastMove = moves[moves.length - 1];
  const dt = (up.atMs - lastMove.atMs) / 1000;
  invariant(dt > 0, 'release timestamp must follow the last move');
  const velocity = (up.y - lastMove.y) / dt;
  invariant(velocity === contract.expected.releaseVelocityPxPerSec, `release velocity drifted (${velocity})`);
  invariant(up.atMs < interrupt.atMs && interrupt.atMs < terminal.atMs, 'release/interrupt/terminal order drifted');
  invariant(contract.candidateSamplesObservedAtRegistration === false, 'preregistration must precede candidate samples');
}

async function startDistServer(baselineRoot) {
  const root = await realpath(resolve(baselineRoot));
  const dist = await realpath(resolve(root, 'dist'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>PROFILE-01 sheet-release-v2</title>');
        return;
      }
      invariant(pathname.startsWith('/dist/'), 'only frozen baseline dist is served');
      const candidate = await realpath(resolve(root, `.${pathname}`));
      invariant(candidate === dist || candidate.startsWith(`${dist}${sep}`), 'path escaped frozen baseline dist');
      const bytes = await readFile(candidate);
      response.writeHead(200, {
        'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error instanceof Error ? error.message : error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  invariant(address && typeof address === 'object', 'baseline server has no bound address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

async function probeEngine(engine, browserType, origin, contract) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: contract.viewport, deviceScaleFactor: contract.dpr });
    try {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'load' });
      const result = await page.evaluate(async ({ behaviorsUrl, contract: frozen }) => {
        const { createBottomSheet } = await import(behaviorsUrl);
        const now = () => performance.now();
        const waitUntil = async (startedAt, targetMs) => {
          while (now() - startedAt < targetMs) {
            await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          }
        };
        const scheduler = () => {
          let pending = 0;
          let failure;
          const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          const checkFailure = () => {
            if (failure !== undefined) throw failure;
          };
          return {
            requestFrame(callback) {
              pending++;
              return requestAnimationFrame((timestamp) => {
                pending--;
                try {
                  callback(timestamp);
                } catch (error) {
                  failure ??= error;
                }
              });
            },
            async drain(roundLimit = 4000) {
              let rounds = 0;
              while (pending > 0) {
                if (++rounds > roundLimit) throw new Error('frame bound exceeded');
                await nextFrame();
                checkFailure();
              }
              checkFailure();
            },
            pending() { return pending; },
          };
        };
        const snapshot = (state) => ({ value: state.value, velocity: state.velocity, phase: state.phase, snapIndex: state.snapIndex });
        const moves = frozen.timeline.filter(({ kind }) => kind === 'move');
        const down = frozen.timeline.find(({ kind }) => kind === 'down');
        const up = frozen.timeline.find(({ kind }) => kind === 'up');
        const interrupt = frozen.timeline.find(({ kind }) => kind === 'interrupt');
        const terminalEvent = frozen.timeline.find(({ kind }) => kind === 'terminal-observation');
        const sched = scheduler();
        const sheet = createBottomSheet({ snapPoints: frozen.snapPoints, requestFrame: sched.requestFrame });
        const startedAt = now();
        try {
          sheet.pointerDown({ x: 0, y: down.y, t: down.atMs / 1000 });
          for (const event of moves) {
            await waitUntil(startedAt, event.atMs);
            sheet.pointerMove({ x: 0, y: event.y, t: event.atMs / 1000 });
          }
          await waitUntil(startedAt, up.atMs);
          sheet.pointerUp({ x: 0, y: up.y, t: up.atMs / 1000 });
          const release = snapshot(sheet.state);
          if (release.phase !== 'release' || release.snapIndex !== frozen.expected.releaseTargetSnapIndex) {
            throw new Error(`release law failed: ${JSON.stringify(release)}`);
          }

          await waitUntil(startedAt, interrupt.atMs);
          const atInterrupt = snapshot(sheet.state);
          if (atInterrupt.phase !== frozen.expected.phaseAtInterrupt) {
            throw new Error(`release settled before interruption: ${JSON.stringify(atInterrupt)}`);
          }
          const valueBeforeInterrupt = atInterrupt.value;
          sheet.snapTo(interrupt.snapIndex);
          const afterInterrupt = snapshot(sheet.state);
          if (afterInterrupt.phase !== 'release' || afterInterrupt.snapIndex !== interrupt.snapIndex) {
            throw new Error(`interrupt target was not adopted: ${JSON.stringify(afterInterrupt)}`);
          }
          if (afterInterrupt.value !== valueBeforeInterrupt) {
            throw new Error(`interrupt teleported value (${valueBeforeInterrupt} -> ${afterInterrupt.value})`);
          }

          await waitUntil(startedAt, terminalEvent.atMs);
          await sched.drain();
          const terminal = snapshot(sheet.state);
          const expectedTerminal = frozen.expected.terminal;
          if (
            terminal.phase !== expectedTerminal.phase || terminal.value !== expectedTerminal.value ||
            terminal.snapIndex !== expectedTerminal.snapIndex || terminal.velocity !== expectedTerminal.velocity
          ) {
            throw new Error(`terminal law failed: ${JSON.stringify(terminal)}`);
          }
          if (sched.pending() !== 0) throw new Error('pending frame work remained after terminal settle');
          return {
            release,
            atInterrupt,
            afterInterrupt,
            terminal,
            elapsedMs: now() - startedAt,
          };
        } finally {
          sheet.destroy();
        }
      }, {
        behaviorsUrl: `${origin}/dist/behaviors/index.js`,
        contract,
      });
      return { engine, version: browser.version(), ...result };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function probeSheetReleaseV2({ baselineRoot, harnessRevision, contract = SHEET_RELEASE_V2 }) {
  validateFrozenContract(contract);
  invariant(/^[0-9a-f]{40}$/.test(harnessRevision), 'harness revision must be an exact Git SHA');
  const server = await startDistServer(baselineRoot);
  try {
    const engines = [];
    for (const engine of ['chromium', 'firefox', 'webkit']) {
      engines.push(await probeEngine(engine, ENGINES[engine], server.origin, contract));
    }
    return {
      schemaVersion: 1,
      status: 'PASS',
      node: contract.node,
      probeId: contract.id,
      baselineRevision: contract.baselineRevision,
      harnessRevision,
      contractSha256: sha256(contract),
      candidateSamples: 0,
      engines,
    };
  } finally {
    await server.close();
  }
}

async function main() {
  const baselineRoot = arg('--baseline-root');
  const outputPath = arg('--out');
  const harnessRevision = arg('--harness-revision') ?? process.env.GITHUB_SHA;
  invariant(baselineRoot && outputPath && harnessRevision, 'CLI requires --baseline-root --out --harness-revision');
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const receipt = await probeSheetReleaseV2({ baselineRoot, harnessRevision });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: 'PASS', outputPath, contractSha256: receipt.contractSha256 })}\n`);
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      status: 'FAIL',
      node: SHEET_RELEASE_V2.node,
      probeId: SHEET_RELEASE_V2.id,
      baselineRevision: SHEET_RELEASE_V2.baselineRevision,
      harnessRevision,
      contractSha256: sha256(SHEET_RELEASE_V2),
      candidateSamples: 0,
      error: String(error instanceof Error ? error.stack ?? error.message : error),
    };
    await writeFile(outputPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
