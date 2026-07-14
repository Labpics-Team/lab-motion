import { defineConfig } from 'tsup';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Несколько публичных субпутей используют один scheduler. Без приватного
 * self-reference `splitting: false` встраивает отдельный singleton в каждый
 * entry: совместный импорт mini + bindings запускает несколько rAF-циклов.
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
 * output-файла, поэтому вложенный animate/mini не является особым случаем.
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

export default defineConfig({
  entry: ['src/index.ts', 'src/easing/index.ts', 'src/react/index.ts', 'src/svelte/index.ts', 'src/vue/index.ts', 'src/value/index.ts', 'src/driver/index.ts', 'src/stagger/index.ts', 'src/timeline/index.ts', 'src/keyframes/index.ts', 'src/decay/index.ts', 'src/lit/index.ts', 'src/gestures/index.ts', 'src/scroll/index.ts', 'src/presence/index.ts', 'src/flip/index.ts', 'src/projection/index.ts', 'src/smart/index.ts', 'src/svg/index.ts', 'src/a11y/index.ts', 'src/spring/index.ts', 'src/waapi/index.ts', 'src/auto/index.ts', 'src/svg-morph/index.ts', 'src/solid/index.ts', 'src/preact/index.ts', 'src/angular/index.ts', 'src/wc/index.ts', 'src/qwik/index.ts', 'src/frame/index.ts', 'src/presets/index.ts', 'src/utils/index.ts', 'src/compositor/index.ts', 'src/compositor/stagger/index.ts', 'src/tokens/index.ts', 'src/animate/index.ts', 'src/animate/mini/index.ts', 'src/animate/native/index.ts', 'src/nano/index.ts', 'src/behaviors/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  // Карты не входят в npm-артефакт; их генерация оставляла в runtime-файлах
  // ссылки на отсутствующие ресурсы и создавала ложные 404 в DevTools.
  sourcemap: false,
  clean: true,
  minify: 'terser',
  // tsup запускает ESM/CJS minify параллельно, а Terser дописывает служебные
  // поля в nested options. Свежие объекты не дают форматам менять друг друга.
  terserOptions: {
    get compress() { return { passes: 3, pure_getters: true }; },
    get mangle() { return { properties: { regex: /^_/ } }; },
  },
  treeshake: true,
  esbuildPlugins: [sharedFramePlugin],
  onSuccess: makeSharedFrameBrowserNative,
});
