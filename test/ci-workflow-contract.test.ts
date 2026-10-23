import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMap, isScalar, isSeq, parse, parseDocument, stringify } from 'yaml';
import vitestConfig from '../vitest.config.js';

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
  if?: string | boolean;
  needs?: string[];
  uses?: string;
  permissions?: Record<string, string>;
  defaults?: unknown;
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

const directory = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const sources = () => new Map(readdirSync(directory)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, readFileSync(join(directory, name), 'utf8')]));
const candidateEvents = new Set(['pull_request', 'pull_request_target', 'merge_group']);
const events = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new Error('Некорректные события workflow');
};
const bash = process.platform === 'win32'
  ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe') : 'bash';
const peers = ['verify', 'tests', 'mutation', 'browser-static', 'documentation'];
const activatePnpm = 'corepack enable\ncorepack install --global pnpm@11.11.0';
const vitestCommand = 'set +e\npnpm vitest run 2>&1 | tee vitest.log\nstatus=${PIPESTATUS[0]}\nexit "$status"';
const gateCommand = 'set -euo pipefail\n[[ "$VERIFY_RESULT" == success ]]\n'
  + '[[ "$TESTS_RESULT" == success ]]\n[[ "$MUTATION_RESULT" == success ]]\n'
  + '[[ "$BROWSER_RESULT" == success ]]\n[[ "$DOCS_RESULT" == success ]]';
const actionlintCommand = [
  'archive="$RUNNER_TEMP/actionlint.tar.gz"',
  'install_dir="$RUNNER_TEMP/actionlint"',
  "curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \\",
  '  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \\',
  '  --output "$archive"',
  "printf '%s  %s\\n' \"$ACTIONLINT_ARCHIVE_SHA256\" \"$archive\" | sha256sum --check --status -",
  'mkdir "$install_dir"',
  'tar -xzf "$archive" -C "$install_dir"',
  '"$install_dir/actionlint"',
].join('\n');
const floorCommand = 'shopt -s nullglob\narchives=(node-floor-artifact/*.tgz)\n'
  + '[[ ${#archives[@]} -eq 1 ]] \\\n'
  + '  || { echo "::error::ожидался ровно один tgz, найдено: ${#archives[@]}"; exit 1; }\n'
  + 'node scripts/pack-smoke.mjs "${archives[0]}"';
const floorMinimumCommand = 'test "$(node --version)" = v22.0.0\n' + floorCommand;

const verifyCommands = [
  actionlintCommand,
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm check:static',
  'pnpm typecheck:native',
  'pnpm build',
  'node scripts/check-docs-facts.mjs',
  'node scripts/check-docs-drift.mjs',
  'node scripts/check-issue-forms.mjs',
  'version="$(node -p "require(\'./package.json\').version")"\n'
    + 'node scripts/check-release.mjs "v${version}" --validate-stored-date',
  'pnpm size',
  'pnpm pack:smoke',
  'pnpm pack:compat',
  'pnpm acceptance:compiler',
  'mkdir node-floor-artifact\npnpm pack --pack-destination node-floor-artifact',
  floorCommand,
  floorMinimumCommand,
];
const testCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm build',
  vitestCommand,
  'node test/fixtures/server-thread-cpu-clock-check.mjs',
];
const mutationCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm build',
  'pnpm exec stryker run stryker.driver.config.mjs',
];
const browserCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm exec playwright install --with-deps ${{ matrix.browser }}',
  'pnpm typecheck:browser',
  'pnpm build',
  'pnpm exec playwright test --project=${{ matrix.browser }} --shard=${{ matrix.shard }}/${{ matrix.shards }} --fail-on-flaky-tests',
];


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

// Порядок и inputs actions задают реальную ОС, Node и передачу проверенного архива.
const requiredActions = {
  "verify": [
    {
      "index": 0,
      "name": "Checkout",
      "uses": "actions/checkout@<sha>",
      "with": {
        "persist-credentials": false,
        "fetch-depth": 0
      }
    },
    {
      "index": 2,
      "name": "Setup Node",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "24"
      }
    },
    {
      "index": 18,
      "name": "Setup consumer Node floor",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "22.0.0"
      }
    }
  ],
  "conformance": [
    {
      "index": 0,
      "name": "Checkout",
      "uses": "actions/checkout@<sha>",
      "with": {
        "persist-credentials": false
      }
    },
    {
      "index": 1,
      "name": "Setup Node",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "24"
      }
    },
    {
      "index": 8,
      "name": "Upload failure artifacts",
      "if": "failure()",
      "uses": "actions/upload-artifact@<sha>",
      "with": {
        "name": "browser-conformance-${{ matrix.browser }}-${{ matrix.shard }}-${{ github.run_id }}",
        "path": "test-results/\nplaywright-report/\n",
        "if-no-files-found": "ignore",
        "retention-days": 1
      }
    }
  ],
  "tests": [
    {
      "index": 0,
      "name": "Checkout",
      "uses": "actions/checkout@<sha>",
      "with": {
        "persist-credentials": false,
        "fetch-depth": 0
      }
    },
    {
      "index": 1,
      "name": "Setup Node",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "24"
      }
    },
    {
      "index": 6,
      "name": "Setup registered native-clock Node",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "24.19.0"
      }
    }
  ],
  "mutation": [
    {
      "index": 0,
      "name": "Checkout",
      "uses": "actions/checkout@<sha>",
      "with": {
        "persist-credentials": false
      }
    },
    {
      "index": 1,
      "name": "Setup Node",
      "uses": "actions/setup-node@<sha>",
      "with": {
        "node-version": "24"
      }
    }
  ]
};

function step(job: Job, name: string): Step {
  const found = job.steps?.find((item) => item.name === name);
  if (!found) throw new Error(`Нет обязательного шага ${name}`);
  return found;
}

function assertCommands(job: Job, commands: string[]) {
  const runs = (job.steps ?? []).filter((item) => item.run);
  expect(runs.map((item) => item.run!.trim())).toEqual(commands);
  for (const item of runs) {
    expect(item.if).toBeUndefined();
    expect(item['continue-on-error']).toBeUndefined();
    expect(item['working-directory']).toBeUndefined();
    expect([undefined, 'bash']).toContain(item.shell);
  }
}

function assertNativeGraph(files: Map<string, string>) {
  assertPinned(files);
  const workflows = new Map([...files].map(([name, source]) => [name, parse(source) as Workflow]));
  expect([...workflows].filter(([, w]) => events(w.on).some((event) => candidateEvents.has(event)))
    .map(([name]) => name).sort()).toEqual(['ci.yml']);
  expect(files.has('ci-gate.yml')).toBe(false);
  const ci = workflows.get('ci.yml')!;
  const browser = workflows.get('browser.yml')!;
  expect(ci.on).toEqual({
    push: { branches: ['main'] }, pull_request: null, merge_group: null,
    workflow_dispatch: { inputs: { profile_baseline: {
      description: 'Снять зарегистрированный размерный baseline PROFILE-01',
      type: 'boolean', default: false,
    }, performance_baseline: {
      description: 'Commit для парного сравнения полной стоимости движения',
      type: 'string', default: '',
    } } },
  });
  expect(browser.on).toEqual({ workflow_call: null });
  expect(Object.keys(ci.jobs).sort()).toEqual(['CI', 'browser-static', 'documentation', 'mutation', 'performance', 'profile-baseline', 'tests', 'verify']);
  expect(ci.jobs['profile-baseline']).toEqual({
    if: "${{ github.event_name == 'workflow_dispatch' && inputs.profile_baseline }}",
    uses: './.github/workflows/profile-01.yml',
  });
  expect(ci.jobs.performance).toEqual({
    if: "${{ github.event_name == 'workflow_dispatch' && inputs.performance_baseline != '' }}",
    uses: './.github/workflows/performance.yml',
    with: { baseline: '${{ inputs.performance_baseline }}' },
  });
  const performance = workflows.get('performance.yml')!;
  expect(performance.on).toEqual({ workflow_call: { inputs: { baseline: { type: 'string', required: true } } } });
  expect(performance.permissions).toEqual({ contents: 'read' });
  expect(performance.jobs.compare!['runs-on']).toEqual(['self-hosted', 'Linux', 'X64']);
  expect(performance.jobs.compare!['continue-on-error']).toBeUndefined();
  expect(workflows.get('profile-01.yml')!.on).toEqual({ workflow_call: null });
  expect(Object.keys(browser.jobs)).toEqual(['conformance']);
  for (const document of [ci, browser]) {
    expect(document.permissions).toEqual({ contents: 'read' });
    expect(document.defaults).toBeUndefined();
    for (const job of Object.values(document.jobs)) {
      expect(job['continue-on-error']).toBeUndefined();
      expect(job.defaults).toBeUndefined();
    }
  }
  const verify = ci.jobs.verify!;
  const tests = ci.jobs.tests!;
  const mutation = ci.jobs.mutation!;
  const conformance = browser.jobs.conformance!;
  for (const job of [verify, tests, mutation, conformance]) {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if).toBeUndefined();
  }
  expect(ci.jobs['browser-static']).toEqual({ uses: './.github/workflows/browser.yml' });
  expect(ci.jobs.documentation).toEqual({ uses: './.github/workflows/docs.yml' });
  expect(workflows.get('docs.yml')!.on).toEqual({ workflow_call: null });
  const reader = workflows.get('docs.yml')!.jobs.reader!;
  expect(reader['runs-on']).toBe('ubuntu-latest');
  assertCommands(reader, [activatePnpm, 'pnpm install --frozen-lockfile', 'pnpm docs:build',
    'pnpm exec playwright install --with-deps chromium firefox webkit', 'pnpm docs:test']);
  // Нет ложных последовательных зависимостей: всё сходится только в CI.
  for (const job of [verify, tests, mutation]) expect(job.needs).toBeUndefined();
  expect(conformance.name).toBe('${{ matrix.browser }} · ${{ matrix.shard }}/${{ matrix.shards }}');
  expect(conformance.needs).toBeUndefined();
  // Полнота задаётся независимо от workflow: потеря/дубль доли не может стать GREEN.
  expect(conformance.strategy).toEqual({
    'fail-fast': false,
    'max-parallel': 4,
    matrix: { include: [
      { browser: 'chromium', shard: 1, shards: 1 },
      { browser: 'firefox', shard: 1, shards: 1 },
      { browser: 'webkit', shard: 1, shards: 2 },
      { browser: 'webkit', shard: 2, shards: 2 },
    ] },
  });
  const actionlint = step(verify, 'GitHub Actions contract');
  expect(actionlint.if).toBeUndefined();
  expect(actionlint['continue-on-error']).toBeUndefined();
  expect(actionlint.shell).toBe('bash');
  expect(actionlint.env).toEqual({
    ACTIONLINT_VERSION: '1.7.12',
    ACTIONLINT_ARCHIVE_SHA256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  });
  for (const [name, job] of Object.entries({ verify, tests, mutation, conformance })) {
    expect(job.steps!.map((item, index) => ({ index, ...item })).filter((item) => item.uses)
      .map((item) => ({ ...item, uses: unpin(item.uses!) })))
      .toEqual(requiredActions[name as keyof typeof requiredActions]);
  }
  assertCommands(verify, verifyCommands);
  assertCommands(tests, testCommands);
  assertCommands(mutation, mutationCommands);
  assertCommands(conformance, browserCommands);
  expect(step(tests, 'Vitest').id).toBe('vitest');
  const gate = ci.jobs.CI!;
  expect(gate.name).toBe('CI');
  expect(gate.if).toBe('${{ always() }}');
  expect(gate.needs).toEqual(peers);
  expect(gate['runs-on']).toBe('ubuntu-latest');
  expect(gate.permissions).toEqual({});
  expect(gate.steps).toEqual([{
    name: 'Require every candidate check',
    shell: 'bash',
    env: {
      VERIFY_RESULT: '${{ needs.verify.result }}',
      TESTS_RESULT: '${{ needs.tests.result }}',
      MUTATION_RESULT: '${{ needs.mutation.result }}',
      BROWSER_RESULT: '${{ needs.browser-static.result }}',
      DOCS_RESULT: '${{ needs.documentation.result }}',
    },
    run: `${gateCommand}\n`,
  }]);
}

describe('нативный граф CI', () => {
  it('проверяет любой PR через явные обязательные jobs', () => assertNativeGraph(sources()));

  it.each([
    ['PR base filter', 'ci.yml', (w: Workflow) => { w.on.pull_request = { branches: ['main'] }; }],
    ['PR path filter', 'ci.yml', (w: Workflow) => { w.on.pull_request = { paths: ['src/**'] }; }],
    ['нет always', 'ci.yml', (w: Workflow) => { delete w.jobs.CI!.if; }],
    ...peers.map((peer) => [`нет needs ${peer}`, 'ci.yml', (w: Workflow) => {
      w.jobs.CI!.needs = w.jobs.CI!.needs!.filter((item) => item !== peer);
    }] as const),
    ['tests ждёт verify без необходимости', 'ci.yml', (w: Workflow) => { w.jobs.tests!.needs = ['verify']; }],
    ['mutation ждёт tests без необходимости', 'ci.yml', (w: Workflow) => { w.jobs.mutation!.needs = ['tests']; }],
    ['новая job вне итога', 'ci.yml', (w: Workflow) => { w.jobs.extra = { 'runs-on': 'ubuntu-latest' }; }],
    ['архив обычного CI', 'ci.yml', (w: Workflow) => {
      w.jobs.verify!.steps!.push({ name: 'Keep package', uses: 'actions/upload-artifact@0123456789012345678901234567890123456789', with: { path: 'node-floor-artifact' } });
    }],
    ['игнорирование verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!['continue-on-error'] = true; }],
    ['пропуск verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!.if = false; }],
    ['игнорирование browser caller', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!['continue-on-error'] = true; }],
    ['другой browser worker', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!.uses = './.github/workflows/release.yml'; }],
    ['нет Node floor', 'ci.yml', (w: Workflow) => { w.jobs.verify!.steps = w.jobs.verify!.steps!.filter(item => item.name !== 'Consumer smoke on minimum runtime'); }],
    ['подмена Node floor настройкой Node 24', 'ci.yml', (w: Workflow) => {
      step(w.jobs.verify!, 'Setup consumer Node floor').with!['node-version'] = '24';
    }],
    ['пропуск browser Setup Node', 'browser.yml', (w: Workflow) => {
      step(w.jobs.conformance!, 'Setup Node').if = false;
    }],
    ['пропущенный consumer', 'ci.yml', (w: Workflow) => {
      step(w.jobs.verify!, 'Consumer smoke on minimum runtime').if = false;
    }],
    ['другой Vitest outcome', 'ci.yml', (w: Workflow) => { step(w.jobs.tests!, 'Vitest').id = 'other'; }],
    ['фальшивый итог', 'ci.yml', (w: Workflow) => { w.jobs.CI!.steps![0]!.env!.BROWSER_RESULT = 'success'; }],
    ['пустой успех', 'ci.yml', (w: Workflow) => { w.jobs.CI!.steps![0]!.run = 'true\n'; }],
    ['игнорирование итога', 'ci.yml', (w: Workflow) => { w.jobs.CI!['continue-on-error'] = true; }],
    ['добавлен trigger browser', 'browser.yml', (w: Workflow) => { w.on.pull_request = null; }],
    ['добавлен PR trigger PROFILE', 'profile-01.yml', (w: Workflow) => { w.on.pull_request = null; }],
    ['PROFILE запущен для обычного кандидата', 'ci.yml', (w: Workflow) => { delete w.jobs['profile-baseline']!.if; }],
    ['PROFILE без явного запроса', 'ci.yml', (w: Workflow) => {
      w.jobs['profile-baseline']!.if = "${{ github.event_name == 'workflow_dispatch' }}";
    }],
    ['нет workflow_call', 'browser.yml', (w: Workflow) => { w.on = { workflow_dispatch: null }; }],
    ...['chromium', 'firefox', 'webkit'].map((engine) => [`нет ${engine}`, 'browser.yml', (w: Workflow) => {
      const matrix = w.jobs.conformance!.strategy!.matrix;
      matrix.include = matrix.include!.filter((item) => item.browser !== engine);
    }] as const),
    ['потеря второй доли WebKit', 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.strategy!.matrix.include!.pop();
    }],
    ['дублирование первой доли WebKit', 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.strategy!.matrix.include![3]!.shard = 1;
    }],
    ['невыполненная третья доля WebKit', 'browser.yml', (w: Workflow) => {
      for (const part of w.jobs.conformance!.strategy!.matrix.include!) {
        if (part.browser === 'webkit') part.shards = 3;
      }
    }],
    ['неполный Firefox', 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.strategy!.matrix.include![1]!.shards = 2;
    }],
    ['отмена соседних browser jobs после сбоя', 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.strategy!['fail-fast'] = true;
    }],
    ['лишняя последовательная browser зависимость', 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.needs = ['verify'];
    }],
    ['игнорирование browser', 'browser.yml', (w: Workflow) => { w.jobs.conformance!['continue-on-error'] = true; }],
  ] as const)('отвергает изменение: %s', (_, file, mutate) => {
    const files = sources();
    assertNativeGraph(files);
    const workflow = parse(files.get(file)!) as Workflow;
    mutate(workflow);
    files.set(file, stringify(workflow));
    expect(() => assertNativeGraph(files)).toThrow();
  });

  it.each([{ trigger: 'pull_request' }, { trigger: ['merge_group'] }, { trigger: { pull_request_target: null } }])(
    'новый candidate workflow требует включения в граф: %j', ({ trigger }) => {
      const files = sources();
      assertNativeGraph(files);
      files.set('new-check.yaml', stringify({ on: trigger, jobs: {} }));
      expect(() => assertNativeGraph(files)).toThrow();
    },
  );

  it.each([
    ['ci.yml', 'verify', verifyCommands],
    ['ci.yml', 'tests', testCommands],
    ['ci.yml', 'mutation', mutationCommands],
    ['browser.yml', 'conformance', browserCommands],
  ] as const)('%s/%s сохраняет каждую обязательную команду', (file, jobId, commands) => {
    const original = sources();
    assertNativeGraph(original);
    for (const command of commands) {
      for (const mutation of ['command', 'if', 'continue-on-error', 'shell'] as const) {
        const files = new Map(original);
        const workflow = parse(files.get(file)!) as Workflow;
        const target = workflow.jobs[jobId]!.steps!.find((item) => item.run?.trim() === command)!;
        if (mutation === 'command') target.run = 'true';
        else if (mutation === 'if') target.if = false;
        else if (mutation === 'shell') target.shell = 'bash {0}';
        else target['continue-on-error'] = true;
        files.set(file, stringify(workflow));
        expect(() => assertNativeGraph(files), `${jobId}: ${command}; ${mutation}`).toThrow();
      }
    }
  });

  it.each([
    ['ci.yml', 'verify'],
    ['ci.yml', 'tests'],
    ['ci.yml', 'mutation'],
    ['browser.yml', 'conformance'],
  ] as const)('%s/%s сохраняет настройку каждого action', (file, jobId) => {
    const original = sources();
    assertNativeGraph(original);
    const steps = (parse(original.get(file)!) as Workflow).jobs[jobId]!.steps!;
    for (const [index, item] of steps.entries()) {
      if (!item.uses) continue;
      for (const mutation of ['remove', 'uses', 'with', 'if', 'continue-on-error', 'order'] as const) {
        const files = new Map(original);
        const workflow = parse(files.get(file)!) as Workflow;
        const actions = workflow.jobs[jobId]!.steps!;
        const target = actions[index]!;
        if (mutation === 'remove') actions.splice(index, 1);
        else if (mutation === 'uses') target.uses = target.uses!.split('@')[0] + '@main';
        else if (mutation === 'with') target.with = { ...target.with, 'unexpected-input': true };
        else if (mutation === 'if') target.if = false;
        else if (mutation === 'continue-on-error') target['continue-on-error'] = true;
        else {
          actions.splice(index, 1);
          actions.splice(index === 0 ? 1 : 0, 0, target);
        }
        files.set(file, stringify(workflow));
        expect(() => assertNativeGraph(files), `${jobId}: ${item.uses}; ${mutation}`).toThrow();
      }
    }
  });

  it.each(['VERIFY_RESULT', 'TESTS_RESULT', 'MUTATION_RESULT', 'BROWSER_RESULT', 'DOCS_RESULT']
    .flatMap((key) => ['success', 'failure', 'cancelled', 'skipped', 'neutral', 'pending', '', undefined]
      .map((result) => ({ key, result }))))('shell итога проверяет $key=$result', ({ key, result }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = ci.jobs.CI!.steps![0]!.run!;
    const env: NodeJS.ProcessEnv = {
      ...process.env, VERIFY_RESULT: 'success', TESTS_RESULT: 'success',
      MUTATION_RESULT: 'success', BROWSER_RESULT: 'success', DOCS_RESULT: 'success',
    };
    delete env[key];
    if (result !== undefined) env[key] = result;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
      env, encoding: 'utf8', timeout: 5000,
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, `${key}=${result}: ${actual.stderr}`).toBe(result === 'success');
  });

  it('shell Vitest сохраняет код отказа после tee для diagnostics', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = step(ci.jobs.tests!, 'Vitest').run!;
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


describe('Единый полный набор Vitest', () => {
  it('сохраняет автоматический выбор fuzz-файлов без второго запуска', () => {
    const root = fileURLToPath(new URL('../test/', import.meta.url));
    const fuzz = readdirSync(root).filter(name => name.endsWith('finiteness-fuzz.test.ts'));
    expect(fuzz.length).toBeGreaterThan(0);
    expect(vitestConfig.test?.include).toEqual(['test/**/*.test.ts']);
    expect(vitestConfig.test?.exclude).toBeUndefined();
    expect(vitestConfig.test?.testNamePattern).toBeUndefined();
    for (const name of ['ci.yml', 'release.yml']) {
      expect(sources().get(name)).not.toContain('pnpm vitest run --reporter=verbose test/*finiteness-fuzz.test.ts');
    }
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
