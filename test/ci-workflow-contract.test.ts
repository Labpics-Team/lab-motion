import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

type Step = {
  name?: string;
  id?: string;
  run?: string;
  if?: string | boolean;
  shell?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
};
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
  strategy?: { 'fail-fast': boolean; matrix: Record<string, string[]> };
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
const peers = ['verify', 'node-floor', 'browser-static'];
const activatePnpm = 'corepack enable\ncorepack install --global pnpm@11.11.0';
const vitestCommand = 'set +e\npnpm vitest run 2>&1 | tee vitest.log\nstatus=${PIPESTATUS[0]}\nexit "$status"';
const gateCommand = 'set -euo pipefail\n[[ "$VERIFY_RESULT" == success ]]\n'
  + '[[ "$NODE_FLOOR_RESULT" == success ]]\n[[ "$BROWSER_RESULT" == success ]]';
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
  vitestCommand,
  'pnpm vitest run --reporter=verbose test/*finiteness-fuzz.test.ts',
  'pnpm size',
  'pnpm pack:smoke',
  'pnpm pack:compat',
  'pnpm acceptance:compiler',
  'mkdir node-floor-artifact\npnpm pack --pack-destination node-floor-artifact',
];
const browserCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm exec playwright install --with-deps ${{ matrix.browser }}',
  'pnpm typecheck:browser',
  'pnpm site:build',
  'pnpm exec playwright test --project=${{ matrix.browser }}',
];
const floorCommand = 'shopt -s nullglob\narchives=(node-floor-artifact/*.tgz)\n'
  + '[[ ${#archives[@]} -eq 1 ]] \\\n'
  + '  || { echo "::error::ожидался ровно один tgz, найдено: ${#archives[@]}"; exit 1; }\n'
  + 'node scripts/pack-smoke.mjs "${archives[0]}"';

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
  const workflows = new Map([...files].map(([name, source]) => [name, parse(source) as Workflow]));
  expect([...workflows].filter(([, w]) => events(w.on).some((event) => candidateEvents.has(event)))
    .map(([name]) => name).sort()).toEqual(['ci.yml']);
  expect(files.has('ci-gate.yml')).toBe(false);
  const ci = workflows.get('ci.yml')!;
  const browser = workflows.get('browser.yml')!;
  expect(ci.on).toEqual({ push: { branches: ['main'] }, pull_request: null, merge_group: null, workflow_dispatch: null });
  expect(browser.on).toEqual({ workflow_call: null });
  expect(Object.keys(ci.jobs).sort()).toEqual(['CI', 'browser-static', 'node-floor', 'verify']);
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
  const floor = ci.jobs['node-floor']!;
  const conformance = browser.jobs.conformance!;
  for (const job of [verify, floor, conformance]) {
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if).toBeUndefined();
  }
  expect(ci.jobs['browser-static']).toEqual({ uses: './.github/workflows/browser.yml' });
  expect(floor.needs).toEqual(['verify']);
  expect(floor.strategy).toEqual({ 'fail-fast': false, matrix: { node: ['22.0.0', '24'] } });
  expect(conformance.strategy).toEqual({ 'fail-fast': false, matrix: { browser: ['chromium', 'firefox', 'webkit'] } });
  const actionlint = step(verify, 'GitHub Actions contract');
  expect(actionlint.if).toBeUndefined();
  expect(actionlint['continue-on-error']).toBeUndefined();
  expect(actionlint.shell).toBe('bash');
  expect(actionlint.env).toEqual({
    ACTIONLINT_VERSION: '1.7.12',
    ACTIONLINT_ARCHIVE_SHA256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  });
  assertCommands(verify, verifyCommands);
  assertCommands(floor, [floorCommand]);
  assertCommands(conformance, browserCommands);
  expect(step(verify, 'Vitest').id).toBe('vitest');
  expect(step(verify, 'Upload Vitest diagnostics').if).toBe("failure() && steps.vitest.outcome == 'failure'");
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
      NODE_FLOOR_RESULT: '${{ needs.node-floor.result }}',
      BROWSER_RESULT: '${{ needs.browser-static.result }}',
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
    ['новая job вне итога', 'ci.yml', (w: Workflow) => { w.jobs.extra = { 'runs-on': 'ubuntu-latest' }; }],
    ['игнорирование verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!['continue-on-error'] = true; }],
    ['пропуск verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!.if = false; }],
    ['игнорирование browser caller', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!['continue-on-error'] = true; }],
    ['другой browser worker', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!.uses = './.github/workflows/release.yml'; }],
    ['нет Node floor', 'ci.yml', (w: Workflow) => { w.jobs['node-floor']!.strategy!.matrix.node = ['24']; }],
    ['скрытые diagnostics', 'ci.yml', (w: Workflow) => {
      step(w.jobs.verify!, 'Upload Vitest diagnostics').if = "steps.vitest.outcome == 'failure'";
    }],
    ['другой Vitest outcome', 'ci.yml', (w: Workflow) => { step(w.jobs.verify!, 'Vitest').id = 'other'; }],
    ['фальшивый итог', 'ci.yml', (w: Workflow) => { w.jobs.CI!.steps![0]!.env!.BROWSER_RESULT = 'success'; }],
    ['пустой успех', 'ci.yml', (w: Workflow) => { w.jobs.CI!.steps![0]!.run = 'true\n'; }],
    ['игнорирование итога', 'ci.yml', (w: Workflow) => { w.jobs.CI!['continue-on-error'] = true; }],
    ['добавлен trigger browser', 'browser.yml', (w: Workflow) => { w.on.pull_request = null; }],
    ['нет workflow_call', 'browser.yml', (w: Workflow) => { w.on = { workflow_dispatch: null }; }],
    ...['chromium', 'firefox', 'webkit'].map((engine) => [`нет ${engine}`, 'browser.yml', (w: Workflow) => {
      w.jobs.conformance!.strategy!.matrix.browser = ['chromium', 'firefox', 'webkit'].filter((item) => item !== engine);
    }] as const),
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
    ['ci.yml', 'node-floor', [floorCommand]],
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

  it('shell итога требует success каждого dependency', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = ci.jobs.CI!.steps![0]!.run!;
    for (const key of ['VERIFY_RESULT', 'NODE_FLOOR_RESULT', 'BROWSER_RESULT']) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', 'neutral', 'pending', '', undefined]) {
        const env: NodeJS.ProcessEnv = { ...process.env, VERIFY_RESULT: 'success', NODE_FLOOR_RESULT: 'success', BROWSER_RESULT: 'success' };
        delete env[key];
        if (result !== undefined) env[key] = result;
        const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
          env, encoding: 'utf8', timeout: 5000,
        });
        expect(actual.error).toBeUndefined();
        expect(actual.status === 0, `${key}=${result}: ${actual.stderr}`).toBe(result === 'success');
      }
    }
  });

  it('shell Vitest сохраняет код отказа после tee для diagnostics', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = step(ci.jobs.verify!, 'Vitest').run!;
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
