import { defineConfig } from 'tsup';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Несколько публичных субпутей используют один scheduler. Без приватного
 * self-reference `splitting: false` встраивает отдельный singleton в каждый
 * entry: совместный импорт animate + bindings запускал бы несколько rAF-циклов.
 * Точечный resolver сохраняет остальные entries самодостаточными и не плодит
 * общие чанки, но оставляет frame единым на уровне установленного пакета.
 *
 * «Единый на уровне пакета» — теперь ПРАВДА без оговорок. До 2026-07-25 пакет
 * ехал в двух форматах, и условные ветки import/require давали смешанному
 * графу (приложение импортирует, транзитивная CJS-зависимость требует) ДВА
 * независимых экземпляра модуля: два rAF-цикла, две конкурирующие записи в
 * один элемент, cancelAll() гасит только свою половину.
 *
 * Замер механизма (Node 22.22.2, синтетический пакет с счётчиком запусков
 * цикла, `createRequire` + `import` в ОДНОМ процессе, два запуска подряд):
 *   exports = { import: './index.js', require: './index.cjs' }
 *       → require-половина видит 1 запуск, import-половина видит 1. ДВА цикла.
 *   exports = './index.js' (одна цель)
 *       → обе половины видят 2 из 2. ОДИН цикл.
 * То есть дело не в сборщике и не в нашем коде: развилку создаёт сам
 * резолвер, и убирает её только единственная цель на субпуть.
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
 * ссылки переводятся на физический общий entry. Относительный путь выводится
 * из каждого output-файла, поэтому вложенный compositor/stagger не является
 * особым случаем.
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
 * поздний pack-smoke). Для каждого субпутя берётся цель `default`
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
      : (target as { default?: unknown } | null)?.default;
    const match = typeof esm === 'string' ? /^\.\/dist\/(.+)\.js$/.exec(esm) : null;
    if (match === null) {
      throw new Error(`build: exports['${subpath}'] не указывает default на ./dist/*.js`);
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

// Декларации НЕ собираются tsup: DTS-бандлинг держал полный чекер в воркере
// и упирался в heap (двухфазная сборка была временным ответом). Теперь их
// эмитит scripts/emit-declarations.mjs по-файлово через ts.transpileDeclaration
// под контрактом isolatedDeclarations — память O(файла), воркеров нет.
export default defineConfig({
  entry: entriesFromPackageExports(),
  // ОДИН формат. CJS-ветка снята вместе с дублированием состояния (см. шапку
  // sharedFramePlugin). Потребители на require() продолжают работать: с Node
  // 22.12 require() читает ESM и отдаёт ТОТ ЖЕ экземпляр модуля. Это не
  // предположение: проба смешанного графа в scripts/pack-smoke.mjs гоняет
  // require+import в одном процессе на УСТАНОВЛЕННОМ тарболе и требует
  // совпадения тождества frame, одного rAF и того, что cancelAll из
  // require-половины гасит import-половину.
  format: ['esm'],
  dts: false,
  splitting: false,
  // Карты не входят в npm-артефакт; их генерация оставляла в runtime-файлах
  // ссылки на отсутствующие ресурсы и создавала ложные 404 в DevTools.
  sourcemap: false,
  clean: true,
  minify: 'terser',
  // Свежие объекты на каждый доступ: Terser дописывает служебные поля в
  // nested options, и переиспользование одного литерала протекало между
  // проходами.
  terserOptions: {
    get compress() { return { passes: 3, pure_getters: true }; },
    get mangle() { return { properties: { regex: /^_/ } }; },
  },
  treeshake: true,
  esbuildPlugins: [sharedFramePlugin],
  onSuccess: makeSharedFrameBrowserNative,
});
