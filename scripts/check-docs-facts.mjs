import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAllowedPostReportChanges,
  parseBenchmarkDocumentationState,
  validateBenchmarkReportPair,
} from '../bench/compare/report-contract.mjs';
import {
  revisionFingerprint,
  sha256Bytes,
} from '../bench/compare/provenance.mjs';
import { listChangedGitPaths } from './git-path-list.mjs';

const write = process.argv.includes('--write');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(ROOT, 'README.md');
const benchmarkPath = path.join(ROOT, 'docs', 'бенчмарк.md');
const benchmarkResultsDirectory = path.join(ROOT, 'bench', 'compare', 'results');
const rootPackagePath = path.join(ROOT, 'package.json');
const benchmarkPackagePath = path.join(ROOT, 'bench', 'compare', 'package.json');

const staleInstall = `Пакет пока не опубликован в npm (публикация — отдельное решение). До этого —
установка из тарбола (git-install не поддержан: \`dist/\` собирается, в гите его нет):

\`\`\`bash
cd lab-motion && pnpm build && pnpm pack   # → labpics-motion-<версия>.tgz
cd ваш-проект && pnpm add /путь/к/labpics-motion-<версия>.tgz
\`\`\``;

const currentInstall = `Установите опубликованную версию из npm:

\`\`\`bash
pnpm add @labpics/motion
\`\`\`

Для разработки из исходников используйте тарбол: \`pnpm build && pnpm pack\`, затем
\`pnpm add /путь/к/labpics-motion-<версия>.tgz\`. Git-установка не поддерживается:
\`dist/\` собирается и не хранится в репозитории.`;

function fail(message) {
  console.error(`docs-facts: ${message}`);
  process.exitCode = 1;
}

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: ROOT, encoding });
}

function validateRevision(payload, stem) {
  const { revision, worktreeSha256 } = payload.provenance;
  try {
    git(['cat-file', '-e', `${revision}^{commit}`]);
    execFileSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], { cwd: ROOT });
  } catch {
    throw new Error(`revision ${revision} не является доступным предком HEAD`);
  }
  if (revisionFingerprint(ROOT, revision) !== worktreeSha256) {
    throw new Error('dirty:false не подтверждается байтами Git revision');
  }
  const changed = listChangedGitPaths(ROOT, `${revision}..HEAD`);
  assertAllowedPostReportChanges(changed, stem);
  const commitTime = Date.parse(git(['show', '-s', '--format=%cI', revision]).trim());
  if (!Number.isFinite(commitTime) || commitTime > Date.parse(payload.generatedAt)) {
    throw new Error('generatedAt раньше времени коммита');
  }
  const historicalInputs = {
    'root/package.json': 'package.json',
    'root/pnpm-lock.yaml': 'pnpm-lock.yaml',
    'root/scripts/compression-policy.mjs': 'scripts/compression-policy.mjs',
    'root/scripts/compression-oracle.mjs': 'scripts/compression-oracle.mjs',
    'bench/package.json': 'bench/compare/package.json',
    'bench/pnpm-lock.yaml': 'bench/compare/pnpm-lock.yaml',
    'bench/bench.mjs': 'bench/compare/bench.mjs',
    'bench/methodology.mjs': 'bench/compare/methodology.mjs',
    'bench/provenance.mjs': 'bench/compare/provenance.mjs',
    'bench/report-contract.mjs': 'bench/compare/report-contract.mjs',
  };
  for (const [label, file] of Object.entries(historicalInputs)) {
    const bytes = git(['show', `${revision}:${file}`], 'buffer');
    const hash = sha256Bytes(bytes);
    if (payload.provenance.inputs[label] !== hash) {
      throw new Error(`${label} SHA-256 не совпадает с Git revision`);
    }
  }
}

function pairedReportNames() {
  let directoryEntries;
  try {
    directoryEntries = readdirSync(benchmarkResultsDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const entries = directoryEntries
    .filter((name) => !name.startsWith('.') && /\.(?:md|json)$/.test(name));
  const stems = new Map();
  for (const name of entries) {
    const extension = path.extname(name).slice(1);
    const stem = name.slice(0, -(extension.length + 1));
    const pair = stems.get(stem) ?? new Set();
    pair.add(extension);
    stems.set(stem, pair);
  }
  for (const [stem, pair] of stems) {
    if (pair.size !== 2 || !pair.has('md') || !pair.has('json')) {
      throw new Error(`${stem}: отчёт осиротел, нужны MD и JSON`);
    }
  }
  return stems;
}

let readme = readFileSync(readmePath, 'utf8');
if (write && readme.includes(staleInstall)) {
  readme = readme.replace(staleInstall, currentInstall);
  writeFileSync(readmePath, readme);
}

const benchmark = readFileSync(benchmarkPath, 'utf8');
if (readme.includes('Пакет пока не опубликован')) fail('README утверждает, что опубликованный пакет не опубликован');
if (!readme.includes('pnpm add @labpics/motion')) fail('README не содержит каноничную npm-установку');

try {
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
  const state = parseBenchmarkDocumentationState(benchmark, rootPackage);
  const pairs = pairedReportNames();
  if (state.kind === 'none') {
    if (pairs.size !== 0) throw new Error('документ отрицает claims, но каталог содержит отчёт');
  } else {
    if (pairs.size !== 1 || !pairs.has(state.stem)) {
      throw new Error(`документ обязан указывать единственную пару отчёта ${state.stem}`);
    }
    const stem = state.stem;
    const markdownFile = path.join(benchmarkResultsDirectory, `${stem}.md`);
    const jsonFile = path.join(benchmarkResultsDirectory, `${stem}.json`);
    if (!existsSync(markdownFile) || !existsSync(jsonFile)) throw new Error(`нет пары отчёта ${stem}`);
    const markdown = readFileSync(markdownFile, 'utf8');
    let payload;
    try {
      payload = JSON.parse(readFileSync(jsonFile, 'utf8'));
    } catch (error) {
      throw new Error(`${stem}.json: невалидный JSON (${error?.message ?? String(error)})`);
    }
    const benchmarkPackage = JSON.parse(readFileSync(benchmarkPackagePath, 'utf8'));
    validateBenchmarkReportPair({ stem, markdown, payload, rootPackage, benchmarkPackage });
    validateRevision(payload, stem);
  }
} catch (error) {
  fail(error?.message ?? String(error));
}

if (benchmark.includes('Достоверных сравнительных чисел пока нет')) {
  fail('документ бенчмарка содержит устаревший статус runtime-измерений');
}
if (benchmark.includes('BACKLOG.md')) fail('документ бенчмарка содержит мёртвую ссылку на backlog');

if (process.exitCode === undefined) console.log(`docs-facts: ${write ? 'write + check' : 'check'} PASS`);
