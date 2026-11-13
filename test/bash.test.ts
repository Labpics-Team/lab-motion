import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashExecutable } from './helpers/bash.js';

describe('Bash для workflow', () => {
  it('сохраняет stdin, cwd, окружение, вывод и код завершения единственного запуска', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'motion workflow bash '));
    try {
      const env = { ...process.env, WORKFLOW_VALUE: 'value with spaces', WORKFLOW_CWD: cwd.replaceAll('\\', '/') };
      const original = { ...env };
      const result = spawnSync(bashExecutable(env), ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `
[[ "$PWD" -ef "$WORKFLOW_CWD" ]]
printf 'once\n' >> calls.txt
bash --noprofile --norc -c 'cat; printf "%s\\n" "$WORKFLOW_VALUE"; printf "diagnostic\\n" >&2; exit 17'
`], { cwd, env, input: 'input with spaces\n', encoding: 'utf8', timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(17);
      expect(result.stdout).toBe('input with spaces\nvalue with spaces\n');
      expect(result.stderr).toBe('diagnostic\n');
      expect(readFileSync(join(cwd, 'calls.txt'), 'utf8')).toBe('once\n');
      expect(env).toEqual(original);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'win32')('запускает runtime выбранного Git в пути с пробелами и сохраняет явный override', () => {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000 });
    expect(git.status, git.stderr).toBe(0);
    const installed = resolve(git.stdout.trim(), '../../..');
    const runtime = relative(installed, resolve(git.stdout.trim(), '../../bin'));
    const temp = mkdtempSync(join(tmpdir(), 'motion portable Git '));
    const relocated = join(temp, 'Git installation with spaces');
    const shadow = join(temp, 'incompatible Bash');
    try {
      // Переносим настоящие команды этого сценария и DLL их runtime без остальных tools Git.
      for (const directory of ['bin', 'cmd', 'usr/bin', runtime]) {
        mkdirSync(join(relocated, directory), { recursive: true });
        for (const entry of readdirSync(join(installed, directory), { withFileTypes: true })) {
          if (!entry.isFile() || !/^(?:bash|sh|cat|cygpath|git)\.exe$|\.dll$/i.test(entry.name)) continue;
          const from = join(installed, directory, entry.name);
          const to = join(relocated, directory, entry.name);
          copyFileSync(from, to);
        }
      }
      mkdirSync(shadow);
      copyFileSync(join(installed, 'cmd/git.exe'), join(shadow, 'bash.exe'));
      const env = { ...process.env, PATH: `${shadow};${join(relocated, 'cmd')};${process.env.PATH}`,
        ProgramFiles: join(temp, 'absent ProgramFiles'), GIT_BASH_PATH: undefined };
      const run = (environment: NodeJS.ProcessEnv) => spawnSync(bashExecutable(environment),
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', "bash --noprofile --norc -c 'cat; cygpath -w /'"],
        { env: environment, input: 'nested utility\n', encoding: 'utf8', timeout: 5000 });
      for (const environment of [env, { ...process.env, GIT_BASH_PATH: join(relocated, 'bin/bash.exe') }]) {
        const result = run(environment);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const [input, root] = result.stdout.trim().split('\n');
        expect(input).toBe('nested utility');
        expect(resolve(root!)).toBe(relocated);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
