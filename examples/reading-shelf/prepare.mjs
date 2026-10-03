import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const destination = process.platform === 'win32' ? `"${temporary}"` : temporary;
  const [packed] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 }));
  if (!packed?.filename) throw new Error('npm pack не вернул имя архива');
  const archive = join(temporary, packed.filename);
  const bytes = readFileSync(archive);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.3.0') throw new Error('Версия примера не совпадает с корневым пакетом');
  rmSync(installed, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', installed, '--strip-components=1'], { timeout: 120_000 });
  const installedManifest = readFileSync(join(installed, 'package.json'));
  if (!installedManifest.equals(readFileSync(join(root, 'package.json')))) {
    throw new Error('Установленный манифест не совпадает с архивом');
  }
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8' }).trim(), archiveSha256: hash(bytes),
    manifestSha256: hash(installedManifest), package: manifest.name, version: manifest.version }, null, 2) + '\n');
  process.stdout.write(`Полка: установлен архив ${hash(bytes)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
