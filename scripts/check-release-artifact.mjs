import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateArchiveMetadata } from './release-metadata.mjs';

const [tarballArgument, tag, sourceSha, manifestArgument, rootPackageArgument] = process.argv.slice(2);

function fail(message) {
  console.error(`release-artifact-check: ${message}`);
  process.exit(1);
}

if (!tarballArgument || !tag || !sourceSha || !manifestArgument) {
  fail('ожидаются аргументы: <tgz> <tag> <source-sha> <manifest.json>');
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`некорректный релизный тег: ${tag}`);
if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail(`некорректный source SHA: ${sourceSha}`);

const tarball = resolve(tarballArgument);
const manifestPath = resolve(manifestArgument);
let archivePackage;
try {
  // Читаем метаданные из самого tgz, чтобы манифест описывал байты артефакта,
  // а не рабочее дерево, из которого он был собран.
  archivePackage = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  fail(`не удалось прочитать package/package.json из tgz: ${error?.message ?? String(error)}`);
}

let rootPackage;
try {
  rootPackage = JSON.parse(readFileSync(
    rootPackageArgument ? resolve(rootPackageArgument) : new URL('../package.json', import.meta.url),
    'utf8',
  ));
  validateArchiveMetadata(rootPackage, archivePackage);
} catch (error) {
  fail(error?.message ?? String(error));
}

if (archivePackage.version !== tag.slice(1)) {
  fail(`версия tgz ${String(archivePackage.version)} не совпадает с тегом ${tag}`);
}

const tarballName = basename(tarball);
const expectedName = `labpics-motion-${archivePackage.version}.tgz`;
if (tarballName !== expectedName) {
  fail(`имя tgz ${tarballName} не совпадает с ожидаемым ${expectedName}`);
}

const tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
const packageIdentity = `${archivePackage.name}@${archivePackage.version}`;
const manifest = {
  schema: 1,
  package: {
    name: archivePackage.name,
    version: archivePackage.version,
    identity: packageIdentity,
    repository: archivePackage.repository.url,
  },
  release: {
    tag,
    sourceSha,
  },
  artifact: {
    file: tarballName,
    sha256: tarballSha256,
  },
};

try {
  // `wx` делает seal одноразовым: повтор не может незаметно заменить ранее
  // проверенную идентичность артефакта.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
} catch (error) {
  fail(`не удалось атомарно создать release-манифест: ${error?.message ?? String(error)}`);
}

// stdout имеет формат GITHUB_OUTPUT; диагностические сообщения идут в stderr.
console.log(`tarball_name=${tarballName}`);
console.log(`tarball_sha256=${tarballSha256}`);
console.log(`package_identity=${packageIdentity}`);
