import { execFileSync } from 'node:child_process';

/**
 * `git -z` сохраняет имя пути без quotePath-экранирования и не путает перевод
 * строки внутри имени с разделителем списка.
 */
export function parseNulDelimitedGitPaths(raw) {
  if (typeof raw !== 'string') throw new TypeError('git path list: ожидалась строка');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\0')) throw new Error('git path list: вывод оборван до NUL-разделителя');

  const paths = raw.slice(0, -1).split('\0');
  if (paths.some((file) => file.length === 0)) {
    throw new Error('git path list: пустое имя пути');
  }
  return paths;
}

export function listChangedGitPaths(root, range) {
  const raw = execFileSync(
    'git',
    ['diff', '--name-only', '-z', '--end-of-options', range, '--'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return parseNulDelimitedGitPaths(raw);
}
