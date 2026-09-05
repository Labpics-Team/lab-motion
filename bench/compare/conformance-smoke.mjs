/** Реальный headed Chromium/CDP smoke; один захват на режим, без повторов. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium } from 'playwright';
import { captureTrajectory, startBenchmarkOrigin } from './bench.mjs';
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

function buildAdapters(temporaryDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (esbuild.version !== manifest.devDependencies.esbuild) {
    throw new Error('esbuild не совпадает с точной версией bench/compare/package.json');
  }
  const adapters = {};
  for (const [id, entry] of [
    ['lab', 'lab.entry.mjs'],
    ['waapi-ctl', 'waapi-control.entry.mjs'],
    ['injected-native-freeze', null],
  ]) {
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
  const evidence = {};
  const rawFrames = {};
  for (const [mode, capture] of Object.entries(captures)) {
    evidence[mode] = capture.decoded;
    evidence[`${mode}Witness`] = capture.witness;
    evidence[`${mode}Clock`] = capture.clock;
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
    const target = run[mode];
    const witness = run.witness[mode];
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

async function main() {
  const temporaryRoot = realpathSync(tmpdir());
  const temporaryDirectory = realpathSync(mkdtempSync(path.join(temporaryRoot, temporaryPrefix)));
  const errors = [];
  let browser;
  let origin;
  try {
    const adapters = buildAdapters(temporaryDirectory);
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
    for (const scenario of [
      { label: 'lab-js', participant: 'lab', adapter: 'lab', expected: { baseline: 'pass', blocked: 'fail' } },
      { label: 'native-control', participant: 'waapi-ctl', adapter: 'waapi-ctl', expected: { baseline: 'pass', blocked: 'pass' } },
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
  console.log('PASS: пять реальных записей подтвердили ожидаемые вердикты S5; один запуск, без performance claims.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
