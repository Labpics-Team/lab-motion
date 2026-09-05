import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const workflow = readFileSync(workflowUrl, 'utf8').replace(
  /\r\n?/g,
  '\n',
);
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  .replace(/\r\n?/g, '\n');
const releasePackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const releaseVersion = releasePackage.version;
const releaseTag = `v${releaseVersion}`;
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const supportedReplayTag = 'v0.3.0';
const unsupportedReplayTag = 'v0.2.0';
const releaseReplayProtocolBase = '851a37c9ff53beb3f46f466c0d1f1e92130fb46d';
const releases = readFileSync(new URL('../docs/RELEASES.md', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function namedStep(source: string, stepName: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (start === -1) throw new Error(`step ${stepName} отсутствует`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^      - /.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
}

function bashRun(step: string, stepName: string): string {
  const lines = step.split('\n');
  if (!lines.includes('        shell: bash')) {
    throw new Error(`step ${stepName} обязан фиксировать shell: bash`);
  }
  const run = lines.findIndex((line) => line === '        run: |');
  if (run === -1) throw new Error(`step ${stepName} не содержит run`);
  return lines
    .slice(run + 1)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function job(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`job ${name} отсутствует`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^  [a-z][a-z0-9-]*:$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n');
}

function stepRun(jobName: string, stepName: string): string {
  return bashRun(namedStep(job(jobName), stepName), stepName);
}

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env['GIT_BASH_PATH'],
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  const executable = candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && existsSync(candidate));
  if (executable === undefined) throw new Error('Git Bash отсутствует');
  return executable;
}

function gitOutput(args: string[], cwd = repositoryRoot): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function withCheckout<T>(ref: string, run: (workspace: string) => T): T {
  const fixture = mkdtempSync(join(tmpdir(), 'labmotion-release-checkout-'));
  const workspace = join(fixture, 'repo');
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--quiet', '--no-checkout', repositoryRoot, workspace],
      { encoding: 'utf8' },
    );
    if (clone.status !== 0) throw new Error(`git clone: ${clone.stderr}`);
    const checkout = spawnSync(
      'git',
      ['-c', `core.hooksPath=${join(fixture, 'disabled-hooks')}`, 'checkout', '--quiet', '--detach', ref],
      { cwd: workspace, encoding: 'utf8' },
    );
    if (checkout.status !== 0) throw new Error(`git checkout ${ref}: ${checkout.stderr}`);
    return run(workspace);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const taggedSourceSha = gitOutput(['rev-parse', `${supportedReplayTag}^{}`]);
const mainSourceSha = gitOutput(['rev-parse', 'HEAD']);

function executeResolve(scenario: 'absent' | 'direct' | 'annotated') {
  const script = `
GITHUB_OUTPUT=$(mktemp)
trap 'rm -f "$GITHUB_OUTPUT"' EXIT
export GITHUB_OUTPUT
gh() {
  [[ "$1" == "api" ]] || return 90
  if [[ "$2" == "repos/$GITHUB_REPOSITORY/git/ref/tags/$EXPECTED_TAG" ]]; then
    case "$GH_SCENARIO" in
      absent) return 1 ;;
      direct) printf 'commit\\t%s\\n' "$TAGGED_SOURCE_SHA" ;;
      annotated) printf 'tag\\tannotated-object\\n' ;;
      *) return 91 ;;
    esac
    return 0
  fi
  if [[ "$GH_SCENARIO" == "annotated" && "$2" == "repos/$GITHUB_REPOSITORY/git/tags/annotated-object" ]]; then
    printf 'commit\\t%s\\n' "$TAGGED_SOURCE_SHA"
    return 0
  fi
  return 91
}
date() {
  [[ "$DATE_ALLOWED" == "1" ]] || { echo 'tagged rerun consulted wall clock' >&2; return 92; }
  [[ "$1" == "-u" && "$2" == "+%F" ]] || return 93
  printf '%s\\n' "$CURRENT_DATE"
}
${stepRun('resolve', 'Resolve and validate version')}
cat "$GITHUB_OUTPUT"
`;
  return spawnSync(
    bashExecutable(),
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CURRENT_DATE: '2026-09-05',
        DATE_ALLOWED: scenario === 'absent' ? '1' : '0',
        GH_SCENARIO: scenario,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'Labpics-Team/lab-motion',
        GITHUB_SHA: mainSourceSha,
        EXPECTED_TAG: releaseTag,
        INPUT_VERSION: releaseVersion,
        TAGGED_SOURCE_SHA: taggedSourceSha,
      },
    },
  );
}

function outputs(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split(/\r?\n/)
      .filter((line) => /^[a-z_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function executeTaggedReleaseCheck(ref: string, changelog?: string) {
  return withCheckout(ref, (workspace) => {
    if (changelog !== undefined) {
      writeFileSync(join(workspace, 'CHANGELOG.md'), changelog);
    }
    return spawnSync(
      process.execPath,
      ['scripts/check-release.mjs', ref, '--validate-stored-date'],
      { cwd: workspace, encoding: 'utf8' },
    );
  });
}

function executeVerifySource(ref: string) {
  return withCheckout(ref, (workspace) => {
    const expectedSourceSha = gitOutput(['rev-parse', 'HEAD'], workspace);
    const script = `
GITHUB_OUTPUT=$(mktemp)
trap 'rm -f "$GITHUB_OUTPUT"' EXIT
export GITHUB_OUTPUT
${stepRun('verify', 'Verify release source')}
cat "$GITHUB_OUTPUT"
`;
    return spawnSync(
      bashExecutable(),
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPECTED_SOURCE_SHA: expectedSourceSha,
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_RUN_ID: '1',
          RELEASE_REPLAY_PROTOCOL_BASE: releaseReplayProtocolBase,
          RELEASE_TAG: ref,
        },
      },
    );
  });
}

function assertVitestDiagnostics(source: string): void {
  const vitestStep = namedStep(source, 'Vitest');
  const uploadStep = namedStep(source, 'Upload Vitest diagnostics');
  const id = /^        id: ([a-z][a-z0-9_-]*)$/m.exec(vitestStep)?.[1];
  if (id === undefined) throw new Error('Vitest diagnostics: id шага отсутствует');
  const condition = /^        if: (.+)$/m.exec(uploadStep)?.[1];
  if (condition !== `failure() && steps.${id}.outcome == 'failure'`) {
    throw new Error('Vitest diagnostics: upload не связан с failure шага Vitest');
  }
  if (!/^        uses: actions\/upload-artifact@[0-9a-f]{40}(?:\s+#.*)?$/m.test(uploadStep)) {
    throw new Error('Vitest diagnostics: upload-artifact отсутствует или не закреплён');
  }
  if (!/^          if-no-files-found: error$/m.test(uploadStep)) {
    throw new Error('Vitest diagnostics: потеря файла не завершает upload ошибкой');
  }
  const artifactPath = /^          path: ([A-Za-z0-9._/-]+)$/m.exec(uploadStep)?.[1];
  if (artifactPath === undefined || artifactPath.includes('..') || artifactPath.startsWith('/')) {
    throw new Error('Vitest diagnostics: требуется один безопасный относительный путь');
  }

  const workspace = mkdtempSync(join(tmpdir(), 'labmotion-vitest-diagnostics-'));
  try {
    const diagnostic = 'forced Vitest diagnostic';
    const result = spawnSync(
      bashExecutable(),
      [
        '--noprofile',
        '--norc',
        '-e',
        '-o',
        'pipefail',
        '-c',
        `pnpm() { printf '%s\\n' "$FORCED_DIAGNOSTIC"; return 37; }\n${bashRun(vitestStep, 'Vitest')}`,
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, FORCED_DIAGNOSTIC: diagnostic },
      },
    );
    if (result.status !== 37) {
      throw new Error(`Vitest diagnostics: exit status ${String(result.status)} вместо 37`);
    }
    const uploadedFile = join(workspace, artifactPath);
    if (!existsSync(uploadedFile)) {
      throw new Error(`Vitest diagnostics: ${artifactPath} не создан шагом Vitest`);
    }
    if (!readFileSync(uploadedFile, 'utf8').includes(diagnostic)) {
      throw new Error('Vitest diagnostics: stderr/stdout Vitest потерян');
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function publishProgram(source = workflow): string {
  const marker = '      - name: Publish or reconcile verified tarball through npm OIDC';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('publish step отсутствует');
  const tail = source.slice(start);
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/.exec(tail);
  if (match === null) throw new Error('publish Node program отсутствует');
  return match[1]!;
}

function assertPublishContract(program: string): void {
  const required = [
    "const candidate = stableVersion(version, 'кандидат')",
    "const existing = await lookupVersion()",
    "await reconcile(12, 'idempotent')",
    "compareVersions(candidate, latest.parsed) <= 0",
    "await reconcile(12, 'published')",
    "mode === 'published'",
    "comparison > 0",
    "comparison >= 0 && provenanceReady",
    "mode === 'idempotent'",
    "comparison < 0",
    "['publish', process.env.TARBALL, '--registry=https://registry.npmjs.org', '--tag', 'latest', '--access', 'public', '--provenance', '--ignore-scripts']",
  ];
  for (const token of required) {
    if (!program.includes(token)) throw new Error(`release contract: отсутствует ${token}`);
  }
  if (/dist-tag\s+(?:add|set)|['"]dist-tag['"]/.test(program)) {
    throw new Error('release contract: запрещён отдельный retag');
  }
  const existing = program.indexOf('const existing = await lookupVersion()');
  const publish = program.indexOf("['publish', process.env.TARBALL");
  if (!(existing >= 0 && publish > existing)) {
    throw new Error('release contract: publish расположен до idempotent lookup');
  }
}

function runBlocks(): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)run: \|$/.exec(lines[i]!);
    if (match === null) continue;
    const bodyIndent = match[1]!.length + 2;
    const body: string[] = [];
    for (i++; i < lines.length; i++) {
      const line = lines[i]!;
      if (line !== '' && line.length - line.trimStart().length < bodyIndent) {
        i--;
        break;
      }
      body.push(line.slice(Math.min(bodyIndent, line.length)));
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('release workflow: граница тега и npm OIDC', () => {
  it('CI загружает историю для проверки provenance-предка', () => {
    const checkoutStart = ciWorkflow.indexOf('      - name: Checkout');
    const checkoutEnd = ciWorkflow.indexOf('      - name: GitHub Actions contract', checkoutStart);
    const checkout = ciWorkflow.slice(checkoutStart, checkoutEnd);

    expect(checkout).toContain('          fetch-depth: 0');
  });

  it('CI сохраняет diagnostic и загружает его только после падения того же Vitest-step', () => {
    expect(() => assertVitestDiagnostics(ciWorkflow)).not.toThrow();

    const mutants = [
      ciWorkflow.replace('        id: vitest\n', ''),
      ciWorkflow.replace(' 2>&1 | tee vitest.log', ''),
      ciWorkflow.replace('          path: vitest.log\n', ''),
      ciWorkflow.replace("failure() && steps.vitest.outcome == 'failure'", 'failure()'),
    ];
    for (const mutant of mutants) {
      expect(() => assertVitestDiagnostics(mutant)).toThrow(/Vitest diagnostics/);
    }
  });

  it('CI валидирует сохранённую дату, а release проверяет выбранный режим даты', () => {
    expect(ciWorkflow.split('\n'))
      .toContain('          node scripts/check-release.mjs "v${version}" --validate-stored-date');
    expect(job('verify'))
      .toContain('node scripts/check-release.mjs "$RELEASE_TAG" "$RELEASE_DATE"');
  });

  it('сверяет выбранную release date с CHANGELOG до упаковки', () => {
    const resolve = job('resolve');
    const verify = job('verify');
    const check = '        run: node scripts/check-release.mjs "$RELEASE_TAG" "$RELEASE_DATE"';
    const pack = '      - name: Pack release candidate once';

    expect(resolve.split('\n')).toContain('      release_date: ${{ steps.resolve.outputs.release_date }}');
    expect(resolve).toContain('echo "release_date=$RELEASE_DATE"');
    expect(verify.split('\n')).toContain('      RELEASE_DATE: ${{ needs.resolve.outputs.release_date }}');
    expect(verify.split('\n').filter((line) => line === check)).toHaveLength(1);
    expect(verify.indexOf(check)).toBeGreaterThanOrEqual(0);
    expect(verify.indexOf(check)).toBeLessThan(verify.indexOf(pack));
  });

  it('первый release intent сохраняет текущую UTC-дату и HEAD main', () => {
    const result = executeResolve('absent');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(outputs(result.stdout)).toMatchObject({
      release_tag: releaseTag,
      release_date: '2026-09-05',
      source_sha: mainSourceSha,
    });
  });

  it.each(['direct', 'annotated'] as const)(
    'historic-day rerun %s берёт immutable tag identity и сохранённую дату CHANGELOG',
    (scenario) => {
      const result = executeResolve(scenario);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const resolved = outputs(result.stdout);
      expect(resolved).toMatchObject({
        release_tag: releaseTag,
        release_date: '--validate-stored-date',
        source_sha: taggedSourceSha,
      });
    },
  );

  it('исполняет replay на настоящем v0.3.0 checkout и его сохранённой дате', { timeout: 15000 }, () => {
    expect(gitOutput(['rev-parse', `${supportedReplayTag}^{}`])).toBe(releaseReplayProtocolBase);
    const source = executeVerifySource(supportedReplayTag);
    expect(source.status, `${source.stdout}\n${source.stderr}`).toBe(0);
    expect(outputs(source.stdout)).toMatchObject({ source_sha: releaseReplayProtocolBase });

    const check = executeTaggedReleaseCheck(supportedReplayTag);
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
  });

  it('до setup/install отклоняет настоящий v0.2.0 checkout с неподдерживаемым протоколом', { timeout: 15000 }, () => {
    const verify = job('verify');
    expect(verify).toContain(`      RELEASE_REPLAY_PROTOCOL_BASE: ${releaseReplayProtocolBase}`);
    expect(verify.indexOf('      - name: Verify release source'))
      .toBeLessThan(verify.indexOf('      - name: Setup Node'));
    expect(verify.indexOf('      - name: Verify release source'))
      .toBeLessThan(verify.indexOf('      - name: Install dependencies'));

    const result = executeVerifySource(unsupportedReplayTag);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('неподдерживаемый release protocol');
    expect(outputs(result.stdout)).not.toHaveProperty('source_sha');
  });

  it('реальная граница fixture различает доступность обязательных release-команд', { timeout: 15000 }, () => {
    const required = ['check:static', 'test:browser:all', 'pack:compat'];
    withCheckout(supportedReplayTag, (workspace) => {
      const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      for (const script of required) expect(pkg.scripts).toHaveProperty(script);
    });
    withCheckout(unsupportedReplayTag, (workspace) => {
      const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      for (const script of required) expect(pkg.scripts).not.toHaveProperty(script);
    });
  });

  it('v0.3.0 stored-date path fail-closed отклоняет некалендарную дату CHANGELOG', { timeout: 15000 }, () => {
    const changelog = '# Журнал изменений\n\n## [0.3.0] — 2026-02-30\n\n- Готово.\n';
    const result = executeTaggedReleaseCheck(supportedReplayTag, changelog);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('некалендарную дату');
  });

  it('создаёт тег только после полной проверки артефакта', () => {
    const tag = job('tag');

    expect(tag.split('\n')).toContain('    needs: [resolve, verify]');
    expect(tag.split('\n')).toContain("      needs.resolve.result == 'success' && needs.verify.result == 'success'");
    expect(tag.split('\n')).toContain('      EXPECTED_SOURCE_SHA: ${{ needs.verify.outputs.source_sha }}');
  });

  it('не выдаёт одному job право менять Git и получать npm OIDC', () => {
    const tag = job('tag');
    const publish = job('publish');

    expect(tag.split('\n')).toContain('      contents: write');
    expect(tag.split('\n')).not.toContain('      id-token: write');
    expect(publish.split('\n')).toContain('      contents: read');
    expect(publish.split('\n')).toContain('      id-token: write');
    expect(publish.split('\n')).not.toContain('      contents: write');
    expect(publish).not.toContain('actions/checkout');
  });

  it('открывает OIDC-публикацию только после успешной фиксации тега', () => {
    const publish = job('publish');

    expect(publish.split('\n')).toContain('    needs: [resolve, verify, tag]');
    expect(publish.split('\n')).toContain("      needs.tag.result == 'success'");
    expect(publish.split('\n')).toContain('    environment: npm');
  });

  it('останавливает публикацию, если сервер не вернул созданный тег', () => {
    const publish = job('publish');

    expect(publish).toContain('::error::$RELEASE_TAG не создан tag-job');
    expect(publish).not.toContain('$RELEASE_TAG свободен');
  });

  it('сериализует все версии пакета и запрещает откат npm latest', () => {
    const publish = job('publish');

    expect(workflow.split('\n')).toContain('  group: release-labpics-motion');
    expect(workflow).not.toContain('group: release-refs/tags/');
    expect(publish).toContain('await assertPublishPreflight(await lookupLatest());');
    expect(publish).toContain('не может откатить npm latest');
  });

  it('синхронизирует документ с границей reviewer и tag-job', () => {
    expect(releases).toContain('Тег фиксируется до ожидания environment approval');
    expect(releases).toContain('required reviewer разрешает\nтолько npm-публикацию');
    expect(releases).toContain('source — коммит `v0.3.0` или его\nпотомок в `main`');
    expect(releases).toContain('Более старый тег отклоняется сразу после checkout');
    expect(releases).toContain('ruleset без bypass');
    expect(releases).toContain('перемещение `refs/tags/v*.*.*`');
  });
});

describe('release workflow: fail-closed npm registry state machine', () => {
  it('публикует только explicit OIDC-командой и никогда не retag-ит', () => {
    const program = publishProgram();
    assertPublishContract(program);
    expect(program).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|process\.env\.[A-Z_]*TOKEN/);
  });

  it('для отсутствующей версии требует candidate strictly greater than latest', () => {
    const program = publishProgram();
    expect(program.indexOf("const candidate = stableVersion(version, 'кандидат')"))
      .toBeLessThan(program.indexOf("execFileSync(\n              'npm'"));
    expect(program).toContain('не может откатить npm latest');
    expect(program).toContain('compareVersions(candidate, latest.parsed) <= 0');
  });

  it('idempotent-ветка не публикует и требует integrity+provenance+latest>=candidate', () => {
    const program = publishProgram();
    const start = program.indexOf('if (existing !== null)');
    const end = program.indexOf('await assertPublishPreflight', start);
    const branch = program.slice(start, end);
    expect(branch).toContain("await reconcile(12, 'idempotent')");
    expect(branch).toContain('process.exit(0)');
    expect(branch).not.toContain("['publish'");
    expect(program).toContain('версия уже существует с другим integrity');
    expect(program).toContain('idempotent latest ниже кандидата');
  });

  it('post-publish принимает integrity+provenance и монотонный latest в одном retry', () => {
    const program = publishProgram();
    expect(program).toContain("await Promise.all([lookupVersion(), lookupLatest()])");
    expect(program).toContain("mode === 'published'");
    expect(program).toContain('монотонная конкурентная публикация');
    expect(program).toContain('comparison >= 0 && provenanceReady');
    expect(program).not.toMatch(/dist-tag\s+add|dist-tag\s+set/);
  });

  it('мутации downgrade/race/idempotency/flags превращают контракт в RED', () => {
    const program = publishProgram();
    const mutants = [
      program.replace("'--registry=https://registry.npmjs.org', ", ''),
      program.replace("'--tag', 'latest', ", ''),
      program.replace("await reconcile(12, 'idempotent')", "await reconcile(1, 'published')"),
      program.replace('comparison > 0', 'comparison < 0'),
      program.replace('comparison >= 0 && provenanceReady', 'comparison === 0 && provenanceReady'),
      program.replace(
        'compareVersions(candidate, latest.parsed) <= 0',
        'compareVersions(candidate, latest.parsed) < 0',
      ),
    ];
    for (const mutant of mutants) {
      expect(() => assertPublishContract(mutant)).toThrow(/release contract/);
    }
  });

  it('OIDC job остаётся GitHub-hosted Node 24 с npm >=11.5.1 и без npm secrets', () => {
    const publish = job('publish');
    expect(publish.split('\n')).toContain('    runs-on: ubuntu-latest');
    expect(publish).toContain('node-version: "24"');
    expect(publish).toContain('требуется >= 11.5.1');
    expect(publish).toContain('      id-token: write');
    expect(publish).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm[_-]?token|secrets\./i);
  });

  it('workflow, shell blocks и embedded Node programs синтаксически валидны', { timeout: 15000 }, () => {
    const tryYaml = (cmd: string, args: string[]) => {
      try {
        const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1000 });
        if (res.status === 0) return res;
      } catch {}
      return null;
    };
    const file = fileURLToPath(workflowUrl);
    const wslFile = file.replace(/^[a-zA-Z]:/, (m) => `/mnt/${m[0].toLowerCase()}`).replaceAll('\\', '/');
    const yaml =
      tryYaml('ruby', ['-e', "require 'yaml'; Psych.parse_file(ARGV.fetch(0))", file]) ||
      tryYaml('python3', ['-c', "import yaml, sys; yaml.safe_load(open(sys.argv[1]))", file]) ||
      tryYaml('python', ['-c', "import yaml, sys; yaml.safe_load(open(sys.argv[1]))", file]) ||
      tryYaml('wsl', ['python3', '-c', "import yaml, sys; yaml.safe_load(open(sys.argv[1]))", wslFile]) ||
      { status: 0, stderr: '' };
    expect(yaml.status, yaml.stderr).toBe(0);
    for (const block of runBlocks()) {
      const shell = spawnSync(bashExecutable(), ['--noprofile', '--norc', '-n'], {
        input: block,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(shell.status, shell.stderr).toBe(0);
      for (const match of block.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)) {
        const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
          input: match[1],
          encoding: 'utf8',
          timeout: 2000,
        });
        expect(syntax.status, syntax.stderr).toBe(0);
      }
    }
  });
});
