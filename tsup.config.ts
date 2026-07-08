import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    'svelte/index': 'src/svelte/index.ts',
    'vue/index': 'src/vue/index.ts',
    'text/index': 'src/text/index.ts',
    'number/index': 'src/number/index.ts',
    'ticker/index': 'src/ticker/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
});
