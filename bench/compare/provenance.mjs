/**
 * Единый контур происхождения сравнительных бенчмарков.
 *
 * Стенд обязан измерять байты текущего checkout, а не случайно оставшийся dist.
 * Поэтому подготовка всегда сначала пересобирает пакет, затем фиксирует точные
 * отпечатки исходного дерева, lock/package-файлов и runtime-файлов dist.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const RUNTIME_FILE = /\.(?:c?js|mjs)$/;

function publishedRuntimeFiles(packageMetadata) {
  const files = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./dist/') && RUNTIME_FILE.test(value)) files.add(value.slice(2));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(packageMetadata.exports);
  return files;
}

function localRuntimeImports(root, entry) {
  const source = readFileSync(entry, 'utf8');
  const specifiers = new Set();
  const patterns = [
    /\b(?:import\s+(?:[^'\"]*?\s+from\s+)?|export\s+[^'\"]*?\s+from\s+)['\"]([^'\"\r\n]+)['\"]/g,
    /\bimport\s*\(\s*['\"]([^'\"\r\n]+)['\"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  const imports = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue;
    const absolute = path.resolve(path.dirname(entry), specifier);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (!relative.startsWith('dist/') || !RUNTIME_FILE.test(relative)) continue;
    imports.push(relative);
  }
  return imports;
}

/**
 * Бенч не может объявить артефактом или импортировать удалённый публичный вход.
 * Проверка идёт до дорогой сборки/браузера и выводится из package.exports —
 * отдельного списка существующих subpath здесь нет.
 */
export function assertBenchmarkExportSurface({
  root,
  requiredDist = [],
  requiredEntries = [],
}) {
  const packageMetadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const published = publishedRuntimeFiles(packageMetadata);
  const required = new Set();
  for (const declared of requiredDist) {
    const relative = declared.replace(/^\.\//, '').split(path.sep).join('/');
    if (!published.has(relative)) {
      throw new Error(`provenance: requiredDist ${declared} не соответствует package export`);
    }
    required.add(relative);
  }
  for (const [label, entry] of requiredEntries) {
    if (!existsSync(entry)) throw new Error(`provenance: benchmark entry отсутствует: ${entry}`);
    for (const relative of localRuntimeImports(root, entry)) {
      if (!published.has(relative)) {
        throw new Error(`provenance: ${label} ссылается на отсутствующий package export ${relative}`);
      }
      if (!required.has(relative)) {
        throw new Error(`provenance: ${label} импортирует ${relative}, не закреплённый в requiredDist`);
      }
    }
  }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function filesBelow(directory, accept = () => true) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if ((entry.isFile() || entry.isSymbolicLink()) && accept(absolute)) out.push(absolute);
    }
  };
  visit(directory);
  return out.sort();
}

/** Детерминированный отпечаток дерева: путь и хеш каждого файла входят в итог. */
export function hashFileTree(directory, accept = () => true) {
  if (!existsSync(directory)) throw new Error(`provenance: каталог не найден: ${directory}`);
  const files = filesBelow(directory, accept);
  if (files.length === 0) throw new Error(`provenance: в каталоге нет измеряемых файлов: ${directory}`);
  const manifest = files.map((file) => lstatSync(file).isSymbolicLink()
    ? {
        path: path.relative(directory, file).split(path.sep).join('/'),
        type: 'symlink',
        target: readlinkSync(file),
      }
    : {
        path: path.relative(directory, file).split(path.sep).join('/'),
        type: 'file',
        sha256: sha256File(file),
      });
  return {
    sha256: sha256Bytes(Buffer.from(JSON.stringify(manifest))),
    files: manifest.length,
  };
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding });
}

/** Отпечаток всех tracked/untracked, но не ignored файлов checkout. */
function worktreeFingerprint(root) {
  const raw = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 'buffer');
  const names = raw.toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Тот же fingerprint для clean Git-коммита: dirty:false становится проверяемым фактом. */
export function revisionFingerprint(root, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('provenance: некорректный revision');
  const raw = git(root, ['ls-tree', '-r', '-z', '--name-only', revision], 'buffer');
  const names = raw.toString('utf8').split('\0').filter(Boolean).sort();
  if (names.length === 0) throw new Error('provenance: revision не содержит файлов');
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(git(root, ['show', `${revision}:${name}`], 'buffer'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function readCheckoutState(root) {
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  const shortRevision = git(root, ['rev-parse', '--short=12', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirty = status.trim().length > 0;
  return {
    revision,
    shortRevision,
    revisionLabel: `${shortRevision}${dirty ? '-dirty' : ''}`,
    dirty,
    worktreeSha256: worktreeFingerprint(root),
  };
}

function installedPnpmVersion() {
  return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
}

const EXACT_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/** Единый контракт точной версии для фиксации и проверки происхождения. */
export function isExactPackageVersion(version) {
  return typeof version === 'string' && EXACT_PACKAGE_VERSION.test(version);
}

function captureInstalledPackages(baseDirectory, packageJson, requiredPackages, owner) {
  const packages = {};
  for (const name of requiredPackages) {
    const expected = packageJson.devDependencies?.[name] ?? packageJson.dependencies?.[name];
    if (!isExactPackageVersion(expected)) {
      throw new Error(`provenance: ${name} должен иметь точную версию в ${owner} package.json`);
    }
    let packageDirectory;
    try {
      packageDirectory = realpathSync(path.join(baseDirectory, 'node_modules', name));
    } catch {
      throw new Error(`provenance: ${name}@${expected} не установлен в ${owner} node_modules`);
    }
    const installed = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    if (installed.version !== expected) {
      throw new Error(`provenance: ${name}: ожидалась ${expected}, установлена ${installed.version}`);
    }
    packages[name] = { version: installed.version, ...hashFileTree(packageDirectory) };
  }
  return packages;
}

/**
 * Повторно разрешает и хеширует фактические package trees после долгого прогона.
 * Lock-файл сам по себе не замечает подмену ignored node_modules во время замера.
 */
export function assertInstalledPackageTreesUnchanged(baseDirectory, expectedPackages) {
  for (const [name, expected] of Object.entries(expectedPackages ?? {})) {
    let packageDirectory;
    try {
      packageDirectory = realpathSync(path.join(baseDirectory, 'node_modules', name));
    } catch {
      throw new Error(`provenance: ${name} исчез во время benchmark-прогона`);
    }
    const installed = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    const tree = hashFileTree(packageDirectory);
    if (
      installed.version !== expected.version ||
      tree.files !== expected.files ||
      tree.sha256 !== expected.sha256
    ) {
      throw new Error(`provenance: ${name} изменился во время benchmark-прогона`);
    }
  }
}

/**
 * Проверяет фактический toolchain и установленные vendor-байты, а не только
 * обещания lock-файла. Node 24 — канонический publish-runtime бенчмарков.
 */
export function captureBenchmarkEnvironment(
  root,
  benchDirectory,
  requiredPackages = [],
  options = {},
) {
  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeMajor = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  if (nodeMajor !== 24) {
    throw new Error(`provenance: benchmark publish требует Node 24, получено ${nodeVersion}`);
  }
  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootPkg.packageManager ?? '');
  if (manager === null) throw new Error('provenance: packageManager обязан точно фиксировать pnpm@x.y.z');
  const expectedPnpm = manager[1];
  const pnpmVersion = options.pnpmVersion ?? installedPnpmVersion();
  if (pnpmVersion !== expectedPnpm) {
    throw new Error(`provenance: требуется pnpm ${expectedPnpm}, получено ${pnpmVersion}`);
  }

  const benchPkg = JSON.parse(readFileSync(path.join(benchDirectory, 'package.json'), 'utf8'));
  if (benchPkg.packageManager !== rootPkg.packageManager) {
    throw new Error(
      `provenance: packageManager benchmark package должен совпадать с root (${rootPkg.packageManager})`,
    );
  }
  const packages = captureInstalledPackages(
    benchDirectory,
    benchPkg,
    requiredPackages,
    'benchmark',
  );
  const rootPackages = captureInstalledPackages(
    root,
    rootPkg,
    options.requiredRootPackages ?? [],
    'root',
  );
  return {
    node: nodeVersion,
    nodeExecutableSha256: options.nodeVersion === undefined ? sha256File(process.execPath) : undefined,
    pnpm: pnpmVersion,
    packages,
    rootPackages,
  };
}

export function buildCurrentCheckout(root) {
  try {
    execFileSync('pnpm', ['--dir', root, 'run', 'build'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(
      `provenance: не удалось пересобрать текущий checkout: ${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
}

function inputHashes(root, benchDirectory, requiredInputs = []) {
  const candidates = [
    ['root/package.json', path.join(root, 'package.json'), true],
    ['root/pnpm-lock.yaml', path.join(root, 'pnpm-lock.yaml'), true],
    ['root/pnpm-workspace.yaml', path.join(root, 'pnpm-workspace.yaml'), false],
    ['bench/package.json', path.join(benchDirectory, 'package.json'), true],
    ['bench/pnpm-lock.yaml', path.join(benchDirectory, 'pnpm-lock.yaml'), true],
    ['bench/pnpm-workspace.yaml', path.join(benchDirectory, 'pnpm-workspace.yaml'), false],
    ...requiredInputs.map(([label, file]) => [label, file, true]),
  ];
  const hashes = {};
  for (const [label, file, required] of candidates) {
    if (!existsSync(file)) {
      if (required) throw new Error(`provenance: обязательный input отсутствует: ${file}`);
      continue;
    }
    hashes[label] = sha256File(file);
  }
  return hashes;
}

/**
 * Пересобирает checkout и возвращает манифест ровно тех локальных байтов, из
 * которых затем собираются адаптеры. build/readState инжектируются только для
 * герметичных тестов; production-вызовы используют реальные pnpm/git.
 */
export function prepareBenchmarkCheckout({
  root,
  benchDirectory,
  requiredDist = [],
  build = buildCurrentCheckout,
  readState = readCheckoutState,
  requiredPackages = [],
  requiredRootPackages = [],
  captureEnvironment = (r, b) => captureBenchmarkEnvironment(r, b, requiredPackages, {
    requiredRootPackages,
  }),
  requireClean = true,
  requiredInputs = [],
  requiredEntries = [],
}) {
  const before = readState(root);
  if (requireClean && before.dirty) {
    throw new Error('provenance: publish-бенчмарк требует clean checkout');
  }
  assertBenchmarkExportSurface({ root, requiredDist, requiredEntries });
  const environment = captureEnvironment(root, benchDirectory);
  build(root);
  for (const relative of requiredDist) {
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      throw new Error(`provenance: сборка не создала обязательный файл: ${relative}`);
    }
  }
  const checkout = readState(root);
  if (
    (requireClean ? checkout.dirty : checkout.dirty !== before.dirty) ||
    checkout.revision !== before.revision ||
    checkout.worktreeSha256 !== before.worktreeSha256
  ) {
    throw new Error('provenance: сборка изменила checkout; результаты недействительны');
  }
  return {
    ...checkout,
    builtAt: new Date().toISOString(),
    inputs: inputHashes(root, benchDirectory, [...requiredInputs, ...requiredEntries]),
    distRuntime: hashFileTree(path.join(root, 'dist'), (file) => RUNTIME_FILE.test(file)),
    environment,
  };
}

/** Прерывает публикацию чисел, если checkout изменился уже во время замера. */
export function assertCheckoutUnchanged(root, prepared, readState = readCheckoutState) {
  const current = readState(root);
  const distRuntime = hashFileTree(path.join(root, 'dist'), (file) => RUNTIME_FILE.test(file));
  if (
    current.revision !== prepared.revision ||
    current.dirty !== prepared.dirty ||
    current.worktreeSha256 !== prepared.worktreeSha256 ||
    distRuntime.sha256 !== prepared.distRuntime.sha256 ||
    distRuntime.files !== prepared.distRuntime.files
  ) {
    throw new Error('provenance: checkout или dist изменился во время бенчмарка; результаты отброшены');
  }
}

/** Повторно хеширует runtime-артефакты после замера: pre-run SHA недостаточно. */
export function assertFileHashesUnchanged(artifacts) {
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (
      typeof artifact?.path !== 'string' ||
      typeof artifact?.sha256 !== 'string' ||
      !existsSync(artifact.path) ||
      sha256File(artifact.path) !== artifact.sha256
    ) {
      throw new Error(`provenance: ${name} изменился во время benchmark-прогона`);
    }
  }
}

export function formatProvenanceMarkdown(prepared, adapters) {
  const lines = [
    '## Происхождение измеренных байтов',
    '',
    `- Checkout: \`${prepared.revisionLabel}\` (полный commit \`${prepared.revision}\`).`,
    `- Рабочее дерево: ${prepared.dirty ? '**dirty**' : 'clean'}; SHA-256 \`${prepared.worktreeSha256}\`.`,
    `- Runtime-дерево dist: ${prepared.distRuntime.files} файлов; SHA-256 \`${prepared.distRuntime.sha256}\`.`,
    `- Runtime: Node \`${prepared.environment?.node ?? 'н/д'}\`, pnpm \`${prepared.environment?.pnpm ?? 'н/д'}\`.`,
    ...(prepared.environment?.nodeExecutableSha256
      ? [`- Node executable SHA-256: \`${prepared.environment.nodeExecutableSha256}\`.`]
      : []),
    '- Lock/package inputs:',
  ];
  for (const [name, hash] of Object.entries(prepared.inputs)) {
    lines.push(`  - \`${name}\`: \`${hash}\``);
  }
  const packageEntries = Object.entries(prepared.environment?.packages ?? {});
  if (packageEntries.length > 0) {
    lines.push('- Фактически установленные benchmark-пакеты:');
    for (const [name, info] of packageEntries) {
      lines.push(`  - \`${name}@${info.version}\`: ${info.files} файлов; SHA-256 \`${info.sha256}\``);
    }
  }
  const rootPackageEntries = Object.entries(prepared.environment?.rootPackages ?? {});
  if (rootPackageEntries.length > 0) {
    lines.push('- Фактически установленный root-tooling:');
    for (const [name, info] of rootPackageEntries) {
      lines.push(`  - \`${name}@${info.version}\`: ${info.files} файлов; SHA-256 \`${info.sha256}\``);
    }
  }
  lines.push('- Собранные адаптеры:');
  for (const [name, hashes] of Object.entries(adapters)) {
    const size = hashes.sizeBundleSha256 === undefined
      ? ''
      : `; size-bundle \`${hashes.sizeBundleSha256}\``;
    lines.push(`  - \`${name}\`: runtime \`${hashes.runtimeSha256}\`${size}`);
  }
  return lines.join('\n');
}
