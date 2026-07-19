import { defineConfig } from 'tsup';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Несколько публичных субпутей используют один scheduler. Без приватного
 * self-reference `splitting: false` встраивает отдельный singleton в каждый
 * entry: совместный импорт animate + bindings запускал бы несколько rAF-циклов.
 * Точечный resolver сохраняет остальные entries самодостаточными и не плодит
 * общие чанки, но оставляет frame единым на уровне установленного пакета.
 */
const sharedFramePlugin = {
  name: 'shared-package-frame',
  setup(build: { onResolve: (options: { filter: RegExp }, callback: () => object) => void }) {
    build.onResolve({ filter: /^(?:\.\.\/)+frame\/index\.js$/ }, () => ({
      path: '#frame',
      external: true,
    }));
  },
};

/**
 * Node понимает package#imports, голый browser/CDN ESM — нет. После сборки
 * переводим только ESM-ссылки на физический общий entry; CJS сохраняет #frame
 * и выбирает .cjs через package.json. Относительный путь выводится из каждого
 * output-файла, поэтому вложенный compositor/stagger не является особым случаем.
 */
async function makeSharedFrameBrowserNative(): Promise<void> {
  const dist = resolve('dist');
  const frame = join(dist, 'frame', 'index.js');
  if (!existsSync(frame)) throw new Error('build: отсутствует dist/frame/index.js');
  const pending = [dist];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('#frame')) continue;
      let specifier = relative(dirname(file), frame).replaceAll('\\', '/');
      if (!specifier.startsWith('.')) specifier = './' + specifier;
      const rewritten = source.replace(/(["'])#frame\1/g, JSON.stringify(specifier));
      if (rewritten.includes('#frame')) {
        throw new Error(`build: не переписан browser-import #frame в ${file}`);
      }
      writeFileSync(file, rewritten);
    }
  }
}

/**
 * Entry-points НЕ дублируются руками: package.json `exports` — единственный
 * источник (раньше список жил и здесь, и в exports, а дрейф ловил только
 * поздний pack-smoke). Для каждого субпутя берётся ESM-цель `import.default`
 * вида ./dist/<name>.js и превращается в пару <name> → src/<name>.ts
 * (корневой '.' даёт index → src/index.ts). Ключ-строка на ресурс вне dist
 * (не-JS ключ) — легальный passthrough, не entry; всё остальное без валидной
 * dist-JS-цели или без исходника — ошибка ДО сборки.
 */
export function entriesFromPackageExports(): Record<string, string> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const exportsMap = pkg.exports ?? {};
  if (Object.keys(exportsMap).length === 0) {
    throw new Error('build: package.json не содержит exports — нечего собирать');
  }
  const entries: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (typeof target === 'string' && !target.startsWith('./dist/')) continue;
    const esm = typeof target === 'string'
      ? target
      : (target as { import?: { default?: unknown } } | null)?.import?.default;
    const match = typeof esm === 'string' ? /^\.\/dist\/(.+)\.js$/.exec(esm) : null;
    if (match === null) {
      throw new Error(`build: exports['${subpath}'] не указывает import.default на ./dist/*.js`);
    }
    const name = match[1]!;
    const source = `src/${name}.ts`;
    if (!existsSync(source)) {
      throw new Error(`build: exports['${subpath}'] требует отсутствующий исходник ${source}`);
    }
    if (entries[name] !== undefined) {
      throw new Error(`build: exports дублируют dist-цель ${name} (субпуть '${subpath}')`);
    }
    entries[name] = source;
  }
  return entries;
}

// Общие настройки эмита: байтовый паритет обоих конфигов обязателен —
// compiler/runtime поставляется браузеру и меряется тем же size-gate.
// ВАЖНО: terserOptions отдаёт фабрика, а не spread-объект — object spread
// вызвал бы геттеры один раз и заморозил nested options, вернув гонку
// параллельного ESM/CJS minify, от которой геттеры защищают.
export function sharedEmit() {
  return {
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    // Карты не входят в npm-артефакт; их генерация оставляла в runtime-файлах
    // ссылки на отсутствующие ресурсы и создавала ложные 404 в DevTools.
    sourcemap: false,
    minify: 'terser',
    // tsup запускает ESM/CJS minify параллельно, а Terser дописывает служебные
    // поля в nested options. Свежие объекты не дают форматам менять друг друга.
    terserOptions: {
      get compress() { return { passes: 3, pure_getters: true }; },
      get mangle() { return { properties: { regex: /^_/ } }; },
    },
    treeshake: true,
  } as const;
}

function splitEntries(): [runtime: Record<string, string>, compiler: Record<string, string>] {
  const runtime: Record<string, string> = {};
  const compiler: Record<string, string> = {};
  for (const [name, source] of Object.entries(entriesFromPackageExports())) {
    (name.startsWith('compiler/') ? compiler : runtime)[name] = source;
  }
  return [runtime, compiler];
}

export const [runtimeEntries, compilerEntries] = splitEntries();

// Две ПОСЛЕДОВАТЕЛЬНЫЕ сборки (`tsup && tsup --config tsup.compiler.config.ts`)
// = два DTS-воркера: build-tool entries (#208) впервые тянут тип-граф
// MotionProgram V1, и общий с 39 runtime-entries dts-бандл упирается в
// heap-лимит воркера на CI. Массив-конфиг tsup исполняет ПАРАЛЛЕЛЬНО, и
// clean первого рейсился бы с выводом второго — поэтому отдельный файл
// конфига и последовательный запуск в build-скрипте.
export default defineConfig({
  ...sharedEmit(),
  entry: runtimeEntries,
  clean: true,
  esbuildPlugins: [sharedFramePlugin],
  onSuccess: makeSharedFrameBrowserNative,
});
