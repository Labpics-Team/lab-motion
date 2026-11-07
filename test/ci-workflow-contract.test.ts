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
// Образ закреплён в контракте; обновление пакета требует повторной проверки образа.
const playwrightImage = 'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

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
const peers = ['verify', 'tests', 'mutation', 'browser-static', 'documentation', 'security'];
const activatePnpm = 'corepack enable\ncorepack install --global pnpm@11.11.0';
const vitestCommand = 'set +e\npnpm vitest run 2>&1 | tee vitest.log\nstatus=${PIPESTATUS[0]}\nexit "$status"';
const gateCommand = 'set -euo pipefail\n'
  + 'if [[ "$EVENT_NAME" == workflow_dispatch && "$STARTUP_DIAGNOSTIC" == true && -z "$PERFORMANCE_BASELINE" ]]; then\n'
  + '  exit 1\nfi\n'
  + 'if [[ "$EVENT_NAME" == workflow_dispatch && "$PERFORMANCE_CONTRACT_ONLY" == true ]]; then\n'
  + '  [[ "$PERFORMANCE_BASELINE" =~ ^[0-9a-f]{40}$ ]]\n'
  + '  [[ "$STARTUP_DIAGNOSTIC" != true && "$PROFILE_BASELINE" != true ]]\n'
  + 'fi\nif [[ "$EVENT_NAME" == workflow_dispatch ]]; then\n'
  + '  [[ "$STARTUP_DIAGNOSTIC" != true || "$PROFILE_BASELINE" != true ]]\n'
  + '  [[ -z "$STARTUP_SCENARIO" || ( ( "$STARTUP_SCENARIO" == s2-warm || "$STARTUP_SCENARIO" == s2-pre-read ) && "$STARTUP_DIAGNOSTIC" == true && "$PROFILE_BASELINE" != true && "$PERFORMANCE_CONTRACT_ONLY" != true && "$PERFORMANCE_BASELINE" =~ ^[0-9a-f]{40}$ ) ]]\n'
  + 'fi\n[[ "$VERIFY_RESULT" == success ]]\n'
  + '[[ "$TESTS_RESULT" == success ]]\n[[ "$MUTATION_RESULT" == success ]]\n'
  + '[[ "$BROWSER_RESULT" == success ]]\n[[ "$DOCS_RESULT" == success ]]\n'
  + '[[ "$SECURITY_RESULT" == success ]]';
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
// Скан зависимостей, конфигурации и секретов: trivy закреплён по sha256, принятые записи берутся
// только из .trivyignore.yaml, ни переменные TRIVY_*, ни trivy.yaml проверяемого дерева настройки не
// меняют, уязвимость с вышедшим исправлением блокирует и при записи, а секреты ищутся и в тестах,
// примерах и документации и не принимаются никакими записями.
const securityCommand = [
  'set -euo pipefail',
  '# trivy читает переменные TRIVY_* как флаги: охват проверки задаёт только этот шаг.',
  'unset "${!TRIVY_@}"',
  'version=0.74.0',
  'sum=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a',
  'dir="$RUNNER_TEMP/trivy"',
  'mkdir -p "$dir"',
  'curl -fsSL --retry 3 --retry-all-errors -o "$dir/trivy.tgz" \\',
  '  "https://github.com/aquasecurity/trivy/releases/download/v$version/trivy_${version}_Linux-64bit.tar.gz"',
  'echo "$sum  $dir/trivy.tgz" | sha256sum -c -',
  'tar -xzf "$dir/trivy.tgz" -C "$dir" trivy',
  'accepted=(--ignorefile /dev/null)',
  '[ -f .trivyignore.yaml ] && accepted=(--ignorefile .trivyignore.yaml)',
  '# Настройки сканера задаёт шаг: trivy.yaml из проверяемого дерева их не меняет.',
  'scan() { "$dir/trivy" fs --config /dev/null --cache-dir "$dir/cache" --exit-code 1 --no-progress "$@" .; }',
  'scan --scanners vuln,misconfig --severity UNKNOWN,HIGH,CRITICAL --include-dev-deps "${accepted[@]}"',
  '# Исправление вышло — принятая раньше уязвимость снова блокирует.',
  'scan --scanners vuln --severity UNKNOWN,HIGH,CRITICAL --include-dev-deps --ignore-unfixed --ignorefile /dev/null',
  '# Секрет в тестах, примерах и документации — такая же утечка: встроенные исключения trivy для них сняты,',
  '# а записи .trivyignore.yaml к секретам не применяются.',
  String.raw`printf 'disable-allow-rules:\n  - tests\n  - examples\n  - markdown\n' > "$dir/secret.yaml"`,
  'scan --scanners secret --secret-config "$dir/secret.yaml" --ignorefile /dev/null',
  '# Тот же путь сканирования должен заметить тестовый ключ внутри examples/.',
  '# Проба живёт только в окружении CI и не попадает в исходники.',
  'probe_dir=$(mktemp -d examples/ci-trivy-canary.XXXXXXXX)',
  String.raw`trap 'rm -rf -- "$probe_dir"' EXIT`,
  'probe_file="$probe_dir/credentials.txt"',
  'python3 test/ci-trivy-canary.py seed "$probe_file"',
  'set +e',
  'scan --scanners secret --secret-config "$dir/secret.yaml" --ignorefile /dev/null --format json > "$dir/secret-canary.json"',
  'canary_status=$?',
  'set -e',
  'python3 test/ci-trivy-canary.py verify "$dir/secret-canary.json" "$probe_file" "$canary_status"',
  'rm -rf -- "$probe_dir"',
  'trap - EXIT',
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
const securityCommands = [securityCommand];
const mutationCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm build',
  'pnpm exec stryker run stryker.driver.config.mjs',
];
const browserCommands = [
  activatePnpm,
  'pnpm install --frozen-lockfile',
  'pnpm exec playwright install --dry-run ${{ matrix.browser }}',
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
      "index": 17,
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
  ],
  "security": [
    {
      "index": 0,
      "name": "Checkout",
      "uses": "actions/checkout@<sha>",
      "with": {
        "persist-credentials": false
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
  // Обычная проверка кандидата не выгружает архивы. Экспорт разрешён только
  // защищённому release и явно запрошенному измерению производительности.
  for (const [name, workflow] of workflows) {
    if (name === 'release.yml') continue;
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const [index, item] of (job.steps ?? []).entries()) {
        if (name === 'performance.yml' && id === 'compare' && index === job.steps!.length - 1) {
          const { name: _name, ...contract } = item;
          expect({ ...contract, uses: unpin(item.uses ?? '') }).toEqual({
            if: '${{ always() }}',
            uses: 'actions/upload-artifact@<sha>',
            with: {
              name: 'motion-performance-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
              path: 'candidate/bench/compare/results/\n${{ runner.temp }}/motion-performance/\n',
              'retention-days': 5,
              'if-no-files-found': 'error',
            },
          });
        } else {
          expect(item.uses ?? '').not.toMatch(/^actions\/(upload-artifact|upload-pages-artifact)@/);
        }
      }
    }
  }
  const release = workflows.get('release.yml')!;
  const sealed = step(release.jobs.verify!, 'Upload sealed package');
  expect(sealed.uses).toMatch(/^actions\/upload-artifact@/);
  expect(sealed.with?.['retention-days']).toBe(30);
  expect(sealed.if).toBeUndefined();
  expect(sealed['continue-on-error']).toBeUndefined();
  expect(release.jobs.publish!.environment).toBe('npm');
  const download = step(release.jobs.publish!, 'Download sealed package by artifact ID');
  expect(download.uses).toMatch(/^actions\/download-artifact@/);
  expect(download.with?.['artifact-ids']).toBe('$' + '{{ needs.verify.outputs.artifact_id }}');
  const ci = workflows.get('ci.yml')!;
  const browser = workflows.get('browser.yml')!;
  const ciEvents = structuredClone(ci.on);
  const dispatch = ciEvents.workflow_dispatch as { inputs: Record<string, { description?: string }> };
  for (const input of Object.values(dispatch.inputs)) delete input.description;
  expect(ciEvents).toEqual({
    push: { branches: ['main'] }, pull_request: null, merge_group: null,
    workflow_dispatch: { inputs: { profile_baseline: {
      type: 'boolean', default: false,
    }, performance_baseline: {
      type: 'string', default: '',
    }, performance_contract_only: {
      type: 'boolean', default: false,
    }, startup_diagnostic: {
      type: 'boolean', default: false,
    }, startup_scenario: {
      type: 'string', default: '',
    } } },
  });
  expect(browser.on).toEqual({ workflow_call: null });
  expect(Object.keys(ci.jobs).sort()).toEqual(['CI', 'browser-static', 'documentation', 'mutation', 'performance', 'profile-baseline', 'security', 'tests', 'verify']);
  expect(ci.jobs['profile-baseline']).toEqual({
    if: "${{ github.event_name == 'workflow_dispatch' && inputs.profile_baseline && !inputs.performance_contract_only && !inputs.startup_diagnostic && inputs.startup_scenario == '' }}",
    uses: './.github/workflows/profile-01.yml',
  });
  expect(ci.jobs.performance).toEqual({
    needs: ['CI'],
    if: "${{ github.event_name == 'workflow_dispatch' && inputs.performance_baseline != '' && !(inputs.performance_contract_only && (inputs.startup_diagnostic || inputs.profile_baseline)) && !(inputs.startup_diagnostic && inputs.profile_baseline) && (inputs.startup_scenario == '' || (inputs.startup_diagnostic && (inputs.startup_scenario == 's2-warm' || inputs.startup_scenario == 's2-pre-read'))) }}",
    uses: './.github/workflows/performance.yml',
    with: { baseline: '${{ inputs.performance_baseline }}', startup_diagnostic: '${{ inputs.startup_diagnostic }}', startup_scenario: '${{ inputs.startup_scenario }}', performance_contract_only: '${{ inputs.performance_contract_only }}' },
  });
  const performance = workflows.get('performance.yml')!;
  expect(performance.on).toEqual({ workflow_call: { inputs: { baseline: { type: 'string', required: true }, startup_diagnostic: { type: 'boolean', default: false }, startup_scenario: { type: 'string', default: '' }, performance_contract_only: { type: 'boolean', default: false } } } });
  expect(performance.permissions).toEqual({ contents: 'read' });
  expect(performance.defaults).toBeUndefined();
  expect(Object.keys(performance.jobs)).toEqual(['compare']);
  const compare = performance.jobs.compare!;
  expect(compare['runs-on']).toBe('ubuntu-latest');
  expect(compare['timeout-minutes']).toBe(90);
  expect(compare.strategy).toBeUndefined();
  expect(compare['continue-on-error']).toBeUndefined();
  expect(compare.if).toBeUndefined();
  expect(compare.defaults).toBeUndefined();
  expect(compare.permissions).toBeUndefined();
  const { name: _baselineName, ...baselineValidation } = compare.steps![0]!;
  expect(baselineValidation).toEqual({
    shell: 'bash', env: { BASELINE: '${{ inputs.baseline }}', STARTUP_SCENARIO: '${{ inputs.startup_scenario }}' },
    run: 'set -euo pipefail\n[[ "$BASELINE" =~ ^[0-9a-f]{40}$ ]]\n[[ "${{ inputs.startup_diagnostic }}" != true || "${{ inputs.performance_contract_only }}" != true ]]\n[[ -z "$STARTUP_SCENARIO" || ( ( "$STARTUP_SCENARIO" == s2-warm || "$STARTUP_SCENARIO" == s2-pre-read ) && "${{ inputs.startup_diagnostic }}" == true && "${{ inputs.performance_contract_only }}" != true ) ]]\n',
  });
  const checkouts = compare.steps!.filter(item => item.uses?.startsWith('actions/checkout@'));
  expect(checkouts.map(({ name: _name, uses, ...contract }) => ({ ...contract, uses: unpin(uses!) })))
    .toEqual([
      { uses: 'actions/checkout@<sha>', with: { path: 'candidate', ref: '${{ github.sha }}', 'persist-credentials': false, 'fetch-depth': 0 } },
      { uses: 'actions/checkout@<sha>', with: { path: 'baseline', ref: '${{ inputs.baseline }}', 'persist-credentials': false, 'fetch-depth': 0 } },
    ]);
  const setup = compare.steps!.filter(item => item.uses?.startsWith('actions/setup-node@'));
  expect(setup.map(({ name: _name, uses, ...contract }) => ({ ...contract, uses: unpin(uses!) })))
    .toEqual([{ uses: 'actions/setup-node@<sha>', with: { 'node-version': '24.19.0' } }]);
  for (const item of compare.steps!) expect(item['continue-on-error']).toBeUndefined();
  const performanceRuns = compare.steps!.filter(item => item.run).slice(1);
  expect(performanceRuns.map(({ name: _name, ...contract }) => ({ ...contract, run: contract.run!.trim() })))
    .toEqual([
      { if: "${{ inputs.startup_scenario == 's2-pre-read' }}", shell: 'bash', 'working-directory': 'candidate', env: { EXPECTED_HEAD: '${{ github.sha }}' }, run: [
        "set -euo pipefail",
        "test \"$(git rev-parse HEAD)\" = \"$EXPECTED_HEAD\"",
        "git merge-base --is-ancestor 741755754fb189776d25832ecb01b99c8f577425 HEAD",
        "git diff --exit-code 741755754fb189776d25832ecb01b99c8f577425 HEAD -- src bench/compare/entries",
        "sha256sum --check --strict <<'PRODUCTION_PINS'",
        "fce7beaf7fdbf5ee08fff61a80abf20926851a83520e20ed29cd36c6c8894d38  src/motion/runtime.ts",
        "32757fe65d3a3bbbe55a293b314124df04478b6155dd84e8ea9aef238db2a9ae  bench/compare/entries/lab.entry.mjs",
        "982ee2a8db956e275ca8664dd26b6e37acd5c21c242e728da611a51ea179cc91  bench/compare/entries/motion.entry.mjs",
        "6ebf96c859f44b05fc824a64022855594d35c3e87d52fd4019b94e522e6531b0  bench/compare/entries/anime.entry.mjs",
        "PRODUCTION_PINS",
      ].join('\n') },
      { run: activatePnpm },
      { id: 'build', run: 'pnpm --dir baseline install --frozen-lockfile\npnpm --dir candidate install --frozen-lockfile\npnpm --dir baseline build\npnpm --dir candidate build' },
      { if: '${{ !inputs.startup_diagnostic && !inputs.performance_contract_only }}', run: 'mkdir -p "$RUNNER_TEMP/motion-performance"\nnode candidate/bench/consumer-size.mjs baseline candidate "$RUNNER_TEMP/motion-performance/consumer-size.json"' },
      { if: '${{ !inputs.startup_diagnostic && !inputs.performance_contract_only }}', run: 'node candidate/bench/easing-pair.mjs baseline candidate "$RUNNER_TEMP/motion-performance/easing.json"' },
      { run: 'pnpm --dir candidate/bench/compare install --frozen-lockfile' },
      { run: 'pnpm --dir candidate/bench/compare exec playwright install --with-deps chromium' },
      { if: '${{ inputs.performance_contract_only }}', shell: 'bash', run: 'set -euo pipefail\nmkdir -p "$RUNNER_TEMP/motion-performance"\nprintf \'mode=performance-contract-only\\n\' > "$RUNNER_TEMP/motion-performance/contract-only.txt"' },
      { if: "${{ inputs.startup_scenario != 's2-pre-read' }}", run: 'xvfb-run -a node --test candidate/bench/compare/transition-profile.contract.test.mjs' },
      { if: '${{ inputs.startup_diagnostic && !inputs.performance_contract_only }}', shell: 'bash', 'working-directory': 'candidate', env: { BASELINE: '${{ inputs.baseline }}', MOTION_STARTUP_DIAGNOSTIC_SCENARIO: '${{ inputs.startup_scenario }}' }, run: 'set -euo pipefail\ngit diff --exit-code "$BASELINE" HEAD -- src bench/compare/entries\nxvfb-run -a node bench/compare/transition-profile.mjs . "$RUNNER_TEMP/motion-performance/startup-diagnostic" startup-diagnostic' },
      { if: "${{ inputs.startup_scenario == 's2-pre-read' }}", shell: 'bash', env: { RAW: '${{ runner.temp }}/motion-performance/startup-diagnostic' }, run: [
        "set -euo pipefail",
        "node --input-type=module - <<'JS'",
        "import assert from 'node:assert/strict';",
        "import { readFileSync, readdirSync } from 'node:fs';",
        "const root = process.env.RAW;",
        "const json = file => JSON.parse(readFileSync(root + '/' + file, 'utf8'));",
        "const rows = readFileSync(root + '/samples.jsonl', 'utf8').trim().split('\\n').map(JSON.parse);",
        "assert.equal(rows.length, 36);",
        "assert.equal(new Set(rows.map(r => r.round + ':' + r.id + ':' + r.condition)).size, 36);",
        "assert.deepEqual([...new Set(rows.map(r => r.id))].sort(), ['anime', 'lab', 'motion']);",
        "assert.deepEqual([...new Set(rows.map(r => r.condition))].sort(), ['control', 'pre-read']);",
        "for (const row of rows) {",
        "  assert.equal(row.valid, true);",
        "  assert.equal(row.rows.length, 8);",
        "  assert.equal(row.rows.filter(b => b.warmup).length, 1);",
        "  assert.equal(row.offeredCalls, 40);",
        "  assert.equal(row.acquiredCalls, 40);",
        "  assert.equal(row.cancelReturnedCalls, 40);",
        "  assert.equal(row.removedTargets, 4000);",
        "  for (const batch of row.rows) {",
        "    assert.equal(batch.calls.length, 5);",
        "    assert.equal(batch.connectedDocumentEffects, 0);",
        "    assert.ok(Number.isFinite(batch.wholeElapsedMs) && batch.wholeElapsedMs >= batch.batchElapsedMs);",
        "    for (const [index, call] of batch.calls.entries()) {",
        "      assert.equal(call.call, index);",
        "      assert.ok(Number.isFinite(call.startElapsedMs) && call.startElapsedMs >= 0);",
        "      assert.ok(Number.isFinite(call.combinedElapsedMs) && call.combinedElapsedMs >= call.startElapsedMs);",
        "      if (row.condition === 'pre-read') {",
        "        assert.equal(typeof call.transform, 'string');",
        "        assert.ok(Number.isFinite(call.preReadElapsedMs) && call.preReadElapsedMs >= 0);",
        "        assert.ok(call.combinedElapsedMs >= call.preReadElapsedMs);",
        "      } else {",
        "        assert.equal(call.transform, null);",
        "        assert.equal(call.preReadElapsedMs, null);",
        "      }",
        "    }",
        "  }",
        "}",
        "for (const id of ['lab', 'motion', 'anime']) assert.equal(json(id + '-original-semantic.json').valid, true);",
        "assert.equal(json('pre-read-pose-control.json').valid, true);",
        "assert.equal(readdirSync(root).filter(f => f.endsWith('.cpuprofile')).length, 0);",
        "assert.equal(json('metadata.json').preReadProbe.profiler, false);",
        "console.log('PRE_READ_RAW_PASS observations=36 publicCalls=1440 profiles=0');",
        "JS",
      ].join('\n') },
      { if: '${{ !inputs.startup_diagnostic && !inputs.performance_contract_only }}', shell: 'bash', run: 'set -euo pipefail\nxvfb-run -a node candidate/bench/compare/transition-profile.mjs candidate "$RUNNER_TEMP/motion-performance/spring" spring-pair baseline\nxvfb-run -a node candidate/bench/compare/transition-profile.mjs candidate "$RUNNER_TEMP/motion-performance/js" js-pair baseline' },
      { if: '${{ !inputs.startup_diagnostic && !inputs.performance_contract_only }}', shell: 'bash', run: 'set -euo pipefail\nxvfb-run -a node candidate/bench/compare/transition-profile.mjs candidate "$RUNNER_TEMP/motion-performance/transition" full baseline' },
      { if: '${{ !inputs.startup_diagnostic && !inputs.performance_contract_only }}', 'working-directory': 'candidate/bench/compare', run: 'xvfb-run -a node bench.mjs' },
      { if: "${{ !inputs.startup_diagnostic && !inputs.performance_contract_only && !cancelled() && steps.build.outcome == 'success' }}", shell: 'bash', run: [
        'set -euo pipefail', 'mkdir -p "$RUNNER_TEMP/motion-performance"', 'motion_size_status=0',
        'node baseline/scripts/size-gate.mjs | tee "$RUNNER_TEMP/motion-performance/baseline-size.txt" || motion_size_status=1',
        'node candidate/scripts/size-gate.mjs | tee "$RUNNER_TEMP/motion-performance/candidate-size.txt" || motion_size_status=1',
        'exit "$motion_size_status"',
      ].join('\n') },
    ]);
  const performanceCallers = [...workflows].flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).filter(([, job]) => job.uses === './.github/workflows/performance.yml')
      .map(([id]) => [file, id]));
  expect(performanceCallers).toEqual([['ci.yml', 'performance']]);
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
  const security = ci.jobs.security!;
  const conformance = browser.jobs.conformance!;
  for (const job of [verify, tests, mutation, security, conformance]) {
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
  for (const job of [verify, tests, mutation, security]) expect(job.needs).toBeUndefined();
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
  for (const [name, job] of Object.entries({ verify, tests, mutation, security, conformance })) {
    expect(job.steps!.map((item, index) => ({ index, ...item })).filter((item) => item.uses)
      .map((item) => ({ ...item, uses: unpin(item.uses!) })))
      .toEqual(requiredActions[name as keyof typeof requiredActions]);
  }
  assertCommands(verify, verifyCommands);
  assertCommands(tests, testCommands);
  assertCommands(mutation, mutationCommands);
  assertCommands(security, securityCommands);
  assertCommands(conformance, browserCommands);
  expect(conformance.container).toEqual({ image: playwrightImage, options: '--user 1001' });
  const imageVersion = /^mcr\.microsoft\.com\/playwright:v([^@]+)-noble@sha256:[a-f0-9]{64}$/.exec(conformance.container!.image);
  expect(imageVersion?.[1]).toBe(playwrightVersion);
  for (const item of conformance.steps!.filter(item => item.run)) expect(item.shell).toBe('bash');
  expect(step(tests, 'Vitest').id).toBe('vitest');
  const gate = ci.jobs.CI!;
  expect(gate.name).toBe('CI');
  expect(gate.if).toBe('${{ always() }}');
  expect(gate.needs).toEqual(peers);
  expect(gate['runs-on']).toBe('ubuntu-latest');
  expect(gate.permissions).toEqual({});
  expect(gate.steps!.map(item => ({ ...item, run: item.run!.replace(/^\s*echo .*\n/gm, '') }))).toEqual([{
    name: 'Require every candidate check',
    shell: 'bash',
    env: {
      VERIFY_RESULT: '${{ needs.verify.result }}',
      TESTS_RESULT: '${{ needs.tests.result }}',
      MUTATION_RESULT: '${{ needs.mutation.result }}',
      BROWSER_RESULT: '${{ needs.browser-static.result }}',
      DOCS_RESULT: '${{ needs.documentation.result }}',
      SECURITY_RESULT: '${{ needs.security.result }}',
      EVENT_NAME: '${{ github.event_name }}',
      STARTUP_DIAGNOSTIC: '${{ inputs.startup_diagnostic }}',
      PERFORMANCE_CONTRACT_ONLY: '${{ inputs.performance_contract_only }}',
      PROFILE_BASELINE: '${{ inputs.profile_baseline }}',
      PERFORMANCE_BASELINE: '${{ inputs.performance_baseline }}',
      STARTUP_SCENARIO: '${{ inputs.startup_scenario }}',
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
    ...['verify', 'tests', 'mutation', 'security'].map((id) => [`performance export в обычном CI/${id}`, 'ci.yml', (w: Workflow) => {
      const performance = parse(sources().get('performance.yml')!) as Workflow;
      w.jobs[id]!.steps!.push(performance.jobs.compare!.steps!.at(-1)!);
    }] as const),
    ['performance без ручного события', 'ci.yml', (w: Workflow) => { w.jobs.performance!.if = "${{ inputs.performance_baseline != '' }}"; }],
    ['performance без явного baseline', 'ci.yml', (w: Workflow) => { w.jobs.performance!.if = "${{ github.event_name == 'workflow_dispatch' }}"; }],
    ['performance с подменой baseline', 'ci.yml', (w: Workflow) => { w.jobs.performance = { ...w.jobs.performance, with: { baseline: 'main' } };  }],
    ['performance обход caller через docs', 'docs.yml', (w: Workflow) => { w.jobs.export = { uses: './.github/workflows/performance.yml' }; }],
    ['performance push trigger', 'performance.yml', (w: Workflow) => { w.on.push = null; }],
    ['performance прямой dispatch', 'performance.yml', (w: Workflow) => { w.on.workflow_dispatch = null; }],
    ['performance без обязательного input', 'performance.yml', (w: Workflow) => { w.on.workflow_call = { inputs: { baseline: { type: 'string', required: false } } }; }],
    ['performance дополнительная job', 'performance.yml', (w: Workflow) => { w.jobs.extra = { 'runs-on': 'ubuntu-latest' }; }],
    ['performance расширяет timeout', 'performance.yml', (w: Workflow) => { w.jobs.compare!['timeout-minutes'] = 360; }],
    ['performance дублирует измерение matrix', 'performance.yml', (w: Workflow) => { w.jobs.compare!.strategy = { 'fail-fast': false, matrix: { node: ['24', '24'] } }; }],
    ['performance пропускает сравнительные assertions', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.find(item => item.run === 'xvfb-run -a node bench.mjs')!.if = false; }],
    ['performance скрывает отказ сравнительных assertions', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.find(item => item.run === 'xvfb-run -a node bench.mjs')!.run += ' || true'; }],
    ['performance скрывает отказ размера', 'performance.yml', (w: Workflow) => { const item = w.jobs.compare!.steps!.find(item => item.run?.includes('exit "$motion_size_status"'))!; item.run = item.run!.replace('exit "$motion_size_status"', 'exit 0'); }],
    ['performance игнорирует failure', 'performance.yml', (w: Workflow) => { w.jobs.compare!['continue-on-error'] = true; }],
    ['performance пропускает baseline validation', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![0]!.if = false; }],
    ['performance ослабляет identity baseline', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![0]!.run = 'true\n'; }],
    ['performance подменяет input baseline', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![0]!.env!.BASELINE = 'main'; }],
    ['performance подменяет checkout baseline', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![2]!.with!.ref = 'main'; }],
    ['performance скрывает исходный failure', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![0]!['continue-on-error'] = true; }],
    ['performance подменяет Node', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.find(item => item.uses?.startsWith('actions/setup-node@'))!.with!['node-version'] = '24'; }],
    ['performance пропускает setup Node', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.find(item => item.uses?.startsWith('actions/setup-node@'))!.if = false; }],
    ['performance пропускает checkout', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps![1]!.if = false; }],
    ['performance export не последний', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.push({ run: 'true' }); }],
    ['performance второй export', 'performance.yml', (w: Workflow) => { w.jobs.compare!.steps!.unshift(w.jobs.compare!.steps!.at(-1)!); }],
    ...['if', 'uses', 'with', 'continue-on-error'].map((field) => [`performance export mutation ${field}`, 'performance.yml', (w: Workflow) => {
      const item = w.jobs.compare!.steps!.at(-1)!;
      if (field === 'if') item.if = '${{ success() }}';
      else if (field === 'uses') item.uses = item.uses!.replace('upload-artifact', 'upload-pages-artifact');
      else if (field === 'with') delete item.with;
      else item['continue-on-error'] = true;
    }] as const),
    ...([
      ['name', 'motion-performance-${{ github.sha }}'],
      ['name', 'motion-performance-${{ github.run_id }}-${{ github.run_attempt }}'],
      ['path', 'candidate/bench/compare/results/\n'],
      ['path', '${{ runner.temp }}/motion-performance/\n'],
      ['path', '**/*\n'],
      ['retention-days', 30],
      ['if-no-files-found', 'ignore'],
    ] as const).map(([field, value]) => [`performance export option ${field}=${value}`, 'performance.yml', (w: Workflow) => {
      w.jobs.compare!.steps!.at(-1)!.with![field] = value;
    }] as const),
    ['раннее истечение release-пакета при ожидании approval', 'release.yml', (w: Workflow) => {
      step(w.jobs.verify!, 'Upload sealed package').with!['retention-days'] = 1;
    }],
    ['неверный artifact ID после approval', 'release.yml', (w: Workflow) => {
      step(w.jobs.publish!, 'Download sealed package by artifact ID').with!['artifact-ids'] = 'wrong-artifact-id';
    }],
    ['игнорирование verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!['continue-on-error'] = true; }],
    ['пропуск verify', 'ci.yml', (w: Workflow) => { w.jobs.verify!.if = false; }],
    ['игнорирование browser caller', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!['continue-on-error'] = true; }],
    ['другой browser worker', 'ci.yml', (w: Workflow) => { w.jobs['browser-static']!.uses = './.github/workflows/release.yml'; }],
    ['нет Node floor', 'ci.yml', (w: Workflow) => { w.jobs.verify!.steps = w.jobs.verify!.steps!.filter(item => item.name !== 'Consumer smoke on minimum runtime'); }],
    ['подмена Node floor настройкой Node 24', 'ci.yml', (w: Workflow) => {
      step(w.jobs.verify!, 'Setup consumer Node floor').with!['node-version'] = '24';
    }],
    ['несовпадение версии browser-образа', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.image = playwrightImage.replace(`v${playwrightVersion}`, 'v0.0.0'); }],
    ['несовпадение digest browser-образа', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.image = playwrightImage.replace(/sha256:[a-f0-9]{64}$/, `sha256:${'0'.repeat(64)}`); }],
    ['browser-образ без закреплённого digest', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.image = playwrightImage.split('@')[0]!; }],
    ['запуск browser-контейнера с root UID', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.options = '--user 0'; }],
    ['неявный UID browser-контейнера', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.options = ''; }],
    ['привилегированные параметры browser-контейнера', 'browser.yml', (w: Workflow) => { w.jobs.conformance!.container!.options += ' --privileged'; }],
    ['неявная оболочка browser-шага', 'browser.yml', (w: Workflow) => { delete step(w.jobs.conformance!, 'Install Playwright browser').shell; }],
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
    ['ci.yml', 'security', securityCommands],
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
  }, 30_000);

  it.each([
    ['ci.yml', 'verify'],
    ['ci.yml', 'tests'],
    ['ci.yml', 'mutation'],
    ['ci.yml', 'security'],
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

  it.each(['VERIFY_RESULT', 'TESTS_RESULT', 'MUTATION_RESULT', 'BROWSER_RESULT', 'DOCS_RESULT', 'SECURITY_RESULT']
    .flatMap((key) => ['success', 'failure', 'cancelled', 'skipped', 'neutral', 'pending', '', undefined]
      .map((result) => ({ key, result }))))('shell итога проверяет $key=$result', ({ key, result }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const program = ci.jobs.CI!.steps![0]!.run!;
    const env: NodeJS.ProcessEnv = {
      ...process.env, VERIFY_RESULT: 'success', TESTS_RESULT: 'success',
      MUTATION_RESULT: 'success', BROWSER_RESULT: 'success', DOCS_RESULT: 'success',
      SECURITY_RESULT: 'success', PERFORMANCE_CONTRACT_ONLY: '', PROFILE_BASELINE: '', EVENT_NAME: 'pull_request',
      STARTUP_DIAGNOSTIC: '', STARTUP_SCENARIO: '', PERFORMANCE_BASELINE: '',
    };
    delete env[key];
    if (result !== undefined) env[key] = result;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
      env, encoding: 'utf8', timeout: 5000,
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, `${key}=${result}: ${actual.stderr}`).toBe(result === 'success');
  });

  it('итог выполняет проверку входа диагностики и сохраняет обычные режимы', () => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const item = ci.jobs.CI!.steps![0]!;
    expect(item.env!.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(item.env!.STARTUP_DIAGNOSTIC).toBe('${{ inputs.startup_diagnostic }}');
    expect(item.env!.PERFORMANCE_BASELINE).toBe('${{ inputs.performance_baseline }}');
    const execute = (program: string, event: string, diagnostic: string, baseline: string) => {
      const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
        env: { ...process.env, VERIFY_RESULT: 'success', TESTS_RESULT: 'success',
          MUTATION_RESULT: 'success', BROWSER_RESULT: 'success', DOCS_RESULT: 'success', SECURITY_RESULT: 'success',
          EVENT_NAME: event, STARTUP_DIAGNOSTIC: diagnostic, STARTUP_SCENARIO: '', PERFORMANCE_BASELINE: baseline, PERFORMANCE_CONTRACT_ONLY: 'false', PROFILE_BASELINE: 'false' },
        encoding: 'utf8', timeout: 5000,
      });
      expect(actual.error).toBeUndefined();
      return actual.status;
    };
    const program = item.run!;
    expect(execute(program, 'workflow_dispatch', 'true', '')).toBe(1);
    expect(execute(program, 'workflow_dispatch', 'true', '6e067b7e584833678f1dff63d5558cb7d9afbd2e')).toBe(0);
    expect(execute(program, 'workflow_dispatch', 'false', '')).toBe(0);
    expect(execute(program, 'workflow_dispatch', '', '')).toBe(0);
    for (const event of ['pull_request', 'push', 'merge_group']) {
      expect(execute(program, event, '', '')).toBe(0);
    }
    // Контроль отличает настоящий отказ от постоянного успеха.
    expect(() => expect(execute('exit 0', 'workflow_dispatch', 'true', '')).toBe(1)).toThrow();
    expect(() => expect(execute('exit 1', 'workflow_dispatch', 'true', '6e067b7e584833678f1dff63d5558cb7d9afbd2e')).toBe(0)).toThrow();
  });

  it.each([
    { contract: 'true', startup: 'false', profile: 'false', baseline: '', passes: false },
    { contract: 'true', startup: 'false', profile: 'false', baseline: 'main', passes: false },
    { contract: 'true', startup: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { contract: 'true', startup: 'false', profile: 'true', baseline: 'a'.repeat(40), passes: false },
    { contract: 'true', startup: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { contract: 'false', startup: 'true', profile: 'true', baseline: 'a'.repeat(40), passes: false },
    { contract: 'false', startup: 'false', profile: 'true', baseline: '', passes: true },
    { contract: 'false', startup: 'false', profile: 'false', baseline: '', passes: true },
    { contract: 'false', startup: 'true', profile: 'false', baseline: '', passes: false },
    { contract: 'false', startup: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: true },
  ])('contract-only aggregate $contract/$startup/$profile', ({ contract, startup, profile, baseline, passes }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', ci.jobs.CI!.steps![0]!.run!], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, EVENT_NAME: 'workflow_dispatch', STARTUP_DIAGNOSTIC: startup,
        PERFORMANCE_CONTRACT_ONLY: contract, PROFILE_BASELINE: profile, PERFORMANCE_BASELINE: baseline, STARTUP_SCENARIO: '',
        VERIFY_RESULT: 'success', TESTS_RESULT: 'success', MUTATION_RESULT: 'success',
        BROWSER_RESULT: 'success', DOCS_RESULT: 'success', SECURITY_RESULT: 'success' },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, actual.stderr).toBe(passes);
  });

  it.each([
    { scenario: '', startup: 'false', contract: 'false', profile: 'false', baseline: '', passes: true },
    { scenario: '', startup: 'true', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { scenario: 's2-pre-read', startup: 'true', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { scenario: 's2-pre-read', startup: 'false', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { scenario: 's2-warm', startup: 'true', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: true },
    { scenario: 's2-warm', startup: 'false', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { scenario: 's2-warm', startup: 'true', contract: 'false', profile: 'false', baseline: '', passes: false },
    { scenario: 's2-warm', startup: 'true', contract: 'false', profile: 'false', baseline: 'main', passes: false },
    { scenario: 's2-warm', startup: 'true', contract: 'true', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { scenario: 's2-warm', startup: 'true', contract: 'false', profile: 'true', baseline: 'a'.repeat(40), passes: false },
    { scenario: 'unknown', startup: 'true', contract: 'false', profile: 'false', baseline: 'a'.repeat(40), passes: false },
    { scenario: 's2-warm', startup: 'false', contract: 'false', profile: 'false', baseline: '', passes: false },
  ])('startup_scenario aggregate dispatch $scenario/$startup/$contract/$profile', ({ scenario, startup, contract, profile, baseline, passes }) => {
    const ci = parse(sources().get('ci.yml')!) as Workflow;
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', ci.jobs.CI!.steps![0]!.run!], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, EVENT_NAME: 'workflow_dispatch', STARTUP_SCENARIO: scenario,
        STARTUP_DIAGNOSTIC: startup, PERFORMANCE_CONTRACT_ONLY: contract,
        PROFILE_BASELINE: profile, PERFORMANCE_BASELINE: baseline,
        VERIFY_RESULT: 'success', TESTS_RESULT: 'success', MUTATION_RESULT: 'success',
        BROWSER_RESULT: 'success', DOCS_RESULT: 'success', SECURITY_RESULT: 'success' },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, actual.stderr).toBe(passes);
  });

  it.each([
    { scenario: '', startup: false, contract: false, passes: true },
    { scenario: 's2-pre-read', startup: true, contract: false, passes: true },
    { scenario: 's2-pre-read', startup: false, contract: false, passes: false },
    { scenario: 's2-pre-read', startup: true, contract: true, passes: false },
    { scenario: 's2-warm', startup: true, contract: false, passes: true },
    { scenario: 's2-warm', startup: false, contract: false, passes: false },
    { scenario: 's2-warm', startup: true, contract: true, passes: false },
    { scenario: 'unknown', startup: true, contract: false, passes: false },
  ])('reusable startup_scenario first-step $scenario/$startup/$contract', ({ scenario, startup, contract, passes }) => {
    const performance = parse(sources().get('performance.yml')!) as Workflow;
    const first = performance.jobs.compare!.steps![0]!;
    const program = first.run!.replaceAll('${{ inputs.startup_diagnostic }}', String(startup))
      .replaceAll('${{ inputs.performance_contract_only }}', String(contract));
    const actual = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', program], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, BASELINE: 'a'.repeat(40), STARTUP_SCENARIO: scenario },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status === 0, actual.stderr).toBe(passes);
  });

  it.each([
    { s5: false, contract: false, scenario: '', cli: true, measurements: true },
    { s5: true, contract: false, scenario: '', cli: true, measurements: false },
    { s5: false, contract: true, scenario: '', cli: true, measurements: false },
    { s5: true, contract: false, scenario: 's2-pre-read', cli: false, measurements: false },
  ])('actual route selection startup=$s5 contract=$contract scenario=$scenario', ({ s5, contract, scenario, cli, measurements }) => {
    const workflow = parse(sources().get('performance.yml')!) as Workflow;
    const selected = (item: Step) => {
      if (item.if === undefined) return true;
      const expression = String(item.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replaceAll('inputs.startup_diagnostic', String(s5))
        .replaceAll('inputs.performance_contract_only', String(contract))
        .replaceAll("inputs.startup_scenario == 's2-pre-read'", String(scenario === 's2-pre-read'))
        .replaceAll("inputs.startup_scenario != 's2-pre-read'", String(scenario !== 's2-pre-read'))
        .replaceAll('!cancelled()', 'true').replaceAll("steps.build.outcome == 'success'", 'true');
      if (!/^[truefals\s!&|()]+$/.test(expression)) throw new Error(`Unsupported route expression: ${expression}`);
      return Function(`return (${expression})`)() as boolean;
    };
    const steps = workflow.jobs.compare!.steps!;
    expect(selected(steps.find(item => item.run?.includes('node --test candidate/bench/compare/transition-profile'))!)).toBe(cli);
    for (const item of steps.filter(item => item.run?.match(/consumer-size\.mjs|easing-pair\.mjs|spring-pair baseline|full baseline|node bench\.mjs|size-gate\.mjs/))) {
      expect(selected(item)).toBe(measurements);
    }
    expect(selected(steps.find(item => item.run?.includes('xvfb-run -a node bench/compare/transition-profile.mjs'))!)).toBe(s5);
    expect(selected(steps.find(item => item.run?.includes('PRODUCTION_PINS'))!)).toBe(scenario === 's2-pre-read');
    expect(selected(steps.find(item => item.run?.includes('PRE_READ_RAW_PASS'))!)).toBe(scenario === 's2-pre-read');
    const receipt = steps.findIndex(item => item.run?.includes('mode=performance-contract-only'));
    expect(selected(steps[receipt]!)).toBe(contract);
    expect(receipt).toBeLessThan(steps.findIndex(item => item.run?.includes('node --test candidate/bench/compare/transition-profile')));
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
