import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = dirname(fileURLToPath(import.meta.url));
const root = resolve(app, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'motion-reading-shelf-'));
const installed = join(app, 'node_modules', '@labpics', 'motion');
const receiptPath = join(app, '.artifacts', 'package.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const args = process.platform === 'win32' ? [npmCli] : [];
  if (process.platform === 'win32' && !existsSync(npmCli)) throw new Error('Не найден npm CLI рядом с Node.js');
  const [packed] = JSON.parse(execFileSync(command,
    [...args, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8', timeout: 120_000 }));
  if (!packed?.filename) throw new Error('npm pack не вернул имя архива');
  const archive = join(temporary, packed.filename);
  const bytes = readFileSync(archive);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.3.0') throw new Error('Версия примера не совпадает с корневым пакетом');
  rmSync(installed, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', installed, '--strip-components=1'], { timeout: 120_000 });
  const installedManifest = readFileSync(join(installed, 'package.json'));
  if (!installedManifest.equals(readFileSync(join(root, 'package.json')))) {
    throw new Error('Установленный манифест не совпадает с архивом');
  }
  const installedPackage = JSON.parse(installedManifest.toString('utf8'));
  const exportPaths = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(exportPaths);
  const paths = exportPaths(installedPackage.exports);
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('./') || !existsSync(join(installed, path))) {
      throw new Error(`Не найден экспорт в архиве: ${path}`);
    }
  }
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'],
    { cwd: root, encoding: 'utf8' }).trim().length > 0, archiveSha256: hash(bytes),
    manifestSha256: hash(installedManifest), package: manifest.name, version: manifest.version }, null, 2) + '\n');
  process.stdout.write(`Полка: установлен архив ${hash(bytes)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
