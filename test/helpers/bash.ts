import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function bashExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return 'bash';
  const explicit = env.GIT_BASH_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const git = spawnSync('git', ['var', 'GIT_SHELL_PATH'], { env, encoding: 'utf8', timeout: 5000 });
  if (git.error || git.status !== 0 || !git.stdout.trim()) {
    throw new Error(`Не удалось найти shell установленного Git: ${git.error?.message ?? git.stderr}`);
  }
  // Git сообщает <root>/usr/bin/sh.exe. Официальный <root>/bin/bash.exe
  // launcher готовит runtime PATH для внешних команд и вложенного Bash.
  const executable = resolve(dirname(git.stdout.trim()), '../../bin/bash.exe');
  if (!existsSync(executable)) throw new Error(`Git Bash отсутствует: ${executable}`);
  return executable;
}
