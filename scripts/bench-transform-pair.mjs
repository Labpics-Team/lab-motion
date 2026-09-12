import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarizeDistribution } from './bench-support.mjs';
import { runTransformLifecycleSample, TRANSFORM_PAIR_PROFILE } from './bench-transform-support.mjs';
import { assertBalancedRunBlocks, makeRoundRobinOrders } from '../bench/compare/methodology.mjs';
import {
  assertCheckoutUnchanged, assertFileHashesUnchanged, assertInstalledPackageTreesUnchanged,
  hashFileTree, prepareBenchmarkCheckout, readCheckoutState, sha256File,
} from '../bench/compare/provenance.mjs';

const IDS = ['baseline', 'candidate'];
const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_FILES = ['scripts/bench-transform-pair.mjs', 'scripts/bench-transform-support.mjs',
  'scripts/bench-support.mjs', 'bench/compare/methodology.mjs', 'bench/compare/provenance.mjs'];

function resolvePair(roots) {
  const baseline = realpathSync(roots.baseline);
  const candidate = realpathSync(roots.candidate);
  if (baseline === candidate) throw new Error('transform pair: один и тот же resolved root');
  return { baseline, candidate };
}

export function parseTransformPairArgs(args) {
  if (args.length !== 4 || args[0] !== '--baseline' || args[2] !== '--candidate' ||
      !args[1] || !args[3] || args[1].startsWith('--') || args[3].startsWith('--')) {
    throw new Error('transform pair: аргументы --baseline <root> --candidate <root> обязательны и исчерпывающи');
  }
  return resolvePair({ baseline: args[1], candidate: args[3] });
}

export function makeTransformPairPlan() {
  const plan = [];
  const profile = TRANSFORM_PAIR_PROFILE;
  let caseIndex = 0;
  for (const lifecycle of profile.lifecycles) for (const channels of profile.channels) for (const count of profile.counts) {
    const spec = { lifecycle, channels, count };
    for (const [phase, rounds] of [['warmup', profile.warmupRounds], ['measurement', profile.rounds]]) {
      const firstBlock = makeRoundRobinOrders(IDS, 2, (profile.seed + caseIndex) >>> 0);
      // Чередование ABBA/BAAB даёт каждому участнику две внешних и две внутренних позиции.
      const orders = Array.from({ length: rounds }, (_, round) => firstBlock[(round + Math.floor(round / 2)) % 2]);
      assertBalancedRunBlocks('transform pair', orders, IDS);
      for (let round = 0; round < rounds; round++) plan.push({
        case: spec, phase, round, block: `${caseIndex}:${phase}:${Math.floor(round / 2)}`, order: orders[round],
      });
    }
    caseIndex++;
  }
  return plan;
}

function buildToStderr(root) {
  // stdout остаётся ровно одним JSON; root передаётся через cwd, не shell-текстом.
  try {
    const result = execFileSync('pnpm', ['run', 'build'], {
      cwd: root, shell: process.platform === 'win32', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stderr.write(result);
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

function prepare(options) {
  const provenance = prepareBenchmarkCheckout({ ...options, build: buildToStderr,
    requiredRootPackages: ['tsup', 'typescript', 'esbuild'],
  });
  return { ...provenance, distTree: hashFileTree(path.join(options.root, 'dist')) };
}

function verify(root, prepared) {
  assertCheckoutUnchanged(root, prepared);
  const tree = hashFileTree(path.join(root, 'dist'));
  if (tree.sha256 !== prepared.distTree.sha256 || tree.files !== prepared.distTree.files) {
    throw new Error('transform pair: dist изменился; результаты отброшены');
  }
  assertInstalledPackageTreesUnchanged(root, prepared.environment.rootPackages);
}

function summarize(samples) {
  return {
    observations: samples.length,
    operationNs: summarizeDistribution(samples.map((sample) => sample.operationNs)),
    frameNs: summarizeDistribution(samples.flatMap((sample) => sample.frameNs)),
    cancelDrainNs: summarizeDistribution(samples.map((sample) => sample.cancelDrainNs)),
  };
}

function pairedBlocks(rounds) {
  if (rounds.length !== TRANSFORM_PAIR_PROFILE.rounds) throw new Error('transform pair: неполные измерительные блоки');
  const blocks = [];
  for (let index = 0; index < rounds.length; index += 2) {
    const first = rounds[index];
    const second = rounds[index + 1];
    if (first.block !== second.block || first.round + 1 !== second.round ||
        first.order[0] !== second.order[1] || first.order[1] !== second.order[0]) {
      throw new Error('transform pair: нарушена парность ABBA/BAAB');
    }
    const contrast = (read) => ((read(first.samples.candidate) - read(first.samples.baseline)) +
      (read(second.samples.candidate) - read(second.samples.baseline))) / 2;
    const frames = first.samples.baseline.frameNs.length;
    if ([first, second].some((round) => IDS.some((id) => round.samples[id].frameNs.length !== frames))) {
      throw new Error('transform pair: форма кадров парного блока различается');
    }
    blocks.push({
      block: first.block, rounds: [first.round, second.round], order: [...first.order, ...second.order],
      candidateMinusBaselineNs: {
        operation: contrast((sample) => sample.operationNs),
        frames: Array.from({ length: frames }, (_, frame) => contrast((sample) => sample.frameNs[frame])),
        cancelDrain: contrast((sample) => sample.cancelDrainNs),
      },
    });
  }
  return blocks;
}

/** Внедряемые зависимости нужны герметичному тесту порядка build→import→measure→verify. */
export async function runTransformPair(inputRoots, dependencies = {}) {
  const roots = resolvePair(inputRoots);
  const prepareCheckout = dependencies.prepare ?? prepare;
  const verifyCheckout = dependencies.verify ?? verify;
  const load = dependencies.load ?? (async (root) => (await import(pathToFileURL(path.join(root, 'dist/animate/index.js')).href)).animate);
  const measure = dependencies.measure ?? runTransformLifecycleSample;
  const harness = Object.fromEntries(HARNESS_FILES.map((name) => {
    const file = path.join(RUNNER_ROOT, name);
    return [name, { path: file, sha256: sha256File(file) }];
  }));
  const provenance = {};
  for (const id of IDS) provenance[id] = prepareCheckout({
    root: roots[id], benchDirectory: roots[id], requireClean: true,
    requiredDist: ['dist/animate/index.js'], requiredInputs: HARNESS_FILES.map((name) => [`harness/${name}`, harness[name].path]),
  });
  // Вторая сборка не может незаметно заменить уже закреплённый первый checkout.
  for (const id of IDS) verifyCheckout(roots[id], provenance[id]);
  const implementations = {};
  for (const id of IDS) implementations[id] = await load(roots[id]);
  const plan = makeTransformPairPlan();
  const raw = [];
  try {
    for (const entry of plan) {
      const paired = {};
      for (const id of entry.order) paired[id] = await measure({ animate: implementations[id], ...entry.case });
      raw.push({ ...entry, samples: paired });
    }
  } finally {
    for (const id of IDS) verifyCheckout(roots[id], provenance[id]);
    assertFileHashesUnchanged(harness);
  }
  const summary = [];
  const paired = [];
  for (const entry of plan.filter((item) => item.phase === 'measurement' && item.round === 0)) {
    const matching = raw.filter((item) => item.phase === 'measurement' &&
      item.case.lifecycle === entry.case.lifecycle && item.case.channels === entry.case.channels && item.case.count === entry.case.count);
    summary.push({ case: entry.case, ...Object.fromEntries(IDS.map((id) => [id, summarize(matching.map((item) => item.samples[id]))])) });
    paired.push({ case: entry.case, blocks: pairedBlocks(matching) });
  }
  return {
    schemaVersion: 2, profile: TRANSFORM_PAIR_PROFILE, seed: TRANSFORM_PAIR_PROFILE.seed,
    provenance, harness, roots,
    environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, execArgv: process.execArgv },
    raw, summary, paired,
    summaryInterpretation: 'descriptive marginal empirical quantiles; not comparative proof',
    pairedInterpretation: 'per-block mean(candidate) minus mean(baseline), paired by frame index; cancels additive linear drift over four execution positions, not arbitrary wall-clock drift; no confidence or admission claim',
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const roots = parseTransformPairArgs(process.argv.slice(2));
    const runner = readCheckoutState(RUNNER_ROOT);
    if (runner.dirty) throw new Error('transform pair: runner требует clean checkout');
    const report = await runTransformPair(roots);
    const after = readCheckoutState(RUNNER_ROOT);
    if (after.revision !== runner.revision || after.worktreeSha256 !== runner.worktreeSha256 || after.dirty) {
      throw new Error('transform pair: runner checkout изменился');
    }
    process.stdout.write(`${JSON.stringify({ ...report, runner })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
