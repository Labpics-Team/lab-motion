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
// Единственное чтение байтов артефакта: и проверка, и хеш в манифесте идут
// от ОДНОГО буфера, иначе между «что проверили» и «что запечатали» остаётся
// окно, в которое файл можно подменить.
let artifactBytes;
try {
  artifactBytes = readFileSync(tarball);
} catch (error) {
  fail(`не удалось прочитать артефакт ${tarball}: ${error?.message ?? String(error)}`);
}

// gzip-магию проверяем сами: bsdtar в режиме извлечения игнорирует -z и
// спокойно читает несжатый tar, тогда как GNU tar его отвергает. Без явной
// проверки строгость гейта зависела бы от того, какой tar первым в PATH.
if (artifactBytes[0] !== 0x1f || artifactBytes[1] !== 0x8b) {
  fail(`артефакт ${basename(tarball)} не является gzip-архивом`);
}

// Верификатор и потребитель обязаны выбирать ОДИН И ТОТ ЖЕ член архива. tar
// берёт запись по точному имени, а npm срезает первый компонент пути у всех
// записей и оставляет ПОСЛЕДНЮЮ совпавшую. Расхождение воспроизводимо: архив
// с package/package.json и zzz/package.json проходит проверку по первому, а
// устанавливается по второму. Требуем ровно одну запись, дающую package.json
// после среза, и чтобы это был канонический package/package.json.
//
// Сравниваем НОРМАЛИЗОВАННЫЕ сегменты: npm нормализует путь записи, поэтому
// package/./package.json для него неотличим от package/package.json, а наивный
// пословный фильтр эту запись пропускал (обход, найден ревью). Пустые сегменты
// («//») схлопываем, «..» — безусловный отказ: путь, выходящий вверх, не бывает
// легитимным членом npm-архива.
const normalizedTail = (member) => {
  const segments = member.split('/').filter((part) => part !== '' && part !== '.');
  if (segments.includes('..')) return '..';
  return segments.slice(1).join('/');
};
try {
  const members = execFileSync('tar', ['-tzf', '-'], {
    input: artifactBytes,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (members.some((member) => normalizedTail(member) === '..')) {
    fail('в tgz есть запись с «..» в пути — архив отвергнут целиком');
  }
  const manifestMembers = members.filter((member) => normalizedTail(member) === 'package.json');
  if (manifestMembers.length !== 1) {
    fail(`в tgz ${manifestMembers.length} записей читаются как package.json: ${manifestMembers.join(', ')}`);
  }
  if (manifestMembers[0] !== 'package/package.json') {
    fail(`манифест лежит в ${manifestMembers[0]}, а не в package/package.json`);
  }
} catch (error) {
  fail(`не удалось перечислить содержимое tgz: ${error?.message ?? String(error)}`);
}

let archivePackage;
try {
  // Читаем метаданные из самого tgz, чтобы манифест описывал байты артефакта,
  // а не рабочее дерево, из которого он был собран.
  archivePackage = JSON.parse(
    // Байты подаём на stdin: тогда tar не разбирает путь вообще, и класс
    // закрыт целиком — ни ведущее «C:» windows-пути (GNU tar принимает его за
    // спецификацию удалённого хоста), ни двоеточие в имени, ни путь длиннее
    // MAX_PATH (такой нельзя выставить рабочим каталогом процесса) больше ни
    // на что не влияют. Флаг -z нужен GNU tar: на stdin он сжатие не угадывает.
    execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
      input: artifactBytes,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
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

const tarballSha256 = createHash('sha256').update(artifactBytes).digest('hex');
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
