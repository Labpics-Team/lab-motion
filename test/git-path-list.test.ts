import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listChangedGitPaths,
  parseNulDelimitedGitPaths,
} from '../scripts/git-path-list.mjs';

const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('NUL-delimited git path list', () => {
  it('preserves Unicode, quotes and newlines without Git quotePath decoding', () => {
    expect(parseNulDelimitedGitPaths(
      'docs/бенчмарк.md\0docs/"quote".md\0docs/line\nbreak.md\0',
    )).toEqual([
      'docs/бенчмарк.md',
      'docs/"quote".md',
      'docs/line\nbreak.md',
    ]);
  });

  it('accepts an empty diff and rejects truncated or ambiguous output', () => {
    expect(parseNulDelimitedGitPaths('')).toEqual([]);
    expect(() => parseNulDelimitedGitPaths('docs/file.md')).toThrow(/NUL/i);
    expect(() => parseNulDelimitedGitPaths('docs/a.md\0\0')).toThrow(/пуст/i);
  });

  it('returns the original Unicode path when Git quotePath is enabled', () => {
    const repository = mkdtempSync(join(tmpdir(), 'lab-motion-git-paths-'));
    temporaryRepositories.push(repository);
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.quotePath', 'true');
    writeFileSync(join(repository, 'base.txt'), 'base\n');
    git('add', 'base.txt');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');

    mkdirSync(join(repository, 'docs'));
    writeFileSync(join(repository, 'docs', 'бенчмарк.md'), 'данные\n');
    git('add', 'docs/бенчмарк.md');
    git('commit', '--quiet', '-m', 'unicode');

    expect(listChangedGitPaths(repository, `${base}..HEAD`)).toEqual([
      'docs/бенчмарк.md',
    ]);
  });
});
