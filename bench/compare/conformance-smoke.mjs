/** Реальный headed Chromium/CDP smoke; один захват на режим, без повторов. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const requireBenchmark = createRequire(import.meta.url);
import { captureDiagnosticError, captureTrajectory, startBenchmarkOrigin } from './bench.mjs';
import { PRODUCTION_ADAPTER_PROFILE } from './methodology.mjs';
import { createBenchmarkMotionConformance, S5_MOTION_REQUIREMENTS } from './report-contract.mjs';
import { S5_MOTION_CONTRACT } from './motion-conformance.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const temporaryPrefix = 'lab-motion-conformance-smoke-';

// Нативная интерполяция удерживает 25% от t=25% до t=65%, затем скачком догоняет время.
const injectedAdapter = `
export const name = 'injected-native-freeze-25-to-65';
export function start(elements, px, duration) {
  const animations = elements.map((element) => element.animate([
    { offset: 0, transform: 'translateX(0px)' },
    { offset: 0.25, transform: 'translateX(' + px * 0.25 + 'px)', easing: 'steps(1, end)' },
    { offset: 0.65, transform: 'translateX(' + px * 0.65 + 'px)' },
    { offset: 1, transform: 'translateX(' + px + 'px)' },
  ], { duration, easing: 'linear', fill: 'forwards' }));
  return { cancel() { for (const animation of animations) animation.cancel(); } };
}
`;

function buildAdapters(temporaryDirectory, diagnostic = false) {
  const esbuild = requireBenchmark('esbuild');
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (esbuild.version !== manifest.devDependencies.esbuild) {
    throw new Error('esbuild не совпадает с точной версией bench/compare/package.json');
  }
  const adapters = {};
  for (const [id, entry] of [
    ['lab', 'lab.entry.mjs'],
    ['waapi-ctl', 'waapi-control.entry.mjs'],
    ['lab-spring', 'lab-spring.entry.mjs'],
    ['injected-native-freeze', null],
  ]) {
    if (diagnostic && id !== 'lab-spring') continue;
    const outfile = path.join(temporaryDirectory, `${id}.iife.js`);
    esbuild.buildSync({
      ...PRODUCTION_ADAPTER_PROFILE,
      format: 'iife',
      globalName: '__adapterModule',
      outfile,
      ...(entry === null
        ? { stdin: { contents: injectedAdapter, sourcefile: 'injected-native-freeze.mjs', loader: 'js' } }
        : { entryPoints: [path.join(directory, 'entries', entry)] }),
    });
    adapters[id] = {
      path: outfile,
      sha256: createHash('sha256').update(readFileSync(outfile)).digest('hex'),
    };
  }
  return adapters;
}

function assessCaptures(participant, captures) {
  const evidence = { measurement: {} };
  const rawFrames = {};
  for (const [mode, capture] of Object.entries(captures)) {
    evidence[mode] = capture.decoded;
    evidence[`${mode}Witness`] = capture.witness;
    evidence[`${mode}Clock`] = capture.clock;
    evidence.measurement[mode] = capture.measurement;
    rawFrames[mode] = capture.rawFrames;
  }
  // Пустые массивы обозначают неизмеренные пути. Это вход oracle, не fixture отчёта.
  const results = Object.fromEntries(S5_MOTION_REQUIREMENTS.baseline.map((id) => [
    id, { raw: { freeze: id === participant ? [{ evidence, rawFrames }] : [] } },
  ]));
  return createBenchmarkMotionConformance(results)[participant].runs[0];
}

async function recordScenario(browser, origin, scenario, adapter) {
  const captures = {};
  for (const mode of Object.keys(scenario.expected)) {
    console.log(`Запись ${scenario.label}: ${mode}; headed Chromium, ${S5_MOTION_CONTRACT.durationMs} мс.`);
    captures[mode] = await captureTrajectory(browser, adapter.path, mode === 'blocked', origin.url);
  }
  const run = assessCaptures(scenario.participant, captures);
  const failures = [];
  for (const [mode, expected] of Object.entries(scenario.expected)) {
    const target = run.diagnostic[mode];
    const witness = run.diagnostic.witness[mode];
    const capture = run.capture[mode];
    const accepted = capture.verdict === 'pass' && witness.verdict === 'pass' && target.verdict === expected;
    console.log(JSON.stringify({
      scenario: scenario.label,
      participant: scenario.participant,
      adapterSha256: adapter.sha256,
      mode,
      expected,
      accepted,
      rawFrames: captures[mode].rawFrames,
      capture,
      witness,
      target,
    }));
    if (!accepted) {
      failures.push(new Error(
        `${scenario.label}.${mode}: ожидалось ${expected}; target=${target.verdict}, `
        + `witness=${witness.verdict}, capture=${capture.verdict}`,
      ));
    }
  }
  return failures;
}

export async function recordCaptureReplay(browser, origin, adapter, outputDirectory, capture = captureTrajectory) {
  if (!path.isAbsolute(outputDirectory)) throw new Error('S5_CAPTURE_DIAGNOSTIC_DIR must be absolute');
  mkdirSync(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, 'observation-replay');
  mkdirSync(destination); // One attempt, never overwrite earlier evidence.
  const adapterBytes = readFileSync(adapter.path);
  if (createHash('sha256').update(adapterBytes).digest('hex') !== adapter.sha256) throw new Error('S5 replay adapter changed');
  writeFileSync(path.join(destination, 'adapter.js'), adapterBytes);
  const captureResult = await capture(browser, adapter.path, true, origin.url, {
    replay: true,
    retain({ frames, nativeDiagnostic, replay, errors }) {
      const retained = frames.map(({ data, ...frame }, index) => {
        const png = `${index.toString().padStart(4, '0')}.png`;
        writeFileSync(path.join(destination, png), Buffer.from(data, 'base64'));
        return { ...frame, png };
      });
      writeFileSync(path.join(destination, 'raw.json'), JSON.stringify({
        mode: 'observation-replay', qualification: false, adapterSha256: adapter.sha256,
        frames: retained, nativeDiagnostic, replay, errors,
      }, null, 2));
    },
  });
  // No oracle admission / compare pass is computed for observed replay.
  writeFileSync(path.join(destination, 'capture.json'), JSON.stringify(captureResult, null, 2));
  return captureResult;
}

export async function recordCaptureDiagnostic(browser, origin, adapter, outputDirectory, capture = captureTrajectory) {
  if (!path.isAbsolute(outputDirectory)) throw new Error('S5_CAPTURE_DIAGNOSTIC_DIR must be absolute');
  mkdirSync(outputDirectory, { recursive: true });
  const errors = [];
  const rounds = [];
  for (let round = 0; round < 8; round++) {
    const captures = {};
    const order = round % 2 === 0 ? ['baseline', 'blocked'] : ['blocked', 'baseline'];
    for (const mode of order) {
      const destination = path.join(outputDirectory, `round-${round}-${mode}`);
      mkdirSync(destination); // Не перезаписывать evidence предыдущего запуска.
      try {
        captures[mode] = await capture(browser, adapter.path, mode === 'blocked', origin.url, {
          retain({ frames, nativeDiagnostic, errors }) {
            const retained = frames.map(({ data, ...frame }, index) => {
              const png = `${index.toString().padStart(4, '0')}.png`;
              writeFileSync(path.join(destination, png), Buffer.from(data, 'base64'));
              return { ...frame, png };
            });
            writeFileSync(path.join(destination, 'raw.json'), JSON.stringify({
              adapterSha256: adapter.sha256, frames: retained, nativeDiagnostic, errors,
            }, null, 2));
          },
        });
        writeFileSync(path.join(destination, 'capture.json'), JSON.stringify(captures[mode], null, 2));
        const native = captures[mode].nativeDiagnostic;
        if (native?.status !== 'recorded' || native.records.some((record) => (
          record.ready?.status !== 'complete' || record.ready.outcome !== 'resolved'
          || !Number.isFinite(record.ready.startTime) || !Number.isFinite(record.ready.startEpochMs)
        ))) errors.push(new Error(`round-${round}.${mode}: native timing incomplete`));
      } catch (error) {
        errors.push(error);
        try {
          writeFileSync(path.join(destination, 'error.json'), JSON.stringify({ error: captureDiagnosticError(error) }, null, 2));
        } catch (retentionError) { errors.push(retentionError); }
      }
    }
    const result = { round, order, captures };
    if (captures.baseline && captures.blocked) {
      try {
        const assessment = assessCaptures('lab-spring', captures);
        result.assessment = assessment;
        for (const mode of order) {
          if (assessment[mode].verdict !== 'pass' || assessment.witness[mode].verdict !== 'pass'
            || assessment.capture[mode].verdict !== 'pass') {
            errors.push(new Error(`round-${round}.${mode}: S5 contract failed`));
          }
        }
      } catch (error) {
        errors.push(error);
        result.assessmentError = captureDiagnosticError(error);
      }
    }
    rounds.push(result);
  }
  try {
    writeFileSync(path.join(outputDirectory, 'diagnostic.json'), JSON.stringify({
      diagnostic: 'native-start-versus-residual-pipeline', contract: S5_MOTION_CONTRACT,
      adapterSha256: adapter.sha256, chromium: browser.version(), rounds,
      errors: errors.map(captureDiagnosticError),
    }, null, 2));
  } catch (retentionError) { errors.push(retentionError); }
  if (errors.length > 0) throw new AggregateError(errors, 'S5 capture diagnostic failed');
}

async function main() {
  const replay = process.env.S5_CAPTURE_REPLAY === '1';
  const diagnostic = process.env.S5_CAPTURE_DIAGNOSTIC === '1';
  if (replay && diagnostic) throw new Error('S5 replay and qualification modes are mutually exclusive');
  const outputDirectory = process.env.S5_CAPTURE_DIAGNOSTIC_DIR;
  if ((diagnostic || replay) && (!outputDirectory || !path.isAbsolute(outputDirectory))) {
    throw new Error('S5_CAPTURE_DIAGNOSTIC_DIR must be absolute');
  }
  const esbuild = requireBenchmark('esbuild');
  const { chromium } = requireBenchmark('playwright');
  const temporaryRoot = realpathSync(tmpdir());
  const temporaryDirectory = realpathSync(mkdtempSync(path.join(temporaryRoot, temporaryPrefix)));
  const errors = [];
  let browser;
  let origin;
  try {
    const adapters = buildAdapters(temporaryDirectory, diagnostic || replay);
    origin = await startBenchmarkOrigin();
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    });
    console.log(JSON.stringify({
      diagnostic: 'S5 CDP conformance smoke',
      contract: S5_MOTION_CONTRACT,
      chromium: browser.version(),
      esbuild: esbuild.version,
      repeats: 1,
    }));
    if (replay) {
      await recordCaptureReplay(browser, origin, adapters['lab-spring'], outputDirectory);
    } else if (diagnostic) {
      await recordCaptureDiagnostic(browser, origin, adapters['lab-spring'], outputDirectory);
    } else for (const scenario of [
      { label: 'lab-root-native', participant: 'lab', adapter: 'lab', expected: { baseline: 'pass', blocked: 'pass' } },
      { label: 'native-control', participant: 'waapi-ctl', adapter: 'waapi-ctl', expected: { baseline: 'pass', blocked: 'pass' } },
      { label: 'lab-spring', participant: 'lab-spring', adapter: 'lab-spring', expected: { baseline: 'pass', blocked: 'pass' } },
      { label: 'injected-native-freeze', participant: 'waapi-ctl', adapter: 'injected-native-freeze', expected: { baseline: 'fail' } },
    ]) {
      errors.push(...await recordScenario(browser, origin, scenario, adapters[scenario.adapter]));
    }
  } catch (error) {
    errors.push(error);
  } finally {
    if (browser !== undefined) {
      try { await browser.close(); } catch (error) { errors.push(error); }
    }
    if (origin !== undefined) {
      try { await origin.close(); } catch (error) { errors.push(error); }
    }
    try {
      // Повторная проверка точного mkdtemp-пути перед рекурсивным удалением.
      if (realpathSync(temporaryDirectory) !== temporaryDirectory
        || path.dirname(temporaryDirectory) !== temporaryRoot
        || !path.basename(temporaryDirectory).startsWith(temporaryPrefix)) {
        throw new Error('Временный каталог smoke изменился; автоматическое удаление запрещено');
      }
      rmSync(temporaryDirectory, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'S5 conformance smoke не пройден');
  console.log(replay ? 'RECORDED: one observer-effect S5 replay; NOT qualification or compare pass.'
    : diagnostic ? 'PASS: 16 S5 diagnostic captures retained; no performance claims.'
    : 'PASS: семь реальных записей подтвердили ожидаемые вердикты S5; один запуск, без performance claims.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
