import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const write = process.argv.includes('--write');
const readmePath = new URL('../README.md', import.meta.url);
const benchmarkPath = new URL('../docs/бенчмарк.md', import.meta.url);
const benchmarkResultsDirectory = new URL('../bench/compare/results/', import.meta.url);

const staleInstall = `Пакет пока не опубликован в npm (публикация — отдельное решение). До этого —
установка из тарбола (git-install не поддержан: \`dist/\` собирается, в гите его нет):

\`\`\`bash
cd lab-motion && pnpm build && pnpm pack   # → labpics-motion-<версия>.tgz
cd ваш-проект && pnpm add /путь/к/labpics-motion-<версия>.tgz
\`\`\``;

const currentInstall = `Пакет опубликован в npm:

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

function latestBenchmarkReport() {
  let entries;
  try {
    entries = readdirSync(benchmarkResultsDirectory);
  } catch {
    fail(`каталог результатов бенчмарка недоступен: ${benchmarkResultsDirectory}`);
    return;
  }
  const reports = entries
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const content = readFileSync(new URL(name, benchmarkResultsDirectory), 'utf8');
      const dateMatch = content.match(/^- Дата:\s*(\S+)\s*$/mu);
      const timestamp = dateMatch ? Date.parse(dateMatch[1]) : Number.NaN;
      return { name, timestamp };
    });

  if (reports.length === 0) {
    fail('bench/compare/results не содержит сгенерированных Markdown-отчётов');
    return undefined;
  }

  const malformed = reports.filter(({ timestamp }) => !Number.isFinite(timestamp));
  for (const { name } of malformed) fail(`${name}: отсутствует корректная строка «- Дата: ISO»`);

  return reports
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((left, right) => right.timestamp - left.timestamp || right.name.localeCompare(left.name))[0];
}

let readme = readFileSync(readmePath, 'utf8');

if (write && readme.includes(staleInstall)) {
  readme = readme.replace(staleInstall, currentInstall);
  writeFileSync(readmePath, readme);
}

const benchmark = readFileSync(benchmarkPath, 'utf8');
const latestReport = latestBenchmarkReport();

if (readme.includes('Пакет пока не опубликован')) {
  fail('README утверждает, что опубликованный пакет не опубликован');
}
if (!readme.includes('pnpm add @labpics/motion')) {
  fail('README не содержит каноническую npm-установку');
}
if (latestReport) {
  const expectedPath = `bench/compare/results/${latestReport.name}`;
  if (!benchmark.includes(expectedPath)) {
    fail(`документ бенчмарка не ссылается на актуальный отчёт ${expectedPath}`);
  }
}
if (benchmark.includes('Достоверных сравнительных чисел пока нет')) {
  fail('документ бенчмарка содержит устаревший статус runtime-измерений');
}
if (benchmark.includes('BACKLOG.md')) {
  fail('документ бенчмарка содержит мёртвую ссылку на backlog');
}

if (process.exitCode === undefined) {
  console.log(`docs-facts: ${write ? 'write + check' : 'check'} PASS`);
}
