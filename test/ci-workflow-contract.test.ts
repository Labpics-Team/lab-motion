import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMap, isScalar, isSeq, parse, parseDocument, stringify } from 'yaml';
import { createVitest, type CliOptions } from 'vitest/node';

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  name?: string;
  id?: string;
  run?: string;
  if?: string | boolean;
  shell?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
};
type BrowserShard = { browser: string; shard: number; shards: number };
type Job = {
  name?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  if?: string | boolean;
  needs?: string[];
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  defaults?: unknown;
  container?: { image: string; options: string };
  'continue-on-error'?: boolean;
  steps?: Step[];
  strategy?: {
    'fail-fast': boolean;
    'max-parallel'?: number;
    matrix: { node?: string[]; include?: BrowserShard[] };
  };
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  defaults?: unknown;
  jobs: Record<string, Job>;
};

const playwrightPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const playwrightVersion = playwrightPackage.devDependencies['@playwright/test'] as string;
const nodeFloor = String(playwrightPackage.engines.node).replace(/^>=/, '').split('.');
while (nodeFloor.length < 3) nodeFloor.push('0');
const minimumNode = nodeFloor.join('.');

const directory = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const sourceFiles = new Map(readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, readFileSync(join(directory, name), 'utf8')]));
const sources = () => new Map(sourceFiles);
const candidateEvents = new Set(['pull_request', 'pull_request_target', 'merge_group']);
const events = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new Error('Некорректные события workflow');
};
const bash = process.platform === 'win32'
  ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe') : 'bash';
// Windows alias python3 может вести в Store; shell-проверки используют установленный Python.
const pythonPath = process.platform === 'win32'
  ? spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim() : '';
const pythonSetup = process.platform === 'win32'
  ? `python3() { '${pythonPath.replaceAll('\\', '/').replaceAll("'", "'\\''")}' "$@"; }\nexport -f python3\n` : '';
// Закрепление внешних actions проверяется правилом, а не значениями: SHA и версию меняет
// Dependabot, поэтому контракт требует полный SHA разрешённого репозитория, а не конкретный.
const allowedActions = new Set([
  'actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact',
]);
const externalAction = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/;
const localWorkflow = /^\.\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const versionComment = /^v\d+\.\d+\.\d+$/;

function unpin(uses: string): string {
  const match = externalAction.exec(uses);
  if (!match || !allowedActions.has(match[1]!)) {
    throw new Error(`Action должен быть закреплён полным SHA разрешённого репозитория: ${uses}`);
  }
  return `${match[1]}@<sha>`;
}

type Reference = { where: string; ref: string; comment: string };

// `uses` заданий и шагов берётся из разобранного YAML, а не из текста: его нельзя ни пропустить
// формой записи (`uses :`), ни подменить строкой внутри многострочного значения. Комментарий
// версии читается с того же поля и той же строки: именно там его обновляет Dependabot, а
// комментарий на соседней строке остался бы старым после обновления SHA и не был бы замечен.
function references(name: string, source: string): Reference[] {
  const document = parseDocument(source);
  expect(document.errors, `${name}: workflow не разбирается`).toEqual([]);
  const found: Reference[] = [];
  const take = (owner: unknown, where: string) => {
    if (!isMap(owner)) return;
    const node = owner.get('uses', true);
    if (node === undefined) return;
    if (!isScalar(node) || typeof node.value !== 'string') throw new Error(`${where}: uses должен быть строкой`);
    found.push({ where, ref: node.value, comment: (node.comment ?? '').split('\n')[0]!.trim() });
  };
  const jobs = document.get('jobs', true);
  if (!isMap(jobs)) return found;
  for (const pair of jobs.items) {
    const where = `${name}: ${isScalar(pair.key) ? String(pair.key.value) : '?'}`;
    take(pair.value, where);
    const steps = isMap(pair.value) ? pair.value.get('steps', true) : undefined;
    if (isSeq(steps)) steps.items.forEach((step, index) => take(step, `${where}.steps[${index}]`));
  }
  return found;
}

// Каждый внешний action закреплён полным SHA разрешённого репозитория, включая jobs без
// ожидаемого списка (docs.yml, release.yml): reusable workflow допускается только локальный.
function assertPinned(files: Map<string, string>) {
  for (const [name, source] of files) {
    for (const { where, ref } of references(name, source)) {
      if (ref.startsWith('./')) expect(ref, `${where}: reusable workflow только из этого репозитория`).toMatch(localWorkflow);
      else unpin(ref);
    }
  }
}


function runStep(job: Job, pattern: RegExp): Step {
  const found = (job.steps ?? []).filter(item => item.run && pattern.test(item.run));
  expect(found, `Ожидался один executable шаг: ${pattern}`).toHaveLength(1);
  return found[0]!;
}

function admitted(job: Job, item?: Step) {
  for (const value of [job, ...(item ? [item] : [])]) {
    expect(value.if).toBeUndefined();
    expect(value['continue-on-error']).toBeUndefined();
    expect((value as Job).defaults).toBeUndefined();
  }
  if (item) {
    expect(item['working-directory']).toBeUndefined();
    expect([undefined, 'bash']).toContain(item.shell);
  }
}

// Одна публичная команда — один executable шаг; текст heredoc и недостижимая ветка им не являются.
const executableLines = (item: Step) => item.run!.trim().split('\n')
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
function command(job: Job, line: string) {
  const found = (job.steps ?? []).filter(item => item.run && executableLines(item).join('\n') === line);
  expect(found, `Ожидался один executable шаг: ${line}`).toHaveLength(1);
  admitted(job, found[0]);
  if (line !== 'pnpm install --frozen-lockfile') {
    before(job, command(job, 'pnpm install --frozen-lockfile'), found[0]!);
    runtime(job, found[0]!);
  }
  return found[0]!;
}

function before(job: Job, first: Step, second: Step) {
  expect(job.steps!.indexOf(first)).toBeLessThan(job.steps!.indexOf(second));
}

// Читаются поля наблюдаемого argv, а не shell-текст. Pflag slice-флаги дополняются,
// scalar-флаги заменяются последним значением; оба способа записи поля равноправны.
function optionValues(args: string[], ...names: string[]): string[] {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    for (const name of names) {
      if (arg === name) values.push(args[index + 1]!);
      else if (arg.startsWith(name + '=')) values.push(arg.slice(name.length + 1));
      else if (/^-[^-]$/.test(name) && arg.startsWith(name)) values.push(arg.slice(name.length));
    }
  }
  return values;
}
const sliceOption = (args: string[], name: string) => optionValues(args, name).flatMap(value => value.split(',')).filter(Boolean);
const scalarOption = (args: string[], name: string) => optionValues(args, name).at(-1);
function booleanOption(args: string[], name: string): boolean {
  return args.filter(arg => arg === name || arg.startsWith(name + '=')).at(-1) === name
    || args.filter(arg => arg === name || arg.startsWith(name + '=')).at(-1) === name + '=true';
}
function toolCalls(path: string): string[][] {
  return readFileSync(path, 'utf8').split('\0\0').filter(Boolean).map(call => call.split('\0'));
}
function assertArchiveLineage(temp: string, expectedDigest?: string, extracted = true) {
  const downloads = toolCalls(join(temp, 'download.args'));
  const extracts = toolCalls(join(temp, 'extract.args'));
  expect(downloads).toHaveLength(1);
  expect(extracts).toHaveLength(extracted ? 1 : 0);
  const output = optionValues(downloads[0]!, '--output', '-o');
  expect(output).toHaveLength(1);
  const check = /^([a-f0-9]{64})\s+(.+)$/.exec(readFileSync(join(temp, 'checksum.input'), 'utf8').trim());
  expect(check, 'Checksum должен читать скачанный архив').not.toBeNull();
  if (expectedDigest) expect(check![1]).toBe(expectedDigest);
  const checks = toolCalls(join(temp, 'checksum.args'));
  expect(checks).toHaveLength(1);
  expect(checks[0]!.some(arg => arg === '--check' || /^-[^-]*c/.test(arg))).toBe(true);
  expect(checks[0]).toContain('-');
  expect(resolve(check![2]!)).toBe(resolve(output[0]!));
  if (!extracted) return;
  let archive: string | undefined;
  for (const [index, arg] of extracts[0]!.entries()) {
    if (arg === '--file') archive = extracts[0]![index + 1];
    else if (arg.startsWith('--file=')) archive = arg.slice('--file='.length);
    const shortFile = /^-([^-]*?)f(.*)$/.exec(arg);
    if (shortFile) archive = shortFile[2] || extracts[0]![index + 1];
  }
  expect(archive).toBeDefined();
  expect(resolve(archive!)).toBe(resolve(output[0]!));
}

// Эти seams наблюдают внешние команды; выбор файла, pipeline и распространение отказа
// исполняет настоящий Bash из workflow. NUL сохраняет границы argv, включая пробелы.
const archiveTrace = `
curl() { printf '%s\\0' "$@" >> "$RUNNER_TEMP/download.args"; printf '\\0' >> "$RUNNER_TEMP/download.args"; }
sha256sum() { printf '%s\\0' "$@" >> "$RUNNER_TEMP/checksum.args"; printf '\\0' >> "$RUNNER_TEMP/checksum.args"; cat > "$RUNNER_TEMP/checksum.input"; return "$CHECKSUM_STATUS"; }
tar() {
  printf '%s\\0' "$@" >> "$RUNNER_TEMP/extract.args"; printf '\\0' >> "$RUNNER_TEMP/extract.args"
  TEST_TOOL_DIRECTORY=
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -C|--directory) shift; TEST_TOOL_DIRECTORY="$1" ;;
      -C*) TEST_TOOL_DIRECTORY="\${1:2}" ;;
      --directory=*) TEST_TOOL_DIRECTORY="\${1#--directory=}" ;;
    esac
    shift
  done
  [[ -d "$TEST_TOOL_DIRECTORY" ]]
  install_test_tool
}
`;
function initializeArchiveTrace(temp: string) {
  for (const name of ['download.args', 'extract.args', 'checksum.args', 'checksum.input']) writeFileSync(join(temp, name), '');
}

function assertActionlintStep(item: Step, checksumStatus = 0, toolStatus = 0) {
  const temp = mkdtempSync(join(tmpdir(), 'motion-ci-actionlint-'));
  initializeArchiveTrace(temp);
  try {
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `${archiveTrace}\ninstall_test_tool() { printf '#!/bin/sh\\nexit ${toolStatus}\\n' > "$TEST_TOOL_DIRECTORY/actionlint"; chmod +x "$TEST_TOOL_DIRECTORY/actionlint"; }\n${item.run}`], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ...item.env, RUNNER_TEMP: temp.replaceAll('\\', '/'), CHECKSUM_STATUS: String(checksumStatus), MSYS2_ARG_CONV_EXCL: '*' },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(checksumStatus || toolStatus);
    assertArchiveLineage(temp, item.env!.ACTIONLINT_ARCHIVE_SHA256, checksumStatus === 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function assertSecurityStep(item: Step, code = 0, checksumStatus = 0) {
  const temp = mkdtempSync(join(tmpdir(), 'motion-ci-security-'));
  const trace = join(temp, 'calls.jsonl');
  const scanner = join(temp, 'trivy.sh');
  initializeArchiveTrace(temp);
  writeFileSync(trace, '');
  // Настоящий Python seed/verify остаётся в shell-пути. Seams заменяют только внешние tools.
  writeFileSync(scanner, `#!/usr/bin/env bash\npython3 - "$@" <<'PY'\nimport json, os, sys\nfrom pathlib import Path\nargs = sys.argv[1:]\nwith open(os.environ['SCANNER_TRACE'], 'a') as out:\n    out.write(json.dumps({'args': args, 'env': [key for key in os.environ if key.startswith('TRIVY_')]}) + '\\n')\nif any(arg == '--format' or arg.startswith('--format=') for arg in args):\n    print(json.dumps({'Results': [{'Target': probe.as_posix(), 'Secrets': [{'RuleID': 'aws-access-key-id'}]} for probe in Path('examples').glob('ci-trivy-canary.*/credentials.txt')]}))\n    sys.exit(1)\nsys.exit(${code})\nPY\n`, { mode: 0o755 });
  try {
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `${pythonSetup}${archiveTrace}\ninstall_test_tool() { cp "$SCANNER_STUB" "$TEST_TOOL_DIRECTORY/trivy"; chmod +x "$TEST_TOOL_DIRECTORY/trivy"; }\n${item.run}`], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, RUNNER_TEMP: temp.replaceAll('\\', '/'), SCANNER_TRACE: trace.replaceAll('\\', '/'),
        SCANNER_STUB: scanner.replaceAll('\\', '/'), CHECKSUM_STATUS: String(checksumStatus), TRIVY_SKIP_DIRS: 'examples', MSYS2_ARG_CONV_EXCL: '*' },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(checksumStatus || code);
    assertArchiveLineage(temp, undefined, checksumStatus === 0);
    const lines = readFileSync(trace, 'utf8').trim();
    const calls = lines ? lines.split('\n').map(line => JSON.parse(line) as { args: string[]; env: string[] }) : [];
    expect(calls).toHaveLength(checksumStatus ? 0 : code ? 1 : 4);
    for (const call of calls) {
      expect(call.env).toEqual([]);
      expect(call.args[0]).toBe('fs');
      expect(call.args.at(-1)).toBe('.');
      expect(scalarOption(call.args, '--config')).toBe('/dev/null');
      expect(scalarOption(call.args, '--exit-code')).toBe('1');
      expect(sliceOption(call.args, '--skip-dirs')).toEqual([]);
      expect(sliceOption(call.args, '--skip-files')).toEqual([]);
    }
    if (checksumStatus) return;
    const severities = (args: string[]) => optionValues(args, '--severity').length
      ? sliceOption(args, '--severity') : ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    expect(sliceOption(calls[0]!.args, '--scanners')).toEqual(expect.arrayContaining(['vuln', 'misconfig']));
    expect(severities(calls[0]!.args)).toEqual(expect.arrayContaining(['UNKNOWN', 'HIGH', 'CRITICAL']));
    expect(booleanOption(calls[0]!.args, '--include-dev-deps')).toBe(true);
    expect(booleanOption(calls[0]!.args, '--ignore-unfixed')).toBe(false);
    expect(scalarOption(calls[0]!.args, '--ignorefile')).toBe(
      readdirSync(fileURLToPath(new URL('../', import.meta.url))).includes('.trivyignore.yaml') ? '.trivyignore.yaml' : '/dev/null');
    if (!code) {
      expect(sliceOption(calls[1]!.args, '--scanners')).toContain('vuln');
      expect(severities(calls[1]!.args)).toEqual(expect.arrayContaining(['UNKNOWN', 'HIGH', 'CRITICAL']));
      expect(booleanOption(calls[1]!.args, '--include-dev-deps')).toBe(true);
      expect(booleanOption(calls[1]!.args, '--ignore-unfixed')).toBe(true);
      for (const index of [1, 2, 3]) expect(scalarOption(calls[index]!.args, '--ignorefile')).toBe('/dev/null');
      for (const index of [2, 3]) {
        expect(sliceOption(calls[index]!.args, '--scanners')).toContain('secret');
        expect(severities(calls[index]!.args)).toEqual(expect.arrayContaining(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']));
        const config = parse(readFileSync(scalarOption(calls[index]!.args, '--secret-config')!, 'utf8'));
        expect(config['disable-allow-rules']).toEqual(expect.arrayContaining(['tests', 'examples', 'markdown']));
      }
      expect(scalarOption(calls[3]!.args, '--format')).toBe('json');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function assertPackConsumer(item: Step, floor: boolean, count: number, code = 0, version = minimumNode) {
  const temp = mkdtempSync(join(tmpdir(), 'motion-ci-consumer-'));
  const trace = join(temp, 'node.args');
  mkdirSync(join(temp, 'node-floor-artifact'));
  for (let index = 0; index < count; index++) writeFileSync(join(temp, 'node-floor-artifact', `${index}.tgz`), 'package seam');
  writeFileSync(trace, '');
  try {
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `node() { printf '%s\\0' "$@" >> "$NODE_TRACE"; printf '\\0' >> "$NODE_TRACE"; if [[ "$1" == --version ]]; then printf 'v%s\\n' "$NODE_VERSION"; else return "$SMOKE_STATUS"; fi; }\n${item.run}`], {
      cwd: temp, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NODE_TRACE: trace.replaceAll('\\', '/'), NODE_VERSION: version, SMOKE_STATUS: String(code) },
    });
    expect(actual.error).toBeUndefined();
    const wrongFloor = floor && version !== minimumNode;
    expect(actual.status, actual.stderr).toBe(wrongFloor || count !== 1 ? 1 : code);
    const expected = floor ? [['--version']] : [];
    if (!wrongFloor && count === 1) expected.push(['scripts/pack-smoke.mjs', 'node-floor-artifact/0.tgz']);
    expect(toolCalls(trace)).toEqual(expected);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function runtime(job: Job, consumer: Step, version?: string) {
  const prior = job.steps!.slice(0, job.steps!.indexOf(consumer));
  const setup = prior.findLast(item => item.uses?.startsWith('actions/setup-node@'));
  expect(setup, 'Runtime должен быть настроен до потребителя').toBeDefined();
  admitted(job, setup);
  const actual = String(setup!.with?.['node-version']);
  if (version) expect(actual).toBe(version);
  else expect(Number(actual.split('.')[0])).toBeGreaterThanOrEqual(Number(nodeFloor[0]));
}

function preparation(job: Job) {
  const install = command(job, 'pnpm install --frozen-lockfile');
  const checkout = job.steps!.find(item => item.uses?.startsWith('actions/checkout@'));
  expect(checkout).toBeDefined();
  admitted(job, checkout);
  expect(checkout!.with?.['persist-credentials']).toBe(false);
  expect(checkout!.with?.ref).toBeUndefined();
  before(job, checkout!, install);
  runtime(job, install);
  const activate = runStep(job, /(?:^|\n)\s*corepack install\s*(?:\n|$)/);
  admitted(job, activate);
  expect(executableLines(activate)).toEqual(['corepack enable', 'corepack install']);
  before(job, activate, install);
  runtime(job, activate);
  return install;
}

// Полнота не зависит от нынешнего количества долей и их порядка.
function assertShards(parts: BrowserShard[]) {
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    const selected = parts.filter(part => part.browser === browser);
    expect(selected.length, browser).toBeGreaterThan(0);
    const total = selected[0]!.shards;
    expect(Number.isSafeInteger(total) && total > 0, browser).toBe(true);
    expect(selected.every(part => part.shards === total), browser).toBe(true);
    expect(selected.length, browser).toBe(total);
    expect(new Set(selected.map(part => part.shard)).size, browser).toBe(total);
    expect(selected.every(part => Number.isSafeInteger(part.shard) && part.shard >= 1 && part.shard <= total), browser).toBe(true);
  }
  expect(parts.every(part => ['chromium', 'firefox', 'webkit'].includes(part.browser))).toBe(true);
}

function assertNativeGraph(files: Map<string, string>) {
  assertPinned(files);
  const workflows = new Map([...files].map(([name, source]) => [name, parse(source) as Workflow]));
  expect([...workflows].filter(([, w]) => events(w.on).some(event => candidateEvents.has(event)))
    .map(([name]) => name)).toEqual(['ci.yml']);
  const ci = workflows.get('ci.yml')!;
  expect(ci.on.pull_request).toBeNull();
  expect(ci.on.merge_group).toBeNull();
  expect(ci.on.push).toEqual({ branches: ['main'] });
  for (const name of ['ci.yml', 'browser.yml', 'docs.yml']) {
    const workflow = workflows.get(name)!;
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.defaults).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job['continue-on-error']).toBeUndefined();
      expect(job.defaults).toBeUndefined();
    }
  }
  const verify = ci.jobs.verify!;
  const tests = ci.jobs.tests!;
  const mutation = ci.jobs.mutation!;
  for (const job of [verify, tests, mutation]) preparation(job);
  const build = command(verify, 'pnpm build');
  runtime(verify, build);
  before(verify, command(verify, 'pnpm check:static'), build);
  for (const line of ['node scripts/check-docs-facts.mjs', 'node scripts/check-docs-drift.mjs', 'node scripts/check-issue-forms.mjs']) command(verify, line);
  const release = runStep(verify, /node scripts\/check-release\.mjs /);
  admitted(verify, release);
  before(verify, command(verify, 'pnpm install --frozen-lockfile'), release);
  const actionlint = runStep(verify, /\/actionlint"/);
  admitted(verify, actionlint);
  expect(actionlint.env?.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(actionlint.env?.ACTIONLINT_ARCHIVE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  if (playwrightPackage.scripts['typecheck:native']) command(verify, 'pnpm typecheck:native');
  expect(playwrightPackage.scripts['check:static']).toMatch(/(?:^| && )pnpm typecheck:browser(?: && |$)/);
  for (const line of ['pnpm size', 'pnpm pack:compat', 'pnpm acceptance:compiler']) {
    before(verify, build, command(verify, line));
  }
  const consumers = verify.steps!.filter(item => item.run?.includes('node scripts/pack-smoke.mjs'));
  expect(consumers).toHaveLength(2);
  const pack = runStep(verify, /pnpm pack --pack-destination /);
  admitted(verify, pack);
  expect(executableLines(pack)).toEqual(['mkdir node-floor-artifact', 'pnpm pack --pack-destination node-floor-artifact']);
  before(verify, build, pack);
  for (const item of consumers) {
    admitted(verify, item);
    before(verify, pack, item);
  }
  runtime(verify, consumers[0]!);
  runtime(verify, consumers[1]!, minimumNode);
  const vitest = runStep(tests, /(?:^|\n)pnpm (?:exec )?vitest run(?: 2>&1 \| tee [\w./-]+)?(?:\n|$)/);
  admitted(tests, vitest);
  before(tests, command(tests, 'pnpm build'), vitest);
  const clock = command(tests, 'node test/fixtures/server-thread-cpu-clock-check.mjs');
  runtime(tests, clock, '24.19.0');
  command(mutation, 'pnpm exec stryker run stryker.driver.config.mjs');
  const security = ci.jobs.security!;
  const scan = runStep(security, /python3 test\/ci-trivy-canary\.py verify /);
  admitted(security, scan);
  const callers = Object.values(ci.jobs).filter(job => job.uses?.match(/\/(browser|docs)\.yml$/));
  expect(callers.map(job => job.uses).sort()).toEqual(['./.github/workflows/browser.yml', './.github/workflows/docs.yml']);
  for (const caller of callers) admitted(caller);
  const browser = workflows.get('browser.yml')!;
  expect(browser.on).toEqual({ workflow_call: null });
  const conformance = browser.jobs.conformance!;
  preparation(conformance);
  const image = /^mcr\.microsoft\.com\/playwright:v([^@]+)-noble@sha256:[a-f0-9]{64}$/.exec(conformance.container!.image);
  expect(image?.[1]).toBe(playwrightVersion);
  expect(conformance.container!.options).toBe('--user 1001');
  expect(conformance.strategy!['fail-fast']).toBe(false);
  assertShards(conformance.strategy!.matrix.include!);
  const browserRun = command(conformance, 'pnpm exec playwright test --project=${{ matrix.browser }} --shard=${{ matrix.shard }}/${{ matrix.shards }} --fail-on-flaky-tests');
  before(conformance, command(conformance, 'pnpm build'), browserRun);
  const reader = workflows.get('docs.yml')!.jobs.reader!;
  expect(workflows.get('docs.yml')!.on).toEqual({ workflow_call: null });
  preparation(reader);
  before(reader, command(reader, 'pnpm docs:build'), command(reader, 'pnpm docs:test'));
  const gate = ci.jobs.CI!;
  expect(gate.name).toBe('CI'); // Имя обязательного итогового check.
  expect(gate.if).toBe('${{ always() }}');
  expect(gate.permissions).toEqual({});
  const required = Object.entries(ci.jobs).filter(([id, job]) => id !== 'CI'
    && !['./.github/workflows/performance.yml', './.github/workflows/profile-01.yml'].includes(job.uses ?? ''))
    .map(([id, job]) => { admitted(id === 'mutation' ? mutation : job); return id; });
  expect([...gate.needs!].sort()).toEqual(required.sort());
  const verdict = gate.steps!.find(item => item.run)!;
  admitted({ ...gate, if: undefined }, verdict);
  expect(verdict.env?.CHECK_RESULTS).toBe('${{ toJSON(needs) }}');
  // Диагностические workflow вызываются только явно; измеряемый baseline имеет immutable identity.
  expect(ci.jobs.performance!.uses).toBe('./.github/workflows/performance.yml');
  expect(ci.jobs.performance!.with?.s5_capture_diagnostic).toBe('${{ inputs.s5_capture_diagnostic }}');
  expect(ci.jobs.performance!.with?.performance_contract_only).toBe('${{ inputs.performance_contract_only }}');
  expect(ci.jobs.performance!.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(ci.jobs.performance!.if).toContain("inputs.performance_baseline != ''");
  expect(ci.jobs.performance!.with?.baseline).toBe('${{ inputs.performance_baseline }}');
  expect(ci.jobs['profile-baseline']!.uses).toBe('./.github/workflows/profile-01.yml');
  expect(workflows.get('profile-01.yml')!.on).toEqual({ workflow_call: null });
  expect(ci.jobs['profile-baseline']!.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(ci.jobs['profile-baseline']!.if).toContain('inputs.profile_baseline');
  const performance = workflows.get('performance.yml')!;
  expect(performance.on).toEqual({ workflow_call: { inputs: {
    baseline: { type: 'string', required: true }, s5_capture_diagnostic: { type: 'boolean', default: false },
    performance_contract_only: { type: 'boolean', default: false },
  } } });
  const compare = performance.jobs.compare!;
  expect(compare.strategy).toBeUndefined();
  expect(compare['continue-on-error']).toBeUndefined();
  const baselineGuard = runStep(compare, /\[\[ "\$BASELINE" =~ /);
  admitted(compare, baselineGuard);
  expect(baselineGuard.env?.BASELINE).toBe('${{ inputs.baseline }}');
  expect(baselineGuard.run).toContain('^[0-9a-f]{40}$');
  const checkouts = compare.steps!.filter(item => item.uses?.startsWith('actions/checkout@'));
  expect(checkouts).toHaveLength(2);
  const original = checkouts.find(item => item.with?.path === 'baseline')!;
  expect(original.with?.ref).toBe('${{ inputs.baseline }}');
  for (const checkout of checkouts) {
    admitted(compare, checkout);
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(checkout.with?.['fetch-depth']).toBe(0);
    before(compare, baselineGuard, checkout);
  }
  for (const item of compare.steps!) expect(item['continue-on-error']).toBeUndefined();
  runtime(compare, runStep(compare, /pnpm --dir candidate build/), '24.19.0');
  const assertions = runStep(compare, /^xvfb-run -a node bench\.mjs\s*$/);
  expect(assertions['working-directory']).toBe('candidate/bench/compare');
  for (const [name, workflow] of workflows) {
    for (const job of Object.values(workflow.jobs)) {
      const exports = (job.steps ?? []).filter(item => item.uses?.startsWith('actions/upload-artifact@'));
      if (name === 'release.yml') continue;
      if (name !== 'performance.yml') expect(exports).toHaveLength(0);
      else {
        expect(exports).toHaveLength(1);
        const exported = exports[0]!;
        expect(exported).toBe(job.steps!.at(-1));
        expect(exported.if).toBe('${{ always() }}');
        expect(exported.with?.name).toBe('motion-performance-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
        expect(exported.with?.path).toBe('candidate/bench/compare/results/\n${{ runner.temp }}/motion-performance/\n');
        expect(exported.with?.['retention-days']).toBe(5);
        expect(exported.with?.['if-no-files-found']).toBe('error');
      }
    }
  }
}

describe('свойства CI', () => {
  it('сохраняет обязательные проверки и потребительские границы', () => assertNativeGraph(sources()));
  it('принимает переименование шагов и полный новый порядок browser-долей', () => {
    const files = sources();
    const ci = parse(files.get('ci.yml')!) as Workflow;
    for (const job of Object.values(ci.jobs)) {
      for (const item of job.steps ?? []) item.name = `Другое имя: ${item.name}`;
    }
    // Независимые проверки допускают иной порядок, подготовка и потребители сохраняются.
    const checks = ci.jobs.verify!.steps!;
    const staticCheck = checks.findIndex(item => item.run === 'pnpm check:static');
    const nativeCheck = checks.findIndex(item => item.run === 'pnpm typecheck:native');
    [checks[staticCheck], checks[nativeCheck]] = [checks[nativeCheck]!, checks[staticCheck]!];
    files.set('ci.yml', stringify(ci));
    const browser = parse(files.get('browser.yml')!) as Workflow;
    browser.jobs.conformance!.strategy!.matrix.include = ['webkit', 'firefox', 'chromium'].flatMap(browser =>
      [3, 1, 2].map(shard => ({ browser, shard, shards: 3 })));
    files.set('browser.yml', stringify(browser));
    assertNativeGraph(files);
  });

  it.each([
    ['пропущенная доля', [{ browser: 'chromium', shard: 1, shards: 2 }]],
    ['дубликат доли', [{ browser: 'chromium', shard: 1, shards: 2 }, { browser: 'chromium', shard: 1, shards: 2 }]],
    ['противоречивый total', [{ browser: 'chromium', shard: 1, shards: 1 }, { browser: 'chromium', shard: 2, shards: 2 }]],
  ] as const)('отвергает неполное покрытие: %s', (_, bad) => {
    const complete = ['firefox', 'webkit'].map(browser => ({ browser, shard: 1, shards: 1 }));
    expect(() => assertShards([...complete, ...bad])).toThrow();
  });

  it.each(['remove', 'if', 'continue-on-error', 'echo'] as const)('нативный TypeScript обязан исполняться: %s', mutation => {
    const files = sources();
    const ci = parse(files.get('ci.yml')!) as Workflow;
    const job = ci.jobs.verify!;
    const target = command(job, 'pnpm typecheck:native');
    if (mutation === 'remove') job.steps = job.steps!.filter(item => item !== target);
    else if (mutation === 'echo') target.run = 'echo pnpm typecheck:native';
    else if (mutation === 'if') target.if = false;
    else target['continue-on-error'] = true;
    files.set('ci.yml', stringify(ci));
    expect(() => assertNativeGraph(files)).toThrow();
  });

  it.each(['runtime-after', 'wrong-floor', 'unobserved-job', 'fake-result'] as const)('отвергает разрыв потребительского пути: %s', mutation => {
    const files = sources();
    const ci = parse(files.get('ci.yml')!) as Workflow;
    if (mutation === 'unobserved-job') ci.jobs.extra = { 'runs-on': 'ubuntu-latest' };
    else if (mutation === 'fake-result') ci.jobs.CI!.steps![0]!.env!.CHECK_RESULTS = '{"fake":{"result":"success"}}';
    else {
      const job = ci.jobs.verify!;
      const floor = job.steps!.find(item => item.with?.['node-version'] === minimumNode)!;
      if (mutation === 'wrong-floor') floor.with!['node-version'] = '24';
      else { job.steps = job.steps!.filter(item => item !== floor); job.steps!.push(floor); }
    }
    files.set('ci.yml', stringify(ci));
    expect(() => assertNativeGraph(files)).toThrow();
  });

  const required = (parse(sources().get('ci.yml')!) as Workflow).jobs.CI!.needs!;
  const success = Object.fromEntries(required.map(key => [key, { result: 'success' }]));
  const verdict = (results: unknown, event = 'pull_request') => {
    const program = pythonSetup + (parse(sources().get('ci.yml')!) as Workflow).jobs.CI!.steps![0]!.run!;
    return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, CHECK_RESULTS: typeof results === 'string' ? results : JSON.stringify(results),
        EVENT_NAME: event, S5_CAPTURE_DIAGNOSTIC: '', PROFILE_BASELINE: '',
        PERFORMANCE_BASELINE: '', PERFORMANCE_CONTRACT_ONLY: '' },
    });
  };
  it('принимает успех всех настоящих зависимостей', () => {
    const actual = verdict(success);
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(0);
  });
  it.each([...required, 'future-check'].flatMap(key => ['failure', 'cancelled', 'skipped']
    .map(result => ({ key, result }))))('настоящий shell итога проверяет $key=$result', ({ key, result }) => {
    const actual = verdict({ ...success, [key]: { result } });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).not.toBe(0);
  });
  it.each(['merge_group', 'push', 'workflow_dispatch'].flatMap(event => ['failure', 'cancelled', 'skipped']
    .map(result => ({ event, result }))))('требует успех mutation на $event: $result', ({ event, result }) => {
    const actual = verdict({ ...success, mutation: { result } }, event);
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).not.toBe(0);
  });
  it.each([{}, null, [], { absent: null }, { absent: {} }, { absent: { result: 'unknown' } }, 'not-json'])('не принимает пустой или повреждённый итог: %j', results => {
    expect(verdict(results).status).not.toBe(0);
  });

  it.each([
    { event: 'workflow_dispatch', s5: 'false', contract: 'true', profile: 'false', baseline: '', passes: false },
    { event: 'workflow_dispatch', s5: 'false', contract: 'true', profile: 'false', baseline: 'main', passes: false },
    { event: 'workflow_dispatch', s5: 'false', contract: 'true', profile: 'true', baseline: 'a'.repeat(40), passes: false },
    { event: 'workflow_dispatch', s5: 'true', contract: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { event: 'workflow_dispatch', s5: 'false', contract: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { event: 'workflow_dispatch', s5: 'true', profile: 'false', baseline: '', passes: false },
    { event: 'workflow_dispatch', s5: 'true', profile: 'false', baseline: 'main', passes: false },
    { event: 'workflow_dispatch', s5: 'true', profile: 'false', baseline: 'a'.repeat(39), passes: false },
    { event: 'workflow_dispatch', s5: 'true', profile: 'false', baseline: 'g'.repeat(40), passes: false },
    { event: 'workflow_dispatch', s5: 'true', profile: 'true', baseline: 'a'.repeat(40), passes: false },
    { event: 'workflow_dispatch', s5: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { event: 'workflow_dispatch', s5: 'false', profile: 'true', baseline: '', passes: true },
    { event: 'pull_request', s5: '', profile: '', baseline: '', passes: true },
  ])('diagnostic aggregate guard $event/$s5/$profile/$baseline', ({ event, s5, profile, baseline, passes, contract }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', pythonSetup + ci.jobs.CI!.steps![0]!.run!], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, EVENT_NAME: event, S5_CAPTURE_DIAGNOSTIC: s5, PERFORMANCE_CONTRACT_ONLY: contract ?? 'false', PROFILE_BASELINE: profile,
        PERFORMANCE_BASELINE: baseline, CHECK_RESULTS: JSON.stringify(success) },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, actual.stderr).toBe(passes);
  });

  it.each([
    { s5: false, contract: false, cli: true, measurements: true },
    { s5: true, contract: false, cli: false, measurements: false },
    { s5: false, contract: true, cli: true, measurements: false },
  ])('actual route selection S5=$s5 contract=$contract', ({ s5, contract, cli, measurements }) => {
    const workflow = parse(sources().get('performance.yml')!) as Workflow;
    const selected = (item: Step) => {
      if (item.if === undefined) return true;
      const expression = String(item.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replaceAll('inputs.s5_capture_diagnostic', String(s5))
        .replaceAll('inputs.performance_contract_only', String(contract))
        .replaceAll('!cancelled()', 'true').replaceAll("steps.build.outcome == 'success'", 'true');
      if (!/^[truefals\s!&|()]+$/.test(expression)) throw new Error(`Unsupported route expression: ${expression}`);
      return Function(`return (${expression})`)() as boolean;
    };
    const steps = workflow.jobs.compare!.steps!;
    expect(selected(steps.find(item => item.run?.includes('node --test candidate/bench/compare/transition-profile'))!)).toBe(cli);
    for (const item of steps.filter(item => item.run?.match(/consumer-size\.mjs|easing-pair\.mjs|spring-pair baseline|full baseline|node bench\.mjs|size-gate\.mjs/))) {
      expect(selected(item)).toBe(measurements);
    }
    expect(selected(steps.find(item => item.run?.includes('git diff --exit-code'))!)).toBe(s5);
    expect(selected(steps.find(item => item.run?.includes('node bench/compare/conformance-smoke'))!)).toBe(s5);
    expect(selected(steps.find(item => item.run?.includes('pnpm exec vitest run test/benchmark-cli-contract'))!)).toBe(s5);
    const receipt = steps.findIndex(item => item.run?.includes('mode=performance-contract-only'));
    expect(selected(steps[receipt]!)).toBe(contract);
    expect(receipt).toBeLessThan(steps.findIndex(item => item.run?.includes('node --test candidate/bench/compare/transition-profile')));
  });

  it.each([0, 1])('S5 product guard propagates git diff status %i before execution', status => {
    const workflow = parse(sources().get('performance.yml')!) as Workflow;
    const guard = workflow.jobs.compare!.steps!.find(item => item.run?.includes('git diff --exit-code'))!;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `git() { printf '%s\\n' "$@"; return ${status}; }\n${guard.run}`], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, BASELINE: 'a'.repeat(40) },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status).toBe(status);
    expect(actual.stdout.trim().split('\n')).toEqual(['diff', '--exit-code', 'a'.repeat(40), 'HEAD', '--', 'src', 'bench/compare/entries']);
  });


  it.each([0, 17])('сравнительные assertions действительно запускаются и возвращают отказ %i', code => {
    const workflow = parse(sources().get('performance.yml')!) as Workflow;
    const item = runStep(workflow.jobs.compare!, /^xvfb-run -a node bench\.mjs\s*$/);
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `xvfb-run() { shift; "$@"; }\nnode() { printf '%s\\n' "$@"; return ${code}; }\n${item.run}`], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(code);
    expect(actual.stdout.trim().split('\n')).toEqual(['bench.mjs']);
  });

  it.each([0, 17])('release smoke исполняет проверку stored-date и возвращает отказ %i', code => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = runStep(ci.jobs.verify!, /node scripts\/check-release\.mjs /);
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `node() { if [[ "$1" == -p ]]; then printf '0.0.0\\n'; else printf '%s\\n' "$@"; return ${code}; fi; }\n${item.run}`], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(code);
    expect(actual.stdout.trim().split('\n')).toEqual(['scripts/check-release.mjs', 'v0.0.0', '--validate-stored-date']);
  });

  it.each([false, true])('package consumer действительно вызывается на runtime floor=%s', floor => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const consumers = ci.jobs.verify!.steps!.filter(item => item.run?.includes('node scripts/pack-smoke.mjs'));
    const item = consumers[floor ? 1 : 0]!;
    for (const count of [0, 2]) assertPackConsumer(item, floor, count);
    for (const code of [0, 17]) assertPackConsumer(item, floor, 1, code);
    if (floor) assertPackConsumer(item, floor, 1, 0, '24.0.0');
  });

  it('heredoc не может заменить исполнение package consumer', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = ci.jobs.verify!.steps!.find(item => item.run?.includes('node scripts/pack-smoke.mjs'))!;
    expect(() => assertPackConsumer({ ...item, run: `cat <<'PRINTED'\n${item.run}PRINTED\n` }, false, 1)).toThrow();
  });

  it.each([0, 17])('security вызывает scanner с полной политикой и возвращает отказ %i', code => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    assertSecurityStep(runStep(ci.jobs.security!, /test\/ci-trivy-canary\.py verify/), code);
  });

  it('security останавливается до scanner при отказе checksum', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    assertSecurityStep(runStep(ci.jobs.security!, /test\/ci-trivy-canary\.py verify/), 0, 17);
  });

  it.each([
    ['секреты только высокой severity', (run: string) => run.replaceAll('scan --scanners secret', 'scan --scanners secret --severity HIGH,CRITICAL')],
    ['исключён lockfile', (run: string) => run.replace('"$@" .;', '"$@" --skip-files pnpm-lock.yaml .;')],
    ['поздний config', (run: string) => run.replace('"$@" .;', '"$@" --config=trivy.yaml .;')],
    ['поздний exit-code', (run: string) => run.replace('"$@" .;', '"$@" --exit-code=0 .;')],
    ['поздний include-dev-deps', (run: string) => run.replace('"$@" .;', '"$@" --include-dev-deps=false .;')],
    ['поздний secret ignorefile', (run: string) => run.replaceAll('scan --scanners secret', 'scan --scanners secret --ignorefile accepted.yaml')
      .replaceAll('--ignorefile /dev/null --format', '--ignorefile /dev/null --ignorefile=accepted.yaml --format')
      .replace('"$@" .;', '"$@" --ignorefile=accepted.yaml .;')],
    ['распакован другой архив', (run: string) => run.replace('tar -xzf "$dir/trivy.tgz"', 'tar -xzf "$RUNNER_TEMP/unverified.tgz"')],
    ['scanner распакован в другом месте', (run: string) => 'mkdir "$RUNNER_TEMP/elsewhere"\n' + run.replace(' -C "$dir" trivy', ' -C "$RUNNER_TEMP/elsewhere" trivy')],
  ] as const)('security witness замечает нарушение: %s', (_, mutate) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = runStep(ci.jobs.security!, /test\/ci-trivy-canary\.py verify/);
    expect(mutate(item.run!)).not.toBe(item.run);
    expect(() => assertSecurityStep({ ...item, run: mutate(item.run!) })).toThrow();
  });

  it('security принимает attached flags, порядок и дополняющие списки', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = runStep(ci.jobs.security!, /test\/ci-trivy-canary\.py verify/);
    const run = item.run!
      .replace('--config /dev/null', '--config=unused.yaml --config=/dev/null')
      .replace('--exit-code 1', '--exit-code=0 --exit-code=1')
      .replaceAll('--scanners vuln,misconfig', '--scanners=misconfig --scanners=vuln')
      .replaceAll('--severity UNKNOWN,HIGH,CRITICAL', '--severity=CRITICAL --severity=HIGH,UNKNOWN')
      .replaceAll('--include-dev-deps', '--include-dev-deps=true')
      .replaceAll('--ignore-unfixed', '--ignore-unfixed=true')
      .replaceAll('scan --scanners secret', 'scan --severity=MEDIUM,LOW --severity=UNKNOWN,HIGH,CRITICAL --scanners=secret')
      .replaceAll('--ignorefile /dev/null', '--ignorefile=unused.yaml --ignorefile=/dev/null')
      .replaceAll('--format json', '--format=json');
    assertSecurityStep({ ...item, run });
  });

  it.each([{ checksumStatus: 0, toolStatus: 0 }, { checksumStatus: 0, toolStatus: 1 }, { checksumStatus: 17, toolStatus: 1 }])(
    'actionlint передаёт отказ checksum=$checksumStatus/tool=$toolStatus', ({ checksumStatus, toolStatus }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    assertActionlintStep(runStep(ci.jobs.verify!, /\/actionlint"/), checksumStatus, toolStatus);
  });

  it.each([
    ['распакован другой архив', (run: string) => run.replace('tar -xzf "$archive"', 'tar -xzf "$RUNNER_TEMP/unverified.tar.gz"')],
    ['поздний tar file', (run: string) => run.replace('tar -xzf "$archive"', 'tar -xzf "$archive" --file="$RUNNER_TEMP/unverified.tar.gz"')],
    ['checksum другого архива', (run: string) => run.replace('"$archive" | sha256sum', '"$RUNNER_TEMP/unverified.tar.gz" | sha256sum')],
    ['checksum не проверяет digest', (run: string) => run.replace('--check --status -', '--status -')],
    ['tool распакован в другом месте', (run: string) => 'mkdir "$RUNNER_TEMP/elsewhere"\n' + run.replace(' -C "$install_dir"', ' -C "$RUNNER_TEMP/elsewhere"')],
  ] as const)('actionlint witness связывает проверенный архив: %s', (_, mutate) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = runStep(ci.jobs.verify!, /\/actionlint"/);
    expect(mutate(item.run!)).not.toBe(item.run);
    expect(() => assertActionlintStep({ ...item, run: mutate(item.run!) })).toThrow();
  });

  it('actionlint принимает attached output и канонически тот же tar file', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = runStep(ci.jobs.verify!, /\/actionlint"/);
    assertActionlintStep({ ...item, run: item.run!.replace('--output "$archive"', '-o"$archive"')
      .replace('tar -xzf "$archive"', 'tar -xz --file="$RUNNER_TEMP/./actionlint.tar.gz"')
      .replace('-C "$install_dir"', '--directory="$RUNNER_TEMP/./actionlint"') });
  });

  it('shell Vitest сохраняет код отказа после tee для diagnostics', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = runStep(ci.jobs.tests!, /(?:^|\n)pnpm (?:exec )?vitest run(?: |$)/).run!;
    const cwd = mkdtempSync(join(tmpdir(), 'motion-ci-vitest-'));
    try {
      for (const code of [0, 17]) {
        const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
          `pnpm() { printf 'test diagnostics\\n'; return ${code}; }\n${program}`], {
          cwd, encoding: 'utf8', timeout: 5000,
        });
        expect(actual.error).toBeUndefined();
        expect(actual.status, actual.stderr).toBe(code);
        expect(readFileSync(join(cwd, 'vitest.log'), 'utf8')).toBe('test diagnostics\n');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});



// Discovery берёт настоящий default config, которым пользуется команда CI, без исполнения suites.
async function assertFullDiscovery(overrides: CliOptions = {}) {
  const vitest = await createVitest({ watch: false, ...overrides });
  try {
    const root = fileURLToPath(new URL('../test/', import.meta.url));
    const expected = readdirSync(root, { recursive: true }).filter(name => name.endsWith('.test.ts'))
      .map(name => resolve(root, name).replaceAll('\\', '/')).sort();
    const actual = (await vitest.globTestSpecifications()).map(spec => spec.moduleId.replaceAll('\\', '/')).sort();
    expect(actual).toEqual(expected);
    expect(vitest.config.testNamePattern).toBeUndefined();
    const driver = await createVitest({ watch: false, config: 'vitest.stryker.driver.config.ts' });
    try {
      const semantic = await driver.globTestSpecifications();
      expect(semantic.length).toBeGreaterThan(0);
      expect(semantic.every(spec => actual.includes(spec.moduleId.replaceAll('\\', '/')))).toBe(true);
      expect(driver.config.environment).toBe(vitest.config.environment);
      expect(driver.config.testNamePattern).toBeUndefined();
    } finally { await driver.close(); }
  } finally { await vitest.close(); }
}

describe('полный автоматический выбор Vitest', () => {
  it('выбирает все test-файлы, включая fuzz и driver semantic suite, в единственном обычном запуске', () => assertFullDiscovery());
  it('замечает исключение целого класса fuzz-файлов', async () => {
    await expect(assertFullDiscovery({ exclude: ['**/*finiteness-fuzz.test.ts'] })).rejects.toThrow();
  });
});

// Политика закрепления: к проверке формы ссылки добавляются комментарий версии `vX.Y.Z`, один SHA на
// action и одна версия на SHA во всех workflow. Читает комментарии, поэтому работает только на
// исходном тексте; мутации графа выше пересобирают YAML и комментарии теряют.
function assertPinPolicy(files: Map<string, string>) {
  assertPinned(files);
  const shaByAction = new Map<string, Set<string>>();
  const versionBySha = new Map<string, Set<string>>();
  let external = 0;
  for (const [name, source] of files) {
    for (const { where, ref, comment } of references(name, source)) {
      if (ref.startsWith('./')) continue;
      external += 1;
      const [, action, sha] = externalAction.exec(ref)!;
      expect(comment, `${where}: у ${ref} нет комментария версии vX.Y.Z`).toMatch(versionComment);
      shaByAction.set(action!, (shaByAction.get(action!) ?? new Set()).add(sha!));
      versionBySha.set(sha!, (versionBySha.get(sha!) ?? new Set()).add(comment));
    }
  }
  expect(external).toBeGreaterThan(0);
  for (const [action, shas] of shaByAction) expect([...shas], `${action}: один SHA на все workflow`).toHaveLength(1);
  for (const [sha, versions] of versionBySha) expect([...versions], `${sha}: одна версия в комментариях`).toHaveLength(1);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bumpAction = (files: Map<string, string>, action: string, sha: string, version: string) => new Map(
  [...files].map(([name, source]) => [name, source.replace(
    new RegExp(`(uses:[ \\t]*${escapeRegExp(action)}@)[0-9a-f]{40}([ \\t]+#[ \\t]*)v\\d+\\.\\d+\\.\\d+`, 'g'),
    `$1${sha}$2${version}`,
  )]),
);
const mutateFirst = (files: Map<string, string>, mutate: (source: string) => string) => {
  for (const [name, source] of files) {
    const mutated = mutate(source);
    if (mutated !== source) return new Map(files).set(name, mutated);
  }
  throw new Error('Мутация не изменила ни один workflow');
};
const checkoutPin = /uses:([ \t]*)actions\/checkout@[0-9a-f]{40}/;
const pinMutants: ReadonlyArray<readonly [string, (source: string) => string]> = [
  ['тег вместо SHA', (source) => source.replace(/(actions\/checkout@)[0-9a-f]{40}/, '$1v7')],
  ['изменяемая ветка вместо SHA', (source) => source.replace(/(actions\/checkout@)[0-9a-f]{40}/, '$1main')],
  ['сокращённый SHA', (source) => source.replace(/(actions\/checkout@)[0-9a-f]{40}/, (_, prefix: string) => `${prefix}3d3c42e`)],
  ['чужой владелец action', (source) => source.replace('actions/checkout@', 'someone/checkout@')],
  ['тег в записи `uses :` с пробелом перед двоеточием', (source) => source.replace(checkoutPin, 'uses : actions/checkout@v7')],
  ['нет комментария версии', (source) => source.replace(/(actions\/checkout@[0-9a-f]{40})[ \t]+#.*/, '$1')],
  ['комментарий без патча', (source) => source.replace(/(actions\/checkout@[0-9a-f]{40}[ \t]+# v\d+)\.\d+\.\d+/, '$1')],
  ['второй SHA того же action', (source) => source.replace(/(actions\/checkout@)[0-9a-f]{40}/, `$1${'a'.repeat(40)}`)],
  ['комментарий версии на следующей строке', (source) => source.replace(
    /(uses: actions\/checkout@[0-9a-f]{40})[ \t]+# (v\d+\.\d+\.\d+)/, '$1\n        # $2')],
  ['две версии одного SHA', (source) => source.replace(/(actions\/checkout@[0-9a-f]{40}[ \t]+# )v\d+\.\d+\.\d+/, '$1v0.0.1')],
  ['reusable workflow из другого репозитория', (source) => source.replace(
    'uses: ./.github/workflows/docs.yml', 'uses: someone/repo/.github/workflows/docs.yml@main')],
];
const decoy = (sha: string) => '      - name: Decoy\n        env:\n          TEXT: |\n'
  + `            uses: actions/checkout@${sha} # v7.0.1\n        run: "true"\n`;

describe('закрепление внешних actions', () => {
  it('закрепляет каждый внешний action полным SHA с комментарием версии', () => assertPinPolicy(sources()));

  it.each([...allowedActions])('принимает обновление %s: новый SHA и версия во всех workflow', (action) => {
    const files = sources();
    assertPinPolicy(files);
    assertNativeGraph(files);
    const bumped = bumpAction(files, action, 'f'.repeat(40), 'v99.0.1');
    expect(bumped).not.toEqual(files);
    assertPinPolicy(bumped);
    assertNativeGraph(bumped);
  });

  it.each(pinMutants)('отвергает закрепление: %s', (_, mutate) => {
    const files = sources();
    assertPinPolicy(files);
    expect(() => assertPinPolicy(mutateFirst(files, mutate))).toThrow();
  });

  it('отвергает закрепление в jobs без ожидаемого списка actions: docs.yml', () => {
    const files = sources();
    const docs = files.get('docs.yml')!;
    const broken = new Map(files).set('docs.yml', docs.replace(/(actions\/setup-node@)[0-9a-f]{40}/, '$1v7'));
    expect(() => assertNativeGraph(broken)).toThrow(/закреплён полным SHA/);
  });

  it('читает uses из разобранного YAML: строка внутри многострочного значения не action и не прикрывает тег', () => {
    const files = sources();
    const docs = files.get('docs.yml')!;
    const sha = /actions\/checkout@([0-9a-f]{40})/.exec(docs)![1]!;
    // Строка с корректным закреплением в env лишь текст: она не может ни считаться action, ни компенсировать тег.
    const inert = new Map(files).set('docs.yml', docs + decoy(sha));
    assertPinPolicy(inert);
    const hidden = new Map(files).set('docs.yml', docs.replace(checkoutPin, 'uses : actions/checkout@v7') + decoy(sha));
    expect(() => assertPinPolicy(hidden)).toThrow(/закреплён полным SHA/);
    expect(() => assertNativeGraph(hidden)).toThrow(/закреплён полным SHA/);
  });
});
