import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Версия принадлежит package.json; установщик не меняет общий Node/toolcache.
export function setupPnpm(manifestPath = 'package.json', env = process.env, execute = execFileSync) {
  const { packageManager } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pin = typeof packageManager === 'string' && /^pnpm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(packageManager);
  if (!pin) throw new Error('packageManager должен задавать точную версию pnpm@x.y.z');
  for (const key of ['RUNNER_TEMP', 'GITHUB_PATH']) {
    if (!env[key] || !isAbsolute(env[key]) || /[\r\n]/.test(env[key])) {
      throw new Error(`${key} должен задавать абсолютный путь задания без перевода строки`);
    }
  }

  const prefix = mkdtempSync(join(env.RUNNER_TEMP, 'pnpm-'));
  const bin = join(prefix, 'bin');
  const options = { cwd: prefix, env };
  execute('npm', ['install', '--global', '--prefix', prefix, '--cache', join(prefix, 'cache'),
    '--ignore-scripts', '--no-audit', '--no-fund', packageManager], { ...options, stdio: 'inherit' });
  const version = execute(join(bin, 'pnpm'), ['--version'], { ...options, encoding: 'utf8' }).trim();
  if (version !== pin[1]) throw new Error(`Ожидался pnpm ${pin[1]}, установлен ${version}`);
  // PATH публикуется только после успешной установки и проверки самого CLI.
  appendFileSync(env.GITHUB_PATH, `${bin}\n`);
  return { version, prefix, bin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Ожидался только путь к package.json');
  setupPnpm(process.argv[2]);
}
