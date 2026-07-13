import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const workflow = readFileSync(workflowUrl, 'utf8').replace(
  /\r\n?/g,
  '\n',
);
const releases = readFileSync(new URL('../docs/RELEASES.md', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

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

  it('workflow, shell blocks и embedded Node programs синтаксически валидны', () => {
    const yaml = spawnSync(
      'ruby',
      ['-e', "require 'yaml'; Psych.parse_file(ARGV.fetch(0))", fileURLToPath(workflowUrl)],
      { encoding: 'utf8' },
    );
    expect(yaml.status, yaml.stderr).toBe(0);
    for (const block of runBlocks()) {
      const shell = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
      expect(shell.status, shell.stderr).toBe(0);
      for (const match of block.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/g)) {
        const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
          input: match[1],
          encoding: 'utf8',
        });
        expect(syntax.status, syntax.stderr).toBe(0);
      }
    }
  });
});
