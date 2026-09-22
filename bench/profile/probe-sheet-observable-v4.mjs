import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHEET_OBSERVABLE_V4 } from './sheet-observable-v4-preregistration.mjs';

const compareRequire = createRequire(new URL('../compare/package.json', import.meta.url));
const { chromium, firefox, webkit } = compareRequire('playwright');
const ENGINES = Object.freeze({ chromium, firefox, webkit });
const MIME = Object.freeze({ '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' });

function invariant(condition, message) {
  if (!condition) throw new Error(`PROFILE-01 sheet-observable-v4: ${message}`);
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
  const inputVelocity = (up.y - lastMove.y) / ((up.atMs - lastMove.atMs) / 1000);
  invariant(inputVelocity === contract.expected.releaseInputVelocityPxPerSec, 'release input velocity drifted');
  invariant(terminal.atMs === contract.derivation.terminalAtMs, 'terminal deadline is not derivation-owned');
  invariant(terminal.atMs === 1548, 'derived terminal deadline drifted');
  invariant(up.atMs < interrupt.atMs && interrupt.atMs < terminal.atMs, 'event order drifted');
  invariant(contract.candidateSamplesObservedAtRegistration === false, 'preregistration must precede samples');
}

async function startDistServer(baselineRoot) {
  const root = await realpath(resolve(baselineRoot));
  const dist = await realpath(resolve(root, 'dist'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>PROFILE-01 sheet observable v4</title>');
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
  invariant(address && typeof address === 'object', 'baseline server has no address');
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
      const result = await page.evaluate(async ({ behaviorsUrl, frozen }) => {
        const { createBottomSheet } = await import(behaviorsUrl);
        const snapshot = (state) => ({
          value: state.value,
          velocity: state.velocity,
          phase: state.phase,
          snapIndex: state.snapIndex,
        });
        const assertMovement = (before, after, dtMs, direction) => {
          const delta = after - before;
          const velocity = delta / (dtMs / 1000);
          if (!Number.isFinite(delta) || delta === 0 || !Number.isFinite(velocity) || Math.sign(delta) !== direction) {
            throw new Error(`observable movement law failed: ${JSON.stringify({ before, after, dtMs, delta, velocity, direction })}`);
          }
          return { before, after, dtMs, delta, velocity };
        };
        const assertTerminal = (state, pending, expected) => {
          if (
            pending !== 0 || state.phase !== expected.phase || state.value !== expected.value ||
            state.snapIndex !== expected.snapIndex || state.velocity !== expected.velocity
          ) {
            throw new Error(`terminal-at-derived-deadline law failed: ${JSON.stringify({ state, pending, expected })}`);
          }
        };
        const expectReject = (fn, label) => {
          try {
            fn();
          } catch {
            return label;
          }
          throw new Error(`oracle negative control survived: ${label}`);
        };

        const oracleControls = {
          stationaryRejected: expectReject(() => assertMovement(260, 260, 16, 1), 'stationary'),
          reverseRejected: expectReject(() => assertMovement(260, 250, 16, 1), 'reverse'),
          pendingTerminalRejected: expectReject(
            () => assertTerminal({ phase: 'settle', value: 300, snapIndex: 1, velocity: 0 }, 1, frozen.expected.terminal),
            'pending-terminal',
          ),
          positiveMovement: assertMovement(260, 276, 16, 1),
        };
        assertTerminal({ phase: 'settle', value: 300, snapIndex: 1, velocity: 0 }, 0, frozen.expected.terminal);

        const scheduler = (startMs) => {
          let now = startMs;
          let queue = [];
          let handle = 0;
          let calls = 0;
          return {
            requestFrame(callback) {
              queue.push(callback);
              calls++;
              return ++handle;
            },
            stepTo(timestamp) {
              if (!Number.isFinite(timestamp) || timestamp < now) throw new Error(`virtual clock moved backwards (${now} -> ${timestamp})`);
              now = timestamp;
              const batch = queue;
              queue = [];
              for (const callback of batch) callback(now);
            },
            advanceTo(deadline, stepMs) {
              while (queue.length > 0 && now < deadline) this.stepTo(Math.min(deadline, now + stepMs));
            },
            pending() { return queue.length; },
            rafCalls() { return calls; },
            get now() { return now; },
          };
        };

        const moves = frozen.timeline.filter(({ kind }) => kind === 'move');
        const down = frozen.timeline.find(({ kind }) => kind === 'down');
        const up = frozen.timeline.find(({ kind }) => kind === 'up');
        const interrupt = frozen.timeline.find(({ kind }) => kind === 'interrupt');
        const terminalEvent = frozen.timeline.find(({ kind }) => kind === 'terminal-observation');
        const sched = scheduler(up.atMs);
        const sheet = createBottomSheet({ snapPoints: frozen.snapPoints, requestFrame: sched.requestFrame });
        try {
          sheet.pointerDown({ x: 0, y: down.y, t: down.atMs / 1000 });
          for (const event of moves) sheet.pointerMove({ x: 0, y: event.y, t: event.atMs / 1000 });
          sheet.pointerUp({ x: 0, y: up.y, t: up.atMs / 1000 });
          const release = snapshot(sheet.state);
          if (release.phase !== 'release' || release.snapIndex !== frozen.expected.releaseTargetSnapIndex) {
            throw new Error(`release target law failed: ${JSON.stringify(release)}`);
          }

          sched.stepTo(up.atMs + frozen.frameStepMs);
          const movementBefore = snapshot(sheet.state);
          sched.stepTo(up.atMs + frozen.frameStepMs * 2);
          const movementAfter = snapshot(sheet.state);
          const observedMovement = assertMovement(
            movementBefore.value,
            movementAfter.value,
            frozen.frameStepMs,
            frozen.expected.movementDirection,
          );

          sched.advanceTo(interrupt.atMs, frozen.frameStepMs);
          if (sched.now < interrupt.atMs) sched.stepTo(interrupt.atMs);
          const atInterrupt = snapshot(sheet.state);
          if (atInterrupt.phase !== 'release' || atInterrupt.value === release.value) {
            throw new Error(`frozen interruption law failed: ${JSON.stringify({ release, atInterrupt })}`);
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

          sched.advanceTo(terminalEvent.atMs, frozen.frameStepMs);
          if (sched.now < terminalEvent.atMs) sched.stepTo(terminalEvent.atMs);
          const terminal = snapshot(sheet.state);
          assertTerminal(terminal, sched.pending(), frozen.expected.terminal);

          return {
            release,
            movementBefore,
            movementAfter,
            observedMovement,
            atInterrupt,
            afterInterrupt,
            terminal,
            terminalObservedAtMs: sched.now,
            pendingAtDeadline: sched.pending(),
            rafCalls: sched.rafCalls(),
            oracleControls,
          };
        } finally {
          sheet.destroy();
        }
      }, { behaviorsUrl: `${origin}/dist/behaviors/index.js`, frozen: contract });
      return { engine, version: browser.version(), status: 'PASS', ...result };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function probeSheetObservableV4({ baselineRoot, harnessRevision, contract = SHEET_OBSERVABLE_V4 }) {
  validateFrozenContract(contract);
  invariant(/^[0-9a-f]{40}$/.test(harnessRevision), 'harness revision must be an exact Git SHA');
  const server = await startDistServer(baselineRoot);
  try {
    const engines = [];
    for (const engine of ['chromium', 'firefox', 'webkit']) {
      try {
        engines.push(await probeEngine(engine, ENGINES[engine], server.origin, contract));
      } catch (error) {
        engines.push({ engine, status: 'FAIL', error: String(error instanceof Error ? error.stack ?? error.message : error) });
      }
    }
    const status = engines.every(({ status: engineStatus }) => engineStatus === 'PASS') ? 'PASS' : 'FAIL';
    return {
      schemaVersion: 1,
      status,
      node: contract.node,
      probeId: contract.id,
      baselineRevision: contract.baselineRevision,
      harnessRevision,
      contractSha256: sha256(contract),
      candidateSamples: 0,
      productionRuntimePackageDeltaBytes: 0,
      derivation: contract.derivation,
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
  const receipt = await probeSheetObservableV4({ baselineRoot, harnessRevision });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ status: receipt.status, outputPath, contractSha256: receipt.contractSha256 })}\n`);
  if (receipt.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
