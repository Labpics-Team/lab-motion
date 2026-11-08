import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const limitBytes = 10 * 1024 * 1024;
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Укажите каталог evidence и новый каталог upload.');
const input = resolve(source), output = resolve(destination);
mkdirSync(output);
let files = [], bytesSeen = 0;
try {
  const collect = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { collect(path); continue; }
      if (!entry.isFile()) throw new Error('Evidence содержит не обычный файл.');
      if (bytesSeen + statSync(path).size > limitBytes) throw new Error('Evidence превышает 10 MiB после teardown.');
      const data = readFileSync(path);
      bytesSeen += data.length;
      if (bytesSeen > limitBytes) throw new Error('Evidence изменился и превысил 10 MiB.');
      files.push([relative(input, path), data]);
    }
  };
  collect(input);
  if (!files.length) throw new Error('Каталог evidence пуст.');
} catch (error) {
  files = [['preparation.json', Buffer.from(JSON.stringify({ passed: false, kind: 'artifact-preparation',
    error: error.message.slice(0, 500), limitBytes, bytesSeen }, null, 2) + '\n')]];
  process.exitCode = 1;
}
// Загружаются прочитанные байты: поздняя запись в исходник не расширяет архив.
for (const [name, data] of files) {
  const path = join(output, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
console.log(JSON.stringify({ prepared: !process.exitCode, uploadBytes: files.reduce((sum, [, data]) => sum + data.length, 0) }));
