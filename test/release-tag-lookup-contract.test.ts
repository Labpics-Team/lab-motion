import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');
const releases = readFileSync(new URL('../docs/RELEASES.md', import.meta.url), 'utf8')
  .replace(/\r\n?/g, '\n');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const releaseTag = `v${pkg.version}`;

type ResolveScenario =
  | 'absent'
  | 'direct'
  | 'annotated'
  | 'api-401'
  | 'api-403'
  | 'api-500'
  | 'network';

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

function resolveRun(): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === '      - name: Resolve and validate version');
  if (start === -1) throw new Error('resolve step отсутствует');
  const next = lines.slice(start + 1).findIndex((line) => /^      - name: /.test(line));
  const end = next === -1 ? lines.length : start + 1 + next;
  const step = lines.slice(start, end);
  const run = step.findIndex((line) => line === '        run: |');
  if (run === -1) throw new Error('resolve run отсутствует');
  return step.slice(run + 1)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

const resolve = resolveRun();

function executeResolve(scenario: ResolveScenario) {
  const script = `
GITHUB_OUTPUT=$(mktemp)
trap 'rm -f "$GITHUB_OUTPUT"' EXIT
export GITHUB_OUTPUT
gh() {
  [[ "$1" == "api" ]] || return 90
  if [[ "$2" == "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$EXPECTED_TAG" ]]; then
    case "$GH_SCENARIO" in
      absent) return 0 ;;
      direct) printf 'commit\\t%s\\n' "$TAGGED_SOURCE_SHA"; return 0 ;;
      annotated) printf 'tag\\tannotated-object\\n'; return 0 ;;
      api-401|api-403|api-500|network)
        printf 'forced tag lookup failure: %s\\n' "$GH_SCENARIO" >&2
        return 1
        ;;
      *) return 91 ;;
    esac
  fi
  if [[ "$GH_SCENARIO" == "annotated" && "$2" == "repos/$GITHUB_REPOSITORY/git/tags/annotated-object" ]]; then
    printf 'commit\\t%s\\n' "$TAGGED_SOURCE_SHA"
    return 0
  fi
  return 91
}
date() {
  [[ "$DATE_ALLOWED" == "1" ]] || { echo 'unexpected wall-clock read' >&2; return 92; }
  [[ "$1" == "-u" && "$2" == "+%F" ]] || return 93
  printf '2026-09-07\\n'
}
${resolve}
cat "$GITHUB_OUTPUT"
`;

  return spawnSync(
    bashExecutable(),
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATE_ALLOWED: scenario === 'absent' ? '1' : '0',
        GH_SCENARIO: scenario,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'Labpics-Team/lab-motion',
        GITHUB_SHA: 'main-source-sha',
        EXPECTED_TAG: releaseTag,
        INPUT_VERSION: pkg.version,
        TAGGED_SOURCE_SHA: 'tagged-source-sha',
      },
    },
  );
}

function outputs(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout.split(/\r?\n/)
      .filter((line) => /^[a-z_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('release resolve: существование тега fail-closed', () => {
  it('использует matching-refs без подавления ошибок API', () => {
    expect(resolve).toContain('git/matching-refs/tags/$RELEASE_TAG');
    expect(resolve).not.toContain('git/ref/tags/$RELEASE_TAG"');
    expect(resolve).not.toContain('2>/dev/null || true');
    expect(resolve).toContain('не удалось проверить существование $RELEASE_TAG');
  });

  it('подтверждённое отсутствие тега создаёт новый release intent', () => {
    const result = executeResolve('absent');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(outputs(result.stdout)).toMatchObject({
      release_date: '2026-09-07',
      source_sha: 'main-source-sha',
    });
  });

  it.each(['direct', 'annotated'] as const)(
    'существующий %s tag переиспользует tagged source без wall clock',
    (scenario) => {
      const result = executeResolve(scenario);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(outputs(result.stdout)).toMatchObject({
        release_date: '--validate-stored-date',
        source_sha: 'tagged-source-sha',
      });
    },
  );

  it.each(['api-401', 'api-403', 'api-500', 'network'] as const)(
    '%s не маскируется под отсутствие тега',
    (scenario) => {
      const result = executeResolve(scenario);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`forced tag lookup failure: ${scenario}`);
      expect(result.stderr).toContain('не удалось проверить существование');
      expect(outputs(result.stdout)).not.toHaveProperty('source_sha');
      expect(outputs(result.stdout)).not.toHaveProperty('release_date');
    },
  );

  it('release guide объявляет Diátaxis-роль и источник stored date', () => {
    expect(releases).toContain('> Роль: практическое руководство');
    expect(releases).toContain('дату секции этой версии в `CHANGELOG.md`');
    expect(releases).not.toContain('сохранённую в теге дату');
  });
});
