import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n',
);
const sourceSha = 'a'.repeat(40);
const workspaces: string[] = [];

function job(name: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`job ${name} отсутствует`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^  [a-z][a-z0-9-]*:$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end);
}

function runScript(jobName: string, stepName: string): string {
  const lines = job(jobName);
  const step = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (step === -1) throw new Error(`step ${stepName} отсутствует`);
  const relativeStepEnd = lines
    .slice(step + 1)
    .findIndex((line) => /^      - /.test(line));
  const stepEnd = relativeStepEnd === -1 ? lines.length : step + 1 + relativeStepEnd;
  if (!lines.slice(step + 1, stepEnd).includes('        shell: bash')) {
    throw new Error(`step ${stepName} обязан фиксировать shell: bash`);
  }
  const run = lines.slice(step + 1, stepEnd).findIndex((line) => line === '        run: |');
  if (run === -1) throw new Error(`step ${stepName} не содержит run`);
  const bodyStart = step + 1 + run + 1;
  return lines
    .slice(bodyStart, stepEnd)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function mockGh(directory: string): void {
  const executable = join(directory, 'gh');
  writeFileSync(
    executable,
    `#!${process.execPath}
const scenario = process.env.GH_SCENARIO;
const expected = process.env.EXPECTED_SOURCE_SHA;
const args = process.argv.slice(2);
const endpoint = args[1] ?? '';
const target = (type, sha) => process.stdout.write(\`${'${type}'}\\t${'${sha}'}\\n\`);
const has = (value) => args.includes(value);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const repository = 'repos/Labpics-Team/lab-motion';
const refLookupJq = '(.data.repository.ref.target // empty) | [.__typename, .oid] | @tsv';
const objectJq = '[.object.type, .object.sha] | @tsv';

if (args[0] !== 'api') process.exit(90);
if (args.includes('graphql')) {
  const validLookup = option('--jq') === refLookupJq && has('owner=Labpics-Team') && has('name=lab-motion') &&
    has('qualifiedName=refs/tags/v9.8.7') &&
    args.some((value) => value.startsWith('query=') && value.includes('ref(qualifiedName: $qualifiedName)'));
  if (!validLookup) process.exit(92);
  if (scenario === 'lookup-failure') process.exit(45);
  if (['absent-create', 'concurrent-correct', 'reread-wrong', 'reread-empty', 'reread-failure'].includes(scenario)) process.exit(0);
  if (scenario === 'existing-wrong') target('Commit', 'b'.repeat(40));
  else if (scenario === 'invalid-type') target('Tree', 'tree-object');
  else if (['annotated-correct', 'annotated-wrong', 'deep-chain'].includes(scenario)) target('Tag', 'annotated-object');
  else target('Commit', expected);
  process.exit(0);
}
if (endpoint === \`${'${repository}'}/git/refs\`) {
  if (!has('ref=refs/tags/v9.8.7') || !has(\`sha=${'${expected}'}\`)) process.exit(93);
  if (scenario === 'concurrent-correct') process.exit(1);
  process.stdout.write('{}\\n');
  process.exit(0);
}
if (endpoint === \`${'${repository}'}/git/ref/tags/v9.8.7\`) {
  if (option('--jq') !== objectJq) process.exit(94);
  if (scenario === 'reread-failure') process.exit(46);
  if (scenario === 'reread-empty') process.exit(0);
  target('commit', scenario === 'reread-wrong' ? 'b'.repeat(40) : expected);
  process.exit(0);
}
if (endpoint === \`${'${repository}'}/git/tags/annotated-object\`) {
  if (option('--jq') !== objectJq) process.exit(95);
  if (scenario === 'deep-chain') target('tag', 'annotated-object');
  else target('commit', scenario === 'annotated-wrong' ? 'b'.repeat(40) : expected);
  process.exit(0);
}
process.exit(91);
`,
  );
  chmodSync(executable, 0o755);
}

function execute(script: string, scenario: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'labmotion-release-tag-'));
  workspaces.push(workspace);
  mockGh(workspace);
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${workspace}:${process.env.PATH ?? ''}`,
      GH_SCENARIO: scenario,
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'Labpics-Team/lab-motion',
      RELEASE_TAG: 'v9.8.7',
      EXPECTED_SOURCE_SHA: sourceSha,
    },
  });
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

const describeBash = process.platform === 'win32' ? describe.skip : describe;

describeBash('release workflow: Git-tag state machine', () => {
  const create = runScript('tag', 'Create or verify tag idempotently');
  const verify = runScript('publish', 'Verify locked release tag binding');

  it.each(['absent-create', 'concurrent-correct', 'existing-correct', 'annotated-correct'])(
    'tag-job принимает безопасный исход %s',
    (scenario) => {
      const result = execute(create, scenario);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('v9.8.7 зафиксирован на проверенном коммите');
    },
  );

  it.each([
    'existing-wrong',
    'lookup-failure',
    'reread-wrong',
    'reread-empty',
    'reread-failure',
    'annotated-wrong',
    'invalid-type',
    'deep-chain',
  ])(
    'tag-job fail-closed для %s',
    (scenario) => {
      const result = execute(create, scenario);
      expect(result.status).not.toBe(0);
    },
  );

  it.each(['existing-correct', 'annotated-correct'])(
    'publish-job принимает точный тег %s',
    (scenario) => {
      const result = execute(verify, scenario);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('v9.8.7 уже указывает на проверенный коммит');
    },
  );

  it.each(['absent-create', 'existing-wrong', 'lookup-failure', 'annotated-wrong', 'invalid-type', 'deep-chain'])(
    'publish-job fail-closed для %s',
    (scenario) => {
      const result = execute(verify, scenario);
      expect(result.status).not.toBe(0);
    },
  );
});
