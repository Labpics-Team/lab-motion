import { isDeepStrictEqual } from 'node:util';

export const RELEASE_PACKAGE_NAME = '@labpics/motion';
export const RELEASE_REPOSITORY = Object.freeze({
  type: 'git',
  url: 'git+https://github.com/Labpics-Team/lab-motion.git',
});

const EXACT_FIELDS = Object.freeze({
  private: false,
  description: 'Headless zero-dependency motion engine: analytic spring solver, keyframes, timeline, FLIP, gestures, WAAPI compositor path, 9 framework bindings.',
  author: 'Labpics',
  keywords: [
    'animation',
    'motion',
    'spring',
    'physics',
    'keyframes',
    'timeline',
    'flip',
    'waapi',
    'headless',
    'zero-dependency',
  ],
  license: 'MIT',
  repository: RELEASE_REPOSITORY,
  engines: { node: '>=22' },
  packageManager: 'pnpm@11.11.0',
  type: 'module',
  main: './dist/index.cjs',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  imports: {
    '#frame': {
      import: './dist/frame/index.js',
      require: './dist/frame/index.cjs',
    },
  },
  files: [
    'dist',
    'docs/errors.md',
    'docs/бенчмарк.md',
    '!dist/**/*.map',
  ],
  publishConfig: { access: 'public' },
  sideEffects: [
    './dist/lit/index.js',
    './dist/lit/index.cjs',
    './dist/wc/index.js',
    './dist/wc/index.cjs',
  ],
  peerDependencies: {
    '@angular/core': '>=16.0.0',
    '@builder.io/qwik': '>=1.4.0',
    lit: '>=3.0.0',
    preact: '>=10.3.1',
    react: '>=18.0.0',
    'solid-js': '>=1.8.0',
    svelte: '>=4.0.0',
    vue: '>=3.0.0',
  },
  peerDependenciesMeta: {
    lit: { optional: true },
    react: { optional: true },
    svelte: { optional: true },
    vue: { optional: true },
    'solid-js': { optional: true },
    preact: { optional: true },
    '@angular/core': { optional: true },
    '@builder.io/qwik': { optional: true },
  },
});

const CONTRACT_FIELDS = Object.freeze([
  'name',
  'version',
  ...Object.keys(EXACT_FIELDS),
  'typesVersions',
  'exports',
]);

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'name',
  'version',
  ...Object.keys(EXACT_FIELDS),
  'typesVersions',
  'exports',
  'scripts',
  'devDependencies',
]);

const FORBIDDEN_DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
]);

const FORBIDDEN_INSTALL_FIELDS = Object.freeze([
  'bin',
  'os',
  'cpu',
  'libc',
  'man',
  'config',
  'directories',
  'workspaces',
  'browser',
  'react-native',
  'unpkg',
  'jsdelivr',
]);

// Pack/publish выполняются только после явных release-гейтов. Lifecycle-хуки не
// должны создавать второй, менее проверяемый путь сборки или запускаться у клиента.
const FORBIDDEN_LIFECYCLE_SCRIPTS = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
]);

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, 'ожидался объект');
  }
}

function assertExact(value, expected, label) {
  if (!isDeepStrictEqual(value, expected)) {
    fail(label, `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(value)}`);
  }
}

function expectedExportTarget(subpath, kind, branch) {
  const directory = subpath === '.' ? '' : `${subpath.slice(2)}/`;
  const extension = kind === 'types'
    ? branch === 'import' ? 'd.ts' : 'd.cts'
    : branch === 'import' ? 'js' : 'cjs';
  return `./dist/${directory}index.${extension}`;
}

function assertExports(exportsMap, label) {
  assertPlainObject(exportsMap, `${label}.exports`);
  const entries = Object.entries(exportsMap);
  if (entries.length === 0 || !Object.hasOwn(exportsMap, '.')) {
    fail(`${label}.exports`, 'обязательна корневая точка входа');
  }
  for (const [subpath, target] of entries) {
    if (subpath !== '.' && !/^\.\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(subpath)) {
      fail(`${label}.exports`, `неканонический субпуть ${subpath}`);
    }
    assertPlainObject(target, `${label}.exports[${subpath}]`);
    assertExact(Object.keys(target), ['import', 'require'], `${label}.exports[${subpath}] conditions`);
    for (const branch of ['import', 'require']) {
      const condition = target[branch];
      assertPlainObject(condition, `${label}.exports[${subpath}].${branch}`);
      assertExact(
        Object.keys(condition),
        ['types', 'default'],
        `${label}.exports[${subpath}].${branch} conditions`,
      );
      for (const kind of ['types', 'default']) {
        const expected = expectedExportTarget(subpath, kind, branch);
        if (condition[kind] !== expected) {
          fail(
            `${label}.exports[${subpath}].${branch}.${kind}`,
            `ожидалось ${expected}, получено ${String(condition[kind])}`,
          );
        }
      }
    }
  }
}

/** Единый fail-closed контракт для root и package.json из tgz. */
export function validateReleaseMetadata(pkg, label = 'package.json') {
  assertPlainObject(pkg, label);
  for (const field of Object.keys(pkg)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(field)) fail(label, `неожиданное top-level поле ${field}`);
  }
  if (pkg.name !== RELEASE_PACKAGE_NAME) fail(label, `неожиданное имя ${String(pkg.name)}`);
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    fail(label, `версия обязана иметь формат x.y.z, получено ${String(pkg.version)}`);
  }
  for (const [field, expected] of Object.entries(EXACT_FIELDS)) {
    assertExact(pkg[field], expected, `${label}.${field}`);
  }
  assertPlainObject(pkg.typesVersions, `${label}.typesVersions`);
  if (Object.keys(pkg.typesVersions).length === 0) fail(`${label}.typesVersions`, 'пустой контракт');
  assertExports(pkg.exports, label);

  for (const field of FORBIDDEN_DEPENDENCY_FIELDS) {
    if (Object.hasOwn(pkg, field)) fail(label, `запрещено поле ${field}`);
  }
  for (const field of FORBIDDEN_INSTALL_FIELDS) {
    if (Object.hasOwn(pkg, field)) fail(label, `запрещено install-поле ${field}`);
  }
  for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(pkg.scripts ?? {}, script)) {
      fail(label, `запрещён lifecycle script ${script}`);
    }
  }
  return pkg;
}

/** Архив обязан нести ровно тот же consumer/release-контракт, что root. */
export function validateArchiveMetadata(rootPackage, archivePackage) {
  validateReleaseMetadata(rootPackage, 'root package.json');
  // pnpm pack намеренно удаляет только packageManager из публикуемого
  // package.json. Проверяем фактическую проекцию pack, не требуя поля, которое
  // сам владелец артефакта гарантированно вырезает; если поле всё же есть,
  // любое расхождение по-прежнему fail-closed.
  const normalizedArchive = Object.hasOwn(archivePackage, 'packageManager')
    ? archivePackage
    : { ...archivePackage, packageManager: rootPackage.packageManager };
  validateReleaseMetadata(normalizedArchive, 'archive package.json');
  for (const field of CONTRACT_FIELDS) {
    if (!isDeepStrictEqual(normalizedArchive[field], rootPackage[field])) {
      fail('archive package.json', `поле ${field} расходится с root package.json`);
    }
  }
  return archivePackage;
}
