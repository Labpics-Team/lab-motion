import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replace(
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
    expect(publish).toContain('await assertMonotonicLatest();');
    expect(publish).toContain('не может его откатить');
  });

  it('синхронизирует документ с границей reviewer и tag-job', () => {
    expect(releases).toContain('Тег фиксируется до ожидания environment approval');
    expect(releases).toContain('required reviewer разрешает\nтолько npm-публикацию');
    expect(releases).toContain('ruleset без bypass');
    expect(releases).toContain('перемещение `refs/tags/v*.*.*`');
  });
});
